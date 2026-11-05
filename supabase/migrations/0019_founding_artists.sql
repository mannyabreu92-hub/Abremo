-- 0019: Founding artists. Moderators pick member artists to feature in a clearly labelled
-- "Founding artists" section and badge. Editorial only: no ranking, score, chart or Index reads
-- this table (tests/db.test.js checks), and it can't be bought.

create table if not exists public.founding_artists (
  artist_id text primary key references public.artists (id) on delete cascade,
  added_at timestamptz not null default now(),
  added_by uuid references public.profiles (id) on delete set null
);
alter table public.founding_artists enable row level security;
drop policy if exists "founding artists are public" on public.founding_artists;
create policy "founding artists are public" on public.founding_artists for select using (true);
revoke all on public.founding_artists from anon, authenticated;
grant select on public.founding_artists to anon, authenticated;

-- The featured artists, earliest first: member artists with at least one published, visible work.
create or replace function public.founding_artists_list() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('artist_id', f.artist_id, 'since', f.added_at) order by f.added_at, f.artist_id), '[]'::json)
  from founding_artists f join artists ar on ar.id = f.artist_id
  where ar.owner_id is not null
    and exists (select 1 from artworks w where w.artist_id = ar.id and not w.hidden and (w.release_at is null or w.release_at <= now()))
$$;
revoke all on function public.founding_artists_list() from public;
grant execute on function public.founding_artists_list() to anon, authenticated;

-- Moderators add or remove a founding artist (member artists only). Logged in the audit trail.
create or replace function public.admin_set_founding(p_artist text, p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  if not exists (select 1 from artists where id = p_artist and owner_id is not null) then
    raise exception 'Only member artists can be founding artists';
  end if;
  if p_on then
    insert into founding_artists (artist_id, added_by) values (p_artist, auth.uid()) on conflict (artist_id) do nothing;
  else
    delete from founding_artists where artist_id = p_artist;
  end if;
  perform log_audit(case when p_on then 'artist.founding_added' else 'artist.founding_removed' end, 'artist', p_artist, '{}'::jsonb);
  return p_on;
end $$;
revoke all on function public.admin_set_founding(text, boolean) from public, anon;
grant execute on function public.admin_set_founding(text, boolean) to authenticated;
