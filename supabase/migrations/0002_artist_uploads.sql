-- Abremi artist uploads
-- Members with the Artist role publish photos of their work. Images live in the public
-- "artworks" storage bucket; each artist can only write to a folder named after their user id.
-- Published works join the shared catalog, so they appear in feeds, rankings and Art Battles.

-- ——— Member artists ———
alter table public.artists add column if not exists owner_id uuid unique references public.profiles (id) on delete cascade;
alter table public.artists add column if not exists created_at timestamptz not null default now();

-- ——— Uploaded artworks (catalog rows keep these columns empty) ———
alter table public.artworks add column if not exists owner_id uuid references public.profiles (id) on delete cascade;
alter table public.artworks add column if not exists category text;
alter table public.artworks add column if not exists style text;
alter table public.artworks add column if not exists medium text;
alter table public.artworks add column if not exists year integer;
alter table public.artworks add column if not exists price integer;
alter table public.artworks add column if not exists image_path text;
alter table public.artworks add column if not exists thumb_path text;
alter table public.artworks add column if not exists width integer;
alter table public.artworks add column if not exists height integer;
alter table public.artworks add column if not exists created_at timestamptz not null default now();
alter table public.artworks add column if not exists hidden boolean not null default false; -- for moderation
create index if not exists artworks_owner_idx on public.artworks (owner_id, created_at desc);

alter table public.artworks drop constraint if exists artworks_upload_valid;
alter table public.artworks add constraint artworks_upload_valid check (
  owner_id is null or (
    char_length(btrim(title)) between 1 and 60
    and category in ('oil', 'illustration', 'sculpture', 'photography', 'digital', 'street', 'ai', 'nft', 'mixed')
    and style in ('Impressionism', 'Expressionism', 'Abstract', 'Minimalism', 'Pop Art', 'Realism', 'Surrealism', 'Cubism', 'Futurism', 'Vaporwave')
    and char_length(coalesce(medium, '')) <= 80
    and year between 1900 and 2100
    and price between 10 and 10000000
    and width between 1 and 10000 and height between 1 and 10000
    and split_part(image_path, '/', 1) = owner_id::text
    and split_part(thumb_path, '/', 1) = owner_id::text
  )
);

-- Moderated works disappear for everyone.
drop policy if exists "catalog is public" on public.artworks;
create policy "catalog is public" on public.artworks for select using (not hidden);

-- ——— Image storage ———
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('artworks', 'artworks', true, 5242880, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "artists upload to their own folder" on storage.objects;
create policy "artists upload to their own folder" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'artworks'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'artist')
  );

-- Deleting (and Storage's remove API) needs the rows to be readable too, so artists can see their own folder.
drop policy if exists "artists read their own files" on storage.objects;
create policy "artists read their own files" on storage.objects for select to authenticated
  using (bucket_id = 'artworks' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "artists delete their own files" on storage.objects;
create policy "artists delete their own files" on storage.objects for delete to authenticated
  using (bucket_id = 'artworks' and (storage.foldername(name))[1] = auth.uid()::text);

-- ——— Publishing ———
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

-- Removes the work (and its likes, saves, reviews and ratings) and returns the files to delete.
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

-- A member's public artist name and country follow their profile.
create or replace function public.sync_member_artist() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update artists set name = new.name, country = new.country where owner_id = new.id;
  return new;
end $$;

drop trigger if exists profiles_sync_artist on public.profiles;
create trigger profiles_sync_artist after update of name, country on public.profiles
  for each row execute function public.sync_member_artist();

-- ——— Community snapshot, now with member artists and their newest works ———
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

-- ——— Grants ———
revoke all on function public.publish_artwork(text, text, text, text, integer, integer, text, text, integer, integer) from public, anon;
grant execute on function public.publish_artwork(text, text, text, text, integer, integer, text, text, integer, integer) to authenticated;
revoke all on function public.delete_artwork(text) from public, anon;
grant execute on function public.delete_artwork(text) to authenticated;
grant execute on function public.community_snapshot() to anon, authenticated;
