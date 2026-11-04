-- Abremi Phase 3: Artist Studio analytics and weekly reports.
-- Adds only; undo with supabase/migrations/down/0009_down.sql.
--
-- Only metrics backed by recorded events are shown:
--   impressions (a work shown in a feed), artwork views, profile visits: recorded here;
--   likes, saves, follows: the existing rows (counted_* rules from 0007).
-- Each viewer counts once per work or page per day; artists' own views never count; members and
-- guests are counted separately (guests by an anonymous device key, so their numbers are approximate).
-- Artists only ever see totals for their own work, never who; countries with fewer than 3 people
-- are grouped as "Other". Analytics never affect rankings.

-- ——— Events ———
create table if not exists public.analytics_events (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('impression', 'artwork_view', 'profile_visit')),
  target_id text not null,
  artist_id text not null references public.artists (id) on delete cascade,
  artwork_id text references public.artworks (id) on delete cascade,
  viewer_id uuid references public.profiles (id) on delete set null,
  guest_key text check (guest_key is null or guest_key ~ '^[A-Za-z0-9-]{16,64}$'),
  viewer_role text,
  viewer_country text,
  day date not null default current_date,
  created_at timestamptz not null default now(),
  check (viewer_id is not null or guest_key is not null)
);
-- Once per viewer, target and day.
create unique index if not exists analytics_events_once_idx
  on public.analytics_events (kind, target_id, (coalesce(viewer_id::text, 'g:' || guest_key)), day);
create index if not exists analytics_events_artist_idx on public.analytics_events (artist_id, day);
create index if not exists analytics_events_viewer_idx on public.analytics_events (viewer_id, created_at) where viewer_id is not null;
create index if not exists analytics_events_guest_idx on public.analytics_events (guest_key, created_at) where guest_key is not null;
alter table public.analytics_events enable row level security;
revoke all on public.analytics_events from anon, authenticated;

-- Records a batch of up to 100 events: [{ "k": "impression" | "artwork_view" | "profile_visit", "t": target id }].
-- Signed-in members are identified by their account; guests by p_guest_key. Returns how many were new.
create or replace function public.record_events(p_events jsonb, p_guest_key text default null) returns integer
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  me public.profiles;
  recent integer;
  n integer;
begin
  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 100 then
    raise exception 'Send up to 100 events at a time' using errcode = '22023';
  end if;
  if uid is null and (p_guest_key is null or p_guest_key !~ '^[A-Za-z0-9-]{16,64}$') then
    return 0;
  end if;
  if uid is not null then
    select * into me from profiles where id = uid;
  end if;
  -- At most 2,000 events an hour per viewer; anything beyond is ignored.
  select count(*) into recent from analytics_events
   where created_at > now() - interval '1 hour'
     and (case when uid is not null then viewer_id = uid else viewer_id is null and guest_key = p_guest_key end);
  if recent >= 2000 then
    return 0;
  end if;
  with ev as (
    select distinct e->>'k' as kind, e->>'t' as target
    from jsonb_array_elements(p_events) e
    where e->>'k' in ('impression', 'artwork_view', 'profile_visit') and coalesce(e->>'t', '') <> ''
  ),
  resolved as (
    select ev.kind, ev.target, w.id as artwork_id, ar.id as artist_id, ar.owner_id
    from ev
    left join artworks w on ev.kind in ('impression', 'artwork_view') and w.id = ev.target and not w.hidden
    join artists ar on ar.id = case when ev.kind = 'profile_visit' then ev.target else w.artist_id end
  )
  insert into analytics_events (kind, target_id, artist_id, artwork_id, viewer_id, guest_key, viewer_role, viewer_country)
  select r.kind, r.target, r.artist_id, r.artwork_id, uid, case when uid is null then p_guest_key end, me.role, me.country
  from resolved r
  where r.owner_id is not null                -- only member artists have someone to report to
    and r.owner_id is distinct from uid       -- your own views never count
  limit greatest(0, 2000 - recent)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.record_events(jsonb, text) from public;
grant execute on function public.record_events(jsonb, text) to anon, authenticated;

-- ——— Summaries ———
-- One artist's totals for a period (internal: called only for the caller's own artist, or by the scheduler).
create or replace function public.artist_summary(p_artist text, p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = public as $$
  with ev as (
    select kind, viewer_id is not null as member from analytics_events
    where artist_id = p_artist and created_at >= p_from and created_at < p_to
  ),
  re as (
    select r.kind from counted_reactions r join artworks w on w.id = r.artwork_id
    where w.artist_id = p_artist and r.kind in ('like', 'super') and r.created_at >= p_from and r.created_at < p_to
  )
  select jsonb_build_object(
    'impressions', jsonb_build_object('members', count(*) filter (where kind = 'impression' and member), 'guests', count(*) filter (where kind = 'impression' and not member)),
    'views', jsonb_build_object('members', count(*) filter (where kind = 'artwork_view' and member), 'guests', count(*) filter (where kind = 'artwork_view' and not member)),
    'visits', jsonb_build_object('members', count(*) filter (where kind = 'profile_visit' and member), 'guests', count(*) filter (where kind = 'profile_visit' and not member)),
    'likes', (select count(*) from re where kind = 'like'),
    'saves', (select count(*) from re where kind = 'super'),
    'followers', (select count(*) from counted_follows f where f.artist_id = p_artist and f.created_at >= p_from and f.created_at < p_to)
  ) from ev
$$;
revoke all on function public.artist_summary(text, timestamptz, timestamptz) from public, anon, authenticated;

-- The caller's Studio for the last p_days (7, 30 or 90): totals vs the previous period, daily series,
-- per-work figures, and audience by role and country (members only; small countries grouped).
create or replace function public.studio_analytics(p_days integer default 30) returns json
language plpgsql stable security definer set search_path = public as $$
declare
  me_artist text;
  days integer := case when p_days in (7, 30, 90) then p_days else 30 end;
  t_to timestamptz := date_trunc('day', now()) + interval '1 day';
  t_from timestamptz := date_trunc('day', now()) + interval '1 day' - make_interval(days => days);
  t_prev timestamptz := date_trunc('day', now()) + interval '1 day' - make_interval(days => 2 * days);
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  select id into me_artist from artists where owner_id = auth.uid();
  if me_artist is null then
    return null;
  end if;
  return json_build_object(
    'artist', me_artist, 'days', days, 'from', t_from, 'to', t_to,
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
revoke all on function public.studio_analytics(integer) from public, anon;
grant execute on function public.studio_analytics(integer) to authenticated;

-- ——— Weekly reports ———
create table if not exists public.weekly_reports (
  user_id uuid not null references public.profiles (id) on delete cascade,
  week_start date not null,
  artist_id text not null references public.artists (id) on delete cascade,
  current jsonb not null,
  previous jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, week_start)
);
alter table public.weekly_reports enable row level security;
drop policy if exists "read own reports" on public.weekly_reports;
create policy "read own reports" on public.weekly_reports for select using (user_id = auth.uid());
revoke all on public.weekly_reports from anon, authenticated;
grant select on public.weekly_reports to authenticated;

-- Last week's report (Monday to Sunday, UTC) for every member artist who doesn't have it yet,
-- with an in-app notification. Also drops analytics events older than 400 days.
create or replace function public.generate_weekly_reports(p_user uuid default null) returns integer
language plpgsql security definer set search_path = public as $$
declare
  wk date := (date_trunc('week', now()) - interval '7 days')::date;
  n integer;
begin
  with made as (
    insert into weekly_reports (user_id, week_start, artist_id, current, previous)
    select ar.owner_id, wk, ar.id,
           artist_summary(ar.id, wk::timestamptz, (wk + 7)::timestamptz),
           artist_summary(ar.id, (wk - 7)::timestamptz, wk::timestamptz)
    from artists ar
    where ar.owner_id is not null and (p_user is null or ar.owner_id = p_user)
      and exists (select 1 from artworks w where w.artist_id = ar.id and w.created_at < (wk + 7)::timestamptz)
    on conflict (user_id, week_start) do nothing
    returning user_id
  )
  insert into notifications (user_id, kind, title, link)
  select user_id, 'weekly_report', 'Your weekly Studio report for ' || to_char(wk, 'Mon FMDD') || ' is ready', 'studio'
  from made;
  get diagnostics n = row_count;
  if p_user is null then
    delete from analytics_events where created_at < now() - interval '400 days';
  end if;
  return n;
end $$;
revoke all on function public.generate_weekly_reports(uuid) from public, anon, authenticated;

-- The caller's reports, newest first (making last week's first if the schedule hasn't yet).
create or replace function public.my_weekly_reports() returns setof public.weekly_reports
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  perform generate_weekly_reports(auth.uid());
  return query select * from weekly_reports where user_id = auth.uid() order by week_start desc limit 26;
end $$;
revoke all on function public.my_weekly_reports() from public, anon;
grant execute on function public.my_weekly_reports() to authenticated;

-- Mondays at 06:17 UTC where pg_cron is available.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('abremi-weekly-reports', '17 6 * * 1', 'select public.generate_weekly_reports();');
  end if;
exception when others then
  raise notice 'Schedule not set up (%). Reports are prepared when artists open their Studio instead.', sqlerrm;
end $$;
