-- Undo for 0013_assistant.sql: drops the Guide's request and event records, its personalization
-- preferences and the daily allowance column. Run it before down/0012_down.sql if undoing several.
begin;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then perform cron.unschedule('abremi-prune-assistant'); end if;
exception when others then null;
end $$;
drop function if exists public.prune_assistant_data();
drop function if exists public.admin_assistant_metrics(integer);
drop function if exists public.record_assistant_event(text, text);
drop function if exists public.finish_assistant_request(uuid, boolean);
drop function if exists public.begin_assistant_request(text, text, text);
drop function if exists public.assistant_catalog();
drop function if exists public.assistant_page_context(text, text);
drop function if exists public.assistant_usage();
drop function if exists public.reset_assistant_personalization();
drop function if exists public.set_assistant_preferences(boolean, text);
drop function if exists public.assistant_preferences();
drop table if exists public.assistant_events;
drop table if exists public.assistant_requests;
alter table public.profiles drop column if exists assistant_interests;
alter table public.profiles drop column if exists assistant_personalize;
alter table public.plans drop column if exists assistant_daily;
commit;
