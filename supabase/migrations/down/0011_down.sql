-- Undo for 0011_coach_passport_opportunities.sql: drops Coach usage records, exhibitions and
-- opportunities (with their data). Run it before down/0010_down.sql if undoing several.
begin;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then perform cron.unschedule('abremi-deadline-reminders'); end if;
exception when others then null;
end $$;
drop function if exists public.send_deadline_reminders();
drop function if exists public.opportunities_list();
drop function if exists public.save_opportunity(uuid, boolean);
drop function if exists public.review_opportunity(uuid, boolean, text);
drop function if exists public.admin_opportunity_queue();
drop function if exists public.suggest_opportunity(text, text, text, text, date, text, text, numeric, text, text);
drop table if exists public.saved_opportunities;
drop function if exists public.artist_passport(text);
drop function if exists public.review_exhibition(uuid, boolean, text);
drop function if exists public.admin_exhibition_queue();
drop function if exists public.delete_exhibition(uuid);
drop function if exists public.submit_exhibition(text, text, text, text, text, date, date, text);
drop function if exists public.finish_coach_request(uuid, boolean);
drop function if exists public.begin_coach_request(text, text, uuid);
drop function if exists public.coach_usage();
drop table if exists public.coach_requests;
drop table if exists public.opportunities;
drop table if exists public.exhibitions;
delete from public.notifications where kind in ('exhibition_review', 'opportunity_deadline');
commit;
