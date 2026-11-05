-- 0020: Verified artists and certificates of authenticity.
--   Verified: a moderator confirms an artist's identity (or that the family runs the studio with the
--   artist's permission). A ✓ appears next to the name. Editorial only: rankings never read it.
--   Certificates: every paid sale gets a unique code. Buyer and artist can open a printable
--   certificate, and anyone can check a code at #certificate/CODE (artwork, artist, date, status;
--   never the buyer).

-- ——— 1. Verified artists ———
create table if not exists public.artist_verifications (
  artist_id text primary key references public.artists (id) on delete cascade,
  managed_by_family boolean not null default false,
  verified_at timestamptz not null default now(),
  verified_by uuid references public.profiles (id) on delete set null
);
alter table public.artist_verifications enable row level security;
drop policy if exists "verifications are public" on public.artist_verifications;
create policy "verifications are public" on public.artist_verifications for select using (true);
revoke all on public.artist_verifications from anon, authenticated;
grant select on public.artist_verifications to anon, authenticated;

create or replace function public.verified_artists() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('artist_id', v.artist_id, 'managed', v.managed_by_family, 'since', v.verified_at) order by v.verified_at), '[]'::json)
  from artist_verifications v join artists ar on ar.id = v.artist_id where ar.owner_id is not null
$$;
revoke all on function public.verified_artists() from public;
grant execute on function public.verified_artists() to anon, authenticated;

create or replace function public.admin_set_verified(p_artist text, p_on boolean, p_managed boolean default false) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  if not exists (select 1 from artists where id = p_artist and owner_id is not null) then
    raise exception 'Only member artists can be verified';
  end if;
  if p_on then
    insert into artist_verifications (artist_id, managed_by_family, verified_by) values (p_artist, coalesce(p_managed, false), auth.uid())
    on conflict (artist_id) do update set managed_by_family = excluded.managed_by_family, verified_by = excluded.verified_by, verified_at = now();
  else
    delete from artist_verifications where artist_id = p_artist;
  end if;
  perform log_audit(case when p_on then 'artist.verified' else 'artist.unverified' end, 'artist', p_artist,
                    jsonb_build_object('managed_by_family', coalesce(p_managed, false)));
  return p_on;
end $$;
revoke all on function public.admin_set_verified(text, boolean, boolean) from public, anon;
grant execute on function public.admin_set_verified(text, boolean, boolean) to authenticated;

-- ——— 2. Certificates of authenticity ———
alter table public.orders add column if not exists certificate_code text unique;

create or replace function public.issue_certificate_code() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.certificate_code is null and new.status in ('paid', 'shipped', 'delivered', 'disputed', 'refunded') then
    new.certificate_code := 'ABR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)) || '-'
      || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)) || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4));
  end if;
  return new;
end $$;
revoke all on function public.issue_certificate_code() from public, anon, authenticated;
drop trigger if exists orders_certificate on public.orders;
create trigger orders_certificate before insert or update of status on public.orders
  for each row execute function public.issue_certificate_code();
update public.orders set status = status where certificate_code is null and status in ('paid', 'shipped', 'delivered', 'disputed', 'refunded');

-- Anyone can check a certificate: the artwork, artist, date and whether it still stands. Never the buyer.
create or replace function public.verify_certificate(p_code text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'code', o.certificate_code, 'artwork_id', o.artwork_id, 'title', o.title,
    'artist_id', o.artist_id, 'artist', ar.name, 'country', ar.country,
    'verified', exists (select 1 from artist_verifications v where v.artist_id = o.artist_id),
    'year', w.year, 'medium', w.medium, 'dimensions', w.dimensions, 'category', w.category,
    'edition_number', o.edition_number, 'edition_size', w.edition_size,
    'issued_at', o.paid_at,
    'valid', o.status in ('paid', 'shipped', 'delivered'),
    'status', case when o.status = 'refunded' then 'void' when o.status = 'disputed' then 'under_review' else 'valid' end)
  from orders o join artists ar on ar.id = o.artist_id left join artworks w on w.id = o.artwork_id
  where o.certificate_code = upper(btrim(coalesce(p_code, ''))) and o.certificate_code is not null
$$;
revoke all on function public.verify_certificate(text) from public;
grant execute on function public.verify_certificate(text) to anon, authenticated;

-- my_orders() now includes each order's certificate code.
create or replace function public.my_orders() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'sales', coalesce((select json_agg(json_build_object('id', o.id, 'artwork_id', o.artwork_id, 'title', o.title, 'amount_cents', o.amount_cents, 'fee_cents', o.fee_cents,
              'currency', o.currency, 'edition_number', o.edition_number, 'status', o.status, 'shipping', o.shipping, 'carrier', o.carrier, 'tracking', o.tracking,
              'buyer', (select name from profiles where id = o.buyer_id), 'paid_at', o.paid_at, 'shipped_at', o.shipped_at, 'delivered_at', o.delivered_at,
              'dispute_reason', o.dispute_reason, 'dispute_resolution', o.dispute_resolution, 'certificate', o.certificate_code) order by o.created_at desc)
              from orders o where o.artist_user = auth.uid() and o.status not in ('pending', 'cancelled')), '[]'::json),
    'purchases', coalesce((select json_agg(json_build_object('id', o.id, 'artwork_id', o.artwork_id, 'title', o.title, 'amount_cents', o.amount_cents,
              'currency', o.currency, 'edition_number', o.edition_number, 'status', o.status, 'carrier', o.carrier, 'tracking', o.tracking,
              'artist', (select name from artists where id = o.artist_id), 'paid_at', o.paid_at, 'shipped_at', o.shipped_at, 'delivered_at', o.delivered_at,
              'dispute_reason', o.dispute_reason, 'dispute_resolution', o.dispute_resolution,
              'certificate', o.certificate_code,
              'can_dispute', o.status in ('paid', 'shipped') or (o.status = 'delivered' and o.delivered_at > now() - interval '14 days')) order by o.created_at desc)
              from orders o where o.buyer_id = auth.uid() and o.status not in ('pending', 'cancelled')), '[]'::json))
  where auth.uid() is not null
$$;
