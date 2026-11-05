-- Undo for 0021_active_since.sql. Run it before down/0020_down.sql if undoing several.
begin;
drop function if exists public.artists_active_since();
drop function if exists public.set_active_since(integer);
alter table public.artists drop constraint if exists artists_active_since_valid;
alter table public.artists drop column if exists active_since;
commit;
