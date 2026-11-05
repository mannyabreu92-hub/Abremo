-- Undo for 0019_founding_artists.sql: removes founding artists. Run it before down/0018_down.sql
-- if undoing several.
begin;
drop function if exists public.admin_set_founding(text, boolean);
drop function if exists public.founding_artists_list();
drop table if exists public.founding_artists;
commit;
