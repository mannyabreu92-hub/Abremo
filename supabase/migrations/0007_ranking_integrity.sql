-- Abremi Phase 2A: ranking integrity, server-side scores and achievements.
-- Adds only; undo with supabase/migrations/down/0007_down.sql.
--
-- What counts toward rankings, leaderboards and achievements (published on the Rankings page):
--   * one like or save per member per work (already enforced), never on your own work;
--   * follows of your own artist page don't count; reviews of your own work don't count;
--   * reactions a moderator excluded after reviewing an integrity flag don't count.
-- Five separate scores, never combined and never affected by payments:
--   artwork popularity, artist reputation, critic credibility, collector interest, battle performance.

-- ——— 1. Exclusions ———
alter table public.reactions add column if not exists excluded boolean not null default false;
alter table public.reactions add column if not exists excluded_reason text;

-- Members can't set or clear the exclusion themselves (their own-row RLS allows other updates).
create or replace function public.guard_reaction_exclusion() returns trigger
language plpgsql as $$
begin
  if current_user in ('postgres', 'supabase_admin') or coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.excluded := false;
    new.excluded_reason := null;
  elsif new.excluded is distinct from old.excluded or new.excluded_reason is distinct from old.excluded_reason then
    new.excluded := old.excluded;
    new.excluded_reason := old.excluded_reason;
  end if;
  return new;
end $$;
drop trigger if exists reactions_guard_exclusion on public.reactions;
create trigger reactions_guard_exclusion before insert or update on public.reactions
  for each row execute function public.guard_reaction_exclusion();

-- The rows that count. These views read everyone's rows, so the API can't query them directly.
create or replace view public.counted_reactions as
  select r.* from public.reactions r
  join public.artworks a on a.id = r.artwork_id
  where not r.excluded and (a.owner_id is null or a.owner_id <> r.user_id);
create or replace view public.counted_follows as
  select f.* from public.follows f
  join public.artists ar on ar.id = f.artist_id
  where ar.owner_id is null or ar.owner_id <> f.user_id;
create or replace view public.counted_reviews as
  select v.* from public.reviews v
  join public.artworks a on a.id = v.artwork_id
  where a.owner_id is null or a.owner_id <> v.user_id;
revoke all on public.counted_reactions, public.counted_follows, public.counted_reviews from public, anon, authenticated;

-- ——— 2. Rate limits ———
create or replace function public.rate_limit_activity() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  recent integer;
  cap integer := case tg_table_name when 'reactions' then 600 when 'follows' then 200 else 1000 end;
begin
  execute format('select count(*) from public.%I where user_id = $1 and created_at > now() - interval ''1 hour''', tg_table_name)
    into recent using new.user_id;
  if recent >= cap then
    raise exception 'Slow down: you can add % % an hour', cap, case tg_table_name when 'reactions' then 'likes and saves' else 'follows' end
      using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists reactions_rate_limit on public.reactions;
create trigger reactions_rate_limit before insert on public.reactions
  for each row execute function public.rate_limit_activity();
drop trigger if exists follows_rate_limit on public.follows;
create trigger follows_rate_limit before insert on public.follows
  for each row execute function public.rate_limit_activity();

-- You can't vote your own work up in Art Battles.
create or replace function public.guard_battle_vote() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from artworks where id = new.winner_id and owner_id = new.user_id) then
    raise exception 'You can’t vote for your own work' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists battle_votes_guard on public.battle_votes;
create trigger battle_votes_guard before insert on public.battle_votes
  for each row execute function public.guard_battle_vote();

-- ——— 3. Server-side scores ———
-- Artwork popularity (all time): Σ role weight × (1 for a like, 2 for a save) + 2 × stars of each critic review.
-- Trending: the same likes and saves, each halved for every 7 days of age.
-- Collector interest: the collector share of popularity. Critic credibility: critic review points and count.
create or replace function public.artwork_scores()
returns table (artwork_id text, popularity integer, trending numeric, collector integer, critic integer, reviews integer)
language sql stable security definer set search_path = public as $$
  with r as (
    select artwork_id,
           sum(case kind when 'like' then role_weight(role) when 'super' then 2 * role_weight(role) else 0 end) as pts,
           sum(case kind when 'like' then role_weight(role) when 'super' then 2 * role_weight(role) else 0 end
               * power(0.5, extract(epoch from (now() - created_at)) / 604800.0)) as trend,
           sum(case when role = 'collector' then case kind when 'like' then 9 when 'super' then 18 else 0 end else 0 end) as coll
    from counted_reactions where kind in ('like', 'super') group by 1
  ),
  v as (select artwork_id, sum(2 * rating) as pts, count(*) as n from counted_reviews group by 1)
  select coalesce(r.artwork_id, v.artwork_id),
         round(coalesce(r.pts, 0) + coalesce(v.pts, 0))::int,
         round(coalesce(r.trend, 0)::numeric, 2),
         coalesce(r.coll, 0)::int,
         coalesce(v.pts, 0)::int,
         coalesce(v.n, 0)::int
  from r full join v on v.artwork_id = r.artwork_id
$$;
revoke all on function public.artwork_scores() from public, anon, authenticated;

-- Artist reputation: the popularity of their works plus Σ role weight of their followers.
create or replace function public.artist_scores()
returns table (artist_id text, country text, reputation integer, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  with works as (
    select a.artist_id, sum(s.popularity) as pts from artwork_scores() s join artworks a on a.id = s.artwork_id group by 1
  ),
  fol as (select artist_id, sum(role_weight(role)) as pts from counted_follows group by 1)
  select ar.id, ar.country, (coalesce(w.pts, 0) + coalesce(f.pts, 0))::int, ar.created_at
  from artists ar left join works w on w.artist_id = ar.id left join fol f on f.artist_id = ar.id
  where coalesce(w.pts, 0) + coalesce(f.pts, 0) > 0
$$;
revoke all on function public.artist_scores() from public, anon, authenticated;

-- ——— 4. Community snapshot: counted rows only, plus the server's scores ———
create or replace function public.community_snapshot() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'reactions', coalesce((
      select json_agg(t) from (
        select artwork_id as a, kind as k, role as r, count(*)::int as n
        from counted_reactions where kind in ('like', 'super') group by 1, 2, 3
      ) t), '[]'::json),
    'reviews', coalesce((
      select json_agg(t) from (
        select artwork_id as a, count(*)::int as n, sum(rating)::int as s from counted_reviews group by 1
      ) t), '[]'::json),
    'follows', coalesce((
      select json_agg(t) from (
        select artist_id as a, role as r, count(*)::int as n from counted_follows group by 1, 2
      ) t), '[]'::json),
    'ratings', coalesce((
      select json_agg(t) from (select artwork_id as a, rating as v, votes as n from artwork_ratings) t
    ), '[]'::json),
    'scores', coalesce((
      select json_agg(x) from (
        select artwork_id as a, popularity as p, trending as t, collector as c, critic as cr from artwork_scores()
      ) x), '[]'::json),
    'artist_scores', coalesce((
      select json_agg(t) from (select artist_id as a, reputation as s from artist_scores()) t
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

-- Member leaderboards count the same rows (same rules as 0003 otherwise).
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

-- ——— 5. Integrity flags (reviewed by moderators; nothing is removed silently) ———
create table if not exists public.integrity_flags (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('new_account_burst')),
  target_type text not null,
  target_id text not null,
  details jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'dismissed', 'confirmed')),
  created_at timestamptz not null default now(),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  note text check (char_length(coalesce(note, '')) <= 500)
);
create index if not exists integrity_flags_open_idx on public.integrity_flags (created_at) where status = 'open';
alter table public.integrity_flags enable row level security;
revoke all on public.integrity_flags from anon, authenticated;

-- A work that got 10+ likes or saves in the last hour, at least 60% of them from accounts under 3 days old.
create or replace function public.detect_suspicious_activity() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with burst as (
    select r.artwork_id, count(*) as total,
           count(*) filter (where p.created_at > r.created_at - interval '72 hours') as fresh,
           min(r.created_at) as since, max(r.created_at) as until
    from counted_reactions r join profiles p on p.id = r.user_id
    where r.kind in ('like', 'super') and r.created_at > now() - interval '1 hour'
    group by 1
  )
  insert into integrity_flags (kind, target_type, target_id, details)
  select 'new_account_burst', 'artwork', b.artwork_id,
         jsonb_build_object('total', b.total, 'new_accounts', b.fresh, 'since', b.since, 'until', b.until)
  from burst b
  where b.total >= 10 and b.fresh::numeric / b.total >= 0.6
    and not exists (select 1 from integrity_flags f where f.target_type = 'artwork' and f.target_id = b.artwork_id
                      and (f.status = 'open' or f.created_at > now() - interval '24 hours'));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.detect_suspicious_activity() from public, anon, authenticated;

create or replace function public.admin_integrity_queue()
returns table (id uuid, kind text, target_type text, target_id text, title text, details jsonb, status text, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  perform detect_suspicious_activity();
  return query
    select f.id, f.kind, f.target_type, f.target_id, a.title, f.details, f.status, f.created_at
    from integrity_flags f left join artworks a on a.id = f.target_id
    where f.status = 'open' order by f.created_at;
end $$;
revoke all on function public.admin_integrity_queue() from public, anon;
grant execute on function public.admin_integrity_queue() to authenticated;

-- Confirming excludes the flagged window's likes and saves from accounts that were under 3 days old.
create or replace function public.resolve_integrity_flag(p_id uuid, p_exclude boolean, p_note text default null)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  f public.integrity_flags;
  n integer := 0;
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  update integrity_flags
     set status = case when p_exclude then 'confirmed' else 'dismissed' end,
         reviewed_by = auth.uid(), reviewed_at = now(), note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_id and status = 'open'
  returning * into f;
  if f.id is null then
    raise exception 'That flag is no longer open' using errcode = 'P0001';
  end if;
  if p_exclude then
    update reactions r set excluded = true, excluded_reason = 'integrity_flag:' || f.id
      from profiles p
     where p.id = r.user_id and r.artwork_id = f.target_id and r.kind in ('like', 'super') and not r.excluded
       and r.created_at between (f.details->>'since')::timestamptz and (f.details->>'until')::timestamptz
       and p.created_at > r.created_at - interval '72 hours';
    get diagnostics n = row_count;
  end if;
  perform log_audit(case when p_exclude then 'integrity_flag.confirmed' else 'integrity_flag.dismissed' end,
                    f.target_type, f.target_id, jsonb_build_object('flag', f.id, 'excluded', n, 'note', f.note));
  return n;
end $$;
revoke all on function public.resolve_integrity_flag(uuid, boolean, text) from public, anon;
grant execute on function public.resolve_integrity_flag(uuid, boolean, text) to authenticated;

-- ——— 6. Achievements, earned on the server with their evidence ———
create table if not exists public.achievement_definitions (
  code text primary key,
  audience text not null check (audience in ('member', 'artist')),
  label text not null,
  criteria text not null,
  sort integer not null default 0
);
alter table public.achievement_definitions enable row level security;
drop policy if exists "criteria are public" on public.achievement_definitions;
create policy "criteria are public" on public.achievement_definitions for select using (true);
revoke all on public.achievement_definitions from anon, authenticated;
grant select on public.achievement_definitions to anon, authenticated;

insert into public.achievement_definitions (code, audience, label, criteria, sort) values
  ('first_discovery', 'member', 'First Discovery', 'Liked or saved your first work.', 10),
  ('early_supporter', 'member', 'Early Supporter', 'Liked a work before it had 10 likes, and it now has 50 or more.', 20),
  ('master_curator', 'member', 'Master Curator', 'Built 3 collections with at least 5 works each.', 30),
  ('collector_elite', 'member', 'Collector Elite', 'As a verified Collector, saved 10 or more works.', 40),
  ('master_critic', 'member', 'Master Critic', 'As a verified Critic, published 10 or more reviews.', 50),
  ('early_believer_1k', 'member', 'Early Believer · 1K', 'Followed an artist before they had 1,000 followers, and they got there.', 60),
  ('early_believer_10k', 'member', 'Early Believer · 10K', 'Followed an artist before they had 10,000 followers, and they got there.', 61),
  ('early_believer_100k', 'member', 'Early Believer · 100K', 'Followed an artist before they had 100,000 followers, and they got there.', 62),
  ('first_work', 'artist', 'First Work', 'Published a first work on Abremi.', 100),
  ('rising_artist', 'artist', 'Rising Artist', 'Joined in the last 2 years and reached the top 25 artists of their country.', 110),
  ('top_100_country', 'artist', 'Top 100 · Country', 'Reached the top 100 artists of their country by reputation.', 120),
  ('top_100_global', 'artist', 'Top 100 · Global', 'Reached the top 100 artists worldwide by reputation.', 130),
  ('battle_champion', 'artist', 'Battle Champion', 'Has a work in the top 10 Art Battle ratings after at least 20 battles.', 140)
on conflict (code) do update set audience = excluded.audience, label = excluded.label, criteria = excluded.criteria, sort = excluded.sort;

create table if not exists public.member_achievements (
  user_id uuid not null references public.profiles (id) on delete cascade,
  code text not null references public.achievement_definitions (code) on delete cascade,
  awarded_at timestamptz not null default now(),
  evidence jsonb not null default '{}'::jsonb,
  primary key (user_id, code)
);
alter table public.member_achievements enable row level security;
drop policy if exists "read own achievements" on public.member_achievements;
create policy "read own achievements" on public.member_achievements for select using (user_id = auth.uid());
revoke all on public.member_achievements from anon, authenticated;
grant select on public.member_achievements to authenticated;

-- Awards what has been earned (achievements are kept once earned). Returns how many were new.
create or replace function public.award_achievements() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with likes as (
    select r.*, count(*) over (partition by r.artwork_id order by r.created_at, r.user_id
                               rows between unbounded preceding and 1 preceding) as before_n,
           count(*) over (partition by r.artwork_id) as total_n
    from counted_reactions r where r.kind in ('like', 'super')
  ),
  follows_ranked as (
    select f.*, count(*) over (partition by f.artist_id order by f.created_at, f.user_id
                               rows between unbounded preceding and 1 preceding) as before_n,
           count(*) over (partition by f.artist_id) as total_n
    from counted_follows f
  ),
  reps as (
    select s.*, rank() over (order by s.reputation desc) as global_rank,
           rank() over (partition by s.country order by s.reputation desc) as country_rank
    from artist_scores() s
  ),
  battles as (
    select ar.artwork_id, ar.rating, ar.votes, rank() over (order by ar.rating desc) as rnk
    from artwork_ratings ar where ar.votes >= 20
  ),
  earned (user_id, code, evidence) as (
    select user_id, 'first_discovery', jsonb_build_object('artwork', (array_agg(artwork_id order by created_at))[1])
      from likes group by user_id
    union all
    (select distinct on (user_id) user_id, 'early_supporter', jsonb_build_object('artwork', artwork_id, 'likes_before', before_n, 'likes_now', total_n)
      from likes where before_n < 10 and total_n >= 50 order by user_id, created_at)
    union all
    select c.owner_id, 'master_curator', jsonb_build_object('collections', count(*))
      from collections c where (select count(*) from collection_items i where i.collection_id = c.id) >= 5
      group by c.owner_id having count(*) >= 3
    union all
    select r.user_id, 'collector_elite', jsonb_build_object('saves', count(*))
      from counted_reactions r join profiles p on p.id = r.user_id
      where r.kind = 'super' and r.role = 'collector' and p.role = 'collector'
      group by r.user_id having count(*) >= 10
    union all
    select v.user_id, 'master_critic', jsonb_build_object('reviews', count(*))
      from counted_reviews v join profiles p on p.id = v.user_id
      where p.role = 'critic' group by v.user_id having count(*) >= 10
    union all
    (select distinct on (f.user_id, m.code) f.user_id, m.code, jsonb_build_object('artist', f.artist_id, 'followers_before', f.before_n, 'followers_now', f.total_n)
      from follows_ranked f
      join (values (1000, 'early_believer_1k'), (10000, 'early_believer_10k'), (100000, 'early_believer_100k')) m(n, code)
        on f.before_n < m.n and f.total_n >= m.n
      order by f.user_id, m.code, f.created_at)
    union all
    select owner_id, 'first_work', jsonb_build_object('artwork', (array_agg(id order by created_at))[1])
      from artworks where owner_id is not null group by owner_id
    union all
    select ar.owner_id, 'top_100_global', jsonb_build_object('rank', r.global_rank, 'reputation', r.reputation)
      from reps r join artists ar on ar.id = r.artist_id where ar.owner_id is not null and r.global_rank <= 100
    union all
    select ar.owner_id, 'top_100_country', jsonb_build_object('rank', r.country_rank, 'country', r.country, 'reputation', r.reputation)
      from reps r join artists ar on ar.id = r.artist_id where ar.owner_id is not null and r.country_rank <= 100
    union all
    select ar.owner_id, 'rising_artist', jsonb_build_object('rank', r.country_rank, 'country', r.country, 'joined', ar.created_at)
      from reps r join artists ar on ar.id = r.artist_id
      where ar.owner_id is not null and r.country_rank <= 25 and ar.created_at > now() - interval '2 years'
    union all
    (select distinct on (a.owner_id) a.owner_id, 'battle_champion', jsonb_build_object('artwork', b.artwork_id, 'rank', b.rnk, 'rating', b.rating, 'battles', b.votes)
      from battles b join artworks a on a.id = b.artwork_id
      where a.owner_id is not null and b.rnk <= 10 order by a.owner_id, b.rnk)
  )
  insert into member_achievements (user_id, code, evidence)
  select user_id, code, evidence from earned
  on conflict (user_id, code) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.award_achievements() from public, anon, authenticated;

-- Your own achievements (awarding anything newly earned first), with their criteria and evidence.
create or replace function public.my_achievements()
returns table (code text, audience text, label text, criteria text, awarded_at timestamptz, evidence jsonb)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  perform award_achievements();
  return query
    select d.code, d.audience, d.label, d.criteria, m.awarded_at, m.evidence
    from member_achievements m join achievement_definitions d on d.code = m.code
    where m.user_id = auth.uid() order by d.sort;
end $$;
revoke all on function public.my_achievements() from public, anon;
grant execute on function public.my_achievements() to authenticated;

-- An artist's public achievements (artist achievements only; member activity stays private).
create or replace function public.artist_achievements(p_artist_id text)
returns table (code text, label text, criteria text, awarded_at timestamptz)
language sql stable security definer set search_path = public as $$
  select d.code, d.label, d.criteria, m.awarded_at
  from artists ar
  join member_achievements m on m.user_id = ar.owner_id
  join achievement_definitions d on d.code = m.code and d.audience = 'artist'
  where ar.id = p_artist_id
  order by d.sort
$$;
revoke all on function public.artist_achievements(text) from public;
grant execute on function public.artist_achievements(text) to anon, authenticated;

-- Every 10 minutes where pg_cron is available: award achievements and look for suspicious bursts.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('abremi-integrity', '*/10 * * * *', 'select public.detect_suspicious_activity(); select public.award_achievements();');
  end if;
exception when others then
  raise notice 'Schedule not set up (%). Achievements are awarded when members open them instead.', sqlerrm;
end $$;
