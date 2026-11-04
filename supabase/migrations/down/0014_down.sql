-- Undo for 0014_teasers_badges.sql: teasers go back to the image blurred in the browser, and badges
-- can no longer be hidden. Run it before down/0013_down.sql if undoing several.
begin;
drop function if exists public.set_plan_badge(boolean);
drop function if exists public.create_drop(text, text, timestamptz, text[], text, text);
-- Earlier versions (from 0012 and 0010).
create or replace function public.create_drop(p_title text, p_description text, p_release_at timestamptz, p_artworks text[], p_teaser text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  ar public.artists;
  d public.drops;
  max_upcoming integer;
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
  max_upcoming := (current_plan(uid)).max_upcoming_drops;
  if (select count(*) from drops where owner_id = uid and released_at is null and cancelled_at is null) >= max_upcoming then
    raise exception 'Your plan allows % upcoming drop% at a time', max_upcoming, case when max_upcoming = 1 then '' else 's' end using errcode = 'P0001';
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

create or replace function public.drops_overview() returns json
language plpgsql security definer set search_path = public as $$
begin
  perform release_due_drops();
  return coalesce((select json_agg(x order by x.sort, x.release_at) from (
    select d.id, d.title, d.description, d.release_at, d.artist_id, ar.name as artist_name,
           case when d.cancelled_at is not null then 'cancelled' when d.release_at > now() then 'upcoming' else 'released' end as phase,
           (select w.thumb_path from artworks w where w.id = d.teaser_artwork) as teaser_thumb,
           (select count(*) from artworks w where w.drop_id = d.id)::int as works,
           exists (select 1 from drop_subscriptions s where s.drop_id = d.id and s.user_id = auth.uid()) as subscribed,
           d.owner_id = auth.uid() as mine,
           case when d.release_at > now() then 0 else 1 end as sort
    from drops d join artists ar on ar.id = d.artist_id
    where d.cancelled_at is null and (d.release_at > now() or d.release_at > now() - interval '14 days')
  ) x), '[]'::json);
end $$;

create or replace function public.drop_detail(p_id uuid) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform release_due_drops();
  return (select json_build_object(
    'id', d.id, 'title', d.title, 'description', d.description, 'release_at', d.release_at,
    'artist_id', d.artist_id, 'artist_name', ar.name,
    'phase', case when d.cancelled_at is not null then 'cancelled' when d.release_at > now() then 'upcoming' else 'released' end,
    'teaser_thumb', (select w.thumb_path from artworks w where w.id = d.teaser_artwork),
    'works', case when d.release_at <= now() or d.owner_id = auth.uid() or d.cancelled_at is not null
                  then coalesce((select json_agg(w.id order by w.created_at) from artworks w where w.drop_id = d.id and not w.hidden), '[]'::json)
                  else '[]'::json end,
    'work_count', (select count(*) from artworks w where w.drop_id = d.id),
    'subscribed', exists (select 1 from drop_subscriptions s where s.drop_id = d.id and s.user_id = auth.uid()),
    'mine', d.owner_id = auth.uid())
  from drops d join artists ar on ar.id = d.artist_id where d.id = p_id);
end $$;

create or replace function public.plan_badges() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_object_agg(ar.id, (current_plan(ar.owner_id)).badge), '{}'::json)
  from artists ar
  join subscriptions s on s.user_id = ar.owner_id
  where (current_plan(ar.owner_id)).badge is not null
$$;

create or replace function public.my_plan() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'plan', row_to_json(p),
    'status', s.status, 'source', s.source, 'ends_at', s.current_period_end,
    'manage', s.source = 'billing' and s.billing_customer is not null)
  from current_plan(auth.uid()) p
  left join subscriptions s on s.user_id = auth.uid() and s.plan = p.code
  where auth.uid() is not null
$$;

alter table public.drops drop column if exists teaser_palette;
alter table public.profiles drop column if exists show_plan_badge;
do $$
declare f text;
begin
  foreach f in array array['create_drop(text, text, timestamptz, text[], text)', 'my_plan()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['drops_overview()', 'drop_detail(uuid)', 'plan_badges()'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
commit;
