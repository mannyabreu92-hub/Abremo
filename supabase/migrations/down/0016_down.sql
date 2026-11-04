-- Undo for 0016_index.sql: removes the Abremi Index and its history. Run it before
-- down/0015_down.sql if undoing several.
begin;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then perform cron.unschedule('abremi-weekly-index'); end if;
exception when others then null;
end $$;
drop function if exists public.admin_publish_index();
drop function if exists public.artist_index_badge(text);
drop function if exists public.index_week(date, text);
drop function if exists public.compute_index(date);
drop table if exists public.index_entries;
drop table if exists public.index_weeks;
commit;
