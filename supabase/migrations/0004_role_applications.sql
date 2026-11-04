-- Abremi role applications: members apply to become a Critic (×5) or Collector (×9);
-- admins review each application and grant or decline it. Roles still can't be self-assigned.
--
-- Make yourself an admin once, in the SQL editor:
--   insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';

create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
-- No policies: nobody can read or change the admin list through the API.
revoke all on public.admins from anon, authenticated;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where user_id = auth.uid())
$$;

create table if not exists public.role_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('critic', 'collector')),
  statement text not null check (char_length(statement) between 40 and 1500),
  links text[] not null default '{}' check (cardinality(links) <= 5),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'withdrawn')),
  decision_note text check (char_length(coalesce(decision_note, '')) <= 500),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users (id) on delete set null
);
create index if not exists role_applications_user_idx on public.role_applications (user_id, created_at desc);
create index if not exists role_applications_pending_idx on public.role_applications (created_at) where status = 'pending';
alter table public.role_applications enable row level security;

drop policy if exists "read own applications" on public.role_applications;
create policy "read own applications" on public.role_applications for select using (user_id = auth.uid());
-- Writes only through the functions below.
revoke insert, update, delete on public.role_applications from anon, authenticated;
grant select on public.role_applications to authenticated;

-- ——— Applying ———
create or replace function public.apply_for_role(p_role text, p_statement text, p_links text[] default '{}')
returns public.role_applications
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  current_role_name text;
  clean_links text[];
  app public.role_applications;
begin
  if uid is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if p_role not in ('critic', 'collector') then
    raise exception 'You can apply to be a Critic or a Collector' using errcode = '22023';
  end if;
  select role into current_role_name from profiles where id = uid;
  if current_role_name = p_role then
    raise exception 'You already have this role' using errcode = '22023';
  end if;
  if exists (select 1 from role_applications where user_id = uid and role = p_role and status = 'pending') then
    raise exception 'You already have a pending application for this role' using errcode = 'P0001';
  end if;
  if (select count(*) from role_applications where user_id = uid and created_at > now() - interval '30 days') >= 3 then
    raise exception 'You can send three applications every 30 days' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(btrim(l)), '{}') into clean_links
    from unnest(coalesce(p_links, '{}')) as l where btrim(l) <> '';
  -- (Postgres regexes cap repetition counts at 255, so the length is checked separately.)
  if exists (select 1 from unnest(clean_links) as l where l !~ '^https://[^[:space:]<>"]+$' or char_length(l) not between 12 and 300) then
    raise exception 'Links must start with https://' using errcode = '22023';
  end if;
  insert into role_applications (user_id, role, statement, links)
  values (uid, p_role, btrim(p_statement), clean_links)
  returning * into app;
  return app;
end $$;

create or replace function public.withdraw_role_application(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update role_applications set status = 'withdrawn', decided_at = now()
  where id = p_id and user_id = auth.uid() and status = 'pending';
  if not found then
    raise exception 'No pending application to withdraw' using errcode = 'P0001';
  end if;
end $$;

-- ——— Reviewing (admins only) ———
create or replace function public.admin_role_queue()
returns table (
  id uuid, role text, statement text, links text[], created_at timestamptz,
  applicant_name text, applicant_country text, applicant_role text, email text, member_since timestamptz,
  likes integer, saves integer, reviews integer, influence_added integer, follows integer, previous_declines integer
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return query
    select a.id, a.role, a.statement, a.links, a.created_at,
           p.name, p.country, p.role, u.email::text, p.created_at,
           (select count(*)::int from reactions r where r.user_id = a.user_id and r.kind = 'like'),
           (select count(*)::int from reactions r where r.user_id = a.user_id and r.kind = 'super'),
           (select count(*)::int from reviews v where v.user_id = a.user_id),
           (select coalesce(sum(case r.kind when 'like' then role_weight(r.role) when 'super' then 2 * role_weight(r.role) else 0 end), 0)::int
              from reactions r where r.user_id = a.user_id),
           (select count(*)::int from follows f where f.user_id = a.user_id),
           (select count(*)::int from role_applications d where d.user_id = a.user_id and d.status = 'declined')
    from role_applications a
    join profiles p on p.id = a.user_id
    left join auth.users u on u.id = a.user_id
    where a.status = 'pending'
    order by a.created_at;
end $$;

create or replace function public.decide_role_application(p_id uuid, p_approve boolean, p_note text default null)
returns public.role_applications
language plpgsql security definer set search_path = public as $$
declare
  app public.role_applications;
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  update role_applications
     set status = case when p_approve then 'approved' else 'declined' end,
         decision_note = nullif(btrim(coalesce(p_note, '')), ''),
         decided_at = now(),
         decided_by = auth.uid()
   where id = p_id and status = 'pending'
  returning * into app;
  if app.id is null then
    raise exception 'That application is no longer pending' using errcode = 'P0001';
  end if;
  if p_approve then
    update profiles set role = app.role where id = app.user_id;
  end if;
  return app;
end $$;

create or replace function public.admin_verified_members()
returns table (user_id uuid, name text, country text, role text, email text, approved_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return query
    select p.id, p.name, p.country, p.role, u.email::text,
           (select max(a.decided_at) from role_applications a where a.user_id = p.id and a.status = 'approved' and a.role = p.role)
    from profiles p left join auth.users u on u.id = p.id
    where p.role in ('critic', 'collector')
    order by p.role, p.name;
end $$;

-- Takes a verified role away (back to Fan). Past votes keep the weight they had when cast.
create or replace function public.revoke_role(p_user uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  update profiles set role = 'fan' where id = p_user and role in ('critic', 'collector');
  if not found then
    raise exception 'That member has no verified role' using errcode = 'P0001';
  end if;
  update role_applications set decision_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), decision_note)
   where user_id = p_user and status = 'approved';
end $$;

revoke all on function public.apply_for_role(text, text, text[]) from public, anon;
grant execute on function public.apply_for_role(text, text, text[]) to authenticated;
revoke all on function public.withdraw_role_application(uuid) from public, anon;
grant execute on function public.withdraw_role_application(uuid) to authenticated;
revoke all on function public.admin_role_queue() from public, anon;
grant execute on function public.admin_role_queue() to authenticated;
revoke all on function public.decide_role_application(uuid, boolean, text) from public, anon;
grant execute on function public.decide_role_application(uuid, boolean, text) to authenticated;
revoke all on function public.admin_verified_members() from public, anon;
grant execute on function public.admin_verified_members() to authenticated;
revoke all on function public.revoke_role(uuid, text) from public, anon;
grant execute on function public.revoke_role(uuid, text) to authenticated;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
