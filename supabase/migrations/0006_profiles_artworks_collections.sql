-- Abremi Phase 1: audit trail, artist profiles, artwork details, and collections on the server.
-- Adds tables and columns only; nothing existing is removed. To undo, run
-- supabase/migrations/down/0006_down.sql (that drops what this file adds, including its data).

-- ——— 1. Audit trail ———
-- Sensitive actions (role decisions, role removals, artwork deletions) are recorded here.
-- Nobody can read or write the table through the API; moderators read it with admin_audit_log().
create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users (id) on delete set null,
  action text not null check (char_length(action) between 1 and 60),
  target_type text not null check (char_length(target_type) between 1 and 40),
  target_id text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_events_target_idx on public.audit_events (target_type, target_id, created_at desc);
create index if not exists audit_events_created_idx on public.audit_events (created_at desc);
alter table public.audit_events enable row level security;
revoke all on public.audit_events from anon, authenticated;

create or replace function public.log_audit(p_action text, p_target_type text, p_target_id text, p_details jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public as $$
  insert into audit_events (actor_id, action, target_type, target_id, details)
  values (auth.uid(), p_action, p_target_type, p_target_id, coalesce(p_details, '{}'::jsonb))
$$;
revoke all on function public.log_audit(text, text, text, jsonb) from public, anon, authenticated;

create or replace function public.admin_audit_log(p_limit integer default 100)
returns table (id uuid, created_at timestamptz, action text, target_type text, target_id text, details jsonb, actor_email text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return query
    select e.id, e.created_at, e.action, e.target_type, e.target_id, e.details, u.email::text
    from audit_events e left join auth.users u on u.id = e.actor_id
    order by e.created_at desc
    limit least(greatest(coalesce(p_limit, 100), 1), 500);
end $$;
revoke all on function public.admin_audit_log(integer) from public, anon;
grant execute on function public.admin_audit_log(integer) to authenticated;

-- Role decisions and removals, now recorded. (Same rules as 0004.)
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
  perform log_audit(case when p_approve then 'role_application.approved' else 'role_application.declined' end,
                    'profile', app.user_id::text,
                    jsonb_build_object('application', app.id, 'role', app.role, 'note', app.decision_note));
  return app;
end $$;

-- Removing a role no longer overwrites the original decision note; the reason goes to the audit trail.
create or replace function public.revoke_role(p_user uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  old_role text;
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  select role into old_role from profiles where id = p_user and role in ('critic', 'collector') for update;
  if old_role is null then
    raise exception 'That member has no verified role' using errcode = 'P0001';
  end if;
  update profiles set role = 'fan' where id = p_user;
  perform log_audit('role.revoked', 'profile', p_user::text,
                    jsonb_build_object('role', old_role, 'note', nullif(btrim(coalesce(p_note, '')), '')));
end $$;

-- ——— 2. Artist profiles (on the existing artists table: no duplicate profile table) ———
alter table public.artists add column if not exists bio text;
alter table public.artists add column if not exists statement text;
alter table public.artists add column if not exists website text;
alter table public.artists add column if not exists instagram text;
alter table public.artists add column if not exists city text;
alter table public.artists add column if not exists avatar_path text;
alter table public.artists add column if not exists updated_at timestamptz not null default now();
alter table public.artists drop constraint if exists artists_profile_valid;
alter table public.artists add constraint artists_profile_valid check (
  char_length(coalesce(bio, '')) <= 1000
  and char_length(coalesce(statement, '')) <= 2000
  and (website is null or (website ~ '^https://[^[:space:]<>"]+$' and char_length(website) <= 200))
  and (instagram is null or instagram ~ '^[A-Za-z0-9._]{1,30}$')
  and char_length(coalesce(city, '')) <= 60
  and (avatar_path is null or (owner_id is not null and split_part(avatar_path, '/', 1) = owner_id::text))
);

-- The member's artist row, created on first use (publishing, or editing the profile).
create or replace function public.ensure_member_artist(p_uid uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  me public.profiles;
  member_artist text := 'm_' || p_uid::text;
begin
  select * into me from profiles where id = p_uid;
  insert into artists (id, name, country, owner_id) values (member_artist, me.name, me.country, p_uid)
  on conflict (id) do update set name = excluded.name, country = excluded.country;
  return member_artist;
end $$;
revoke all on function public.ensure_member_artist(uuid) from public, anon, authenticated;

create or replace function public.update_artist_profile(
  p_bio text, p_statement text, p_website text, p_instagram text, p_city text, p_avatar_path text
) returns public.artists
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  row public.artists;
  clean_avatar text := nullif(btrim(coalesce(p_avatar_path, '')), '');
begin
  if uid is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if not exists (select 1 from artists where owner_id = uid)
     and (select role from profiles where id = uid) is distinct from 'artist' then
    raise exception 'Switch to the Artist role to set up an artist profile' using errcode = '42501';
  end if;
  if clean_avatar is not null and not exists (
       select 1 from storage.objects o
        where o.bucket_id = 'artworks' and o.name = clean_avatar and (storage.foldername(o.name))[1] = uid::text) then
    raise exception 'Upload the portrait before saving' using errcode = '22023';
  end if;
  perform ensure_member_artist(uid);
  update artists set
    bio = nullif(btrim(coalesce(p_bio, '')), ''),
    statement = nullif(btrim(coalesce(p_statement, '')), ''),
    website = nullif(btrim(coalesce(p_website, '')), ''),
    instagram = nullif(ltrim(btrim(coalesce(p_instagram, '')), '@'), ''),
    city = nullif(btrim(coalesce(p_city, '')), ''),
    avatar_path = clean_avatar,
    updated_at = now()
  where owner_id = uid
  returning * into row;
  return row;
end $$;
revoke all on function public.update_artist_profile(text, text, text, text, text, text) from public, anon;
grant execute on function public.update_artist_profile(text, text, text, text, text, text) to authenticated;

-- Publishing uses the shared helper (same rules as 0002).
create or replace function public.publish_artwork(
  p_title text, p_category text, p_style text, p_medium text, p_year integer, p_price integer,
  p_image_path text, p_thumb_path text, p_width integer, p_height integer
) returns public.artworks
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  member_artist text;
  work public.artworks;
begin
  if uid is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if (select role from profiles where id = uid) is distinct from 'artist' then
    raise exception 'Switch to the Artist role to publish work' using errcode = '42501';
  end if;
  if (select count(*) from artworks a where a.owner_id = uid and a.created_at > now() - interval '1 day') >= 20 then
    raise exception 'Daily limit reached: 20 new works per day' using errcode = 'P0001';
  end if;
  if (select count(*) from storage.objects o where o.bucket_id = 'artworks' and o.name in (p_image_path, p_thumb_path)
        and (storage.foldername(o.name))[1] = uid::text) < 2 then
    raise exception 'Upload the image before publishing' using errcode = '22023';
  end if;
  member_artist := ensure_member_artist(uid);
  insert into artworks (id, artist_id, title, base_elo, owner_id, category, style, medium, year, price,
                        image_path, thumb_path, width, height)
  values ('u_' || replace(gen_random_uuid()::text, '-', ''), member_artist, btrim(p_title), 1200, uid,
          p_category, p_style, nullif(btrim(coalesce(p_medium, '')), ''), p_year, p_price,
          p_image_path, p_thumb_path, p_width, p_height)
  returning * into work;
  return work;
end $$;

-- ——— 3. Artwork details ———
alter table public.artworks add column if not exists description text;
alter table public.artworks add column if not exists dimensions text;
alter table public.artworks add column if not exists availability text;
alter table public.artworks add column if not exists updated_at timestamptz not null default now();
alter table public.artworks drop constraint if exists artworks_details_valid;
alter table public.artworks add constraint artworks_details_valid check (
  char_length(coalesce(description, '')) <= 2000
  and char_length(coalesce(dimensions, '')) <= 60
  -- 'sold' is what the artist reports; verified sales are a separate, later feature.
  and (availability is null or availability in ('available', 'sold', 'not_for_sale', 'on_request'))
  and (owner_id is not null or (description is null and dimensions is null and availability is null))
);

create or replace function public.update_artwork(
  p_id text, p_title text, p_category text, p_style text, p_medium text, p_year integer, p_price integer,
  p_description text, p_dimensions text, p_availability text
) returns public.artworks
language plpgsql security definer set search_path = public as $$
declare
  work public.artworks;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  update artworks set
    title = btrim(p_title), category = p_category, style = p_style,
    medium = nullif(btrim(coalesce(p_medium, '')), ''), year = p_year, price = p_price,
    description = nullif(btrim(coalesce(p_description, '')), ''),
    dimensions = nullif(btrim(coalesce(p_dimensions, '')), ''),
    availability = coalesce(nullif(p_availability, ''), 'available'),
    updated_at = now()
  where id = p_id and owner_id = auth.uid()
  returning * into work;
  if work.id is null then
    raise exception 'Not your artwork' using errcode = '42501';
  end if;
  return work;
end $$;
revoke all on function public.update_artwork(text, text, text, text, text, integer, integer, text, text, text) from public, anon;
grant execute on function public.update_artwork(text, text, text, text, text, integer, integer, text, text, text) to authenticated;

-- Deleting a work is now recorded. (Same rules as 0002.)
create or replace function public.delete_artwork(p_id text)
returns table (image_path text, thumb_path text)
language plpgsql security definer set search_path = public as $$
declare
  gone public.artworks;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  delete from artworks a where a.id = p_id and a.owner_id = auth.uid() returning a.* into gone;
  if gone.id is null then
    raise exception 'Not your artwork' using errcode = '42501';
  end if;
  perform log_audit('artwork.deleted', 'artwork', gone.id, jsonb_build_object('title', gone.title));
  image_path := gone.image_path;
  thumb_path := gone.thumb_path;
  return next;
end $$;

-- ——— 4. Collections (private by default) ———
create table if not exists public.collections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  description text check (char_length(coalesce(description, '')) <= 500),
  is_private boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists collections_owner_idx on public.collections (owner_id, created_at);

create table if not exists public.collection_items (
  collection_id uuid not null references public.collections (id) on delete cascade,
  artwork_id text not null references public.artworks (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (collection_id, artwork_id)
);
create index if not exists collection_items_artwork_idx on public.collection_items (artwork_id);

create or replace function public.guard_collection() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and (select count(*) from collections where owner_id = new.owner_id) >= 100 then
    raise exception 'You can have up to 100 collections' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.owner_id <> old.owner_id then
    raise exception 'Collections cannot change owner' using errcode = '42501';
  end if;
  new.name := btrim(new.name);
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists collections_guard on public.collections;
create trigger collections_guard before insert or update on public.collections
  for each row execute function public.guard_collection();

create or replace function public.guard_collection_item() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from collection_items where collection_id = new.collection_id) >= 500 then
    raise exception 'A collection can hold up to 500 works' using errcode = 'P0001';
  end if;
  update collections set updated_at = now() where id = new.collection_id;
  return new;
end $$;
drop trigger if exists collection_items_guard on public.collection_items;
create trigger collection_items_guard before insert on public.collection_items
  for each row execute function public.guard_collection_item();

alter table public.collections enable row level security;
alter table public.collection_items enable row level security;

drop policy if exists "own or public collections" on public.collections;
create policy "own or public collections" on public.collections for select
  using (owner_id = auth.uid() or not is_private);
drop policy if exists "create own collections" on public.collections;
create policy "create own collections" on public.collections for insert to authenticated
  with check (owner_id = auth.uid());
drop policy if exists "edit own collections" on public.collections;
create policy "edit own collections" on public.collections for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "delete own collections" on public.collections;
create policy "delete own collections" on public.collections for delete to authenticated
  using (owner_id = auth.uid());

drop policy if exists "items of visible collections" on public.collection_items;
create policy "items of visible collections" on public.collection_items for select
  using (exists (select 1 from collections c where c.id = collection_id and (c.owner_id = auth.uid() or not c.is_private)));
drop policy if exists "add to own collections" on public.collection_items;
create policy "add to own collections" on public.collection_items for insert to authenticated
  with check (exists (select 1 from collections c where c.id = collection_id and c.owner_id = auth.uid()));
drop policy if exists "remove from own collections" on public.collection_items;
create policy "remove from own collections" on public.collection_items for delete to authenticated
  using (exists (select 1 from collections c where c.id = collection_id and c.owner_id = auth.uid()));

revoke all on public.collections, public.collection_items from anon, authenticated;
grant select on public.collections, public.collection_items to anon, authenticated;
grant insert, delete on public.collections, public.collection_items to authenticated;
grant update (name, description, is_private) on public.collections to authenticated;

-- A shared (public) collection, with the curator's display name. Private ones are never returned
-- to anyone but their owner.
create or replace function public.public_collection(p_id uuid) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'id', c.id, 'name', c.name, 'description', c.description, 'is_private', c.is_private,
    'owner_name', p.name, 'mine', coalesce(c.owner_id = auth.uid(), false), 'updated_at', c.updated_at,
    'items', coalesce((select json_agg(i.artwork_id order by i.added_at desc)
                         from collection_items i join artworks a on a.id = i.artwork_id
                        where i.collection_id = c.id and not a.hidden), '[]'::json))
  from collections c join profiles p on p.id = c.owner_id
  where c.id = p_id and (not c.is_private or c.owner_id = auth.uid())
$$;
revoke all on function public.public_collection(uuid) from public;
grant execute on function public.public_collection(uuid) to anon, authenticated;

-- ——— 5. Community snapshot: artist profiles and artwork details too (still totals only) ———
create or replace function public.community_snapshot() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'reactions', coalesce((
      select json_agg(t) from (
        select artwork_id as a, kind as k, role as r, count(*)::int as n
        from reactions where kind in ('like', 'super') group by 1, 2, 3
      ) t), '[]'::json),
    'reviews', coalesce((
      select json_agg(t) from (
        select artwork_id as a, count(*)::int as n, sum(rating)::int as s from reviews group by 1
      ) t), '[]'::json),
    'follows', coalesce((
      select json_agg(t) from (
        select artist_id as a, role as r, count(*)::int as n from follows group by 1, 2
      ) t), '[]'::json),
    'ratings', coalesce((
      select json_agg(t) from (select artwork_id as a, rating as v from artwork_ratings) t
    ), '[]'::json),
    'members', (select count(*)::int from profiles),
    'artists', coalesce((
      select json_agg(t) from (
        select id, name, country, created_at, bio, statement, website, instagram, city, avatar_path
        from artists where owner_id is not null
      ) t), '[]'::json),
    'uploads', coalesce((
      select json_agg(t) from (
        select id, artist_id, title, category, style, medium, year, price,
               image_path, thumb_path, width, height, created_at, description, dimensions, availability
        from artworks where owner_id is not null and not hidden
        order by created_at desc limit 2000
      ) t), '[]'::json)
  )
$$;
grant execute on function public.community_snapshot() to anon, authenticated;
