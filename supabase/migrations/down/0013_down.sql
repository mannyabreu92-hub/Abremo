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
update public.plans set coach_monthly = 20 where code = 'free';
-- The 0012 version of the Coach's start (no Pro-only message).
create or replace function public.begin_coach_request(p_tool text, p_artwork text default null, p_opportunity uuid default null) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  ar public.artists;
  w public.artworks;
  o public.opportunities;
  req uuid;
  since timestamptz := now() - interval '30 days';
  monthly integer;
begin
  if uid is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  select * into ar from artists where owner_id = uid;
  if ar.id is null then
    raise exception 'The Coach is for artists: publish a work first' using errcode = '42501';
  end if;
  if p_tool not in ('bio', 'statement', 'description', 'engagement', 'social', 'application') then
    raise exception 'Unknown Coach tool' using errcode = '22023';
  end if;
  monthly := (current_plan(uid)).coach_monthly;
  if (select count(*) from coach_requests where user_id = uid and status <> 'failed' and created_at >= date_trunc('month', now())) >= monthly then
    raise exception 'You’ve used this month’s % Coach requests. They reset on the 1st.', monthly using errcode = 'P0001';
  end if;
  if (select count(*) from coach_requests where status <> 'failed' and created_at > now() - interval '1 day') >= 400 then
    raise exception 'The Coach is busy today. Please try again tomorrow.' using errcode = 'P0001';
  end if;
  if p_tool in ('description', 'social') then
    select * into w from artworks where id = p_artwork and owner_id = uid;
    if w.id is null then
      raise exception 'Choose one of your own works' using errcode = '22023';
    end if;
  end if;
  if p_tool = 'application' then
    select * into o from opportunities where id = p_opportunity and status = 'approved';
    if o.id is null then
      raise exception 'Choose a listed opportunity' using errcode = '22023';
    end if;
  end if;
  insert into coach_requests (user_id, tool) values (uid, p_tool) returning id into req;
  return json_build_object(
    'request_id', req,
    'artist', json_build_object('name', ar.name, 'country', ar.country, 'city', ar.city, 'bio', ar.bio, 'statement', ar.statement,
                                'website', ar.website, 'joined', ar.created_at::date),
    'works', coalesce((select json_agg(json_build_object('id', x.id, 'title', x.title, 'medium', coalesce(x.medium, x.category), 'style', x.style,
                                       'year', x.year, 'dimensions', x.dimensions, 'availability', x.availability, 'description', x.description) order by x.created_at desc)
                       from (select * from artworks where owner_id = uid and not hidden order by created_at desc limit 30) x), '[]'::json),
    'artwork', case when w.id is not null then json_build_object('id', w.id, 'title', w.title, 'medium', coalesce(w.medium, w.category), 'style', w.style,
                    'year', w.year, 'dimensions', w.dimensions, 'description', w.description, 'thumb_path', w.thumb_path) end,
    'stats', case when p_tool = 'engagement' then json_build_object(
                    'last_30_days', artist_summary(ar.id, since, now()),
                    'previous_30_days', artist_summary(ar.id, since - interval '30 days', since),
                    'followers_total', (select count(*) from counted_follows where artist_id = ar.id)) end,
    'opportunity', case when o.id is not null then json_build_object('title', o.title, 'kind', o.kind, 'organizer', o.organizer, 'location', o.location,
                        'deadline', o.deadline, 'eligibility', o.eligibility, 'description', o.description) end,
    'achievements', coalesce((select json_agg(d.label) from member_achievements m join achievement_definitions d on d.code = m.code
                              where m.user_id = uid and d.audience = 'artist'), '[]'::json),
    'exhibitions', coalesce((select json_agg(json_build_object('title', e.title, 'venue', e.venue, 'year', extract(year from e.start_date)::int) order by e.start_date desc)
                             from exhibitions e where e.owner_id = uid and e.status = 'verified'), '[]'::json)
  );
end $$;
commit;
