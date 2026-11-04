-- Abremi Phase 6: subscription readiness, gallery accounts, beta tools.
--
--   1. Plans and entitlements. Artist Free, Pro, Elite and Gallery are defined here; the database
--      decides what each account gets (never the app). Payments stay OFF (app_settings) until the
--      product requirements, provider, taxes and refund policy are reviewed. Until then moderators
--      can grant a plan for a fixed period (audited), e.g. to beta testers.
--      Plans NEVER touch rankings: artwork_scores(), artist_scores(), the snapshot and the
--      leaderboards don't read them (tests/db.test.js checks this).
--   2. Plan-dependent limits: Coach requests, analytics range, upcoming drops, priority review.
--   3. Gallery accounts: members apply, moderators verify; verified galleries get a public page and,
--      on the Gallery plan, post Opportunities without review.
--   4. Beta: invite codes (optionally required for new sign-ups), in-app feedback, app error log.
--   5. Billing hooks for a future payment provider (service role only; inactive while payments are off).

-- ——— 0. Settings ———
create table if not exists public.app_settings (
  id boolean primary key default true check (id),
  invite_required boolean not null default false,
  payments_enabled boolean not null default false, -- switched on only in the SQL editor, after review
  updated_at timestamptz not null default now()
);
insert into public.app_settings (id) values (true) on conflict (id) do nothing;
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;

create or replace function public.app_flags() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('invite_required', invite_required, 'payments_enabled', payments_enabled) from app_settings
$$;

-- ——— 1. Plans and entitlements ———
create table if not exists public.plans (
  code text primary key check (code in ('free', 'pro', 'elite', 'gallery')),
  name text not null,
  audience text not null check (audience in ('artist', 'gallery')),
  coach_monthly integer not null check (coach_monthly between 0 and 1000),
  analytics_days integer not null check (analytics_days in (90, 365)),
  max_upcoming_drops integer not null check (max_upcoming_drops between 0 and 20),
  priority_review boolean not null default false,
  direct_opportunities boolean not null default false,
  badge text check (badge in ('Pro', 'Elite')),
  sort integer not null
);
-- Same values as src/core/plans.js (tests/db.test.js checks they agree). No prices: those are set
-- when payments are switched on.
insert into public.plans (code, name, audience, coach_monthly, analytics_days, max_upcoming_drops, priority_review, direct_opportunities, badge, sort) values
  ('free', 'Artist Free', 'artist', 20, 90, 1, false, false, null, 1),
  ('pro', 'Artist Pro', 'artist', 60, 365, 3, false, false, 'Pro', 2),
  ('elite', 'Artist Elite', 'artist', 150, 365, 3, true, false, 'Elite', 3),
  ('gallery', 'Gallery', 'gallery', 100, 90, 1, false, true, null, 4)
on conflict (code) do update set name = excluded.name, audience = excluded.audience, coach_monthly = excluded.coach_monthly,
  analytics_days = excluded.analytics_days, max_upcoming_drops = excluded.max_upcoming_drops, priority_review = excluded.priority_review,
  direct_opportunities = excluded.direct_opportunities, badge = excluded.badge, sort = excluded.sort;
alter table public.plans enable row level security;
drop policy if exists "plans are public" on public.plans;
create policy "plans are public" on public.plans for select using (true);
revoke all on public.plans from anon, authenticated;
grant select on public.plans to anon, authenticated;

-- One row per member: their current paid or granted plan. No row = Artist Free.
create table if not exists public.subscriptions (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  plan text not null references public.plans (code),
  status text not null check (status in ('active', 'trialing', 'past_due', 'canceled')),
  source text not null check (source in ('grant', 'billing')),
  current_period_end timestamptz,
  granted_by uuid references auth.users (id) on delete set null,
  note text check (char_length(coalesce(note, '')) <= 300),
  billing_customer text check (char_length(coalesce(billing_customer, '')) <= 100),
  billing_subscription text check (char_length(coalesce(billing_subscription, '')) <= 100),
  updated_at timestamptz not null default now(),
  check (source = 'billing' or current_period_end is not null) -- grants always end
);
alter table public.subscriptions enable row level security;
drop policy if exists "read own subscription" on public.subscriptions;
create policy "read own subscription" on public.subscriptions for select using (user_id = auth.uid());
revoke all on public.subscriptions from anon, authenticated;
grant select on public.subscriptions to authenticated;

-- The plan in force for a member right now (server-side only; never trusts the app).
create or replace function public.current_plan(p_user uuid) returns public.plans
language sql stable security definer set search_path = public as $$
  select p.* from plans p
  where p.code = coalesce((select s.plan from subscriptions s
                            where s.user_id = p_user and s.status in ('active', 'trialing', 'past_due')
                              and (s.current_period_end is null or s.current_period_end > now())), 'free')
$$;
revoke all on function public.current_plan(uuid) from public, anon, authenticated;

create or replace function public.my_plan() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'plan', row_to_json(p),
    'status', s.status, 'source', s.source, 'ends_at', s.current_period_end,
    'manage', s.source = 'billing' and s.billing_customer is not null)
  from current_plan(auth.uid()) p
  left join subscriptions s on s.user_id = auth.uid() and s.plan = p.code
  where auth.uid() is not null
$$;

-- Public badges (Pro, Elite) by artist id: display only, never used in any ranking.
create or replace function public.plan_badges() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_object_agg(ar.id, (current_plan(ar.owner_id)).badge), '{}'::json)
  from artists ar
  join subscriptions s on s.user_id = ar.owner_id
  where (current_plan(ar.owner_id)).badge is not null
$$;

-- Moderators find members by display name to grant a plan (no emails).
create or replace function public.admin_find_members(p_query text) returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return coalesce((select json_agg(x) from (
    select p.id, p.name, p.country, p.role, ar.id as artist_id, (current_plan(p.id)).code as plan,
           exists (select 1 from galleries g where g.owner_id = p.id and g.status = 'verified') as verified_gallery
    from profiles p left join artists ar on ar.owner_id = p.id
    where char_length(btrim(coalesce(p_query, ''))) >= 2
      and (p.name ilike '%' || btrim(p_query) || '%' or ar.name ilike '%' || btrim(p_query) || '%')
    order by p.name limit 20) x), '[]'::json);
end $$;

-- ——— 3. Gallery accounts (defined before the plan grants, which check them) ———
create table if not exists public.galleries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references public.profiles (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 120),
  city text not null check (char_length(btrim(city)) between 2 and 80),
  country text not null check (country ~ '^[A-Z]{2}$'),
  website text not null check (website ~ '^https://[^[:space:]<>"]+$' and char_length(website) <= 300),
  bio text not null default '' check (char_length(bio) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  review_note text check (char_length(coalesce(review_note, '')) <= 500),
  created_at timestamptz not null default now(),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz
);
alter table public.galleries enable row level security;
drop policy if exists "verified galleries are public" on public.galleries;
create policy "verified galleries are public" on public.galleries for select using (status = 'verified' or owner_id = auth.uid());
revoke all on public.galleries from anon, authenticated;
grant select on public.galleries to anon, authenticated;

alter table public.opportunities add column if not exists gallery_id uuid references public.galleries (id) on delete set null;

-- Apply (accounts 3+ days old), or re-apply after a decline. Editing a verified gallery keeps it
-- verified unless the name changes, which sends it back for review.
create or replace function public.apply_gallery(p_name text, p_city text, p_country text, p_website text, p_bio text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  g public.galleries;
begin
  if uid is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if (select created_at from profiles where id = uid) > now() - interval '3 days' then
    raise exception 'New accounts can apply for a gallery account after 3 days' using errcode = '42501';
  end if;
  select * into g from galleries where owner_id = uid;
  if g.id is null then
    insert into galleries (owner_id, name, city, country, website, bio)
    values (uid, btrim(p_name), btrim(p_city), upper(btrim(p_country)), btrim(p_website), btrim(coalesce(p_bio, '')))
    returning * into g;
  else
    update galleries set name = btrim(p_name), city = btrim(p_city), country = upper(btrim(p_country)), website = btrim(p_website),
           bio = btrim(coalesce(p_bio, '')),
           status = case when g.status = 'verified' and btrim(p_name) = g.name then 'verified' else 'pending' end,
           review_note = case when g.status = 'verified' and btrim(p_name) = g.name then g.review_note end
     where id = g.id returning * into g;
  end if;
  return g.id;
end $$;

create or replace function public.admin_gallery_queue() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return coalesce((select json_agg(json_build_object('id', g.id, 'name', g.name, 'city', g.city, 'country', g.country, 'website', g.website,
                                    'bio', g.bio, 'created_at', g.created_at, 'member', p.name, 'member_since', p.created_at) order by g.created_at)
                   from galleries g join profiles p on p.id = g.owner_id where g.status = 'pending'), '[]'::json);
end $$;

create or replace function public.review_gallery(p_id uuid, p_verify boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare g public.galleries;
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  update galleries set status = case when p_verify then 'verified' else 'rejected' end, review_note = nullif(btrim(coalesce(p_note, '')), ''),
         reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_id and status = 'pending' returning * into g;
  if g.id is null then
    raise exception 'That gallery is no longer pending' using errcode = 'P0001';
  end if;
  perform log_audit(case when p_verify then 'gallery.verified' else 'gallery.rejected' end, 'gallery', g.id::text,
                    jsonb_build_object('name', g.name, 'note', g.review_note));
  insert into notifications (user_id, kind, title, link)
  values (g.owner_id, 'gallery_review', case when p_verify then g.name || ' is now a verified gallery on Abremi'
                                             else g.name || ' couldn’t be verified' || coalesce(': ' || g.review_note, '') end,
          case when p_verify then 'gallery/' || g.id else 'profile' end);
end $$;

create or replace function public.gallery_page(p_id uuid) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'id', g.id, 'name', g.name, 'city', g.city, 'country', g.country, 'website', g.website, 'bio', g.bio, 'verified_at', g.reviewed_at,
    'opportunities', coalesce((select json_agg(json_build_object('id', o.id, 'kind', o.kind, 'title', o.title, 'location', o.location,
                                               'deadline', o.deadline, 'fee', o.fee, 'fee_currency', o.fee_currency, 'link', o.link) order by o.deadline)
                               from opportunities o where o.gallery_id = g.id and o.status = 'approved' and o.deadline >= current_date), '[]'::json))
  from galleries g where g.id = p_id and g.status = 'verified'
$$;

create or replace function public.my_gallery() returns json
language sql stable security definer set search_path = public as $$
  select row_to_json(g) from galleries g where g.owner_id = auth.uid()
$$;

-- Plan grants: moderators only, always with an end date, audited, and never over a paid plan.
create or replace function public.admin_grant_plan(p_user uuid, p_plan text, p_until date, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare cur public.subscriptions;
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  if p_plan not in ('pro', 'elite', 'gallery') then
    raise exception 'Choose Pro, Elite or Gallery' using errcode = '22023';
  end if;
  if p_until is null or p_until <= current_date or p_until > current_date + 366 then
    raise exception 'A grant ends between tomorrow and a year from now' using errcode = '22023';
  end if;
  if not exists (select 1 from profiles where id = p_user) then
    raise exception 'Member not found' using errcode = 'P0002';
  end if;
  if p_plan = 'gallery' and not exists (select 1 from galleries where owner_id = p_user and status = 'verified') then
    raise exception 'The Gallery plan is for verified galleries' using errcode = '22023';
  end if;
  select * into cur from subscriptions where user_id = p_user;
  if cur.source = 'billing' and cur.status in ('active', 'trialing', 'past_due') then
    raise exception 'This member has a paid subscription' using errcode = 'P0001';
  end if;
  insert into subscriptions (user_id, plan, status, source, current_period_end, granted_by, note, updated_at)
  values (p_user, p_plan, 'active', 'grant', p_until::timestamptz + interval '1 day', auth.uid(), nullif(btrim(coalesce(p_note, '')), ''), now())
  on conflict (user_id) do update set plan = excluded.plan, status = 'active', source = 'grant', current_period_end = excluded.current_period_end,
    granted_by = excluded.granted_by, note = excluded.note, billing_customer = null, billing_subscription = null, updated_at = now();
  perform log_audit('plan.granted', 'member', p_user::text, jsonb_build_object('plan', p_plan, 'until', p_until, 'note', p_note));
  insert into notifications (user_id, kind, title, link)
  values (p_user, 'plan_granted', 'You have ' || (select name from plans where code = p_plan) || ' until ' || to_char(p_until, 'Mon FMDD, YYYY'), 'plans');
end $$;

create or replace function public.admin_revoke_plan(p_user uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  delete from subscriptions where user_id = p_user and source = 'grant';
  if not found then
    raise exception 'No granted plan to remove' using errcode = 'P0001';
  end if;
  perform log_audit('plan.revoked', 'member', p_user::text, jsonb_build_object('note', p_note));
end $$;

create or replace function public.admin_plan_holders() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return coalesce((select json_agg(json_build_object('user_id', s.user_id, 'name', p.name, 'plan', s.plan, 'status', s.status, 'source', s.source,
                                    'ends_at', s.current_period_end, 'note', s.note) order by s.current_period_end nulls last)
                   from subscriptions s join profiles p on p.id = s.user_id
                   where s.current_period_end is null or s.current_period_end > now()), '[]'::json);
end $$;

-- ——— 2. Plan-dependent limits (replacing the 0009–0011 versions) ———
create or replace function public.coach_usage() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'used', (select count(*) from coach_requests where user_id = auth.uid() and status <> 'failed' and created_at >= date_trunc('month', now())),
    'limit', (current_plan(auth.uid())).coach_monthly,
    'plan', (current_plan(auth.uid())).name,
    'resets_at', date_trunc('month', now()) + interval '1 month')
$$;

-- Starts a Coach request: checks the limits (the plan's monthly requests, 400 a day overall) and
-- returns the grounding context. Failed requests (finish_coach_request(id, false)) don't count.
create or replace function public.begin_coach_request(p_tool text, p_artwork text default null, p_opportunity uuid default null) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  ar public.artists;
  w public.artworks;
  o public.opportunities;
  req uuid;
  since timestamptz := now() - interval '30 days';
  monthly integer;
begin
  if uid is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  select * into ar from artists where owner_id = uid;
  if ar.id is null then
    raise exception 'The Coach is for artists: publish a work first' using errcode = '42501';
  end if;
  if p_tool not in ('bio', 'statement', 'description', 'engagement', 'social', 'application') then
    raise exception 'Unknown Coach tool' using errcode = '22023';
  end if;
  monthly := (current_plan(uid)).coach_monthly;
  if (select count(*) from coach_requests where user_id = uid and status <> 'failed' and created_at >= date_trunc('month', now())) >= monthly then
    raise exception 'You’ve used this month’s % Coach requests. They reset on the 1st.', monthly using errcode = 'P0001';
  end if;
  if (select count(*) from coach_requests where status <> 'failed' and created_at > now() - interval '1 day') >= 400 then
    raise exception 'The Coach is busy today. Please try again tomorrow.' using errcode = 'P0001';
  end if;
  if p_tool in ('description', 'social') then
    select * into w from artworks where id = p_artwork and owner_id = uid;
    if w.id is null then
      raise exception 'Choose one of your own works' using errcode = '22023';
    end if;
  end if;
  if p_tool = 'application' then
    select * into o from opportunities where id = p_opportunity and status = 'approved';
    if o.id is null then
      raise exception 'Choose a listed opportunity' using errcode = '22023';
    end if;
  end if;
  insert into coach_requests (user_id, tool) values (uid, p_tool) returning id into req;
  return json_build_object(
    'request_id', req,
    'artist', json_build_object('name', ar.name, 'country', ar.country, 'city', ar.city, 'bio', ar.bio, 'statement', ar.statement,
                                'website', ar.website, 'joined', ar.created_at::date),
    'works', coalesce((select json_agg(json_build_object('id', x.id, 'title', x.title, 'medium', coalesce(x.medium, x.category), 'style', x.style,
                                       'year', x.year, 'dimensions', x.dimensions, 'availability', x.availability, 'description', x.description) order by x.created_at desc)
                       from (select * from artworks where owner_id = uid and not hidden order by created_at desc limit 30) x), '[]'::json),
    'artwork', case when w.id is not null then json_build_object('id', w.id, 'title', w.title, 'medium', coalesce(w.medium, w.category), 'style', w.style,
                    'year', w.year, 'dimensions', w.dimensions, 'description', w.description, 'thumb_path', w.thumb_path) end,
    'stats', case when p_tool = 'engagement' then json_build_object(
                    'last_30_days', artist_summary(ar.id, since, now()),
                    'previous_30_days', artist_summary(ar.id, since - interval '30 days', since),
                    'followers_total', (select count(*) from counted_follows where artist_id = ar.id)) end,
    'opportunity', case when o.id is not null then json_build_object('title', o.title, 'kind', o.kind, 'organizer', o.organizer, 'location', o.location,
                        'deadline', o.deadline, 'eligibility', o.eligibility, 'description', o.description) end,
    'achievements', coalesce((select json_agg(d.label) from member_achievements m join achievement_definitions d on d.code = m.code
                              where m.user_id = uid and d.audience = 'artist'), '[]'::json),
    'exhibitions', coalesce((select json_agg(json_build_object('title', e.title, 'venue', e.venue, 'year', extract(year from e.start_date)::int) order by e.start_date desc)
                             from exhibitions e where e.owner_id = uid and e.status = 'verified'), '[]'::json)
  );
end $$;

-- The caller's Studio for the last p_days: 7, 30 or 90 on every plan; 365 on plans that include it.
create or replace function public.studio_analytics(p_days integer default 30) returns json
language plpgsql stable security definer set search_path = public as $$
declare
  me_artist text;
  max_days integer := (current_plan(auth.uid())).analytics_days;
  days integer := case when p_days in (7, 30, 90, 365) then p_days else 30 end;
  t_to timestamptz;
  t_from timestamptz;
  t_prev timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if days > max_days then
    raise exception 'A year of analytics comes with Artist Pro and Elite' using errcode = '42501';
  end if;
  t_to := date_trunc('day', now()) + interval '1 day';
  t_from := t_to - make_interval(days => days);
  t_prev := t_to - make_interval(days => 2 * days);
  select id into me_artist from artists where owner_id = auth.uid();
  if me_artist is null then
    return null;
  end if;
  return json_build_object(
    'artist', me_artist, 'days', days, 'max_days', max_days, 'from', t_from, 'to', t_to,
    'current', artist_summary(me_artist, t_from, t_to),
    'previous', artist_summary(me_artist, t_prev, t_from),
    'followers_total', (select count(*) from counted_follows where artist_id = me_artist),
    'daily', (
      select json_agg(json_build_object(
        'day', d::date,
        'impressions', (select count(*) from analytics_events e where e.artist_id = me_artist and e.kind = 'impression' and e.day = d::date),
        'views', (select count(*) from analytics_events e where e.artist_id = me_artist and e.kind = 'artwork_view' and e.day = d::date),
        'visits', (select count(*) from analytics_events e where e.artist_id = me_artist and e.kind = 'profile_visit' and e.day = d::date),
        'likes', (select count(*) from counted_reactions r join artworks w on w.id = r.artwork_id
                   where w.artist_id = me_artist and r.kind in ('like', 'super') and r.created_at >= d and r.created_at < d + interval '1 day'),
        'followers', (select count(*) from counted_follows f where f.artist_id = me_artist and f.created_at < d + interval '1 day')
      ) order by d)
      from generate_series(t_from, t_to - interval '1 day', interval '1 day') d
    ),
    'works', coalesce((
      select json_agg(x order by x.views desc, x.likes desc) from (
        select w.id, w.title,
          (select count(*) from analytics_events e where e.artwork_id = w.id and e.kind = 'impression' and e.created_at >= t_from)::int as impressions,
          (select count(*) from analytics_events e where e.artwork_id = w.id and e.kind = 'artwork_view' and e.created_at >= t_from)::int as views,
          (select count(*) from counted_reactions r where r.artwork_id = w.id and r.kind = 'like' and r.created_at >= t_from)::int as likes,
          (select count(*) from counted_reactions r where r.artwork_id = w.id and r.kind = 'super' and r.created_at >= t_from)::int as saves
        from artworks w where w.artist_id = me_artist
      ) x), '[]'::json),
    'roles', coalesce((
      select json_object_agg(role, n) from (
        select role, count(distinct user_id) as n from (
          select r.user_id, r.role from counted_reactions r join artworks w on w.id = r.artwork_id
            where w.artist_id = me_artist and r.kind in ('like', 'super') and r.created_at >= t_from
          union all
          select f.user_id, f.role from counted_follows f where f.artist_id = me_artist and f.created_at >= t_from
        ) a group by role
      ) g), '{}'::json),
    'countries', coalesce((
      select json_agg(json_build_object('country', country, 'people', people) order by people desc, country) from (
        select case when n >= 3 then country else 'Other' end as country, sum(n)::int as people from (
          select p.country, count(*) as n from profiles p
          where p.id in (
            select r.user_id from counted_reactions r join artworks w on w.id = r.artwork_id
              where w.artist_id = me_artist and r.kind in ('like', 'super') and r.created_at >= t_from
            union select f.user_id from counted_follows f where f.artist_id = me_artist and f.created_at >= t_from
            union select e.viewer_id from analytics_events e where e.artist_id = me_artist and e.viewer_id is not null and e.created_at >= t_from)
          group by p.country
        ) c group by 1
      ) g), '[]'::json)
  );
end $$;

create or replace function public.create_drop(p_title text, p_description text, p_release_at timestamptz, p_artworks text[], p_teaser text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  ar public.artists;
  d public.drops;
  max_upcoming integer;
begin
  select * into ar from artists where owner_id = uid;
  if uid is null or ar.id is null then
    raise exception 'Publish a work first' using errcode = '42501';
  end if;
  if p_release_at < now() + interval '10 minutes' or p_release_at > now() + interval '60 days' then
    raise exception 'Release between 10 minutes and 60 days from now' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_artworks), 0) not between 1 and 12 then
    raise exception 'A drop has 1 to 12 works' using errcode = '22023';
  end if;
  if (select count(*) from artworks where id = any (p_artworks) and owner_id = uid and not hidden
        and (drop_id is null or drop_id in (select id from drops where released_at is not null or cancelled_at is not null))) <> cardinality(p_artworks) then
    raise exception 'A drop can include only your own works that aren’t in another upcoming drop' using errcode = '42501';
  end if;
  if p_teaser is not null and not (p_teaser = any (p_artworks)) then
    raise exception 'The preview must be one of the drop’s works' using errcode = '22023';
  end if;
  max_upcoming := (current_plan(uid)).max_upcoming_drops;
  if (select count(*) from drops where owner_id = uid and released_at is null and cancelled_at is null) >= max_upcoming then
    raise exception 'Your plan allows % upcoming drop% at a time', max_upcoming, case when max_upcoming = 1 then '' else 's' end using errcode = 'P0001';
  end if;
  insert into drops (artist_id, owner_id, title, description, release_at, teaser_artwork)
  values (ar.id, uid, btrim(p_title), btrim(coalesce(p_description, '')), p_release_at, coalesce(p_teaser, p_artworks[1]))
  returning * into d;
  update artworks set drop_id = d.id, release_at = d.release_at where id = any (p_artworks);
  insert into notifications (user_id, kind, title, link)
  select f.user_id, 'drop_announced', ar.name || ' announced a drop: “' || d.title || '”', 'drop/' || d.id
  from counted_follows f where f.artist_id = ar.id;
  return d.id;
end $$;

-- Elite artists' exhibitions are reviewed first (order only; the checks are the same).
create or replace function public.admin_exhibition_queue() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return coalesce((select json_agg(json_build_object('id', x.id, 'artist', x.artist, 'artist_id', x.artist_id, 'kind', x.kind, 'title', x.title,
                                    'venue', x.venue, 'city', x.city, 'country', x.country, 'start_date', x.start_date, 'end_date', x.end_date,
                                    'link', x.link, 'created_at', x.created_at, 'priority', x.priority) order by x.priority desc, x.created_at)
                   from (select e.*, ar.name as artist, (current_plan(e.owner_id)).priority_review as priority
                         from exhibitions e join artists ar on ar.id = e.artist_id where e.status = 'pending') x), '[]'::json);
end $$;

-- Opportunities: moderators publish directly; verified galleries on the Gallery plan publish directly
-- (10 a day, audited); everyone else's suggestion waits for review (accounts 3+ days old, 5 a day).
create or replace function public.suggest_opportunity(p_kind text, p_title text, p_organizer text, p_location text, p_deadline date,
                                                      p_eligibility text, p_description text, p_fee numeric, p_fee_currency text, p_link text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  admin boolean := is_admin();
  gal public.galleries;
  direct boolean;
  daily integer;
  new_id uuid;
begin
  if uid is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  select * into gal from galleries where owner_id = uid and status = 'verified';
  direct := admin or (gal.id is not null and (current_plan(uid)).direct_opportunities);
  if not admin and gal.id is null and (select created_at from profiles where id = uid) > now() - interval '3 days' then
    raise exception 'New accounts can suggest opportunities after 3 days' using errcode = '42501';
  end if;
  daily := case when direct then 10 else 5 end;
  if not admin and (select count(*) from opportunities where submitted_by = uid and created_at > now() - interval '1 day') >= daily then
    raise exception 'You can post % opportunities a day', daily using errcode = 'P0001';
  end if;
  if p_deadline < current_date then
    raise exception 'The deadline has passed' using errcode = '22023';
  end if;
  insert into opportunities (kind, title, organizer, location, deadline, eligibility, description, fee, fee_currency, link, status, submitted_by,
                             reviewed_by, reviewed_at, gallery_id)
  values (p_kind, btrim(p_title), case when gal.id is not null then gal.name else btrim(p_organizer) end, btrim(p_location), p_deadline,
          btrim(coalesce(p_eligibility, '')), btrim(coalesce(p_description, '')),
          coalesce(p_fee, 0), upper(coalesce(nullif(p_fee_currency, ''), 'USD')), btrim(p_link),
          case when direct then 'approved' else 'pending' end, uid, case when direct then uid end, case when direct then now() end, gal.id)
  returning opportunities.id into new_id;
  if direct then
    perform log_audit(case when admin then 'opportunity.published' else 'opportunity.published_by_gallery' end, 'opportunity', new_id::text,
                      jsonb_build_object('title', p_title, 'gallery', gal.name));
  end if;
  return new_id;
end $$;

create or replace function public.opportunities_list() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object(
    'id', o.id, 'kind', o.kind, 'title', o.title, 'organizer', o.organizer, 'location', o.location, 'deadline', o.deadline,
    'eligibility', o.eligibility, 'description', o.description, 'fee', o.fee, 'fee_currency', o.fee_currency, 'link', o.link,
    'gallery_id', g.id,
    'saved', exists (select 1 from saved_opportunities s where s.opportunity_id = o.id and s.user_id = auth.uid())
  ) order by o.deadline, o.title), '[]'::json)
  from opportunities o left join galleries g on g.id = o.gallery_id and g.status = 'verified'
  where o.status = 'approved' and o.deadline >= current_date
$$;

-- ——— 4. Beta: invite codes, feedback, app errors ———
create table if not exists public.invite_codes (
  code text primary key check (code ~ '^[A-Z0-9]{10}$'),
  created_by uuid references auth.users (id) on delete set null,
  max_uses integer not null check (max_uses between 1 and 500),
  uses integer not null default 0 check (uses >= 0),
  expires_at timestamptz,
  note text check (char_length(coalesce(note, '')) <= 200),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.invite_codes enable row level security;
revoke all on public.invite_codes from anon, authenticated;

create table if not exists public.invite_redemptions (
  code text not null references public.invite_codes (code) on delete cascade,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (code, user_id)
);
alter table public.invite_redemptions enable row level security;
revoke all on public.invite_redemptions from anon, authenticated;

-- While invites are required, a new account needs a valid code in its sign-up metadata
-- (signInWithOtp options.data.invite). Existing members sign in as usual.
create or replace function public.guard_invite() returns trigger
language plpgsql security definer set search_path = public as $$
declare c text := upper(btrim(coalesce(new.raw_user_meta_data->>'invite', '')));
begin
  if not coalesce((select invite_required from app_settings), false) then
    return new;
  end if;
  update invite_codes set uses = uses + 1
   where code = c and revoked_at is null and uses < max_uses and (expires_at is null or expires_at > now());
  if not found then
    raise exception 'Abremi is invite-only right now: a valid invite code is needed to join' using errcode = '42501';
  end if;
  insert into invite_redemptions (code, user_id) values (c, new.id) on conflict do nothing;
  return new;
end $$;
revoke all on function public.guard_invite() from public, anon, authenticated;
drop trigger if exists abremi_guard_invite on auth.users;
create trigger abremi_guard_invite before insert on auth.users for each row execute function public.guard_invite();

-- Lets the sign-in form say whether a code works before an email is sent. Reveals only yes/no.
create or replace function public.check_invite(p_code text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from invite_codes where code = upper(btrim(coalesce(p_code, ''))) and revoked_at is null
                 and uses < max_uses and (expires_at is null or expires_at > now()))
$$;

create or replace function public.admin_create_invite(p_max_uses integer, p_days integer default 30, p_note text default null) returns text
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  if p_days is not null and p_days not between 1 and 365 then
    raise exception 'Codes last 1 to 365 days' using errcode = '22023';
  end if;
  -- 10 characters from an alphabet without look-alikes (no 0/O, 1/I/L), each from a fresh random UUID.
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + get_byte(decode(md5(gen_random_uuid()::text), 'hex'), 0) % 31, 1), '')
    into c from generate_series(1, 10);
  insert into invite_codes (code, created_by, max_uses, expires_at, note)
  values (c, auth.uid(), p_max_uses, case when p_days is not null then now() + make_interval(days => p_days) end, nullif(btrim(coalesce(p_note, '')), ''));
  perform log_audit('invite.created', 'invite', c, jsonb_build_object('max_uses', p_max_uses, 'days', p_days, 'note', p_note));
  return c;
end $$;

create or replace function public.admin_invites() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return json_build_object(
    'invite_required', (select invite_required from app_settings),
    'codes', coalesce((select json_agg(json_build_object('code', code, 'max_uses', max_uses, 'uses', uses, 'expires_at', expires_at, 'note', note,
                                        'revoked', revoked_at is not null, 'created_at', created_at) order by created_at desc)
                       from invite_codes), '[]'::json));
end $$;

create or replace function public.admin_revoke_invite(p_code text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  update invite_codes set revoked_at = now() where code = p_code and revoked_at is null;
  if found then
    perform log_audit('invite.revoked', 'invite', p_code, '{}'::jsonb);
  end if;
end $$;

create or replace function public.admin_set_invite_required(p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  update app_settings set invite_required = p_on, updated_at = now();
  perform log_audit(case when p_on then 'beta.invites_required' else 'beta.invites_optional' end, 'settings', 'invite_required', '{}'::jsonb);
end $$;

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id) on delete set null,
  kind text not null check (kind in ('bug', 'idea', 'other')),
  message text not null check (char_length(btrim(message)) between 5 and 2000),
  page text check (char_length(coalesce(page, '')) <= 200),
  user_agent text check (char_length(coalesce(user_agent, '')) <= 300),
  status text not null default 'open' check (status in ('open', 'resolved')),
  note text check (char_length(coalesce(note, '')) <= 500),
  created_at timestamptz not null default now(),
  resolved_by uuid references auth.users (id) on delete set null,
  resolved_at timestamptz
);
alter table public.feedback enable row level security;
drop policy if exists "read own feedback" on public.feedback;
create policy "read own feedback" on public.feedback for select using (user_id = auth.uid());
revoke all on public.feedback from anon, authenticated;
grant select on public.feedback to authenticated;

create or replace function public.submit_feedback(p_kind text, p_message text, p_page text default null, p_user_agent text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if (select count(*) from feedback where user_id = auth.uid() and created_at > now() - interval '1 day') >= 10 then
    raise exception 'You can send 10 notes a day. Thank you!' using errcode = 'P0001';
  end if;
  insert into feedback (user_id, kind, message, page, user_agent)
  values (auth.uid(), p_kind, btrim(p_message), left(p_page, 200), left(p_user_agent, 300))
  returning id into new_id;
  return new_id;
end $$;

create or replace function public.admin_feedback(p_status text default 'open') returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return coalesce((select json_agg(json_build_object('id', f.id, 'kind', f.kind, 'message', f.message, 'page', f.page, 'user_agent', f.user_agent,
                                    'member', p.name, 'created_at', f.created_at, 'status', f.status, 'note', f.note) order by f.created_at desc)
                   from (select * from feedback where status = coalesce(p_status, 'open') order by created_at desc limit 200) f
                   left join profiles p on p.id = f.user_id), '[]'::json);
end $$;

create or replace function public.resolve_feedback(p_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  update feedback set status = 'resolved', note = nullif(btrim(coalesce(p_note, '')), ''), resolved_by = auth.uid(), resolved_at = now()
   where id = p_id and status = 'open';
  if not found then
    raise exception 'That note is already resolved' using errcode = 'P0001';
  end if;
end $$;

-- App errors: what broke and where, with no account, IP or personal data. Capped so it can't be flooded.
create table if not exists public.client_errors (
  id bigint generated always as identity primary key,
  message text not null,
  source text,
  page text,
  release text,
  user_agent text,
  signed_in boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists client_errors_time_idx on public.client_errors (created_at);
alter table public.client_errors enable row level security;
revoke all on public.client_errors from anon, authenticated;

create or replace function public.log_client_error(p_message text, p_source text default null, p_page text default null,
                                                   p_release text default null, p_user_agent text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(btrim(p_message), '') = '' then
    return;
  end if;
  if (select count(*) from client_errors where created_at > now() - interval '1 hour') >= 500 then
    return; -- quietly drop the excess
  end if;
  insert into client_errors (message, source, page, release, user_agent, signed_in)
  values (left(btrim(p_message), 500), left(p_source, 300), left(regexp_replace(coalesce(p_page, ''), '[?].*$', ''), 200), left(p_release, 40),
          left(p_user_agent, 300), auth.uid() is not null);
end $$;

create or replace function public.admin_client_errors(p_days integer default 7) returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return coalesce((select json_agg(x order by x.last_seen desc) from (
    select message, source, count(*)::int as count, max(created_at) as last_seen, min(created_at) as first_seen,
           array_agg(distinct release) filter (where release is not null) as releases,
           array_agg(distinct page) filter (where page is not null and page <> '') as pages
    from client_errors where created_at > now() - make_interval(days => least(greatest(coalesce(p_days, 7), 1), 30))
    group by message, source order by max(created_at) desc limit 100) x), '[]'::json);
end $$;

create or replace function public.prune_client_errors() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from client_errors where created_at < now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.prune_client_errors() from public, anon, authenticated;

-- ——— 5. Billing hooks (inactive while payments are off) ———
-- The billing server function (api/stripe-webhook.js) calls apply_billing_event() with the service
-- role. Events are applied once (by id), and only while payments are switched on.
create table if not exists public.billing_events (
  id text primary key check (char_length(id) <= 100),
  user_id uuid,
  kind text,
  created_at timestamptz not null default now()
);
alter table public.billing_events enable row level security;
revoke all on public.billing_events from anon, authenticated;

create or replace function public.apply_billing_event(p_event_id text, p_kind text, p_user uuid, p_plan text, p_status text,
                                                      p_period_end timestamptz, p_customer text, p_subscription text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if not (select payments_enabled from app_settings) then
    raise exception 'Payments are switched off' using errcode = '42501';
  end if;
  insert into billing_events (id, user_id, kind) values (p_event_id, p_user, p_kind) on conflict (id) do nothing;
  if not found then
    return 'duplicate';
  end if;
  if not exists (select 1 from profiles where id = p_user) then
    return 'unknown member';
  end if;
  if p_plan not in ('pro', 'elite', 'gallery') or p_status not in ('active', 'trialing', 'past_due', 'canceled') then
    raise exception 'Unknown plan or status' using errcode = '22023';
  end if;
  if p_plan = 'gallery' and not exists (select 1 from galleries where owner_id = p_user and status = 'verified') then
    return 'not a verified gallery';
  end if;
  insert into subscriptions (user_id, plan, status, source, current_period_end, billing_customer, billing_subscription, updated_at)
  values (p_user, p_plan, p_status, 'billing', p_period_end, p_customer, p_subscription, now())
  on conflict (user_id) do update set plan = excluded.plan, status = excluded.status, source = 'billing',
    current_period_end = excluded.current_period_end, billing_customer = coalesce(excluded.billing_customer, subscriptions.billing_customer),
    billing_subscription = coalesce(excluded.billing_subscription, subscriptions.billing_subscription), granted_by = null, note = null, updated_at = now()
  where subscriptions.source = 'grant' or subscriptions.billing_subscription is null or subscriptions.billing_subscription = excluded.billing_subscription;
  perform log_audit('plan.billing_' || p_status, 'member', p_user::text, jsonb_build_object('plan', p_plan, 'event', p_event_id));
  return 'applied';
end $$;
revoke all on function public.apply_billing_event(text, text, uuid, text, text, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.apply_billing_event(text, text, uuid, text, text, timestamptz, text, text) to service_role;

-- ——— Grants ———
do $$
declare f text;
begin
  foreach f in array array[
    'my_plan()', 'admin_find_members(text)', 'apply_gallery(text, text, text, text, text)', 'admin_gallery_queue()',
    'review_gallery(uuid, boolean, text)', 'my_gallery()', 'admin_grant_plan(uuid, text, date, text)', 'admin_revoke_plan(uuid, text)',
    'admin_plan_holders()', 'coach_usage()', 'begin_coach_request(text, text, uuid)', 'studio_analytics(integer)',
    'create_drop(text, text, timestamptz, text[], text)', 'admin_exhibition_queue()',
    'suggest_opportunity(text, text, text, text, date, text, text, numeric, text, text)',
    'admin_create_invite(integer, integer, text)', 'admin_invites()', 'admin_revoke_invite(text)', 'admin_set_invite_required(boolean)',
    'submit_feedback(text, text, text, text)', 'admin_feedback(text)', 'resolve_feedback(uuid, text)', 'admin_client_errors(integer)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['app_flags()', 'plan_badges()', 'gallery_page(uuid)', 'opportunities_list()', 'check_invite(text)',
                           'log_client_error(text, text, text, text, text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;

-- App errors older than 30 days are deleted daily where pg_cron is available.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('abremi-prune-client-errors', '41 3 * * *', 'select public.prune_client_errors();');
  end if;
exception when others then
  raise notice 'Schedule not set up (%). Old app errors need pg_cron to be pruned.', sqlerrm;
end $$;
