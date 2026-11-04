-- Undo for 0009_analytics.sql: drops analytics events and weekly reports (with their data).
-- Run it before down/0008_down.sql if undoing several.
begin;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then perform cron.unschedule('abremi-weekly-reports'); end if;
exception when others then null;
end $$;
drop function if exists public.my_weekly_reports();
drop function if exists public.generate_weekly_reports(uuid);
drop table if exists public.weekly_reports;
drop function if exists public.studio_analytics(integer);
drop function if exists public.artist_summary(text, timestamptz, timestamptz);
drop function if exists public.record_events(jsonb, text);
drop table if exists public.analytics_events;
delete from public.notifications where kind = 'weekly_report';
commit;
