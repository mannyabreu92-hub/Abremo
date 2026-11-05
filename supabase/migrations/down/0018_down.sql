-- Undo for 0018_seasons.sql: removes seasons (and their frozen results and achievements), medium
-- leagues and Art Battle streaks, and restores member_leaderboards() from 0007. Run it before
-- down/0017_down.sql if undoing several.
begin;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then perform cron.unschedule('abremi-season-close'); end if;
exception when others then null;
end $$;
drop trigger if exists battle_streak_awards on public.battle_votes;
drop function if exists public.award_battle_streak();
drop function if exists public.my_battle_streak();
drop function if exists public.battle_streak(uuid);
drop function if exists public.close_season(date);
drop function if exists public.member_leaderboards(text, integer, date, text);
drop function if exists public.season_boards(timestamptz, timestamptz, text, text);
drop table if exists public.season_results;
delete from public.achievement_definitions where code like 'season\_%' or code in ('streak_7', 'streak_30', 'streak_100');
delete from public.notifications where kind = 'season';

-- member_leaderboards() as in 0007
create or replace function public.member_leaderboards(p_country text default null, p_limit integer default 50)
returns json
language sql stable security definer set search_path = public as $$
  with
  contrib as (
    select user_id, role,
           sum(case kind when 'like' then role_weight(role) when 'super' then 2 * role_weight(role) else 0 end)::int as pts
    from counted_reactions group by 1, 2
  ),
  review_pts as (
    select user_id, sum(2 * rating)::int as pts, count(*)::int as n from counted_reviews group by 1
  ),
  ordered as (
    select user_id, role_weight(role) as w,
           coalesce(sum(role_weight(role)) over (partition by artwork_id order by created_at, user_id
             rows between unbounded preceding and 1 preceding), 0) as before_w,
           sum(role_weight(role)) over (partition by artwork_id) as total_w
    from counted_reactions where kind in ('like', 'super')
  ),
  discovery as (
    select user_id, count(*)::int as n, sum(ln(1 + (total_w - before_w - w)) / (1 + before_w)) as raw
    from ordered group by 1
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
  ),
  ranked as (
    select b.*, rank() over (partition by board order by score desc) as rnk,
           row_number() over (partition by board order by score desc, name) as pos
    from boards b
  ),
  lim as (select greatest(1, least(coalesce(p_limit, 50), 100)) as n)
  select json_build_object(
    'collectors', coalesce((select json_agg(json_build_object('rank', rnk, 'name', name, 'country', country, 'score', score, 'detail', detail, 'me', coalesce(id = auth.uid(), false)) order by pos)
                            from ranked, lim where board = 'collectors' and rnk <= lim.n), '[]'::json),
    'critics', coalesce((select json_agg(json_build_object('rank', rnk, 'name', name, 'country', country, 'score', score, 'detail', detail, 'me', coalesce(id = auth.uid(), false)) order by pos)
                         from ranked, lim where board = 'critics' and rnk <= lim.n), '[]'::json),
    'discoverers', coalesce((select json_agg(json_build_object('rank', rnk, 'name', name, 'country', country, 'score', score, 'detail', detail, 'me', coalesce(id = auth.uid(), false)) order by pos)
                             from ranked, lim where board = 'discoverers' and rnk <= lim.n), '[]'::json),
    'me', coalesce((select json_object_agg(board, json_build_object('rank', rnk, 'score', score, 'detail', detail))
                    from ranked where id = auth.uid()), '{}'::json),
    'members', (select count(*)::int from profiles where public_leaderboards)
  )
$$;
revoke all on function public.member_leaderboards(text, integer) from public;
grant execute on function public.member_leaderboards(text, integer) to anon, authenticated;
commit;
