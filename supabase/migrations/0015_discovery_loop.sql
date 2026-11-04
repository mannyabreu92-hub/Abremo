-- Abremi Phase 8: the discovery-to-ownership loop.
--
--   1. Offers: a purchase inquiry can carry an offer (amount and currency). Same rules as every
--      inquiry (accounts 3+ days old, daily limits, blocks, never sample artists, never your own
--      work, only works that are available or on request). Nothing is charged: the artist replies.
--   2. Waitlist: "Notify me" for works that aren't available. Private to the member.
--   3. Alerts: when a work becomes available or changes price, everyone who treasured it or joined
--      its waitlist is told once; when an artist announces a drop, members who treasured their work
--      (and don't already follow them) are told too.
--   4. Collector interests: mediums, regions and a price limit, used for the member's own Discover
--      deck and the Guide. Private; never used for rankings.

-- ——— 1. Offers ———
alter table public.inquiries add column if not exists offer_amount numeric(12, 2) check (offer_amount is null or offer_amount > 0);
alter table public.inquiries add column if not exists offer_currency text check (offer_currency is null or offer_currency ~ '^[A-Z]{3}$');

create or replace function public.send_offer(p_artwork text, p_amount numeric, p_currency text, p_message text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  cur text := upper(btrim(coalesce(p_currency, 'USD')));
  q uuid;
  w public.artworks;
begin
  if p_amount is null or p_amount <= 0 or p_amount > 10000000 then
    raise exception 'Enter an offer between 1 and 10,000,000' using errcode = '22023';
  end if;
  if cur !~ '^[A-Z]{3}$' then
    raise exception 'Use a three-letter currency code, like USD' using errcode = '22023';
  end if;
  select * into w from artworks where id = p_artwork;
  -- send_inquiry applies every inquiry rule (and checks the work is available or on request).
  q := send_inquiry(p_artwork, null, 'purchase', p_message);
  update inquiries set offer_amount = round(p_amount, 2), offer_currency = cur where id = q;
  update notifications set title = (select name from profiles where id = auth.uid()) || ' made an offer of ' || cur || ' '
                                   || to_char(round(p_amount, 2), 'FM999,999,990.00') || ' for “' || w.title || '”'
   where link = 'inquiry/' || q and kind = 'inquiry';
  return q;
end $$;

-- The inquiry lists show the offer.
create or replace function public.inquiry_offer(p_id uuid) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('amount', offer_amount, 'currency', offer_currency)
  from inquiries where id = p_id and offer_amount is not null and auth.uid() in (artist_user, sender_id)
$$;

-- ——— 2. Waitlist ———
create table if not exists public.artwork_watches (
  user_id uuid not null references public.profiles (id) on delete cascade,
  artwork_id text not null references public.artworks (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, artwork_id)
);
alter table public.artwork_watches enable row level security;
drop policy if exists "read own watches" on public.artwork_watches;
create policy "read own watches" on public.artwork_watches for select using (user_id = auth.uid());
revoke all on public.artwork_watches from anon, authenticated;
grant select on public.artwork_watches to authenticated;

create or replace function public.watch_artwork(p_id text, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if p_on then
    if (select count(*) from artwork_watches where user_id = auth.uid()) >= 200 then
      raise exception 'You can follow 200 works at a time' using errcode = 'P0001';
    end if;
    insert into artwork_watches (user_id, artwork_id)
    select auth.uid(), id from artworks where id = p_id and owner_id is not null and owner_id <> auth.uid() and not hidden
    on conflict do nothing;
    if not found and not exists (select 1 from artwork_watches where user_id = auth.uid() and artwork_id = p_id) then
      raise exception 'You can’t follow this work' using errcode = '22023';
    end if;
  else
    delete from artwork_watches where user_id = auth.uid() and artwork_id = p_id;
  end if;
end $$;

create or replace function public.my_watches() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(artwork_id order by created_at desc), '[]'::json) from artwork_watches where user_id = auth.uid()
$$;

-- ——— 3. Alerts ———
create or replace function public.alert_artwork_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  -- Read fields by name, so undoing older migrations (which drop columns) never breaks updates.
  n jsonb := to_jsonb(new);
  o jsonb := to_jsonb(old);
  became_available boolean := coalesce(n->>'availability', 'available') in ('available', 'on_request')
                              and coalesce(o->>'availability', 'available') not in ('available', 'on_request');
  new_price boolean := (n->>'price') is distinct from (o->>'price') and coalesce(n->>'availability', 'available') in ('available', 'on_request');
begin
  if new.owner_id is null or coalesce((n->>'hidden')::boolean, false) or coalesce((n->>'release_at')::timestamptz > now(), false)
     or not (became_available or new_price) then
    return new;
  end if;
  insert into notifications (user_id, kind, title, link)
  select distinct u, 'artwork_alert',
         case when became_available then '“' || new.title || '” is now available' else '“' || new.title || '” has a new price' end,
         'art/' || new.id
  from (select user_id as u from reactions where artwork_id = new.id and kind = 'super'
        union select user_id from artwork_watches where artwork_id = new.id) x
  where u <> new.owner_id;
  return new;
end $$;
revoke all on function public.alert_artwork_change() from public, anon, authenticated;
drop trigger if exists abremi_alert_artwork_change on public.artworks;
-- No column list, so older migrations can still be undone; the function checks what changed.
create trigger abremi_alert_artwork_change after update on public.artworks
  for each row execute function public.alert_artwork_change();

create or replace function public.alert_drop_to_treasurers() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into notifications (user_id, kind, title, link)
  select distinct r.user_id, 'drop_announced',
         (select name from artists where id = new.artist_id) || ', whose work you treasured, announced a drop: “' || new.title || '”',
         'drop/' || new.id
  from reactions r join artworks w on w.id = r.artwork_id
  where w.artist_id = new.artist_id and r.kind = 'super' and r.user_id <> new.owner_id
    and not exists (select 1 from follows f where f.user_id = r.user_id and f.artist_id = new.artist_id);
  return new;
end $$;
revoke all on function public.alert_drop_to_treasurers() from public, anon, authenticated;
drop trigger if exists abremi_alert_drop_to_treasurers on public.drops;
create trigger abremi_alert_drop_to_treasurers after insert on public.drops
  for each row execute function public.alert_drop_to_treasurers();

-- ——— 4. Collector interests ———
alter table public.profiles add column if not exists discovery_interests jsonb not null default '{}'::jsonb
  check (jsonb_typeof(discovery_interests) = 'object' and pg_column_size(discovery_interests) < 2000);

create or replace function public.set_discovery_interests(p_mediums text[], p_regions text[], p_price_max integer) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_mediums), 0) > 9 or coalesce(cardinality(p_regions), 0) > 12 then
    raise exception 'Choose fewer interests' using errcode = '22023';
  end if;
  if p_price_max is not null and p_price_max not between 1 and 10000000 then
    raise exception 'Choose a price limit between 1 and 10,000,000' using errcode = '22023';
  end if;
  update profiles set discovery_interests = jsonb_build_object(
      'mediums', coalesce((select jsonb_agg(m) from unnest(p_mediums) m where m ~ '^[a-z]{2,20}$'), '[]'::jsonb),
      'regions', coalesce((select jsonb_agg(r) from unnest(p_regions) r where r ~ '^[A-Z]{2}$'), '[]'::jsonb),
      'price_max', p_price_max,
      'updated_at', now())
   where id = auth.uid();
end $$;

-- The member's own interests (and whether they allow personalization, for the Guide).
create or replace function public.my_discovery_interests() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('interests', discovery_interests, 'personalize', assistant_personalize) from profiles where id = auth.uid()
$$;

-- ——— Grants ———
do $$
declare f text;
begin
  foreach f in array array['send_offer(text, numeric, text, text)', 'inquiry_offer(uuid)', 'watch_artwork(text, boolean)', 'my_watches()',
                           'set_discovery_interests(text[], text[], integer)', 'my_discovery_interests()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
