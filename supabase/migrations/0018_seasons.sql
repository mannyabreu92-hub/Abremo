-- 0018: Seasons, Leagues and Streaks.
--   Seasons: the member boards (Top Discoverers, Collectors, Critics) counted within one calendar
--   month (UTC). On the 1st, last month's top 10 of each board is frozen into season_results and
--   becomes a permanent achievement, e.g. "Top 10 Discoverer · November 2026".
--   Leagues: the same boards filtered by country (as before) and now by medium.
--   Streaks: a daily Art Battle streak (at least one vote a UTC day; one missed day a week is
--   forgiven), with achievements at 7, 30 and 100 days.
-- Same rules as before: members who opted out stay hidden, your own work never counts, and plans
-- are never read.

-- ——— 1. The boards for any window, country and medium ———
-- A season counts the reactions and reviews made within it. Discovery credit for a like made in the
-- season comes from the weight that arrived after it, up to the season's end, so a past season's
-- standings don't keep moving. Internal: only member_leaderboards() and close_season() call it.
create or replace function public.season_boards(p_from timestamptz, p_to timestamptz, p_country text, p_medium text)
returns table (board text, user_id uuid, name text, country text, score integer, detail integer, rnk bigint, pos bigint)
language sql stable security definer set search_path = public as $$
  with
  base as (
    select r.user_id, r.artwork_id, r.kind, r.role, r.created_at
    from counted_reactions r join artworks a on a.id = r.artwork_id
    where (p_medium is null or a.category = p_medium) and (p_to is null or r.created_at < p_to)
  ),
  inwin as (select * from base where p_from is null or created_at >= p_from),
  contrib as (
    select user_id, role,
           sum(case kind when 'like' then role_weight(role) when 'super' then 2 * role_weight(role) else 0 end)::int as pts
    from inwin group by 1, 2
  ),
  review_pts as (
    select v.user_id, sum(2 * v.rating)::int as pts, count(*)::int as n
    from counted_reviews v join artworks a on a.id = v.artwork_id
    where (p_medium is null or a.category = p_medium)
      and (p_from is null or v.created_at >= p_from) and (p_to is null or v.created_at < p_to)
    group by 1
  ),
  ordered as (
    select user_id, created_at, role_weight(role) as w,
           coalesce(sum(role_weight(role)) over (partition by artwork_id order by created_at, user_id
             rows between unbounded preceding and 1 preceding), 0) as before_w,
           sum(role_weight(role)) over (partition by artwork_id) as total_w
    from base where kind in ('like', 'super')
  ),
  discovery as (
    select user_id, count(*)::int as n, sum(ln(1 + (total_w - before_w - w)) / (1 + before_w)) as raw
    from ordered where p_from is null or created_at >= p_from group by 1
  ),
  eligible as (
    select p.id, p.name, p.country, p.role
    from profiles p
    where (p.public_leaderboards or p.id = auth.uid())
      and (p_country is null or p.country = p_country)
  ),
  boards as (
    select 'collectors' as board, e.id, e.name, e.country, c.pts as score, c.pts as detail
    from eligible e join contrib c on c.user_id = e.id and c.role = 'collector'
    where e.role = 'collector' and c.pts > 0
    union all
    select 'critics', e.id, e.name, e.country,
           coalesce(c.pts, 0) + coalesce(rp.pts, 0), coalesce(rp.n, 0)
    from eligible e
    left join contrib c on c.user_id = e.id and c.role = 'critic'
    left join review_pts rp on rp.user_id = e.id
    where e.role = 'critic' and coalesce(c.pts, 0) + coalesce(rp.pts, 0) > 0
    union all
    select 'discoverers', e.id, e.name, e.country, round(100 * (1 - exp(-d.raw / 8)))::int, d.n
    from eligible e join discovery d on d.user_id = e.id
    where d.n >= 3
  )
  select b.board, b.id, b.name, b.country, b.score, b.detail,
         rank() over (partition by b.board order by b.score desc),
         row_number() over (partition by b.board order by b.score desc, b.name)
  from boards b
$$;
revoke all on function public.season_boards(timestamptz, timestamptz, text, text) from public, anon, authenticated;

-- ——— 2. member_leaderboards() gains a season (any day in the month) and a medium ———
drop function if exists public.member_leaderboards(text, integer);
create or replace function public.member_leaderboards(p_country text default null, p_limit integer default 50,
                                                      p_season date default null, p_medium text default null)
returns json
language sql stable security definer set search_path = public as $$
  with
  win as (
    select case when p_season is null then null else date_trunc('month', p_season::timestamp) at time zone 'utc' end as f
  ),
  ranked as (
    select s.* from win, season_boards(win.f, win.f + interval '1 month', p_country, nullif(p_medium, '')) s
  ),
  lim as (select greatest(1, least(coalesce(p_limit, 50), 100)) as n)
  select json_build_object(
    'collectors', coalesce((select json_agg(json_build_object('rank', rnk, 'name', name, 'country', country, 'score', score, 'detail', detail, 'me', coalesce(user_id = auth.uid(), false)) order by pos)
                            from ranked, lim where board = 'collectors' and rnk <= lim.n), '[]'::json),
    'critics', coalesce((select json_agg(json_build_object('rank', rnk, 'name', name, 'country', country, 'score', score, 'detail', detail, 'me', coalesce(user_id = auth.uid(), false)) order by pos)
                         from ranked, lim where board = 'critics' and rnk <= lim.n), '[]'::json),
    'discoverers', coalesce((select json_agg(json_build_object('rank', rnk, 'name', name, 'country', country, 'score', score, 'detail', detail, 'me', coalesce(user_id = auth.uid(), false)) order by pos)
                             from ranked, lim where board = 'discoverers' and rnk <= lim.n), '[]'::json),
    'me', coalesce((select json_object_agg(board, json_build_object('rank', rnk, 'score', score, 'detail', detail))
                    from ranked where user_id = auth.uid()), '{}'::json),
    'members', (select count(*)::int from profiles where public_leaderboards)
  )
$$;
revoke all on function public.member_leaderboards(text, integer, date, text) from public;
grant execute on function public.member_leaderboards(text, integer, date, text) to anon, authenticated;

-- ——— 3. Season archive: last month's top 10, frozen once, as permanent achievements ———
create table if not exists public.season_results (
  season date not null,
  board text not null check (board in ('discoverers', 'collectors', 'critics')),
  user_id uuid not null references public.profiles (id) on delete cascade,
  rank integer not null,
  score integer not null,
  frozen_at timestamptz not null default now(),
  primary key (season, board, user_id)
);
alter table public.season_results enable row level security;
drop policy if exists "read own season results" on public.season_results;
create policy "read own season results" on public.season_results for select using (user_id = auth.uid());
revoke all on public.season_results from anon, authenticated;
grant select on public.season_results to authenticated;

-- Freezes a finished month (worldwide, all media, public members only). Runs once per season;
-- calling it again changes nothing. Returns how many places were awarded.
create or replace function public.close_season(p_season date) returns integer
language plpgsql security definer set search_path = public as $$
declare
  m date := date_trunc('month', p_season)::date;
  f timestamptz := m::timestamp at time zone 'utc';
  month_name text := to_char(m, 'FMMonth YYYY');
  n integer;
begin
  if m >= date_trunc('month', now() at time zone 'utc')::date then
    raise exception 'That season hasn’t finished yet';
  end if;
  if exists (select 1 from season_results where season = m) then return 0; end if;
  insert into season_results (season, board, user_id, rank, score)
  select m, s.board, s.user_id, s.rnk, s.score
  from season_boards(f, f + interval '1 month', null, null) s
  join profiles p on p.id = s.user_id and p.public_leaderboards
  where s.rnk <= 10;
  get diagnostics n = row_count;
  insert into achievement_definitions (code, audience, label, criteria, sort)
  select 'season_' || to_char(m, 'YYYY_MM') || '_' || b.board, 'member',
         'Top 10 ' || b.title || ' · ' || month_name,
         'Finished in the top 10 ' || b.title || 's of ' || month_name || '.',
         1000 + b.ord
  from (values ('discoverers', 'Discoverer', 1), ('collectors', 'Collector', 2), ('critics', 'Critic', 3)) b(board, title, ord)
  where exists (select 1 from season_results r where r.season = m and r.board = b.board)
  on conflict (code) do nothing;
  insert into member_achievements (user_id, code, evidence)
  select r.user_id, 'season_' || to_char(m, 'YYYY_MM') || '_' || r.board,
         jsonb_build_object('season', m, 'board', r.board, 'rank', r.rank, 'score', r.score)
  from season_results r where r.season = m
  on conflict (user_id, code) do nothing;
  insert into notifications (user_id, kind, title, link)
  select r.user_id, 'season',
         'You finished No. ' || r.rank || ' among Top ' || initcap(r.board) || ' in ' || month_name, '#profile'
  from season_results r where r.season = m;
  return n;
end $$;
revoke all on function public.close_season(date) from public, anon, authenticated;

-- ——— 4. Art Battle streaks ———
-- At least one vote a UTC day keeps the streak; a single missed day is forgiven once every 7 days
-- (two missed days in a row, or a second miss within the week, end it). Today still counts as open.
-- Same rules as src/core/streak.js. Internal.
create or replace function public.battle_streak(p_user uuid) returns json
language plpgsql stable security definer set search_path = public as $$
declare
  today date := (now() at time zone 'utc')::date;
  days date[];
  d date;
  run integer := 0;
  best integer := 0;
  forgiven date;
begin
  days := array(select distinct (created_at at time zone 'utc')::date from battle_votes where user_id = p_user order by 1);
  if cardinality(days) = 0 then
    return json_build_object('current', 0, 'best', 0, 'today', false, 'grace_used', false);
  end if;
  for d in select g::date from generate_series(days[1], today, interval '1 day') g loop
    if d = any(days) then
      run := run + 1;
      best := greatest(best, run);
    elsif d = today then
      null;
    elsif run > 0 and (forgiven is null or d - forgiven >= 7) then
      forgiven := d;
    else
      run := 0;
      forgiven := null;
    end if;
  end loop;
  return json_build_object('current', run, 'best', best, 'today', today = any(days),
                           'grace_used', forgiven is not null and today - forgiven < 7);
end $$;
revoke all on function public.battle_streak(uuid) from public, anon, authenticated;

create or replace function public.my_battle_streak() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  return battle_streak(auth.uid());
end $$;
revoke all on function public.my_battle_streak() from public, anon;
grant execute on function public.my_battle_streak() to authenticated;

insert into public.achievement_definitions (code, audience, label, criteria, sort) values
  ('streak_7', 'member', 'Art Battle Streak · 7 days', 'Voted in the Art Battle 7 days running (one missed day a week is forgiven).', 70),
  ('streak_30', 'member', 'Art Battle Streak · 30 days', 'Voted in the Art Battle 30 days running (one missed day a week is forgiven).', 71),
  ('streak_100', 'member', 'Art Battle Streak · 100 days', 'Voted in the Art Battle 100 days running (one missed day a week is forgiven).', 72)
on conflict (code) do update set audience = excluded.audience, label = excluded.label, criteria = excluded.criteria, sort = excluded.sort;

-- Awards streak milestones as votes arrive (only on a member's first vote of the day).
create or replace function public.award_battle_streak() returns trigger
language plpgsql security definer set search_path = public as $$
declare best integer;
begin
  if exists (select 1 from battle_votes v where v.user_id = new.user_id and v.id <> new.id
               and (v.created_at at time zone 'utc')::date = (new.created_at at time zone 'utc')::date) then
    return null;
  end if;
  best := (battle_streak(new.user_id)->>'best')::int;
  insert into member_achievements (user_id, code, evidence)
  select new.user_id, m.code, jsonb_build_object('days', best)
  from (values (7, 'streak_7'), (30, 'streak_30'), (100, 'streak_100')) m(n, code)
  where best >= m.n
  on conflict (user_id, code) do nothing;
  return null;
end $$;
revoke all on function public.award_battle_streak() from public, anon, authenticated;
drop trigger if exists battle_streak_awards on public.battle_votes;
create trigger battle_streak_awards after insert on public.battle_votes
  for each row execute function public.award_battle_streak();

-- ——— 5. Schedule: freeze last month on the 1st at 00:23 UTC ———
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('abremi-season-close', '23 0 1 * *',
      'select public.close_season((date_trunc(''month'', now() at time zone ''utc'') - interval ''1 month'')::date);');
  end if;
exception when others then
  raise notice 'Schedule not set up (%). Seasons need pg_cron to be frozen each month.', sqlerrm;
end $$;
