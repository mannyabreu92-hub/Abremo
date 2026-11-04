-- Abremi Phase 4: Collector Radar (real inquiries between members and artists) and Drops
-- (scheduled releases). Adds only; undo with supabase/migrations/down/0010_down.sql.
--
-- Inquiries: in-app conversations only; each side sees the other's display name, nothing else.
-- Only the two participants can read a conversation; moderators see one only if it is reported.
-- Drops: an artist schedules works for release; they stay hidden until the release time.

-- ——— 1. Collector Radar ———
create table if not exists public.inquiries (
  id uuid primary key default gen_random_uuid(),
  artwork_id text references public.artworks (id) on delete cascade,      -- null: about the artist (commission, sponsorship)
  artist_id text not null references public.artists (id) on delete cascade,
  artist_user uuid not null references public.profiles (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('purchase', 'commission', 'question', 'sponsorship')),
  status text not null default 'open' check (status in ('open', 'closed', 'declined')),
  artist_unread boolean not null default true,
  sender_unread boolean not null default false,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  check (artist_user <> sender_id)
);
create index if not exists inquiries_artist_idx on public.inquiries (artist_user, last_message_at desc);
create index if not exists inquiries_sender_idx on public.inquiries (sender_id, last_message_at desc);
create index if not exists inquiries_artwork_idx on public.inquiries (artwork_id);

create table if not exists public.inquiry_messages (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null references public.inquiries (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists inquiry_messages_thread_idx on public.inquiry_messages (inquiry_id, created_at);
create index if not exists inquiry_messages_sender_idx on public.inquiry_messages (sender_id, created_at);

create table if not exists public.member_blocks (
  user_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, blocked_id),
  check (user_id <> blocked_id)
);

create table if not exists public.inquiry_reports (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null references public.inquiries (id) on delete cascade,
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  reason text not null check (char_length(btrim(reason)) between 3 and 500),
  status text not null default 'open' check (status in ('open', 'dismissed', 'closed')),
  created_at timestamptz not null default now(),
  unique (inquiry_id, reporter_id)
);

alter table public.inquiries enable row level security;
alter table public.inquiry_messages enable row level security;
alter table public.member_blocks enable row level security;
alter table public.inquiry_reports enable row level security;
drop policy if exists "participants read inquiries" on public.inquiries;
create policy "participants read inquiries" on public.inquiries for select using (auth.uid() in (artist_user, sender_id));
drop policy if exists "participants read messages" on public.inquiry_messages;
create policy "participants read messages" on public.inquiry_messages for select
  using (exists (select 1 from public.inquiries i where i.id = inquiry_id and auth.uid() in (i.artist_user, i.sender_id)));
drop policy if exists "read own blocks" on public.member_blocks;
create policy "read own blocks" on public.member_blocks for select using (user_id = auth.uid());
revoke all on public.inquiries, public.inquiry_messages, public.member_blocks, public.inquiry_reports from anon, authenticated;
grant select on public.inquiries, public.inquiry_messages, public.member_blocks to authenticated;

create or replace function public.is_blocked_between(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from member_blocks where (user_id = a and blocked_id = b) or (user_id = b and blocked_id = a))
$$;
revoke all on function public.is_blocked_between(uuid, uuid) from public, anon, authenticated;

-- Start a conversation about a work (or, with p_artwork null, about an artist: commission, sponsorship, question).
create or replace function public.send_inquiry(p_artwork text, p_artist text, p_kind text, p_message text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  w public.artworks;
  ar public.artists;
  q public.inquiries;
begin
  if uid is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if (select created_at from profiles where id = uid) > now() - interval '3 days' then
    raise exception 'New accounts can send inquiries after 3 days' using errcode = '42501';
  end if;
  if p_kind not in ('purchase', 'commission', 'question', 'sponsorship') then
    raise exception 'Unknown inquiry type' using errcode = '22023';
  end if;
  if p_artwork is not null then
    select * into w from artworks where id = p_artwork;
    if w.id is null or w.hidden or (w.release_at is not null and w.release_at > now()) then
      raise exception 'Artwork not found' using errcode = 'P0002';
    end if;
    select * into ar from artists where id = w.artist_id;
    if p_kind = 'purchase' and coalesce(w.availability, 'available') not in ('available', 'on_request') then
      raise exception 'This work isn’t available' using errcode = '22023';
    end if;
  else
    select * into ar from artists where id = p_artist;
    if p_kind = 'purchase' then
      raise exception 'Choose a work to ask about buying it' using errcode = '22023';
    end if;
  end if;
  if ar.id is null or ar.owner_id is null then
    raise exception 'Sample artists can’t be contacted' using errcode = '22023';
  end if;
  if ar.owner_id = uid then
    raise exception 'That’s your own work' using errcode = '22023';
  end if;
  if is_blocked_between(uid, ar.owner_id) then
    raise exception 'You can’t contact this member' using errcode = '42501';
  end if;
  if (select count(*) from inquiries where sender_id = uid and created_at > now() - interval '1 day') >= 10 then
    raise exception 'You can start 10 conversations a day' using errcode = 'P0001';
  end if;
  if exists (select 1 from inquiries where sender_id = uid and artist_id = ar.id and status = 'open'
               and artwork_id is not distinct from w.id) then
    raise exception 'You already have an open conversation about this' using errcode = 'P0001';
  end if;
  if char_length(btrim(coalesce(p_message, ''))) < 10 then
    raise exception 'Write a little more (at least 10 characters)' using errcode = '22023';
  end if;
  insert into inquiries (artwork_id, artist_id, artist_user, sender_id, kind)
  values (w.id, ar.id, ar.owner_id, uid, p_kind) returning * into q;
  insert into inquiry_messages (inquiry_id, sender_id, body) values (q.id, uid, btrim(p_message));
  insert into notifications (user_id, kind, title, link)
  values (ar.owner_id, 'inquiry', (select name from profiles where id = uid) || ' sent you ' ||
          case p_kind when 'purchase' then 'a purchase inquiry' when 'commission' then 'a commission request'
                      when 'sponsorship' then 'a sponsorship request' else 'a question' end ||
          coalesce(' about “' || w.title || '”', ''), 'inquiry/' || q.id);
  return q.id;
end $$;

create or replace function public.reply_inquiry(p_id uuid, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  q public.inquiries;
  other uuid;
begin
  select * into q from inquiries where id = p_id and uid in (artist_user, sender_id);
  if q.id is null then
    raise exception 'Conversation not found' using errcode = 'P0002';
  end if;
  if q.status <> 'open' then
    raise exception 'This conversation is closed' using errcode = 'P0001';
  end if;
  other := case when uid = q.artist_user then q.sender_id else q.artist_user end;
  if is_blocked_between(uid, other) then
    raise exception 'You can’t message this member' using errcode = '42501';
  end if;
  if (select count(*) from inquiry_messages where sender_id = uid and created_at > now() - interval '1 day') >= 100 then
    raise exception 'You can send 100 messages a day' using errcode = 'P0001';
  end if;
  insert into inquiry_messages (inquiry_id, sender_id, body) values (q.id, uid, btrim(coalesce(p_body, '')));
  -- One notification per unread stretch, not one per message.
  if (uid = q.artist_user and not q.sender_unread) or (uid = q.sender_id and not q.artist_unread) then
    insert into notifications (user_id, kind, title, link)
    values (other, 'inquiry_reply', (select name from profiles where id = uid) || ' replied to your conversation', 'inquiry/' || q.id);
  end if;
  update inquiries set last_message_at = now(),
         artist_unread = artist_unread or uid = sender_id,
         sender_unread = sender_unread or uid = artist_user
   where id = q.id;
end $$;

-- The artist can decline or close; the sender can close.
create or replace function public.set_inquiry_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare q public.inquiries;
begin
  select * into q from inquiries where id = p_id and auth.uid() in (artist_user, sender_id);
  if q.id is null then
    raise exception 'Conversation not found' using errcode = 'P0002';
  end if;
  if p_status not in ('closed', 'declined') or (p_status = 'declined' and auth.uid() <> q.artist_user) then
    raise exception 'Only the artist can decline; either of you can close' using errcode = '42501';
  end if;
  update inquiries set status = p_status where id = q.id;
end $$;

create or replace function public.mark_inquiry_read(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update inquiries set artist_unread = case when auth.uid() = artist_user then false else artist_unread end,
                       sender_unread = case when auth.uid() = sender_id then false else sender_unread end
   where id = p_id and auth.uid() in (artist_user, sender_id)
$$;

-- Your conversations, newest first, with the other member's display name and role only.
create or replace function public.my_inquiries() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object(
    'id', q.id, 'kind', q.kind, 'status', q.status, 'artwork', q.artwork_id, 'artist', q.artist_id,
    'side', case when q.artist_user = auth.uid() then 'artist' else 'sender' end,
    'other_name', p.name, 'other_role', p.role,
    'unread', case when q.artist_user = auth.uid() then q.artist_unread else q.sender_unread end,
    'last_message', (select left(m.body, 140) from inquiry_messages m where m.inquiry_id = q.id order by m.created_at desc limit 1),
    'last_message_at', q.last_message_at
  ) order by q.last_message_at desc), '[]'::json)
  from inquiries q
  join profiles p on p.id = case when q.artist_user = auth.uid() then q.sender_id else q.artist_user end
  where auth.uid() in (q.artist_user, q.sender_id)
$$;

create or replace function public.inquiry_thread(p_id uuid) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'id', q.id, 'kind', q.kind, 'status', q.status, 'artwork', q.artwork_id, 'artist', q.artist_id,
    'side', case when q.artist_user = auth.uid() then 'artist' else 'sender' end,
    'other_id', case when q.artist_user = auth.uid() then q.sender_id else q.artist_user end,
    'other_name', p.name, 'other_role', p.role,
    'blocked', exists (select 1 from member_blocks b where b.user_id = auth.uid() and b.blocked_id = p.id),
    'messages', coalesce((select json_agg(json_build_object('mine', m.sender_id = auth.uid(), 'body', m.body, 'at', m.created_at) order by m.created_at)
                          from inquiry_messages m where m.inquiry_id = q.id), '[]'::json))
  from inquiries q
  join profiles p on p.id = case when q.artist_user = auth.uid() then q.sender_id else q.artist_user end
  where q.id = p_id and auth.uid() in (q.artist_user, q.sender_id)
$$;

-- Block or unblock the other member of a conversation (blocking also closes open conversations between you).
create or replace function public.set_block(p_inquiry uuid, p_block boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  q public.inquiries;
  other uuid;
begin
  select * into q from inquiries where id = p_inquiry and auth.uid() in (artist_user, sender_id);
  if q.id is null then
    raise exception 'Conversation not found' using errcode = 'P0002';
  end if;
  other := case when auth.uid() = q.artist_user then q.sender_id else q.artist_user end;
  if p_block then
    insert into member_blocks (user_id, blocked_id) values (auth.uid(), other) on conflict do nothing;
    update inquiries set status = 'closed' where status = 'open'
      and ((artist_user = auth.uid() and sender_id = other) or (artist_user = other and sender_id = auth.uid()));
  else
    delete from member_blocks where user_id = auth.uid() and blocked_id = other;
  end if;
end $$;

create or replace function public.report_inquiry(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from inquiries where id = p_id and auth.uid() in (artist_user, sender_id)) then
    raise exception 'Conversation not found' using errcode = 'P0002';
  end if;
  insert into inquiry_reports (inquiry_id, reporter_id, reason) values (p_id, auth.uid(), btrim(coalesce(p_reason, '')))
  on conflict (inquiry_id, reporter_id) do update set reason = excluded.reason, status = 'open', created_at = now();
end $$;

-- Moderators see a conversation only once it has been reported; opening it is recorded.
create or replace function public.admin_inquiry_reports() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return coalesce((select json_agg(json_build_object(
    'id', r.id, 'inquiry', r.inquiry_id, 'reason', r.reason, 'created_at', r.created_at,
    'reporter', rp.name, 'artist', ap.name, 'sender', sp.name, 'status', q.status,
    'messages', (select json_agg(json_build_object('from', mp.name, 'body', m.body, 'at', m.created_at) order by m.created_at)
                 from inquiry_messages m join profiles mp on mp.id = m.sender_id where m.inquiry_id = q.id)
  ) order by r.created_at)
  from inquiry_reports r join inquiries q on q.id = r.inquiry_id
  join profiles rp on rp.id = r.reporter_id join profiles ap on ap.id = q.artist_user join profiles sp on sp.id = q.sender_id
  where r.status = 'open'), '[]'::json);
end $$;

create or replace function public.resolve_inquiry_report(p_id uuid, p_close boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r public.inquiry_reports;
begin
  if not is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  update inquiry_reports set status = case when p_close then 'closed' else 'dismissed' end where id = p_id and status = 'open' returning * into r;
  if r.id is null then
    raise exception 'That report is no longer open' using errcode = 'P0001';
  end if;
  if p_close then
    update inquiries set status = 'closed' where id = r.inquiry_id;
  end if;
  perform log_audit(case when p_close then 'inquiry_report.closed' else 'inquiry_report.dismissed' end, 'inquiry', r.inquiry_id::text,
                    jsonb_build_object('report', r.id, 'note', nullif(btrim(coalesce(p_note, '')), '')));
end $$;

-- Collector interest for the caller's works: inquiries, and how many verified collectors saved each (counts only).
create or replace function public.collector_interest() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object(
    'artwork', w.id,
    'inquiries', (select count(*) from inquiries q where q.artwork_id = w.id),
    'open_inquiries', (select count(*) from inquiries q where q.artwork_id = w.id and q.status = 'open'),
    'collector_saves', (select count(*) from counted_reactions r where r.artwork_id = w.id and r.kind = 'super' and r.role = 'collector')
  )), '[]'::json)
  from artworks w join artists ar on ar.id = w.artist_id
  where ar.owner_id = auth.uid()
$$;

-- ——— 2. Drops ———
create table if not exists public.drops (
  id uuid primary key default gen_random_uuid(),
  artist_id text not null references public.artists (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 3 and 80),
  description text not null default '' check (char_length(description) <= 1000),
  release_at timestamptz not null,
  teaser_artwork text references public.artworks (id) on delete set null,
  created_at timestamptz not null default now(),
  released_at timestamptz,
  cancelled_at timestamptz
);
create index if not exists drops_release_idx on public.drops (release_at) where released_at is null and cancelled_at is null;

create table if not exists public.drop_subscriptions (
  drop_id uuid not null references public.drops (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (drop_id, user_id)
);

alter table public.artworks add column if not exists drop_id uuid references public.drops (id) on delete set null;
alter table public.artworks add column if not exists release_at timestamptz;   -- hidden from everyone else until then

alter table public.drops enable row level security;
alter table public.drop_subscriptions enable row level security;
drop policy if exists "drops are public" on public.drops;
create policy "drops are public" on public.drops for select using (true);
drop policy if exists "read own drop subscriptions" on public.drop_subscriptions;
create policy "read own drop subscriptions" on public.drop_subscriptions for select using (user_id = auth.uid());
revoke all on public.drops, public.drop_subscriptions from anon, authenticated;
grant select on public.drops to anon, authenticated;
grant select on public.drop_subscriptions to authenticated;

-- Unreleased works are invisible to everyone but their artist.
drop policy if exists "catalog is public" on public.artworks;
create policy "catalog is public" on public.artworks for select
  using (not hidden and (release_at is null or release_at <= now() or owner_id = auth.uid()));

-- …and can't be liked, saved or voted on early (by guessing their id).
create or replace function public.guard_unreleased() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from artworks where id = new.artwork_id and release_at > now()) then
    raise exception 'This work hasn’t been released yet' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists reactions_unreleased on public.reactions;
create trigger reactions_unreleased before insert or update on public.reactions for each row execute function public.guard_unreleased();
drop trigger if exists reviews_unreleased on public.reviews;
create trigger reviews_unreleased before insert on public.reviews for each row execute function public.guard_unreleased();

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

-- Cancelling (by the artist, or a moderator, recorded) makes the works visible again without a release.
create or replace function public.cancel_drop(p_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare d public.drops;
begin
  select * into d from drops where id = p_id and released_at is null and cancelled_at is null;
  if d.id is null then
    raise exception 'That drop has already been released or cancelled' using errcode = 'P0001';
  end if;
  if d.owner_id <> auth.uid() and not is_admin() then
    raise exception 'Only the artist or a moderator can cancel a drop' using errcode = '42501';
  end if;
  update drops set cancelled_at = now() where id = d.id;
  update artworks set release_at = null where drop_id = d.id;
  if d.owner_id <> auth.uid() then
    perform log_audit('drop.cancelled', 'drop', d.id::text, jsonb_build_object('title', d.title, 'note', nullif(btrim(coalesce(p_note, '')), '')));
  end if;
end $$;

create or replace function public.subscribe_drop(p_id uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if p_on then
    insert into drop_subscriptions (drop_id, user_id)
    select id, auth.uid() from drops where id = p_id and released_at is null and cancelled_at is null
    on conflict do nothing;
  else
    delete from drop_subscriptions where drop_id = p_id and user_id = auth.uid();
  end if;
end $$;

-- Releases due drops: notifies followers and subscribers once. (Visibility follows release_at by itself.)
create or replace function public.release_due_drops() returns integer
language plpgsql security definer set search_path = public as $$
declare
  d record;
  n integer := 0;
begin
  for d in select dr.*, ar.name as artist_name from drops dr join artists ar on ar.id = dr.artist_id
            where dr.released_at is null and dr.cancelled_at is null and dr.release_at <= now() for update of dr loop
    update drops set released_at = now() where id = d.id;
    insert into notifications (user_id, kind, title, link)
    select u, 'drop_released', d.artist_name || '’s drop “' || d.title || '” is live', 'drop/' || d.id
    from (select f.user_id as u from counted_follows f where f.artist_id = d.artist_id
          union select s.user_id from drop_subscriptions s where s.drop_id = d.id) x
    where u <> d.owner_id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.release_due_drops() from public, anon, authenticated;

-- Upcoming and recent drops, with a teaser (one work's thumbnail, shown blurred until release).
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

-- The caller's own unreleased works (hidden from the public snapshot until release).
create or replace function public.my_scheduled_works() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('id', id, 'title', title, 'drop_id', drop_id, 'release_at', release_at,
                                             'thumb_path', thumb_path, 'image_path', image_path) order by release_at), '[]'::json)
  from artworks where owner_id = auth.uid() and release_at > now()
$$;

-- ——— 3. The public snapshot leaves out unreleased works ———
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
        from artworks where owner_id is not null and not hidden and (release_at is null or release_at <= now())
        order by created_at desc limit 2000
      ) t), '[]'::json)
  )
$$;
grant execute on function public.community_snapshot() to anon, authenticated;

-- ——— Grants ———
do $$
declare f text;
begin
  foreach f in array array[
    'send_inquiry(text, text, text, text)', 'reply_inquiry(uuid, text)', 'set_inquiry_status(uuid, text)', 'mark_inquiry_read(uuid)',
    'my_inquiries()', 'inquiry_thread(uuid)', 'set_block(uuid, boolean)', 'report_inquiry(uuid, text)',
    'admin_inquiry_reports()', 'resolve_inquiry_report(uuid, boolean, text)', 'collector_interest()',
    'create_drop(text, text, timestamptz, text[], text)', 'cancel_drop(uuid, text)', 'subscribe_drop(uuid, boolean)', 'my_scheduled_works()'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['drops_overview()', 'drop_detail(uuid)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;

-- Release drops on time where pg_cron is available (every 5 minutes).
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('abremi-drops', '*/5 * * * *', 'select public.release_due_drops();');
  end if;
exception when others then
  raise notice 'Schedule not set up (%). Drops are announced as released when someone opens them instead.', sqlerrm;
end $$;
