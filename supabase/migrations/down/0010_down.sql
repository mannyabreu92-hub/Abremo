-- Undo for 0010_radar_drops.sql: drops inquiries, messages, blocks, reports, drops and drop
-- subscriptions (with their data), makes any unreleased works visible, and restores the 0007
-- snapshot and the 0002 catalog policy. Run it before down/0009_down.sql if undoing several.
begin;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then perform cron.unschedule('abremi-drops'); end if;
exception when others then null;
end $$;
drop policy if exists "catalog is public" on public.artworks;
create policy "catalog is public" on public.artworks for select using (not hidden);
drop trigger if exists reactions_unreleased on public.reactions;
drop trigger if exists reviews_unreleased on public.reviews;
drop function if exists public.guard_unreleased();
alter table public.artworks drop column if exists release_at, drop column if exists drop_id;
drop function if exists public.my_scheduled_works();
drop function if exists public.drop_detail(uuid);
drop function if exists public.drops_overview();
drop function if exists public.release_due_drops();
drop function if exists public.subscribe_drop(uuid, boolean);
drop function if exists public.cancel_drop(uuid, text);
drop function if exists public.create_drop(text, text, timestamptz, text[], text);
drop table if exists public.drop_subscriptions;
drop table if exists public.drops;
drop function if exists public.collector_interest();
drop function if exists public.resolve_inquiry_report(uuid, boolean, text);
drop function if exists public.admin_inquiry_reports();
drop function if exists public.report_inquiry(uuid, text);
drop function if exists public.set_block(uuid, boolean);
drop function if exists public.inquiry_thread(uuid);
drop function if exists public.my_inquiries();
drop function if exists public.mark_inquiry_read(uuid);
drop function if exists public.set_inquiry_status(uuid, text);
drop function if exists public.reply_inquiry(uuid, text);
drop function if exists public.send_inquiry(text, text, text, text);
drop function if exists public.is_blocked_between(uuid, uuid);
drop table if exists public.inquiry_reports;
drop table if exists public.member_blocks;
drop table if exists public.inquiry_messages;
drop table if exists public.inquiries;
delete from public.notifications where kind in ('inquiry', 'inquiry_reply', 'drop_announced', 'drop_released');

-- The 0007 snapshot.
create or replace function public.community_snapshot() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'reactions', coalesce((
      select json_agg(t) from (
        select artwork_id as a, kind as k, role as r, count(*)::int as n
        from counted_reactions where kind in ('like', 'super') group by 1, 2, 3
      ) t), '[]'::json),
    'reviews', coalesce((
      select json_agg(t) from (
        select artwork_id as a, count(*)::int as n, sum(rating)::int as s from counted_reviews group by 1
      ) t), '[]'::json),
    'follows', coalesce((
      select json_agg(t) from (
        select artist_id as a, role as r, count(*)::int as n from counted_follows group by 1, 2
      ) t), '[]'::json),
    'ratings', coalesce((
      select json_agg(t) from (select artwork_id as a, rating as v, votes as n from artwork_ratings) t
    ), '[]'::json),
    'scores', coalesce((
      select json_agg(x) from (
        select artwork_id as a, popularity as p, trending as t, collector as c, critic as cr from artwork_scores()
      ) x), '[]'::json),
    'artist_scores', coalesce((
      select json_agg(t) from (select artist_id as a, reputation as s from artist_scores()) t
    ), '[]'::json),
    'members', (select count(*)::int from profiles),
    'artists', coalesce((
      select json_agg(t) from (
        select id, name, country, created_at, bio, statement, website, instagram, city, avatar_path
        from artists where owner_id is not null
      ) t), '[]'::json),
    'uploads', coalesce((
      select json_agg(t) from (
        select id, artist_id, title, category, style, medium, year, price,
               image_path, thumb_path, width, height, created_at, description, dimensions, availability
        from artworks where owner_id is not null and not hidden
        order by created_at desc limit 2000
      ) t), '[]'::json)
  )
$$;
grant execute on function public.community_snapshot() to anon, authenticated;
commit;
