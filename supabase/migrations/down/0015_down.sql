-- Undo for 0015_discovery_loop.sql: removes offers' amounts, waitlists, alerts and collector
-- interests (with their data). Run it before down/0014_down.sql if undoing several.
begin;
drop trigger if exists abremi_alert_drop_to_treasurers on public.drops;
drop trigger if exists abremi_alert_artwork_change on public.artworks;
drop function if exists public.alert_drop_to_treasurers();
drop function if exists public.alert_artwork_change();
drop function if exists public.my_discovery_interests();
drop function if exists public.set_discovery_interests(text[], text[], integer);
drop function if exists public.my_watches();
drop function if exists public.watch_artwork(text, boolean);
drop function if exists public.inquiry_offer(uuid);
drop function if exists public.send_offer(text, numeric, text, text);
drop table if exists public.artwork_watches;
alter table public.inquiries drop column if exists offer_amount;
alter table public.inquiries drop column if exists offer_currency;
alter table public.profiles drop column if exists discovery_interests;
delete from public.notifications where kind = 'artwork_alert';
commit;
