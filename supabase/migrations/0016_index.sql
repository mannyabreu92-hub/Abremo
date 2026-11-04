-- The Abremi Index: a weekly public chart of real member artists and works.
--
-- Each Monday the past 7 days are frozen into a citable chart: overall, per medium and per artist
-- country. A work's score is its admirations (+1 × role weight) and treasures (+2 × role weight)
-- from that week, counted the same way as the rankings (your own activity and excluded bursts never
-- count). An artist's score is the sum of their works' scores. Sample works and artists are never
-- included, and plans are never read (tests/db.test.js checks this).

create table if not exists public.index_weeks (
  week date primary key,                 -- the Monday the week ended (the chart covers the 7 days before)
  published_at timestamptz not null default now()
);
create table if not exists public.index_entries (
  week date not null references public.index_weeks (week) on delete cascade,
  chart text not null check (chart ~ '^(overall|medium:[a-z]{2,20}|country:[A-Z]{2})$'),
  kind text not null check (kind in ('artwork', 'artist')),
  rank integer not null check (rank between 1 and 100),
  target text not null,
  score integer not null,
  primary key (week, chart, kind, rank)
);
create index if not exists index_entries_target_idx on public.index_entries (target, week);
alter table public.index_weeks enable row level security;
alter table public.index_entries enable row level security;
drop policy if exists "the index is public" on public.index_weeks;
create policy "the index is public" on public.index_weeks for select using (true);
drop policy if exists "the index is public" on public.index_entries;
create policy "the index is public" on public.index_entries for select using (true);
revoke all on public.index_weeks, public.index_entries from anon, authenticated;
grant select on public.index_weeks, public.index_entries to anon, authenticated;

-- Freezes the chart for the week ending on p_week (a Monday). Safe to run again: it replaces it.
create or replace function public.compute_index(p_week date) returns integer
language plpgsql security definer set search_path = public as $$
declare
  t_to timestamptz := p_week::timestamptz;
  t_from timestamptz := p_week::timestamptz - interval '7 days';
  n integer;
begin
  delete from index_weeks where week = p_week;
  insert into index_weeks (week) values (p_week);
  create temporary table if not exists _index_works (artwork_id text, artist_id text, category text, country text, score integer) on commit drop;
  truncate _index_works;
  insert into _index_works
  select w.id, w.artist_id, w.category, ar.country,
         sum(case r.kind when 'like' then role_weight(r.role) when 'super' then 2 * role_weight(r.role) else 0 end)::int
  from counted_reactions r
  join artworks w on w.id = r.artwork_id
  join artists ar on ar.id = w.artist_id
  where r.kind in ('like', 'super') and r.created_at >= t_from and r.created_at < t_to
    and w.owner_id is not null and ar.owner_id is not null and not w.hidden and (w.release_at is null or w.release_at <= t_to)
  group by w.id, w.artist_id, w.category, ar.country
  having sum(case r.kind when 'like' then role_weight(r.role) when 'super' then 2 * role_weight(r.role) else 0 end) > 0;

  -- Works: overall, by medium, by artist country. Ties broken by id, so the chart is stable.
  insert into index_entries (week, chart, kind, rank, target, score)
  select p_week, chart, 'artwork', rk, artwork_id, score from (
    select c.chart, x.artwork_id, x.score, row_number() over (partition by c.chart order by x.score desc, x.artwork_id) as rk
    from _index_works x
    cross join lateral (values ('overall'), ('medium:' || x.category), ('country:' || x.country)) c(chart)
    where c.chart ~ '^(overall|medium:[a-z]{2,20}|country:[A-Z]{2})$'
  ) s where rk <= 100;
  -- Artists: the sum of their works' scores.
  insert into index_entries (week, chart, kind, rank, target, score)
  select p_week, chart, 'artist', rk, artist_id, score from (
    select c.chart, a.artist_id, a.score, row_number() over (partition by c.chart order by a.score desc, a.artist_id) as rk
    from (select artist_id, country, sum(score)::int as score, (array_agg(category order by score desc))[1] as category
          from _index_works group by artist_id, country) a
    cross join lateral (values ('overall'), ('medium:' || a.category), ('country:' || a.country)) c(chart)
    where c.chart ~ '^(overall|medium:[a-z]{2,20}|country:[A-Z]{2})$'
  ) s where rk <= 100;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.compute_index(date) from public, anon, authenticated;

-- One week's chart (the latest by default), with the list of weeks and charts available.
create or replace function public.index_week(p_week date default null, p_chart text default 'overall') returns json
language sql stable security definer set search_path = public as $$
  with wk as (select coalesce(p_week, (select max(week) from index_weeks)) as week)
  select json_build_object(
    'week', (select week from wk),
    'covers_from', (select week - 7 from wk),
    'chart', p_chart,
    'weeks', coalesce((select json_agg(week order by week desc) from (select week from index_weeks order by week desc limit 52) w), '[]'::json),
    'charts', coalesce((select json_agg(distinct chart) from index_entries where week = (select week from wk)), '[]'::json),
    'artworks', coalesce((select json_agg(json_build_object('rank', e.rank, 'id', e.target, 'title', w.title, 'artist_id', w.artist_id, 'artist', ar.name, 'score', e.score) order by e.rank)
                          from index_entries e join artworks w on w.id = e.target join artists ar on ar.id = w.artist_id
                          where e.week = (select week from wk) and e.chart = p_chart and e.kind = 'artwork' and not w.hidden), '[]'::json),
    'artists', coalesce((select json_agg(json_build_object('rank', e.rank, 'id', e.target, 'name', ar.name, 'country', ar.country, 'score', e.score) order by e.rank)
                         from index_entries e join artists ar on ar.id = e.target
                         where e.week = (select week from wk) and e.chart = p_chart and e.kind = 'artist'), '[]'::json))
$$;

-- An artist's best place in the latest Index (for the badge), or null.
create or replace function public.artist_index_badge(p_artist text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('week', e.week, 'covers_from', e.week - 7, 'chart', e.chart, 'rank', e.rank, 'name', ar.name)
  from index_entries e join artists ar on ar.id = e.target
  where e.kind = 'artist' and e.target = p_artist and e.week = (select max(week) from index_weeks)
  order by e.rank, case when e.chart = 'overall' then 0 when e.chart like 'medium:%' then 1 else 2 end
  limit 1
$$;

-- Moderators can publish the current week early (for the first Index, or after fixing a burst).
create or replace function public.admin_publish_index() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  n := compute_index(date_trunc('week', now())::date);
  perform log_audit('index.published', 'index', date_trunc('week', now())::date::text, jsonb_build_object('entries', n));
  return n;
end $$;

do $$
declare f text;
begin
  foreach f in array array['index_week(date, text)', 'artist_index_badge(text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  revoke all on function public.admin_publish_index() from public, anon;
  grant execute on function public.admin_publish_index() to authenticated;
end $$;

-- Every Monday at 00:17 UTC; and once now, so the first Index exists.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('abremi-weekly-index', '17 0 * * 1', 'select public.compute_index(date_trunc(''week'', now())::date);');
  end if;
exception when others then
  raise notice 'Schedule not set up (%). The weekly Index needs pg_cron, or a moderator can publish it.', sqlerrm;
end $$;
select public.compute_index(date_trunc('week', now())::date);
