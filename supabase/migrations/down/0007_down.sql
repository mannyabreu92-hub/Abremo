-- Undo for 0007_ranking_integrity.sql: restores the 0006 snapshot and 0003 leaderboards, and drops
-- the exclusions, rate limits, scores, integrity flags and achievements (including their data).
begin;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then perform cron.unschedule('abremi-integrity'); end if;
exception when others then null;
end $$;

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

create or replace function public.member_leaderboards(p_country text default null, p_limit integer default 50)
returns json
language sql stable security definer set search_path = public as $$
  with
  contrib as (
    select user_id, role,
           sum(case kind when 'like' then role_weight(role) when 'super' then 2 * role_weight(role) else 0 end)::int as pts
    from reactions group by 1, 2
  ),
  review_pts as (
    select user_id, sum(2 * rating)::int as pts, count(*)::int as n from reviews group by 1
  ),
  ordered as (
    select user_id, role_weight(role) as w,
           coalesce(sum(role_weight(role)) over (partition by artwork_id order by created_at, user_id
             rows between unbounded preceding and 1 preceding), 0) as before_w,
           sum(role_weight(role)) over (partition by artwork_id) as total_w
    from reactions where kind in ('like', 'super')
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
grant execute on function public.member_leaderboards(text, integer) to anon, authenticated;

drop function if exists public.artist_achievements(text);
drop function if exists public.my_achievements();
drop function if exists public.award_achievements();
drop table if exists public.member_achievements;
drop table if exists public.achievement_definitions;
drop function if exists public.resolve_integrity_flag(uuid, boolean, text);
drop function if exists public.admin_integrity_queue();
drop function if exists public.detect_suspicious_activity();
drop table if exists public.integrity_flags;
drop function if exists public.artist_scores();
drop function if exists public.artwork_scores();
drop trigger if exists battle_votes_guard on public.battle_votes;
drop function if exists public.guard_battle_vote();
drop trigger if exists reactions_rate_limit on public.reactions;
drop trigger if exists follows_rate_limit on public.follows;
drop function if exists public.rate_limit_activity();
drop view if exists public.counted_reactions;
drop view if exists public.counted_follows;
drop view if exists public.counted_reviews;
drop trigger if exists reactions_guard_exclusion on public.reactions;
drop function if exists public.guard_reaction_exclusion();
alter table public.reactions drop column if exists excluded, drop column if exists excluded_reason;
commit;
