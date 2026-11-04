-- Undo for 0012_plans_galleries_beta.sql: drops plans and subscriptions, galleries, invite codes,
-- feedback and the app error log (with their data), and restores the earlier versions of the
-- functions 0012 replaced. Run it before down/0011_down.sql if undoing several.
begin;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then perform cron.unschedule('abremi-prune-client-errors'); end if;
exception when others then null;
end $$;
drop trigger if exists abremi_guard_invite on auth.users;
drop function if exists public.guard_invite();
drop function if exists public.apply_billing_event(text, text, uuid, text, text, timestamptz, text, text);
drop function if exists public.prune_client_errors();
drop function if exists public.admin_client_errors(integer);
drop function if exists public.log_client_error(text, text, text, text, text);
drop function if exists public.resolve_feedback(uuid, text);
drop function if exists public.admin_feedback(text);
drop function if exists public.submit_feedback(text, text, text, text);
drop function if exists public.admin_set_invite_required(boolean);
drop function if exists public.admin_revoke_invite(text);
drop function if exists public.admin_invites();
drop function if exists public.admin_create_invite(integer, integer, text);
drop function if exists public.check_invite(text);
drop function if exists public.admin_plan_holders();
drop function if exists public.admin_revoke_plan(uuid, text);
drop function if exists public.admin_grant_plan(uuid, text, date, text);
drop function if exists public.my_gallery();
drop function if exists public.gallery_page(uuid);
drop function if exists public.review_gallery(uuid, boolean, text);
drop function if exists public.admin_gallery_queue();
drop function if exists public.apply_gallery(text, text, text, text, text);
drop function if exists public.admin_find_members(text);
drop function if exists public.plan_badges();
drop function if exists public.my_plan();

-- Earlier versions of the replaced functions (they no longer read plans).
-- From 0011_coach_passport_opportunities.sql
create or replace function public.coach_usage() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'used', (select count(*) from coach_requests where user_id = auth.uid() and status <> 'failed' and created_at >= date_trunc('month', now())),
    'limit', 20,
    'resets_at', date_trunc('month', now()) + interval '1 month')
$$;

-- From 0011_coach_passport_opportunities.sql
create or replace function public.begin_coach_request(p_tool text, p_artwork text default null, p_opportunity uuid default null) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  ar public.artists;
  w public.artworks;
  o public.opportunities;
  req uuid;
  since timestamptz := now() - interval '30 days';
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
  if (select count(*) from coach_requests where user_id = uid and status <> 'failed' and created_at >= date_trunc('month', now())) >= 20 then
    raise exception 'You’ve used this month’s 20 Coach requests. They reset on the 1st.' using errcode = 'P0001';
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

-- From 0011_coach_passport_opportunities.sql
create or replace function public.admin_exhibition_queue() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return coalesce((select json_agg(json_build_object('id', e.id, 'artist', ar.name, 'artist_id', ar.id, 'kind', e.kind, 'title', e.title,
                                    'venue', e.venue, 'city', e.city, 'country', e.country, 'start_date', e.start_date, 'end_date', e.end_date,
                                    'link', e.link, 'created_at', e.created_at) order by e.created_at)
                   from exhibitions e join artists ar on ar.id = e.artist_id where e.status = 'pending'), '[]'::json);
end $$;

-- From 0011_coach_passport_opportunities.sql
create or replace function public.suggest_opportunity(p_kind text, p_title text, p_organizer text, p_location text, p_deadline date,
                                                      p_eligibility text, p_description text, p_fee numeric, p_fee_currency text, p_link text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  admin boolean := is_admin();
  new_id uuid;
begin
  if uid is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if not admin and (select created_at from profiles where id = uid) > now() - interval '3 days' then
    raise exception 'New accounts can suggest opportunities after 3 days' using errcode = '42501';
  end if;
  if not admin and (select count(*) from opportunities where submitted_by = uid and created_at > now() - interval '1 day') >= 5 then
    raise exception 'You can suggest 5 opportunities a day' using errcode = 'P0001';
  end if;
  if p_deadline < current_date then
    raise exception 'The deadline has passed' using errcode = '22023';
  end if;
  insert into opportunities (kind, title, organizer, location, deadline, eligibility, description, fee, fee_currency, link, status, submitted_by,
                             reviewed_by, reviewed_at)
  values (p_kind, btrim(p_title), btrim(p_organizer), btrim(p_location), p_deadline, btrim(coalesce(p_eligibility, '')), btrim(coalesce(p_description, '')),
          coalesce(p_fee, 0), upper(coalesce(nullif(p_fee_currency, ''), 'USD')), btrim(p_link),
          case when admin then 'approved' else 'pending' end, uid, case when admin then uid end, case when admin then now() end)
  returning opportunities.id into new_id;
  if admin then
    perform log_audit('opportunity.published', 'opportunity', new_id::text, jsonb_build_object('title', p_title));
  end if;
  return new_id;
end $$;

-- From 0011_coach_passport_opportunities.sql
create or replace function public.opportunities_list() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object(
    'id', o.id, 'kind', o.kind, 'title', o.title, 'organizer', o.organizer, 'location', o.location, 'deadline', o.deadline,
    'eligibility', o.eligibility, 'description', o.description, 'fee', o.fee, 'fee_currency', o.fee_currency, 'link', o.link,
    'saved', exists (select 1 from saved_opportunities s where s.opportunity_id = o.id and s.user_id = auth.uid())
  ) order by o.deadline, o.title), '[]'::json)
  from opportunities o where o.status = 'approved' and o.deadline >= current_date
$$;

-- From 0009_analytics.sql
create or replace function public.studio_analytics(p_days integer default 30) returns json
language plpgsql stable security definer set search_path = public as $$
declare
  me_artist text;
  days integer := case when p_days in (7, 30, 90) then p_days else 30 end;
  t_to timestamptz := date_trunc('day', now()) + interval '1 day';
  t_from timestamptz := date_trunc('day', now()) + interval '1 day' - make_interval(days => days);
  t_prev timestamptz := date_trunc('day', now()) + interval '1 day' - make_interval(days => 2 * days);
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  select id into me_artist from artists where owner_id = auth.uid();
  if me_artist is null then
    return null;
  end if;
  return json_build_object(
    'artist', me_artist, 'days', days, 'from', t_from, 'to', t_to,
    'current', artist_summary(me_artist, t_from, t_to),
    'previous', artist_summary(me_artist, t_prev, t_from),
    'followers_total', (select count(*) from counted_follows where artist_id = me_artist),
    'daily', (
      select json_agg(json_build_object(
        'day', d::date,
        'impressions', (select count(*) from analytics_events e where e.artist_id = me_artist and e.kind = 'impression' and e.day = d::date),
        'views', (select count(*) from analytics_events e where e.artist_id = me_artist and e.kind = 'artwork_view' and e.day = d::date),
        'visits', (select count(*) from analytics_events e where e.artist_id = me_artist and e.kind = 'profile_visit' and e.day = d::date),
        'likes', (select count(*) from counted_reactions r join artworks w on w.id = r.artwork_id
                   where w.artist_id = me_artist and r.kind in ('like', 'super') and r.created_at >= d and r.created_at < d + interval '1 day'),
        'followers', (select count(*) from counted_follows f where f.artist_id = me_artist and f.created_at < d + interval '1 day')
      ) order by d)
      from generate_series(t_from, t_to - interval '1 day', interval '1 day') d
    ),
    'works', coalesce((
      select json_agg(x order by x.views desc, x.likes desc) from (
        select w.id, w.title,
          (select count(*) from analytics_events e where e.artwork_id = w.id and e.kind = 'impression' and e.created_at >= t_from)::int as impressions,
          (select count(*) from analytics_events e where e.artwork_id = w.id and e.kind = 'artwork_view' and e.created_at >= t_from)::int as views,
          (select count(*) from counted_reactions r where r.artwork_id = w.id and r.kind = 'like' and r.created_at >= t_from)::int as likes,
          (select count(*) from counted_reactions r where r.artwork_id = w.id and r.kind = 'super' and r.created_at >= t_from)::int as saves
        from artworks w where w.artist_id = me_artist
      ) x), '[]'::json),
    'roles', coalesce((
      select json_object_agg(role, n) from (
        select role, count(distinct user_id) as n from (
          select r.user_id, r.role from counted_reactions r join artworks w on w.id = r.artwork_id
            where w.artist_id = me_artist and r.kind in ('like', 'super') and r.created_at >= t_from
          union all
          select f.user_id, f.role from counted_follows f where f.artist_id = me_artist and f.created_at >= t_from
        ) a group by role
      ) g), '{}'::json),
    'countries', coalesce((
      select json_agg(json_build_object('country', country, 'people', people) order by people desc, country) from (
        select case when n >= 3 then country else 'Other' end as country, sum(n)::int as people from (
          select p.country, count(*) as n from profiles p
          where p.id in (
            select r.user_id from counted_reactions r join artworks w on w.id = r.artwork_id
              where w.artist_id = me_artist and r.kind in ('like', 'super') and r.created_at >= t_from
            union select f.user_id from counted_follows f where f.artist_id = me_artist and f.created_at >= t_from
            union select e.viewer_id from analytics_events e where e.artist_id = me_artist and e.viewer_id is not null and e.created_at >= t_from)
          group by p.country
        ) c group by 1
      ) g), '[]'::json)
  );
end $$;

-- From 0010_radar_drops.sql
create or replace function public.create_drop(p_title text, p_description text, p_release_at timestamptz, p_artworks text[], p_teaser text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  ar public.artists;
  d public.drops;
begin
  select * into ar from artists where owner_id = uid;
  if uid is null or ar.id is null then
    raise exception 'Publish a work first' using errcode = '42501';
  end if;
  if p_release_at < now() + interval '10 minutes' or p_release_at > now() + interval '60 days' then
    raise exception 'Release between 10 minutes and 60 days from now' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_artworks), 0) not between 1 and 12 then
    raise exception 'A drop has 1 to 12 works' using errcode = '22023';
  end if;
  if (select count(*) from artworks where id = any (p_artworks) and owner_id = uid and not hidden
        and (drop_id is null or drop_id in (select id from drops where released_at is not null or cancelled_at is not null))) <> cardinality(p_artworks) then
    raise exception 'A drop can include only your own works that aren’t in another upcoming drop' using errcode = '42501';
  end if;
  if p_teaser is not null and not (p_teaser = any (p_artworks)) then
    raise exception 'The preview must be one of the drop’s works' using errcode = '22023';
  end if;
  if (select count(*) from drops where owner_id = uid and released_at is null and cancelled_at is null) >= 3 then
    raise exception 'You can have 3 upcoming drops at a time' using errcode = 'P0001';
  end if;
  insert into drops (artist_id, owner_id, title, description, release_at, teaser_artwork)
  values (ar.id, uid, btrim(p_title), btrim(coalesce(p_description, '')), p_release_at, coalesce(p_teaser, p_artworks[1]))
  returning * into d;
  update artworks set drop_id = d.id, release_at = d.release_at where id = any (p_artworks);
  insert into notifications (user_id, kind, title, link)
  select f.user_id, 'drop_announced', ar.name || ' announced a drop: “' || d.title || '”', 'drop/' || d.id
  from counted_follows f where f.artist_id = ar.id;
  return d.id;
end $$;

drop function if exists public.current_plan(uuid);
drop function if exists public.app_flags();
drop table if exists public.billing_events;
drop table if exists public.client_errors;
drop table if exists public.feedback;
drop table if exists public.invite_redemptions;
drop table if exists public.invite_codes;
alter table public.opportunities drop column if exists gallery_id;
drop table if exists public.galleries;
drop table if exists public.subscriptions;
drop table if exists public.plans;
drop table if exists public.app_settings;
delete from public.notifications where kind in ('gallery_review', 'plan_granted');
commit;
