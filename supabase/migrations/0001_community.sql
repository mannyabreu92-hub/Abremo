-- Gabangi community schema
-- Accounts, reactions, follows, reviews and Art Battles shared by everyone.
--
-- Security model
--   * Row Level Security on every table: people read and write only their own rows.
--   * A reaction's role (fan / artist / critic / collector) is stamped by the server from
--     the profile, never trusted from the client, so nobody can fake a heavier vote.
--   * Critic and Collector roles can only be granted by the service role (an admin).
--   * Battle ratings change only through cast_battle_vote(), which is rate limited.
--   * Community totals are exposed as aggregates only (community_snapshot()).

-- ——— Catalog (filled by supabase/seed.sql) ———
create table if not exists public.artists (
  id text primary key,
  name text not null,
  country text not null
);

create table if not exists public.artworks (
  id text primary key,
  artist_id text not null references public.artists (id) on delete cascade,
  title text not null,
  base_elo integer not null
);
create index if not exists artworks_artist_idx on public.artworks (artist_id);

-- ——— Roles ———
create or replace function public.role_weight(r text) returns integer
language sql immutable as $$
  select case r when 'fan' then 1 when 'artist' then 3 when 'critic' then 5 when 'collector' then 9 end
$$;

-- ——— Profiles ———
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null default 'Collector' check (char_length(name) between 1 and 40),
  country text not null default 'US' check (country ~ '^[A-Z]{2}$'),
  role text not null default 'fan' check (role in ('fan', 'artist', 'critic', 'collector')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.guard_profile() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.id <> old.id then
    raise exception 'Profile id cannot change' using errcode = '42501';
  end if;
  if new.role in ('critic', 'collector')
     and (tg_op = 'INSERT' or new.role is distinct from old.role)
     and coalesce(auth.role(), '') <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'Critic and Collector roles require verification' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before insert or update on public.profiles
  for each row execute function public.guard_profile();

-- Every new account gets a profile.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(nullif(left(split_part(coalesce(new.email, ''), '@', 1), 40), ''), 'Collector'))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Accounts created before this migration, and a self-healing call for the client.
insert into public.profiles (id) select id from auth.users on conflict (id) do nothing;

create or replace function public.ensure_profile() returns public.profiles
language plpgsql security definer set search_path = public as $$
declare p public.profiles;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  insert into public.profiles (id) values (auth.uid()) on conflict (id) do nothing;
  select * into p from public.profiles where id = auth.uid();
  return p;
end $$;

-- Stamp the voter's current role onto their contribution.
create or replace function public.stamp_role() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select role into new.role from public.profiles where id = new.user_id;
  if new.role is null then
    raise exception 'Profile missing' using errcode = '42501';
  end if;
  return new;
end $$;

-- ——— Reactions: like / save (super) / pass ———
create table if not exists public.reactions (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  artwork_id text not null references public.artworks (id) on delete cascade,
  kind text not null check (kind in ('like', 'super', 'pass')),
  role text not null default 'fan',
  created_at timestamptz not null default now(),
  primary key (user_id, artwork_id)
);
create index if not exists reactions_artwork_idx on public.reactions (artwork_id);

drop trigger if exists reactions_stamp on public.reactions;
create trigger reactions_stamp before insert or update on public.reactions
  for each row execute function public.stamp_role();

-- ——— Follows ———
create table if not exists public.follows (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  artist_id text not null references public.artists (id) on delete cascade,
  role text not null default 'fan',
  created_at timestamptz not null default now(),
  primary key (user_id, artist_id)
);
create index if not exists follows_artist_idx on public.follows (artist_id);

drop trigger if exists follows_stamp on public.follows;
create trigger follows_stamp before insert or update on public.follows
  for each row execute function public.stamp_role();

-- ——— Critic reviews (public) ———
create table if not exists public.reviews (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  artwork_id text not null references public.artworks (id) on delete cascade,
  rating integer not null check (rating between 1 and 5),
  body text not null default '' check (char_length(body) <= 500),
  role text not null default 'critic',
  created_at timestamptz not null default now(),
  primary key (user_id, artwork_id)
);

drop trigger if exists reviews_stamp on public.reviews;
create trigger reviews_stamp before insert or update on public.reviews
  for each row execute function public.stamp_role();

-- ——— Art Battles ———
create table if not exists public.artwork_ratings (
  artwork_id text primary key references public.artworks (id) on delete cascade,
  rating integer not null,
  votes integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.battle_votes (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  winner_id text not null references public.artworks (id) on delete cascade,
  loser_id text not null references public.artworks (id) on delete cascade,
  role text not null,
  gain integer not null,
  loss integer not null,
  created_at timestamptz not null default now()
);
create index if not exists battle_votes_user_idx on public.battle_votes (user_id, created_at desc);

-- Same maths as src/core/elo.js: K = 16 + 4 × role weight; the loser drops 75% of the gain.
create or replace function public.cast_battle_vote(p_winner text, p_loser text)
returns table (winner_rating integer, loser_rating integer, gain integer, loss integer, crowd integer)
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  voter_role text;
  winner_artist text;
  loser_artist text;
  wr integer;
  lr integer;
  k integer;
  expected double precision;
  g integer;
  l integer;
begin
  if uid is null then
    raise exception 'Sign in to vote' using errcode = '42501';
  end if;
  select role into voter_role from profiles where id = uid;
  if voter_role is null then
    raise exception 'Profile missing' using errcode = '42501';
  end if;
  select artist_id into winner_artist from artworks where id = p_winner;
  select artist_id into loser_artist from artworks where id = p_loser;
  if winner_artist is null or loser_artist is null or p_winner = p_loser then
    raise exception 'Unknown artworks' using errcode = '22023';
  end if;
  if winner_artist = loser_artist then
    raise exception 'Battles are between different artists' using errcode = '22023';
  end if;
  if exists (select 1 from battle_votes v where v.user_id = uid and v.created_at > now() - interval '1 second') then
    raise exception 'Slow down — one vote per second' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from battle_votes v
    where v.user_id = uid and v.created_at > now() - interval '10 minutes'
      and least(v.winner_id, v.loser_id) = least(p_winner, p_loser)
      and greatest(v.winner_id, v.loser_id) = greatest(p_winner, p_loser)
  ) then
    raise exception 'You already judged this pair' using errcode = 'P0001';
  end if;

  insert into artwork_ratings (artwork_id, rating)
    select id, base_elo from artworks where id in (p_winner, p_loser)
    on conflict (artwork_id) do nothing;
  -- Lock both rows in a fixed order so concurrent votes cannot deadlock.
  perform 1 from artwork_ratings where artwork_id in (p_winner, p_loser) order by artwork_id for update;
  select rating into wr from artwork_ratings where artwork_id = p_winner;
  select rating into lr from artwork_ratings where artwork_id = p_loser;

  k := 16 + 4 * role_weight(voter_role);
  expected := 1 / (1 + power(10::double precision, (lr - wr) / 400.0));
  g := greatest(1, round((k * (1 - expected))::numeric)::integer);
  l := floor(g * 0.75)::integer;

  update artwork_ratings set rating = rating + g, votes = votes + 1, updated_at = now() where artwork_id = p_winner;
  update artwork_ratings set rating = rating - l, votes = votes + 1, updated_at = now() where artwork_id = p_loser;
  insert into battle_votes (user_id, winner_id, loser_id, role, gain, loss) values (uid, p_winner, p_loser, voter_role, g, l);

  return query select wr + g, lr - l, g, l, round((expected * 100)::numeric)::integer;
end $$;

-- ——— Community totals (aggregates only; individual rows stay private) ———
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
    'members', (select count(*)::int from profiles)
  )
$$;

-- ——— Row Level Security ———
alter table public.artists enable row level security;
alter table public.artworks enable row level security;
alter table public.profiles enable row level security;
alter table public.reactions enable row level security;
alter table public.follows enable row level security;
alter table public.reviews enable row level security;
alter table public.artwork_ratings enable row level security;
alter table public.battle_votes enable row level security;

drop policy if exists "catalog is public" on public.artists;
create policy "catalog is public" on public.artists for select using (true);
drop policy if exists "catalog is public" on public.artworks;
create policy "catalog is public" on public.artworks for select using (true);
drop policy if exists "ratings are public" on public.artwork_ratings;
create policy "ratings are public" on public.artwork_ratings for select using (true);

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles for select using (id = auth.uid());
drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "own reactions" on public.reactions;
create policy "own reactions" on public.reactions for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own follows" on public.follows;
create policy "own follows" on public.follows for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "reviews are public" on public.reviews;
create policy "reviews are public" on public.reviews for select using (true);
drop policy if exists "critics write reviews" on public.reviews;
create policy "critics write reviews" on public.reviews for insert
  with check (user_id = auth.uid() and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'critic'));
drop policy if exists "delete own reviews" on public.reviews;
create policy "delete own reviews" on public.reviews for delete using (user_id = auth.uid());

drop policy if exists "read own votes" on public.battle_votes;
create policy "read own votes" on public.battle_votes for select using (user_id = auth.uid());

-- ——— Grants ———
grant usage on schema public to anon, authenticated;
grant select on public.artists, public.artworks, public.artwork_ratings, public.reviews to anon, authenticated;
grant select, update (name, country, role) on public.profiles to authenticated;
grant select, insert, update, delete on public.reactions, public.follows to authenticated;
grant insert, delete on public.reviews to authenticated;
grant select on public.battle_votes to authenticated;
revoke insert, update, delete on public.artwork_ratings, public.battle_votes from anon, authenticated;
revoke all on function public.cast_battle_vote(text, text) from public, anon;
grant execute on function public.cast_battle_vote(text, text) to authenticated;
revoke all on function public.ensure_profile() from public, anon;
grant execute on function public.ensure_profile() to authenticated;
grant execute on function public.community_snapshot() to anon, authenticated;
