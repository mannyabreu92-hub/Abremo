-- 0021: "Active since": an artist can give the year their career began (shown as "Active since
-- 1994"). Artists who don't are shown as "On Abremi since <year they joined>". Display only:
-- nothing in the rankings reads it (the "new artist" signals keep using the join date).

alter table public.artists add column if not exists active_since integer;
do $$ begin
  alter table public.artists add constraint artists_active_since_valid check (active_since is null or active_since between 1900 and 2100);
exception when duplicate_object then null;
end $$;

-- Set (or clear, with null) your own artist's year. Not in the future.
create or replace function public.set_active_since(p_year integer) returns integer
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if p_year is not null and (p_year < 1900 or p_year > extract(year from now())::int) then
    raise exception 'Enter a year between 1900 and this year' using errcode = '22023';
  end if;
  perform ensure_member_artist(uid);
  update artists set active_since = p_year, updated_at = now() where owner_id = uid;
  return p_year;
end $$;
revoke all on function public.set_active_since(integer) from public, anon;
grant execute on function public.set_active_since(integer) to authenticated;

-- Everyone can read the years (member artists only).
create or replace function public.artists_active_since() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('artist_id', id, 'year', active_since)), '[]'::json)
  from artists where owner_id is not null and active_since is not null
$$;
revoke all on function public.artists_active_since() from public;
grant execute on function public.artists_active_since() to anon, authenticated;
