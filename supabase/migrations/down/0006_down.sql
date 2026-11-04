-- Undo for 0006_profiles_artworks_collections.sql.
-- Drops the collections, the audit trail, and the new artist and artwork columns (including the
-- data in them), and restores the 0002/0004 versions of the functions 0006 changed.
-- Run in the SQL editor only if you need to roll Phase 1 back.
begin;

drop function if exists public.public_collection(uuid);
drop table if exists public.collection_items;
drop table if exists public.collections;
drop function if exists public.guard_collection_item();
drop function if exists public.guard_collection();
drop function if exists public.update_artwork(text, text, text, text, text, integer, integer, text, text, text);
drop function if exists public.update_artist_profile(text, text, text, text, text, text);
drop function if exists public.admin_audit_log(integer);

alter table public.artworks drop constraint if exists artworks_details_valid;
alter table public.artworks drop column if exists description, drop column if exists dimensions,
  drop column if exists availability, drop column if exists updated_at;
alter table public.artists drop constraint if exists artists_profile_valid;
alter table public.artists drop column if exists bio, drop column if exists statement, drop column if exists website,
  drop column if exists instagram, drop column if exists city, drop column if exists avatar_path, drop column if exists updated_at;

-- The previous versions (from 0002 and 0004).
drop function if exists public.delete_artwork(text);
create or replace function public.publish_artwork(
  p_title text, p_category text, p_style text, p_medium text, p_year integer, p_price integer,
  p_image_path text, p_thumb_path text, p_width integer, p_height integer
) returns public.artworks
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  me public.profiles;
  member_artist text;
  work public.artworks;
begin
  if uid is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  select * into me from profiles where id = uid;
  if me.role is distinct from 'artist' then
    raise exception 'Switch to the Artist role to publish work' using errcode = '42501';
  end if;
  if (select count(*) from artworks a where a.owner_id = uid and a.created_at > now() - interval '1 day') >= 20 then
    raise exception 'Daily limit reached: 20 new works per day' using errcode = 'P0001';
  end if;
  if (select count(*) from storage.objects o where o.bucket_id = 'artworks' and o.name in (p_image_path, p_thumb_path)
        and (storage.foldername(o.name))[1] = uid::text) < 2 then
    raise exception 'Upload the image before publishing' using errcode = '22023';
  end if;

  member_artist := 'm_' || uid::text;
  insert into artists (id, name, country, owner_id) values (member_artist, me.name, me.country, uid)
  on conflict (id) do update set name = excluded.name, country = excluded.country;

  insert into artworks (id, artist_id, title, base_elo, owner_id, category, style, medium, year, price,
                        image_path, thumb_path, width, height)
  values ('u_' || replace(gen_random_uuid()::text, '-', ''), member_artist, btrim(p_title), 1200, uid,
          p_category, p_style, nullif(btrim(coalesce(p_medium, '')), ''), p_year, p_price,
          p_image_path, p_thumb_path, p_width, p_height)
  returning * into work;
  return work;
end $$;

create or replace function public.delete_artwork(p_id text)
returns table (image_path text, thumb_path text)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  return query
    delete from artworks a where a.id = p_id and a.owner_id = auth.uid()
    returning a.image_path, a.thumb_path;
  if not found then
    raise exception 'Not your artwork' using errcode = '42501';
  end if;
end $$;

create or replace function public.community_snapshot() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'reactions', coalesce((
      select json_agg(t) from (
        select artwork_id as a, kind as k, role as r, count(*)::int as n
        from reactions where kind in ('like', 'super') group by 1, 2, 3
      ) t), '[]'::json),
    'reviews', coalesce((
      select json_agg(t) from (
        select artwork_id as a, count(*)::int as n, sum(rating)::int as s from reviews group by 1
      ) t), '[]'::json),
    'follows', coalesce((
      select json_agg(t) from (
        select artist_id as a, role as r, count(*)::int as n from follows group by 1, 2
      ) t), '[]'::json),
    'ratings', coalesce((
      select json_agg(t) from (select artwork_id as a, rating as v from artwork_ratings) t
    ), '[]'::json),
    'members', (select count(*)::int from profiles),
    'artists', coalesce((
      select json_agg(t) from (
        select id, name, country, created_at from artists where owner_id is not null
      ) t), '[]'::json),
    'uploads', coalesce((
      select json_agg(t) from (
        select id, artist_id, title, category, style, medium, year, price,
               image_path, thumb_path, width, height, created_at
        from artworks where owner_id is not null and not hidden
        order by created_at desc limit 2000
      ) t), '[]'::json)
  )
$$;

create or replace function public.decide_role_application(p_id uuid, p_approve boolean, p_note text default null)
returns public.role_applications
language plpgsql security definer set search_path = public as $$
declare
  app public.role_applications;
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  update role_applications
     set status = case when p_approve then 'approved' else 'declined' end,
         decision_note = nullif(btrim(coalesce(p_note, '')), ''),
         decided_at = now(),
         decided_by = auth.uid()
   where id = p_id and status = 'pending'
  returning * into app;
  if app.id is null then
    raise exception 'That application is no longer pending' using errcode = 'P0001';
  end if;
  if p_approve then
    update profiles set role = app.role where id = app.user_id;
  end if;
  return app;
end $$;

create or replace function public.revoke_role(p_user uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  update profiles set role = 'fan' where id = p_user and role in ('critic', 'collector');
  if not found then
    raise exception 'That member has no verified role' using errcode = 'P0001';
  end if;
  update role_applications set decision_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), decision_note)
   where user_id = p_user and status = 'approved';
end $$;

drop function if exists public.ensure_member_artist(uuid);
drop function if exists public.log_audit(text, text, text, jsonb);
drop table if exists public.audit_events;

grant execute on function public.delete_artwork(text) to authenticated;
revoke all on function public.delete_artwork(text) from public, anon;
grant execute on function public.community_snapshot() to anon, authenticated;
commit;
