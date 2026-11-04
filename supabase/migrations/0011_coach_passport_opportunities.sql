-- Abremi Phase 5: AI Career Coach (quota and grounded context), Artist Passport (verified
-- exhibitions, competition history, milestones) and Gallery Opportunities.
-- Adds only; undo with supabase/migrations/down/0011_down.sql.

-- ——— 1. Artist Passport ———
create table if not exists public.exhibitions (
  id uuid primary key default gen_random_uuid(),
  artist_id text not null references public.artists (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('solo', 'group', 'fair', 'online', 'residency')),
  title text not null check (char_length(btrim(title)) between 3 and 120),
  venue text not null check (char_length(btrim(venue)) between 2 and 120),
  city text check (char_length(coalesce(city, '')) <= 60),
  country text check (country is null or country ~ '^[A-Z]{2}$'),
  start_date date not null,
  end_date date,
  link text not null check (link ~ '^https://[^[:space:]<>"]+$' and char_length(link) <= 300),
  status text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  review_note text check (char_length(coalesce(review_note, '')) <= 500),
  created_at timestamptz not null default now(),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  check (end_date is null or end_date >= start_date)
);
create index if not exists exhibitions_artist_idx on public.exhibitions (artist_id, start_date desc);
alter table public.exhibitions enable row level security;
drop policy if exists "verified exhibitions are public; artists see their own" on public.exhibitions;
create policy "verified exhibitions are public; artists see their own" on public.exhibitions for select
  using (status = 'verified' or owner_id = auth.uid());
revoke all on public.exhibitions from anon, authenticated;
grant select on public.exhibitions to anon, authenticated;

create or replace function public.submit_exhibition(p_kind text, p_title text, p_venue text, p_city text, p_country text,
                                                    p_start date, p_end date, p_link text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  ar public.artists;
  new_id uuid;
begin
  select * into ar from artists where owner_id = auth.uid();
  if auth.uid() is null or ar.id is null then
    raise exception 'Publish a work first' using errcode = '42501';
  end if;
  if (select count(*) from exhibitions where owner_id = auth.uid() and status = 'pending') >= 10 then
    raise exception 'You have 10 exhibitions waiting for review' using errcode = 'P0001';
  end if;
  if p_start > now() + interval '2 years' then
    raise exception 'Add exhibitions that have been confirmed, within the next 2 years' using errcode = '22023';
  end if;
  insert into exhibitions (artist_id, owner_id, kind, title, venue, city, country, start_date, end_date, link)
  values (ar.id, auth.uid(), p_kind, btrim(p_title), btrim(p_venue), nullif(btrim(coalesce(p_city, '')), ''), nullif(upper(coalesce(p_country, '')), ''),
          p_start, p_end, btrim(p_link))
  returning exhibitions.id into new_id;
  return new_id;
end $$;

create or replace function public.delete_exhibition(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from exhibitions where id = p_id and owner_id = auth.uid();
  if not found then
    raise exception 'Not your exhibition' using errcode = '42501';
  end if;
end $$;

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

create or replace function public.review_exhibition(p_id uuid, p_verify boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare e public.exhibitions;
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  update exhibitions set status = case when p_verify then 'verified' else 'rejected' end, review_note = nullif(btrim(coalesce(p_note, '')), ''),
         reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_id and status = 'pending' returning * into e;
  if e.id is null then
    raise exception 'That exhibition is no longer pending' using errcode = 'P0001';
  end if;
  perform log_audit(case when p_verify then 'exhibition.verified' else 'exhibition.rejected' end, 'exhibition', e.id::text,
                    jsonb_build_object('title', e.title, 'venue', e.venue, 'note', e.review_note));
  insert into notifications (user_id, kind, title, link)
  values (e.owner_id, 'exhibition_review', case when p_verify then '“' || e.title || '” is verified on your Passport'
                                                else '“' || e.title || '” couldn’t be verified' || coalesce(': ' || e.review_note, '') end, 'artist/' || e.artist_id);
end $$;

-- An artist's public Passport: every entry comes from a server record and says where it came from.
create or replace function public.artist_passport(p_artist text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'achievements', coalesce((select json_agg(json_build_object('label', d.label, 'criteria', d.criteria, 'at', m.awarded_at) order by m.awarded_at)
                              from member_achievements m join achievement_definitions d on d.code = m.code and d.audience = 'artist'
                              where m.user_id = ar.owner_id), '[]'::json),
    'competitions', coalesce((select json_agg(json_build_object('id', c.id, 'title', c.title, 'kind', c.kind, 'closed_at', c.closed_at,
                                               'place', (r->>'place')::int, 'votes', (r->>'votes')::int, 'artwork', r->>'artwork') order by c.closed_at desc)
                              from competitions c, jsonb_array_elements(c.results->'entries') r
                              join competition_entries e on e.id = (r->>'entry')::uuid
                              where e.user_id = ar.owner_id and c.closed_at is not null), '[]'::json),
    'exhibitions', coalesce((select json_agg(json_build_object('kind', e.kind, 'title', e.title, 'venue', e.venue, 'city', e.city, 'country', e.country,
                                              'start_date', e.start_date, 'end_date', e.end_date, 'link', e.link) order by e.start_date desc)
                             from exhibitions e where e.artist_id = ar.id and e.status = 'verified'), '[]'::json),
    'milestones', json_build_object(
      'joined', ar.created_at,
      'first_work', (select min(created_at) from artworks where artist_id = ar.id and (release_at is null or release_at <= now())),
      'first_drop', (select min(released_at) from drops where artist_id = ar.id),
      'first_inquiry', (select min(created_at) from inquiries where artist_id = ar.id))
  )
  from artists ar where ar.id = p_artist and ar.owner_id is not null
$$;

-- ——— 2. Gallery Opportunities ———
create table if not exists public.opportunities (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('open_call', 'exhibition', 'residency', 'prize')),
  title text not null check (char_length(btrim(title)) between 3 and 120),
  organizer text not null check (char_length(btrim(organizer)) between 2 and 120),
  location text not null check (char_length(btrim(location)) between 2 and 120),
  deadline date not null,
  eligibility text not null default '' check (char_length(eligibility) <= 1000),
  description text not null default '' check (char_length(description) <= 2000),
  fee numeric(10, 2) not null default 0 check (fee >= 0 and fee <= 10000),
  fee_currency text not null default 'USD' check (fee_currency ~ '^[A-Z]{3}$'),
  link text not null check (link ~ '^https://[^[:space:]<>"]+$' and char_length(link) <= 300),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  submitted_by uuid references public.profiles (id) on delete set null,
  review_note text check (char_length(coalesce(review_note, '')) <= 500),
  created_at timestamptz not null default now(),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz
);
create index if not exists opportunities_deadline_idx on public.opportunities (deadline) where status = 'approved';
alter table public.opportunities enable row level security;
drop policy if exists "approved opportunities are public" on public.opportunities;
create policy "approved opportunities are public" on public.opportunities for select
  using (status = 'approved' or submitted_by = auth.uid());
revoke all on public.opportunities from anon, authenticated;
grant select on public.opportunities to anon, authenticated;

create table if not exists public.saved_opportunities (
  user_id uuid not null references public.profiles (id) on delete cascade,
  opportunity_id uuid not null references public.opportunities (id) on delete cascade,
  reminded_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, opportunity_id)
);
alter table public.saved_opportunities enable row level security;
drop policy if exists "read own saved opportunities" on public.saved_opportunities;
create policy "read own saved opportunities" on public.saved_opportunities for select using (user_id = auth.uid());
revoke all on public.saved_opportunities from anon, authenticated;
grant select on public.saved_opportunities to authenticated;

-- Members (accounts 3+ days old, 5 a day) suggest; moderators post directly or approve. Both audited.
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

create or replace function public.admin_opportunity_queue() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return coalesce((select json_agg(row_to_json(o) order by o.created_at) from opportunities o where o.status = 'pending'), '[]'::json);
end $$;

create or replace function public.review_opportunity(p_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare o public.opportunities;
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  update opportunities set status = case when p_approve then 'approved' else 'rejected' end, review_note = nullif(btrim(coalesce(p_note, '')), ''),
         reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_id and status = 'pending' returning * into o;
  if o.id is null then
    raise exception 'That listing is no longer pending' using errcode = 'P0001';
  end if;
  perform log_audit(case when p_approve then 'opportunity.approved' else 'opportunity.rejected' end, 'opportunity', o.id::text,
                    jsonb_build_object('title', o.title, 'note', o.review_note));
end $$;

create or replace function public.save_opportunity(p_id uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if p_on then
    insert into saved_opportunities (user_id, opportunity_id)
    select auth.uid(), id from opportunities where id = p_id and status = 'approved'
    on conflict do nothing;
  else
    delete from saved_opportunities where user_id = auth.uid() and opportunity_id = p_id;
  end if;
end $$;

-- Listings open now (deadline today or later), with whether you saved each.
create or replace function public.opportunities_list() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object(
    'id', o.id, 'kind', o.kind, 'title', o.title, 'organizer', o.organizer, 'location', o.location, 'deadline', o.deadline,
    'eligibility', o.eligibility, 'description', o.description, 'fee', o.fee, 'fee_currency', o.fee_currency, 'link', o.link,
    'saved', exists (select 1 from saved_opportunities s where s.opportunity_id = o.id and s.user_id = auth.uid())
  ) order by o.deadline, o.title), '[]'::json)
  from opportunities o where o.status = 'approved' and o.deadline >= current_date
$$;

-- A reminder 3 days before the deadline of each saved opportunity, once.
create or replace function public.send_deadline_reminders() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with due as (
    update saved_opportunities s set reminded_at = now()
      from opportunities o
     where o.id = s.opportunity_id and o.status = 'approved' and s.reminded_at is null
       and o.deadline between current_date and current_date + 3
    returning s.user_id, o.id, o.title, o.deadline
  )
  insert into notifications (user_id, kind, title, link)
  select user_id, 'opportunity_deadline', '“' || title || '” closes ' || to_char(deadline, 'Mon FMDD'), 'opportunities'
  from due;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.send_deadline_reminders() from public, anon, authenticated;

-- ——— 3. Career Coach ———
-- The AI itself runs in a server function (api/coach.js) that holds the API key. It calls
-- begin_coach_request() with the artist's own session, so the database decides who may use the
-- Coach, enforces the limits, and hands over only that artist's own data as context.
create table if not exists public.coach_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  tool text not null check (tool in ('bio', 'statement', 'description', 'engagement', 'social', 'application')),
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  created_at timestamptz not null default now()
);
create index if not exists coach_requests_user_idx on public.coach_requests (user_id, created_at desc);
create index if not exists coach_requests_day_idx on public.coach_requests (created_at);
alter table public.coach_requests enable row level security;
drop policy if exists "read own coach requests" on public.coach_requests;
create policy "read own coach requests" on public.coach_requests for select using (user_id = auth.uid());
revoke all on public.coach_requests from anon, authenticated;
grant select on public.coach_requests to authenticated;

create or replace function public.coach_usage() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'used', (select count(*) from coach_requests where user_id = auth.uid() and status <> 'failed' and created_at >= date_trunc('month', now())),
    'limit', 20,
    'resets_at', date_trunc('month', now()) + interval '1 month')
$$;

-- Starts a Coach request: checks the limits (20 a month per artist, 400 a day overall) and returns the
-- grounding context. Failed requests (finish_coach_request(id, false)) don't count.
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

create or replace function public.finish_coach_request(p_id uuid, p_ok boolean) returns void
language sql security definer set search_path = public as $$
  update coach_requests set status = case when p_ok then 'done' else 'failed' end
   where id = p_id and user_id = auth.uid() and status = 'pending'
$$;

-- ——— Grants ———
do $$
declare f text;
begin
  foreach f in array array[
    'coach_usage()', 'begin_coach_request(text, text, uuid)', 'finish_coach_request(uuid, boolean)',
    'submit_exhibition(text, text, text, text, text, date, date, text)', 'delete_exhibition(uuid)', 'admin_exhibition_queue()',
    'review_exhibition(uuid, boolean, text)', 'suggest_opportunity(text, text, text, text, date, text, text, numeric, text, text)',
    'admin_opportunity_queue()', 'review_opportunity(uuid, boolean, text)', 'save_opportunity(uuid, boolean)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['artist_passport(text)', 'opportunities_list()'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;

-- Deadline reminders daily at 07:23 UTC where pg_cron is available.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('abremi-deadline-reminders', '23 7 * * *', 'select public.send_deadline_reminders();');
  end if;
exception when others then
  raise notice 'Schedule not set up (%). Deadline reminders need pg_cron.', sqlerrm;
end $$;
