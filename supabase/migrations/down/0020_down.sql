-- Undo for 0020_verified_certificates.sql: removes verified artists and certificate codes, and restores
-- my_orders() from 0017. Run it before down/0019_down.sql if undoing several.
begin;
drop function if exists public.verify_certificate(text);
drop trigger if exists orders_certificate on public.orders;
drop function if exists public.issue_certificate_code();
alter table public.orders drop column if exists certificate_code;
drop function if exists public.admin_set_verified(text, boolean, boolean);
drop function if exists public.verified_artists();
drop table if exists public.artist_verifications;

-- my_orders() as in 0017
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
commit;
