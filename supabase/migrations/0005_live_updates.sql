-- Abremi live updates.
--
-- 1. community_pulse: one public row whose version goes up whenever likes, saves, follows,
--    reviews, battle ratings or uploads change. Apps subscribe to it with Supabase Realtime and
--    refetch community_snapshot() (totals only). No individual vote is ever broadcast.
-- 2. community_history: the public totals, kept once an hour, so every app compares the
--    current chart with the same previous hourly chart ("▲ 3 since 3 PM"). Real data only:
--    when there is no earlier chart from the last 24 hours, no movement is shown.

-- ——— 1. Pulse ———
create table if not exists public.community_pulse (
  id smallint primary key default 1 check (id = 1),
  version bigint not null default 0,
  changed_at timestamptz not null default now()
);
insert into public.community_pulse (id) values (1) on conflict (id) do nothing;
alter table public.community_pulse enable row level security;
drop policy if exists "pulse is public" on public.community_pulse;
create policy "pulse is public" on public.community_pulse for select using (true);
revoke insert, update, delete, truncate on public.community_pulse from anon, authenticated;
grant select on public.community_pulse to anon, authenticated;

-- At most one bump per second, so a burst of votes doesn't make every app refetch for each
-- one. Apps refetch 1.5 seconds after a bump, which also picks up changes the throttle skipped.
create or replace function public.bump_community_pulse() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update community_pulse set version = version + 1, changed_at = clock_timestamp()
   where id = 1 and changed_at < clock_timestamp() - interval '1 second';
  return null;
end $$;
revoke all on function public.bump_community_pulse() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['reactions', 'reviews', 'follows', 'artwork_ratings', 'artworks', 'artists', 'profiles'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_pulse', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each statement execute function public.bump_community_pulse()', t || '_pulse', t);
  end loop;
end $$;

-- Let Supabase Realtime send changes to the pulse row (it respects the select policy above).
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime' and not puballtables)
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'community_pulse') then
    alter publication supabase_realtime add table public.community_pulse;
  end if;
end $$;

-- ——— 2. Hourly charts ———
create table if not exists public.community_history (
  hour timestamptz primary key,          -- the hour this chart belongs to
  taken_at timestamptz not null default now(),
  snapshot jsonb not null                -- community_snapshot() totals, without the upload list
);
alter table public.community_history enable row level security;
drop policy if exists "history is public" on public.community_history;
create policy "history is public" on public.community_history for select using (true);
revoke insert, update, delete, truncate on public.community_history from anon, authenticated;
grant select on public.community_history to anon, authenticated;

-- Keeps this hour's chart if it hasn't been kept yet, and drops charts older than 8 days.
create or replace function public.take_community_history() returns void
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from community_history where hour = date_trunc('hour', now())) then
    return;
  end if;
  insert into community_history (hour, snapshot)
  values (date_trunc('hour', now()), community_snapshot()::jsonb - 'uploads' - 'artists')
  on conflict (hour) do nothing;
  delete from community_history where hour < now() - interval '8 days';
end $$;
revoke all on function public.take_community_history() from public, anon, authenticated;

-- The chart to compare against: the latest one from an earlier hour, at most 24 hours old.
-- Also keeps this hour's chart, so charts exist even where pg_cron isn't available.
create or replace function public.chart_baseline() returns json
language plpgsql security definer set search_path = public as $$
declare
  b public.community_history;
begin
  perform take_community_history();
  select * into b from community_history
   where hour < date_trunc('hour', now()) and hour >= date_trunc('hour', now()) - interval '24 hours'
   order by hour desc limit 1;
  if b.hour is null then
    return null;
  end if;
  return json_build_object('hour', b.hour, 'taken_at', b.taken_at, 'snapshot', b.snapshot);
end $$;
revoke all on function public.chart_baseline() from public;
grant execute on function public.chart_baseline() to anon, authenticated;

-- Keep a chart at the top of every hour when pg_cron is available (it is on Supabase).
do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('abremi-hourly-chart', '0 * * * *', 'select public.take_community_history()');
  end if;
exception when others then
  raise notice 'Hourly schedule not set up (%). Charts are kept on the first visit each hour instead.', sqlerrm;
end $$;
