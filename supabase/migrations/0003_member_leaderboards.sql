-- Abremi member leaderboards: Top Collectors, Top Critics, Top Discoverers.
-- Same maths as src/core/leaderboards.js (tests/db.test.js checks they agree).
--
-- Privacy
--   * Members choose whether they appear (profiles.public_leaderboards, on by default).
--   * New members get a neutral display name ("Member 3F2A"), never part of their email.
--   * Boards expose display name, country, score and rank only: no ids, no emails, no activity.
--   * The viewer always sees their own standing, even when they have chosen not to appear.

alter table public.profiles add column if not exists public_leaderboards boolean not null default true;
grant update (public_leaderboards) on public.profiles to authenticated;

-- New accounts: a neutral display name instead of the start of their email address.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name)
  values (new.id, 'Member ' || upper(substr(md5(new.id::text), 1, 4)))
  on conflict (id) do nothing;
  return new;
end $$;

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
