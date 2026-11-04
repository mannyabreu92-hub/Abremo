-- Abremi Phase 2B: Artist Arena and Creative Challenges, one competition system.
-- Adds only; undo with supabase/migrations/down/0008_down.sql.
--
-- How a competition runs (all enforced here, not in the app):
--   entries open → artists submit one of their own published works (one entry each)
--   voting → each eligible member has one vote (all roles equal), changeable until voting closes;
--            no voting for your own entry; accounts must be 3+ days old with 5+ likes;
--            vote totals stay hidden until voting closes
--   closed → the server records places (ties share a place), awards achievements, and notifies
--            entrants and the winners' followers.

-- ——— Tables ———
create table if not exists public.competitions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('daily', 'weekly', 'category', 'country', 'emerging', 'challenge')),
  title text not null check (char_length(btrim(title)) between 3 and 80),
  brief text not null default '' check (char_length(brief) <= 1000),
  rules text not null default '' check (char_length(rules) <= 2000),
  category text check (category is null or category in ('oil', 'illustration', 'sculpture', 'photography', 'digital', 'street', 'ai', 'nft', 'mixed')),
  country text check (country is null or country ~ '^[A-Z]{2}$'),
  entries_open_at timestamptz not null,
  voting_opens_at timestamptz not null,
  voting_closes_at timestamptz not null,
  cancelled_at timestamptz,
  closed_at timestamptz,
  results jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint competitions_schedule check (entries_open_at < voting_opens_at and voting_opens_at < voting_closes_at),
  constraint competitions_scope check ((kind = 'category') = (category is not null) and (kind = 'country') = (country is not null))
);
create index if not exists competitions_closes_idx on public.competitions (voting_closes_at) where closed_at is null and cancelled_at is null;

create table if not exists public.competition_entries (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions (id) on delete cascade,
  artwork_id text not null references public.artworks (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (competition_id, user_id),
  unique (competition_id, artwork_id)
);
create index if not exists competition_entries_user_idx on public.competition_entries (user_id);

create table if not exists public.competition_votes (
  competition_id uuid not null references public.competitions (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  entry_id uuid not null references public.competition_entries (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (competition_id, user_id)
);
create index if not exists competition_votes_entry_idx on public.competition_votes (entry_id);

-- Notifications from the server (results, wins). Members read and mark only their own.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  title text not null,
  link text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

alter table public.competitions enable row level security;
alter table public.competition_entries enable row level security;
alter table public.competition_votes enable row level security;
alter table public.notifications enable row level security;

drop policy if exists "competitions are public" on public.competitions;
create policy "competitions are public" on public.competitions for select using (true);
drop policy if exists "entries are public" on public.competition_entries;
create policy "entries are public" on public.competition_entries for select using (true);
drop policy if exists "read own votes" on public.competition_votes;
create policy "read own votes" on public.competition_votes for select using (user_id = auth.uid());
drop policy if exists "read own notifications" on public.notifications;
create policy "read own notifications" on public.notifications for select using (user_id = auth.uid());

revoke all on public.competitions, public.competition_entries, public.competition_votes, public.notifications from anon, authenticated;
grant select on public.competitions, public.competition_entries to anon, authenticated;
grant select on public.competition_votes, public.notifications to authenticated;

-- ——— Achievements for competitions ———
insert into public.achievement_definitions (code, audience, label, criteria, sort) values
  ('first_entry', 'artist', 'First Entry', 'Entered a first Arena competition or Creative Challenge.', 150),
  ('podium_finish', 'artist', 'Podium Finish', 'Placed in the top 3 of an Arena competition or Creative Challenge.', 160),
  ('competition_winner', 'artist', 'Competition Winner', 'Won an Arena competition or Creative Challenge (1st place, ties included).', 170)
on conflict (code) do update set audience = excluded.audience, label = excluded.label, criteria = excluded.criteria, sort = excluded.sort;

-- ——— Phases ———
create or replace function public.competition_phase(c public.competitions) returns text
language sql stable as $$
  select case
    when c.cancelled_at is not null then 'cancelled'
    when now() < c.entries_open_at then 'upcoming'
    when now() < c.voting_opens_at then 'entries'
    when now() < c.voting_closes_at then 'voting'
    else 'closed'
  end
$$;

-- Whether a member may vote (shown in the app, enforced in cast_competition_vote).
create or replace function public.voting_eligibility(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when p_user is null then 'Sign in to vote'
    when (select created_at from profiles where id = p_user) > now() - interval '3 days' then 'New accounts can vote after 3 days'
    when (select count(*) from counted_reactions where user_id = p_user and kind in ('like', 'super')) < 5 then 'Like at least 5 works to vote'
    else null
  end
$$;
revoke all on function public.voting_eligibility(uuid) from public, anon, authenticated;

-- ——— Moderators: create and cancel ———
create or replace function public.create_competition(
  p_kind text, p_title text, p_brief text, p_rules text, p_category text, p_country text,
  p_entries_open_at timestamptz, p_voting_opens_at timestamptz, p_voting_closes_at timestamptz
) returns public.competitions
language plpgsql security definer set search_path = public as $$
declare c public.competitions;
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  if p_voting_closes_at > now() + interval '90 days' then
    raise exception 'Competitions can run for up to 90 days' using errcode = '22023';
  end if;
  insert into competitions (kind, title, brief, rules, category, country, entries_open_at, voting_opens_at, voting_closes_at, created_by)
  values (p_kind, btrim(p_title), btrim(coalesce(p_brief, '')), btrim(coalesce(p_rules, '')),
          nullif(p_category, ''), nullif(upper(coalesce(p_country, '')), ''),
          p_entries_open_at, p_voting_opens_at, p_voting_closes_at, auth.uid())
  returning * into c;
  perform log_audit('competition.created', 'competition', c.id::text, jsonb_build_object('title', c.title, 'kind', c.kind));
  return c;
end $$;

create or replace function public.cancel_competition(p_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare c public.competitions;
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  update competitions set cancelled_at = now() where id = p_id and cancelled_at is null and closed_at is null returning * into c;
  if c.id is null then
    raise exception 'That competition has already ended' using errcode = 'P0001';
  end if;
  perform log_audit('competition.cancelled', 'competition', c.id::text, jsonb_build_object('title', c.title, 'note', nullif(btrim(coalesce(p_note, '')), '')));
end $$;

-- ——— Artists: enter and withdraw ———
create or replace function public.enter_competition(p_competition uuid, p_artwork text) returns public.competition_entries
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  c public.competitions;
  w public.artworks;
  ar public.artists;
  e public.competition_entries;
begin
  if uid is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  select * into c from competitions where id = p_competition;
  if c.id is null then
    raise exception 'Competition not found' using errcode = 'P0002';
  end if;
  if competition_phase(c) <> 'entries' then
    raise exception 'Entries are not open' using errcode = 'P0001';
  end if;
  select * into w from artworks where id = p_artwork;
  if w.id is null or w.owner_id is distinct from uid or w.hidden then
    raise exception 'You can only enter your own published work' using errcode = '42501';
  end if;
  select * into ar from artists where id = w.artist_id;
  if c.kind = 'category' and w.category is distinct from c.category then
    raise exception 'This competition is for a different medium' using errcode = '22023';
  end if;
  if c.kind = 'country' and ar.country is distinct from c.country then
    raise exception 'This competition is for artists from another country' using errcode = '22023';
  end if;
  if c.kind = 'emerging' and ar.created_at < now() - interval '12 months' then
    raise exception 'Emerging competitions are for artists who joined in the last 12 months' using errcode = '22023';
  end if;
  insert into competition_entries (competition_id, artwork_id, user_id) values (c.id, w.id, uid) returning * into e;
  insert into member_achievements (user_id, code, evidence)
  values (uid, 'first_entry', jsonb_build_object('competition', c.id, 'artwork', w.id))
  on conflict (user_id, code) do nothing;
  return e;
exception when unique_violation then
  raise exception 'You already have an entry in this competition' using errcode = 'P0001';
end $$;

create or replace function public.withdraw_entry(p_competition uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c public.competitions;
begin
  select * into c from competitions where id = p_competition;
  if c.id is null or competition_phase(c) <> 'entries' then
    raise exception 'Entries can be withdrawn only while entries are open' using errcode = 'P0001';
  end if;
  delete from competition_entries where competition_id = p_competition and user_id = auth.uid();
  if not found then
    raise exception 'You have no entry in this competition' using errcode = 'P0001';
  end if;
end $$;

-- ——— Members: one vote each ———
create or replace function public.cast_competition_vote(p_competition uuid, p_entry uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  c public.competitions;
  e public.competition_entries;
  why text;
begin
  select * into c from competitions where id = p_competition;
  if c.id is null or competition_phase(c) <> 'voting' then
    raise exception 'Voting is not open' using errcode = 'P0001';
  end if;
  why := voting_eligibility(uid);
  if why is not null then
    raise exception '%', why using errcode = '42501';
  end if;
  select * into e from competition_entries where id = p_entry and competition_id = p_competition;
  if e.id is null then
    raise exception 'That entry is not in this competition' using errcode = '22023';
  end if;
  if e.user_id = uid then
    raise exception 'You can’t vote for your own entry' using errcode = '42501';
  end if;
  insert into competition_votes (competition_id, user_id, entry_id) values (c.id, uid, e.id)
  on conflict (competition_id, user_id) do update set entry_id = excluded.entry_id, updated_at = now();
end $$;

-- ——— Closing: places, achievements, notifications ———
create or replace function public.finalize_competition(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  c public.competitions;
  res jsonb;
begin
  select * into c from competitions where id = p_id for update;
  if c.id is null or c.closed_at is not null or c.cancelled_at is not null or now() < c.voting_closes_at then
    return;
  end if;
  with tally as (
    select e.id, e.artwork_id, e.user_id, e.created_at, count(v.user_id)::int as votes
    from competition_entries e left join competition_votes v on v.entry_id = e.id
    where e.competition_id = c.id group by e.id
  ),
  placed as (
    select t.*, case when t.votes > 0 then rank() over (order by t.votes desc)::int end as place from tally t
  )
  select coalesce(jsonb_agg(jsonb_build_object('entry', id, 'artwork', artwork_id, 'votes', votes, 'place', place)
                            order by place nulls last, created_at), '[]'::jsonb)
    into res from placed;
  update competitions set closed_at = now(), results = jsonb_build_object('entries', res, 'voters', (select count(*) from competition_votes where competition_id = c.id))
   where id = c.id;

  insert into member_achievements (user_id, code, evidence)
  select e.user_id, x.code, jsonb_build_object('competition', c.id, 'title', c.title, 'place', (r->>'place')::int, 'artwork', r->>'artwork')
  from jsonb_array_elements(res) r
  join competition_entries e on e.id = (r->>'entry')::uuid
  join (values ('competition_winner', 1), ('podium_finish', 3)) x(code, max_place) on (r->>'place')::int <= x.max_place
  on conflict (user_id, code) do nothing;

  -- Entrants hear how they did; followers of the winners hear about the win.
  insert into notifications (user_id, kind, title, link)
  select e.user_id, 'competition_result',
         case when (r->>'place') is null then 'Results are in for “' || c.title || '”'
              else 'Your entry placed ' || (r->>'place') || case (r->>'place')::int when 1 then 'st' when 2 then 'nd' when 3 then 'rd' else 'th' end || ' in “' || c.title || '”' end,
         'competition/' || c.id
  from jsonb_array_elements(res) r join competition_entries e on e.id = (r->>'entry')::uuid;
  insert into notifications (user_id, kind, title, link)
  select distinct f.user_id, 'competition_win', ar.name || ' won “' || c.title || '”', 'competition/' || c.id
  from jsonb_array_elements(res) r
  join artworks w on w.id = r->>'artwork'
  join artists ar on ar.id = w.artist_id
  join counted_follows f on f.artist_id = ar.id
  where (r->>'place')::int = 1;
end $$;
revoke all on function public.finalize_competition(uuid) from public, anon, authenticated;

create or replace function public.close_due_competitions() returns integer
language plpgsql security definer set search_path = public as $$
declare
  c record;
  n integer := 0;
begin
  for c in select id from competitions where closed_at is null and cancelled_at is null and voting_closes_at <= now() loop
    perform finalize_competition(c.id);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.close_due_competitions() from public, anon, authenticated;

-- ——— Reading ———
-- The Arena: every competition with its phase, entry count, and your entry and vote.
create or replace function public.arena() returns json
language plpgsql security definer set search_path = public as $$
begin
  perform close_due_competitions(); -- results appear on time even where pg_cron isn't available
  return coalesce((
    select json_agg(json_build_object(
      'id', c.id, 'kind', c.kind, 'title', c.title, 'brief', c.brief, 'category', c.category, 'country', c.country,
      'entries_open_at', c.entries_open_at, 'voting_opens_at', c.voting_opens_at, 'voting_closes_at', c.voting_closes_at,
      'phase', competition_phase(c),
      'entries', (select count(*) from competition_entries e where e.competition_id = c.id),
      'my_entry', (select e.artwork_id from competition_entries e where e.competition_id = c.id and e.user_id = auth.uid()),
      'winner', (select r->>'artwork' from jsonb_array_elements(c.results->'entries') r where (r->>'place')::int = 1 limit 1)
    ) order by c.voting_closes_at desc)
    from competitions c
    where c.cancelled_at is null or c.cancelled_at > now() - interval '7 days'
  ), '[]'::json);
end $$;
revoke all on function public.arena() from public;
grant execute on function public.arena() to anon, authenticated;

-- One competition: rules, entries, your vote and whether you can vote; vote totals only once closed.
create or replace function public.competition_detail(p_id uuid) returns json
language plpgsql security definer set search_path = public as $$
declare c public.competitions;
begin
  perform finalize_competition(p_id);
  select * into c from competitions where id = p_id;
  if c.id is null then
    return null;
  end if;
  return json_build_object(
    'id', c.id, 'kind', c.kind, 'title', c.title, 'brief', c.brief, 'rules', c.rules, 'category', c.category, 'country', c.country,
    'entries_open_at', c.entries_open_at, 'voting_opens_at', c.voting_opens_at, 'voting_closes_at', c.voting_closes_at,
    'phase', competition_phase(c), 'results', c.results,
    'entries', coalesce((select json_agg(json_build_object('id', e.id, 'artwork', e.artwork_id, 'mine', e.user_id = auth.uid()) order by e.created_at)
                         from competition_entries e join artworks w on w.id = e.artwork_id
                         where e.competition_id = c.id and not w.hidden), '[]'::json),
    'my_vote', (select v.entry_id from competition_votes v where v.competition_id = c.id and v.user_id = auth.uid()),
    'can_vote', voting_eligibility(auth.uid()) is null,
    'vote_blocker', voting_eligibility(auth.uid())
  );
end $$;
revoke all on function public.competition_detail(uuid) from public;
grant execute on function public.competition_detail(uuid) to anon, authenticated;

create or replace function public.mark_notifications_read() returns void
language sql security definer set search_path = public as $$
  update notifications set read_at = now() where user_id = auth.uid() and read_at is null
$$;

-- Grants for the member and moderator functions.
revoke all on function public.create_competition(text, text, text, text, text, text, timestamptz, timestamptz, timestamptz) from public, anon;
grant execute on function public.create_competition(text, text, text, text, text, text, timestamptz, timestamptz, timestamptz) to authenticated;
revoke all on function public.cancel_competition(uuid, text) from public, anon;
grant execute on function public.cancel_competition(uuid, text) to authenticated;
revoke all on function public.enter_competition(uuid, text) from public, anon;
grant execute on function public.enter_competition(uuid, text) to authenticated;
revoke all on function public.withdraw_entry(uuid) from public, anon;
grant execute on function public.withdraw_entry(uuid) to authenticated;
revoke all on function public.cast_competition_vote(uuid, uuid) from public, anon;
grant execute on function public.cast_competition_vote(uuid, uuid) to authenticated;
revoke all on function public.mark_notifications_read() from public, anon;
grant execute on function public.mark_notifications_read() to authenticated;

-- Close competitions on time where pg_cron is available (every 10 minutes).
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('abremi-competitions', '*/10 * * * *', 'select public.close_due_competitions();');
  end if;
exception when others then
  raise notice 'Schedule not set up (%). Competitions close when someone opens the Arena instead.', sqlerrm;
end $$;
