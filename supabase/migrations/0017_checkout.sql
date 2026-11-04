-- Abremi: real checkout (switched off until reviewed), the commission model and editions.
--
--   * Buyers pay through Stripe Checkout; artists are paid by Stripe Connect Express (Stripe verifies
--     them, holds the funds and pays them out). Abremi keeps a 20% commission and never holds
--     artists' money. Taxes are not calculated here (handled with the owner's accountant).
--   * The database decides what can be bought (orders are created by begin_purchase(), as the
--     buyer); only the signed Stripe webhook, with the service role, can mark an order paid.
--   * Editions: prints made and shipped by the artist, one numbered print per order.
--   * After payment: the artist ships with tracking, the buyer confirms delivery, and within 14 days
--     of delivery the buyer can report a problem; moderators decide (refunds are made in Stripe).
--   * Verified sales appear on the Artist Passport.
-- Switched on only when app_settings.sales_enabled is true AND SALES_ENABLED=true in Vercel.

alter table public.app_settings add column if not exists sales_enabled boolean not null default false;
create or replace function public.app_flags() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('invite_required', invite_required, 'payments_enabled', payments_enabled, 'sales_enabled', sales_enabled) from app_settings
$$;

-- ——— Editions ———
alter table public.artworks add column if not exists edition_size integer check (edition_size is null or edition_size between 2 and 500);
alter table public.artworks add column if not exists editions_sold integer not null default 0 check (editions_sold >= 0);

create or replace function public.set_edition(p_artwork text, p_size integer) returns void
language plpgsql security definer set search_path = public as $$
declare w public.artworks;
begin
  select * into w from artworks where id = p_artwork and owner_id = auth.uid();
  if w.id is null then
    raise exception 'Not your artwork' using errcode = '42501';
  end if;
  if p_size is not null and (p_size not between 2 and 500 or p_size < w.editions_sold) then
    raise exception 'An edition has 2 to 500 prints, and no fewer than already sold' using errcode = '22023';
  end if;
  if p_size is null and w.editions_sold > 0 then
    raise exception 'Prints of this edition have been sold' using errcode = '22023';
  end if;
  update artworks set edition_size = p_size where id = w.id;
end $$;

-- ——— Payout accounts (Stripe Connect Express) ———
create table if not exists public.payout_accounts (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  stripe_account text not null unique check (stripe_account ~ '^acct_[A-Za-z0-9]+$'),
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.payout_accounts enable row level security;
drop policy if exists "read own payout account" on public.payout_accounts;
create policy "read own payout account" on public.payout_accounts for select using (user_id = auth.uid());
revoke all on public.payout_accounts from anon, authenticated;

create or replace function public.my_payout_status() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('connected', p.user_id is not null, 'charges_enabled', coalesce(p.charges_enabled, false),
                           'payouts_enabled', coalesce(p.payouts_enabled, false), 'details_submitted', coalesce(p.details_submitted, false))
  from (select auth.uid() as uid) me left join payout_accounts p on p.user_id = me.uid
  where auth.uid() is not null
$$;

-- Artists who can be paid (public: just ids, so the app can show "Buy").
create or replace function public.artists_accepting_payments() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(ar.id), '[]'::json) from artists ar join payout_accounts p on p.user_id = ar.owner_id
  where p.charges_enabled and (select sales_enabled from app_settings)
$$;

-- Service role only: the server function records the account and its status.
create or replace function public.set_payout_account(p_user uuid, p_account text, p_charges boolean, p_payouts boolean, p_details boolean) returns void
language sql security definer set search_path = public as $$
  insert into payout_accounts (user_id, stripe_account, charges_enabled, payouts_enabled, details_submitted, updated_at)
  values (p_user, p_account, coalesce(p_charges, false), coalesce(p_payouts, false), coalesce(p_details, false), now())
  on conflict (user_id) do update set stripe_account = excluded.stripe_account, charges_enabled = excluded.charges_enabled,
    payouts_enabled = excluded.payouts_enabled, details_submitted = excluded.details_submitted, updated_at = now()
$$;
create or replace function public.update_payout_status(p_account text, p_charges boolean, p_payouts boolean, p_details boolean) returns void
language sql security definer set search_path = public as $$
  update payout_accounts set charges_enabled = coalesce(p_charges, false), payouts_enabled = coalesce(p_payouts, false),
    details_submitted = coalesce(p_details, false), updated_at = now() where stripe_account = p_account
$$;
create or replace function public.payout_account_for(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select stripe_account from payout_accounts where user_id = p_user
$$;

-- ——— Orders ———
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  artwork_id text references public.artworks (id) on delete set null,
  title text not null,
  artist_id text not null references public.artists (id) on delete cascade,
  artist_user uuid not null references public.profiles (id) on delete cascade,
  buyer_id uuid not null references public.profiles (id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  fee_cents integer not null check (fee_cents >= 0),
  currency text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  edition_number integer,
  status text not null default 'pending' check (status in ('pending', 'paid', 'shipped', 'delivered', 'disputed', 'refunded', 'cancelled')),
  checkout_session text unique,
  payment_intent text,
  shipping jsonb,
  carrier text check (char_length(coalesce(carrier, '')) <= 60),
  tracking text check (char_length(coalesce(tracking, '')) <= 100),
  dispute_reason text check (char_length(coalesce(dispute_reason, '')) <= 1000),
  dispute_resolution text check (char_length(coalesce(dispute_resolution, '')) <= 1000),
  created_at timestamptz not null default now(),
  paid_at timestamptz, shipped_at timestamptz, delivered_at timestamptz, updated_at timestamptz not null default now(),
  check (artist_user <> buyer_id)
);
create index if not exists orders_buyer_idx on public.orders (buyer_id, created_at desc);
create index if not exists orders_artist_idx on public.orders (artist_user, created_at desc);
alter table public.orders enable row level security;
drop policy if exists "the two people read an order" on public.orders;
create policy "the two people read an order" on public.orders for select using (auth.uid() in (buyer_id, artist_user));
revoke all on public.orders from anon, authenticated;
grant select on public.orders to authenticated;

-- Starts a purchase as the buyer: the database checks everything and creates a pending order.
create or replace function public.begin_purchase(p_artwork text) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  w public.artworks;
  ar public.artists;
  o public.orders;
  open_orders integer;
begin
  if not (select sales_enabled from app_settings) then
    raise exception 'Buying isn’t switched on yet' using errcode = '42501';
  end if;
  if uid is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if (select created_at from profiles where id = uid) > now() - interval '3 days' then
    raise exception 'New accounts can buy after 3 days' using errcode = '42501';
  end if;
  update orders set status = 'cancelled', updated_at = now() where status = 'pending' and created_at < now() - interval '1 hour';
  select * into w from artworks where id = p_artwork;
  if w.id is null or w.hidden or (w.release_at is not null and w.release_at > now()) or w.owner_id is null then
    raise exception 'Artwork not found' using errcode = 'P0002';
  end if;
  if w.owner_id = uid then
    raise exception 'That’s your own work' using errcode = '22023';
  end if;
  if coalesce(w.availability, 'available') <> 'available' or coalesce(w.price, 0) <= 0 then
    raise exception 'This work isn’t for sale at a listed price' using errcode = '22023';
  end if;
  select * into ar from artists where id = w.artist_id;
  if not exists (select 1 from payout_accounts p where p.user_id = w.owner_id and p.charges_enabled) then
    raise exception 'This artist can’t take payments yet. Ask them about it instead.' using errcode = '22023';
  end if;
  if is_blocked_between(uid, w.owner_id) then
    raise exception 'You can’t buy from this member' using errcode = '42501';
  end if;
  if (select count(*) from orders where buyer_id = uid and status = 'pending') >= 5 then
    raise exception 'Finish or cancel your other checkouts first' using errcode = 'P0001';
  end if;
  select count(*) into open_orders from orders where artwork_id = w.id and status in ('pending', 'paid', 'shipped', 'delivered', 'disputed');
  if w.edition_size is null and open_orders > 0 then
    raise exception 'Someone is already buying this work' using errcode = 'P0001';
  end if;
  if w.edition_size is not null and open_orders >= w.edition_size then
    raise exception 'This edition is sold out' using errcode = 'P0001';
  end if;
  insert into orders (artwork_id, title, artist_id, artist_user, buyer_id, amount_cents, fee_cents)
  values (w.id, w.title || case when w.edition_size is not null then ' (print, edition of ' || w.edition_size || ')' else '' end,
          ar.id, w.owner_id, uid, w.price * 100, round(w.price * 100 * 0.20))
  returning * into o;
  return json_build_object('order_id', o.id, 'title', o.title, 'amount_cents', o.amount_cents, 'fee_cents', o.fee_cents, 'currency', o.currency);
end $$;

-- Service role only: where the money goes, and recording the Checkout session.
create or replace function public.order_payout_target(p_order uuid) returns text
language sql stable security definer set search_path = public as $$
  select p.stripe_account from orders o join payout_accounts p on p.user_id = o.artist_user where o.id = p_order and o.status = 'pending' and p.charges_enabled
$$;
create or replace function public.attach_checkout_session(p_order uuid, p_session text) returns void
language sql security definer set search_path = public as $$
  update orders set checkout_session = p_session, updated_at = now() where id = p_order and status = 'pending'
$$;

-- Service role only (the signed webhook): the payment succeeded. Applied once; the amount must match.
create or replace function public.complete_order(p_session text, p_payment_intent text, p_amount integer, p_shipping jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare o public.orders; w public.artworks; n integer;
begin
  select * into o from orders where checkout_session = p_session for update;
  if o.id is null then return 'unknown session'; end if;
  if o.status <> 'pending' then return 'already ' || o.status; end if;
  if p_amount is distinct from o.amount_cents then
    raise exception 'Amount mismatch for order %', o.id using errcode = '22023';
  end if;
  select * into w from artworks where id = o.artwork_id for update;
  if w.edition_size is not null then
    n := w.editions_sold + 1;
    update artworks set editions_sold = n, availability = case when n >= w.edition_size then 'sold' else availability end where id = w.id;
  elsif w.id is not null then
    update artworks set availability = 'sold' where id = w.id;
  end if;
  update orders set status = 'paid', payment_intent = p_payment_intent, shipping = p_shipping, edition_number = n, paid_at = now(), updated_at = now()
   where id = o.id;
  insert into notifications (user_id, kind, title, link) values
    (o.artist_user, 'sale', 'You sold “' || o.title || '”. Ship it and add tracking in Orders.', 'orders'),
    (o.buyer_id, 'purchase', 'Your purchase of “' || o.title || '” is confirmed. The artist will ship it.', 'orders');
  return 'paid';
end $$;

create or replace function public.refund_order(p_payment_intent text) returns text
language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  update orders set status = 'refunded', updated_at = now() where payment_intent = p_payment_intent and status <> 'refunded' returning * into o;
  if o.id is null then return 'unknown or already refunded'; end if;
  insert into notifications (user_id, kind, title, link) values
    (o.buyer_id, 'purchase', '“' || o.title || '” was refunded.', 'orders'), (o.artist_user, 'sale', '“' || o.title || '” was refunded to the buyer.', 'orders');
  return 'refunded';
end $$;

-- Both people's orders. Shipping addresses are shown to the artist (to ship) and the buyer only.
create or replace function public.my_orders() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'sales', coalesce((select json_agg(json_build_object('id', o.id, 'artwork_id', o.artwork_id, 'title', o.title, 'amount_cents', o.amount_cents, 'fee_cents', o.fee_cents,
              'currency', o.currency, 'edition_number', o.edition_number, 'status', o.status, 'shipping', o.shipping, 'carrier', o.carrier, 'tracking', o.tracking,
              'buyer', (select name from profiles where id = o.buyer_id), 'paid_at', o.paid_at, 'shipped_at', o.shipped_at, 'delivered_at', o.delivered_at,
              'dispute_reason', o.dispute_reason, 'dispute_resolution', o.dispute_resolution) order by o.created_at desc)
              from orders o where o.artist_user = auth.uid() and o.status not in ('pending', 'cancelled')), '[]'::json),
    'purchases', coalesce((select json_agg(json_build_object('id', o.id, 'artwork_id', o.artwork_id, 'title', o.title, 'amount_cents', o.amount_cents,
              'currency', o.currency, 'edition_number', o.edition_number, 'status', o.status, 'carrier', o.carrier, 'tracking', o.tracking,
              'artist', (select name from artists where id = o.artist_id), 'paid_at', o.paid_at, 'shipped_at', o.shipped_at, 'delivered_at', o.delivered_at,
              'dispute_reason', o.dispute_reason, 'dispute_resolution', o.dispute_resolution,
              'can_dispute', o.status in ('paid', 'shipped') or (o.status = 'delivered' and o.delivered_at > now() - interval '14 days')) order by o.created_at desc)
              from orders o where o.buyer_id = auth.uid() and o.status not in ('pending', 'cancelled')), '[]'::json))
  where auth.uid() is not null
$$;

create or replace function public.mark_shipped(p_order uuid, p_carrier text, p_tracking text) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  if char_length(btrim(coalesce(p_carrier, ''))) < 2 or char_length(btrim(coalesce(p_tracking, ''))) < 4 then
    raise exception 'Add the carrier and tracking number' using errcode = '22023';
  end if;
  update orders set status = 'shipped', carrier = btrim(p_carrier), tracking = btrim(p_tracking), shipped_at = now(), updated_at = now()
   where id = p_order and artist_user = auth.uid() and status = 'paid' returning * into o;
  if o.id is null then raise exception 'That order can’t be marked shipped' using errcode = 'P0001'; end if;
  insert into notifications (user_id, kind, title, link) values (o.buyer_id, 'purchase', '“' || o.title || '” has shipped (' || o.carrier || ' ' || o.tracking || ')', 'orders');
end $$;

create or replace function public.confirm_delivery(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  update orders set status = 'delivered', delivered_at = now(), updated_at = now()
   where id = p_order and buyer_id = auth.uid() and status = 'shipped' returning * into o;
  if o.id is null then raise exception 'That order can’t be marked delivered' using errcode = 'P0001'; end if;
  insert into notifications (user_id, kind, title, link) values (o.artist_user, 'sale', 'The buyer received “' || o.title || '”', 'orders');
end $$;

-- The buyer reports a problem: before delivery, or within 14 days after it. Moderators decide.
create or replace function public.open_dispute(p_order uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'Describe the problem (at least 10 characters)' using errcode = '22023';
  end if;
  update orders set status = 'disputed', dispute_reason = btrim(p_reason), updated_at = now()
   where id = p_order and buyer_id = auth.uid()
     and (status in ('paid', 'shipped') or (status = 'delivered' and delivered_at > now() - interval '14 days'))
  returning * into o;
  if o.id is null then raise exception 'Problems can be reported until 14 days after delivery' using errcode = 'P0001'; end if;
  insert into notifications (user_id, kind, title, link) values (o.artist_user, 'sale', 'The buyer reported a problem with “' || o.title || '”. A moderator will look at it.', 'orders');
  insert into notifications (user_id, kind, title, link) select user_id, 'dispute', 'A buyer reported a problem with an order', 'admin' from admins;
end $$;

create or replace function public.admin_disputes() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only' using errcode = '42501'; end if;
  return coalesce((select json_agg(json_build_object('id', o.id, 'title', o.title, 'amount_cents', o.amount_cents, 'currency', o.currency,
            'artist', (select name from artists where id = o.artist_id), 'buyer', (select name from profiles where id = o.buyer_id),
            'reason', o.dispute_reason, 'paid_at', o.paid_at, 'shipped_at', o.shipped_at, 'delivered_at', o.delivered_at,
            'carrier', o.carrier, 'tracking', o.tracking, 'payment_intent', o.payment_intent) order by o.updated_at)
          from orders o where o.status = 'disputed'), '[]'::json);
end $$;

-- A moderator's decision. A refund itself is made in the Stripe dashboard (the webhook then records it).
create or replace function public.resolve_dispute(p_order uuid, p_refund boolean, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  if not is_admin() then raise exception 'Admins only' using errcode = '42501'; end if;
  update orders set dispute_resolution = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now(),
         status = case when p_refund then 'disputed' when delivered_at is not null then 'delivered' when shipped_at is not null then 'shipped' else 'paid' end
   where id = p_order and status = 'disputed' returning * into o;
  if o.id is null then raise exception 'That order isn’t disputed' using errcode = 'P0001'; end if;
  perform log_audit(case when p_refund then 'order.refund_approved' else 'order.dispute_declined' end, 'order', o.id::text, jsonb_build_object('note', p_note, 'title', o.title));
  insert into notifications (user_id, kind, title, link) values
    (o.buyer_id, 'purchase', case when p_refund then 'Your problem with “' || o.title || '” was upheld: a refund is on its way.' else 'A moderator reviewed your problem with “' || o.title || '”.' end
                             || coalesce(' ' || o.dispute_resolution, ''), 'orders'),
    (o.artist_user, 'sale', 'A moderator decided on the problem with “' || o.title || '”.' || coalesce(' ' || o.dispute_resolution, ''), 'orders');
end $$;

-- ——— Verified sales on the Passport ———
create or replace function public.artist_passport(p_artist text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'achievements', coalesce((select json_agg(json_build_object('label', d.label, 'criteria', d.criteria, 'at', m.awarded_at) order by m.awarded_at)
                              from member_achievements m join achievement_definitions d on d.code = m.code and d.audience = 'artist'
                              where m.user_id = ar.owner_id), '[]'::json),
    'competitions', coalesce((select json_agg(json_build_object('id', c.id, 'title', c.title, 'kind', c.kind, 'closed_at', c.closed_at,
                                               'place', (r->>'place')::int, 'votes', (r->>'votes')::int, 'artwork', r->>'artwork') order by c.closed_at desc)
                              from competitions c, jsonb_array_elements(c.results->'entries') r
                              join competition_entries e on e.id = (r->>'entry')::uuid
                              where e.user_id = ar.owner_id and c.closed_at is not null), '[]'::json),
    'exhibitions', coalesce((select json_agg(json_build_object('kind', e.kind, 'title', e.title, 'venue', e.venue, 'city', e.city, 'country', e.country,
                                              'start_date', e.start_date, 'end_date', e.end_date, 'link', e.link) order by e.start_date desc)
                             from exhibitions e where e.artist_id = ar.id and e.status = 'verified'), '[]'::json),
    'verified_sales', (select count(*) from orders o where o.artist_id = ar.id and o.status in ('paid', 'shipped', 'delivered')),
    'milestones', json_build_object(
      'joined', ar.created_at,
      'first_work', (select min(created_at) from artworks where artist_id = ar.id and (release_at is null or release_at <= now())),
      'first_drop', (select min(released_at) from drops where artist_id = ar.id),
      'first_inquiry', (select min(created_at) from inquiries where artist_id = ar.id),
      'first_sale', (select min(paid_at) from orders where artist_id = ar.id and status in ('paid', 'shipped', 'delivered')))
  )
  from artists ar where ar.id = p_artist and ar.owner_id is not null
$$;

-- ——— Grants ———
do $$
declare f text;
begin
  foreach f in array array['set_edition(text, integer)', 'my_payout_status()', 'begin_purchase(text)', 'my_orders()', 'mark_shipped(uuid, text, text)',
                           'confirm_delivery(uuid)', 'open_dispute(uuid, text)', 'admin_disputes()', 'resolve_dispute(uuid, boolean, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['set_payout_account(uuid, text, boolean, boolean, boolean)', 'update_payout_status(text, boolean, boolean, boolean)',
                           'payout_account_for(uuid)', 'order_payout_target(uuid)', 'attach_checkout_session(uuid, text)',
                           'complete_order(text, text, integer, jsonb)', 'refund_order(text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['artists_accepting_payments()', 'app_flags()', 'artist_passport(text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
