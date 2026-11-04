-- Undo for 0008_competitions.sql: drops competitions, entries, votes and notifications (with their
-- data) and the competition achievements. Run it before down/0007 and down/0006 if undoing several.
begin;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then perform cron.unschedule('abremi-competitions'); end if;
exception when others then null;
end $$;
drop function if exists public.mark_notifications_read();
drop function if exists public.competition_detail(uuid);
drop function if exists public.arena();
drop function if exists public.close_due_competitions();
drop function if exists public.finalize_competition(uuid);
drop function if exists public.cast_competition_vote(uuid, uuid);
drop function if exists public.withdraw_entry(uuid);
drop function if exists public.enter_competition(uuid, text);
drop function if exists public.cancel_competition(uuid, text);
drop function if exists public.create_competition(text, text, text, text, text, text, timestamptz, timestamptz, timestamptz);
drop function if exists public.voting_eligibility(uuid);
drop function if exists public.competition_phase(public.competitions);
drop table if exists public.notifications;
drop table if exists public.competition_votes;
drop table if exists public.competition_entries;
drop table if exists public.competitions;
delete from public.member_achievements where code in ('first_entry', 'podium_finish', 'competition_winner');
delete from public.achievement_definitions where code in ('first_entry', 'podium_finish', 'competition_winner');
commit;
