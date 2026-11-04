-- Abremi Phase 7: the Abremi Guide, one assistant with three modes (discovery, artists, collectors).
--
-- The AI runs in a Vercel server function (api/assistant.js) that holds the API key. It calls
-- begin_assistant_request() with the member's own session, so the database decides who may ask, applies
-- the limits, and hands over only public catalog data plus the member's OWN data. Conversations are
-- never stored: assistant_requests keeps the mode, time and outcome; assistant_events keeps counts of
-- what people did with the suggestions. Plans set the daily allowance only; nothing here reads plans
-- when choosing what to show (tests/db.test.js checks this).

-- ——— 1. Allowance per plan (messages a day) ———
alter table public.plans add column if not exists assistant_daily integer not null default 30 check (assistant_daily between 0 and 1000);
update public.plans set assistant_daily = case code when 'free' then 30 when 'pro' then 60 when 'elite' then 100 when 'gallery' then 60 end;

-- ——— 2. Personalization preferences (the member's own; private) ———
alter table public.profiles add column if not exists assistant_personalize boolean not null default true;
alter table public.profiles add column if not exists assistant_interests text not null default '' check (char_length(assistant_interests) <= 300);

create or replace function public.assistant_preferences() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('personalize', assistant_personalize, 'interests', assistant_interests) from profiles where id = auth.uid()
$$;

create or replace function public.set_assistant_preferences(p_personalize boolean, p_interests text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  update profiles set assistant_personalize = coalesce(p_personalize, true), assistant_interests = left(btrim(coalesce(p_interests, '')), 300)
   where id = auth.uid();
end $$;

-- Reset: forget stated interests and what the member did with suggestions. Follows, likes and saves
-- are the member's own features and stay; switch personalization off to stop the Guide using them.
create or replace function public.reset_assistant_personalization() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  update profiles set assistant_interests = '', assistant_personalize = true where id = auth.uid();
  delete from assistant_events where user_id = auth.uid();
end $$;

-- ——— 3. Requests (limits and repeat use; never the conversation) ———
create table if not exists public.assistant_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  mode text not null check (mode in ('visitor', 'artist', 'collector')),
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  created_at timestamptz not null default now()
);
create index if not exists assistant_requests_user_idx on public.assistant_requests (user_id, created_at desc);
create index if not exists assistant_requests_day_idx on public.assistant_requests (created_at);
alter table public.assistant_requests enable row level security;
drop policy if exists "read own assistant requests" on public.assistant_requests;
create policy "read own assistant requests" on public.assistant_requests for select using (user_id = auth.uid());
revoke all on public.assistant_requests from anon, authenticated;
grant select on public.assistant_requests to authenticated;

create or replace function public.assistant_usage() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'used', (select count(*) from assistant_requests where user_id = auth.uid() and status <> 'failed' and created_at >= date_trunc('day', now())),
    'limit', (current_plan(auth.uid())).assistant_daily,
    'resets_at', date_trunc('day', now()) + interval '1 day')
  where auth.uid() is not null
$$;

-- What the Guide may know about the page being viewed: public data only (and the member's own).
create or replace function public.assistant_page_context(p_type text, p_id text) returns json
language plpgsql stable security definer set search_path = public as $$
declare
  w public.artworks;
  ar public.artists;
  pair text[];
begin
  if p_type = 'artwork' then
    select * into w from artworks where id = p_id and not hidden and (release_at is null or release_at <= now() or owner_id = auth.uid());
    if w.id is null then return null; end if;
    select * into ar from artists where id = w.artist_id;
    return json_build_object('type', 'artwork',
      'artwork', json_build_object('id', w.id, 'title', w.title, 'artist_id', w.artist_id, 'artist', ar.name, 'category', w.category, 'style', w.style,
                                   'medium', w.medium, 'year', w.year, 'description', w.description, 'dimensions', w.dimensions,
                                   'availability', case when w.owner_id is null then 'sample' else w.availability end, 'sample', w.owner_id is null,
                                   'thumb_path', case when w.owner_id is not null then w.thumb_path end),
      'signals', json_build_object(
        'likes', (select count(*) from counted_reactions where artwork_id = w.id and kind = 'like'),
        'saves', (select count(*) from counted_reactions where artwork_id = w.id and kind = 'super'),
        'reviews', (select count(*) from counted_reviews where artwork_id = w.id),
        'battle_rating', (select rating from artwork_ratings where artwork_id = w.id),
        'battle_votes', (select votes from artwork_ratings where artwork_id = w.id)));
  elsif p_type = 'artist' then
    select * into ar from artists where id = p_id;
    if ar.id is null then return null; end if;
    return json_build_object('type', 'artist',
      'artist', json_build_object('id', ar.id, 'name', ar.name, 'country', ar.country, 'city', ar.city, 'sample', ar.owner_id is null,
                                  'bio', left(ar.bio, 600), 'statement', left(ar.statement, 600), 'joined', ar.created_at::date),
      'followers', (select count(*) from counted_follows where artist_id = ar.id),
      'works', coalesce((select json_agg(a.id order by a.created_at desc) from (
        select id, created_at from artworks where artist_id = ar.id and not hidden and (release_at is null or release_at <= now()) order by created_at desc limit 24) a), '[]'::json),
      'achievements', coalesce((select json_agg(d.label) from member_achievements m join achievement_definitions d on d.code = m.code and d.audience = 'artist'
                                where m.user_id = ar.owner_id), '[]'::json));
  elsif p_type = 'collection' then
    -- Shared collections by link, or the member's own; never the owner's name unless it's the member.
    return (select json_build_object('type', 'collection', 'name', c.name, 'description', c.description, 'mine', c.owner_id = auth.uid(),
              'items', coalesce((select json_agg(i.artwork_id order by i.added_at desc) from collection_items i join artworks a on a.id = i.artwork_id
                                 where i.collection_id = c.id and not a.hidden), '[]'::json))
            from collections c where c.id::text = p_id and (not c.is_private or c.owner_id = auth.uid()));
  elsif p_type = 'ranking' then
    return json_build_object('type', 'ranking', 'view', left(p_id, 40),
      'top_artworks', coalesce((select json_agg(x.artwork_id order by x.popularity desc, x.artwork_id) from (
        select s.artwork_id, s.popularity from artwork_scores() s join artworks a on a.id = s.artwork_id
        where not a.hidden and (a.release_at is null or a.release_at <= now()) order by s.popularity desc, s.artwork_id limit 15) x), '[]'::json),
      'trending', coalesce((select json_agg(x.artwork_id order by x.trending desc, x.artwork_id) from (
        select s.artwork_id, s.trending from artwork_scores() s join artworks a on a.id = s.artwork_id
        where not a.hidden and (a.release_at is null or a.release_at <= now()) and s.trending > 0 order by s.trending desc, s.artwork_id limit 10) x), '[]'::json),
      'top_artists', coalesce((select json_agg(x.artist_id order by x.reputation desc, x.artist_id) from (
        select artist_id, reputation from artist_scores() order by reputation desc, artist_id limit 10) x), '[]'::json));
  elsif p_type = 'battle' then
    pair := string_to_array(p_id, ',');
    return json_build_object('type', 'battle', 'pair', coalesce((select json_agg(json_build_object('id', a.id, 'rating', r.rating, 'votes', r.votes))
      from artworks a left join artwork_ratings r on r.artwork_id = a.id
      where a.id = any (pair[1:2]) and not a.hidden and (a.release_at is null or a.release_at <= now())), '[]'::json));
  elsif p_type = 'competition' then
    return (select json_build_object('type', 'competition', 'title', c.title, 'kind', c.kind, 'brief', c.brief, 'category', c.category,
                                     'phase', competition_phase(c), 'voting_closes_at', c.voting_closes_at,
                                     'results', case when c.closed_at is not null then c.results->'entries' end)
            from competitions c where c.id::text = p_id and c.cancelled_at is null);
  end if;
  return null;
end $$;
revoke all on function public.assistant_page_context(text, text) from public, anon, authenticated;

-- The public catalog the Guide chooses suggestions from: visible works and artists with their public
-- totals. It never reads plans, private collections, other members' activity or contact details.
create or replace function public.assistant_catalog() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'artworks', coalesce((select json_agg(json_build_object('id', a.id, 'title', a.title, 'artist_id', a.artist_id, 'category', a.category,
                                 'style', a.style, 'medium', a.medium, 'year', a.year, 'sample', a.owner_id is null,
                                 'availability', case when a.owner_id is null then null else a.availability end,
                                 'description', left(a.description, 240), 'popularity', coalesce(s.popularity, 0), 'trending', coalesce(s.trending, 0),
                                 'created_at', a.created_at))
                          from artworks a left join artwork_scores() s on s.artwork_id = a.id
                          where not a.hidden and (a.release_at is null or a.release_at <= now())), '[]'::json),
    'artists', coalesce((select json_agg(json_build_object('id', ar.id, 'name', ar.name, 'country', ar.country, 'city', ar.city,
                                 'sample', ar.owner_id is null, 'bio', left(ar.bio, 200),
                                 'followers', (select count(*) from counted_follows f where f.artist_id = ar.id)))
                         from artists ar), '[]'::json))
$$;
revoke all on function public.assistant_catalog() from public, anon, authenticated;

-- Starts a request: signed-in members only; the artist mode only for artists; the plan's daily
-- allowance and an overall daily cap. Returns the grounding context.
create or replace function public.begin_assistant_request(p_mode text, p_page_type text default null, p_page_id text default null) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  me public.profiles;
  ar public.artists;
  daily integer;
  req uuid;
  since timestamptz := now() - interval '30 days';
begin
  if uid is null then
    raise exception 'Sign in to use the Guide' using errcode = '42501';
  end if;
  if p_mode not in ('visitor', 'artist', 'collector') then
    raise exception 'Unknown mode' using errcode = '22023';
  end if;
  select * into me from profiles where id = uid;
  select * into ar from artists where owner_id = uid;
  if p_mode = 'artist' and ar.id is null then
    raise exception 'The artist mode is for artists: publish a work first' using errcode = '42501';
  end if;
  daily := (current_plan(uid)).assistant_daily;
  if (select count(*) from assistant_requests where user_id = uid and status <> 'failed' and created_at >= date_trunc('day', now())) >= daily then
    raise exception 'You’ve used today’s % messages. They reset at midnight UTC.', daily using errcode = 'P0001';
  end if;
  if (select count(*) from assistant_requests where status <> 'failed' and created_at > now() - interval '1 day') >= 2000 then
    raise exception 'The Guide is busy today. Please try again tomorrow.' using errcode = 'P0001';
  end if;
  insert into assistant_requests (user_id, mode) values (uid, p_mode) returning id into req;
  return json_build_object(
    'request_id', req,
    'mode', p_mode,
    'member', json_build_object('role', me.role, 'country', me.country, 'is_artist', ar.id is not null),
    'page', case when p_page_type is not null then assistant_page_context(p_page_type, p_page_id) end,
    'catalog', assistant_catalog(),
    'personal', case when me.assistant_personalize then json_build_object(
        'interests', me.assistant_interests,
        'follows', coalesce((select json_agg(artist_id order by created_at desc) from (select artist_id, created_at from follows where user_id = uid order by created_at desc limit 50) f), '[]'::json),
        'saved', coalesce((select json_agg(artwork_id order by created_at desc) from (select artwork_id, created_at from reactions where user_id = uid and kind = 'super' order by created_at desc limit 50) r), '[]'::json),
        'liked', coalesce((select json_agg(artwork_id order by created_at desc) from (select artwork_id, created_at from reactions where user_id = uid and kind = 'like' order by created_at desc limit 50) r), '[]'::json))
      else json_build_object('interests', '', 'follows', '[]'::json, 'saved', '[]'::json, 'liked', '[]'::json) end,
    'collections', case when p_mode = 'collector' then coalesce((select json_agg(json_build_object('name', c.name, 'private', c.is_private,
                          'items', coalesce((select json_agg(i.artwork_id) from collection_items i where i.collection_id = c.id), '[]'::json)) order by c.updated_at desc)
                       from collections c where c.owner_id = uid), '[]'::json) end,
    'studio', case when p_mode = 'artist' then json_build_object(
        'artist', json_build_object('id', ar.id, 'name', ar.name, 'country', ar.country, 'city', ar.city, 'bio', ar.bio, 'statement', ar.statement,
                                    'website', ar.website is not null, 'portrait', ar.avatar_path is not null),
        'works', coalesce((select json_agg(json_build_object('id', a.id, 'title', a.title, 'category', a.category, 'style', a.style, 'medium', a.medium,
                                 'has_description', coalesce(a.description, '') <> '', 'has_dimensions', a.dimensions is not null,
                                 'availability', a.availability, 'hidden', a.hidden) order by a.created_at desc)
                          from (select * from artworks where owner_id = uid order by created_at desc limit 40) a), '[]'::json),
        'last_30_days', artist_summary(ar.id, since, now()),
        'previous_30_days', artist_summary(ar.id, since - interval '30 days', since),
        'followers_total', (select count(*) from counted_follows where artist_id = ar.id)) end
  );
end $$;

create or replace function public.finish_assistant_request(p_id uuid, p_ok boolean) returns void
language sql security definer set search_path = public as $$
  update assistant_requests set status = case when p_ok then 'done' else 'failed' end
   where id = p_id and user_id = auth.uid() and status = 'pending'
$$;

-- ——— 4. What people do with suggestions (counts only) ———
create table if not exists public.assistant_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('open', 'artwork_click', 'artist_visit', 'follow', 'collection_add', 'search')),
  target text check (char_length(coalesce(target, '')) <= 100),
  created_at timestamptz not null default now()
);
create index if not exists assistant_events_time_idx on public.assistant_events (created_at);
alter table public.assistant_events enable row level security;
revoke all on public.assistant_events from anon, authenticated;

create or replace function public.record_assistant_event(p_kind text, p_target text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    return;
  end if;
  if (select count(*) from assistant_events where user_id = auth.uid() and created_at > now() - interval '1 hour') >= 300 then
    return;
  end if;
  insert into assistant_events (user_id, kind, target) values (auth.uid(), p_kind, left(p_target, 100));
end $$;

create or replace function public.admin_assistant_metrics(p_days integer default 30) returns json
language plpgsql stable security definer set search_path = public as $$
declare since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365));
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return json_build_object(
    'days', least(greatest(coalesce(p_days, 30), 1), 365),
    'messages', (select count(*) from assistant_requests where created_at >= since and status = 'done'),
    'failed', (select count(*) from assistant_requests where created_at >= since and status = 'failed'),
    'members', (select count(distinct user_id) from assistant_requests where created_at >= since),
    'returning', (select count(*) from (select user_id from assistant_requests where created_at >= since
                                        group by user_id having count(distinct created_at::date) >= 2) r),
    'by_mode', coalesce((select json_object_agg(mode, n) from (select mode, count(*) as n from assistant_requests where created_at >= since group by mode) m), '{}'::json),
    'events', coalesce((select json_object_agg(kind, n) from (select kind, count(*) as n from assistant_events where created_at >= since group by kind) e), '{}'::json));
end $$;

create or replace function public.prune_assistant_data() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer; m integer;
begin
  delete from assistant_events where created_at < now() - interval '400 days';
  get diagnostics n = row_count;
  delete from assistant_requests where created_at < now() - interval '400 days';
  get diagnostics m = row_count;
  return n + m;
end $$;
revoke all on function public.prune_assistant_data() from public, anon, authenticated;

-- ——— Grants ———
do $$
declare f text;
begin
  foreach f in array array[
    'assistant_preferences()', 'set_assistant_preferences(boolean, text)', 'reset_assistant_personalization()', 'assistant_usage()',
    'begin_assistant_request(text, text, text)', 'finish_assistant_request(uuid, boolean)', 'record_assistant_event(text, text)',
    'admin_assistant_metrics(integer)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('abremi-prune-assistant', '17 4 * * *', 'select public.prune_assistant_data();');
  end if;
exception when others then
  raise notice 'Schedule not set up (%). Old assistant counts need pg_cron to be pruned.', sqlerrm;
end $$;
