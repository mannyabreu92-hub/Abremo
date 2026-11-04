-- Undo for 0017_checkout.sql: removes checkout, orders, payout accounts and editions (with their
-- data). Run it before down/0016_down.sql if undoing several.
begin;
drop function if exists public.resolve_dispute(uuid, boolean, text);
drop function if exists public.admin_disputes();
drop function if exists public.open_dispute(uuid, text);
drop function if exists public.confirm_delivery(uuid);
drop function if exists public.mark_shipped(uuid, text, text);
drop function if exists public.my_orders();
drop function if exists public.refund_order(text);
drop function if exists public.complete_order(text, text, integer, jsonb);
drop function if exists public.attach_checkout_session(uuid, text);
drop function if exists public.order_payout_target(uuid);
drop function if exists public.begin_purchase(text);
drop function if exists public.payout_account_for(uuid);
drop function if exists public.update_payout_status(text, boolean, boolean, boolean);
drop function if exists public.set_payout_account(uuid, text, boolean, boolean, boolean);
drop function if exists public.artists_accepting_payments();
drop function if exists public.my_payout_status();
drop function if exists public.set_edition(text, integer);
-- Earlier versions (0011 and 0012).
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
    'milestones', json_build_object(
      'joined', ar.created_at,
      'first_work', (select min(created_at) from artworks where artist_id = ar.id and (release_at is null or release_at <= now())),
      'first_drop', (select min(released_at) from drops where artist_id = ar.id),
      'first_inquiry', (select min(created_at) from inquiries where artist_id = ar.id))
  )
  from artists ar where ar.id = p_artist and ar.owner_id is not null
$$;

create or replace function public.app_flags() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('invite_required', invite_required, 'payments_enabled', payments_enabled) from app_settings
$$;
drop table if exists public.orders;
drop table if exists public.payout_accounts;
alter table public.artworks drop column if exists editions_sold;
alter table public.artworks drop column if exists edition_size;
alter table public.app_settings drop column if exists sales_enabled;
delete from public.notifications where kind in ('sale', 'purchase', 'dispute');
commit;
