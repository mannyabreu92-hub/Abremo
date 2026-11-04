# Abremi community backend (Supabase)

Abremi runs in two modes:

- **Demo mode** (no configuration): everything a visitor does stays on their device.
- **Community mode**: accounts plus one shared database, so everyone's likes, saves, follows,
  reviews and Art Battle votes add up into the same rankings.

## Files

| File | Purpose |
| --- | --- |
| `migrations/0001_community.sql` | Tables, Row Level Security, role stamping, battle voting, community totals |
| `migrations/0002_artist_uploads.sql` | Member artists, uploaded artworks, the `artworks` image bucket and its access rules, publish/delete |
| `migrations/0003_member_leaderboards.sql` | Member leaderboards (`member_leaderboards()`), the leaderboard opt-out, neutral default names |
| `migrations/0004_role_applications.sql` | Critic & Collector applications, the admin list, and the review functions |
| `migrations/0006_profiles_artworks_collections.sql` | Audit trail, artist profiles, artwork details (description, size, availability), collections; the shared catalog starts every work at the same battle rating |
| `migrations/down/0006_down.sql` | Undoes 0006 (drops its tables and columns, with their data, and restores the earlier functions). Not part of `setup.sql` |
| `migrations/0010_radar_drops.sql` | Collector Radar (inquiries, messages, blocks, reports) and Drops (scheduled releases, hidden until release; pg_cron every 5 minutes) |
| `migrations/down/0010_down.sql` | Undoes 0010 (run it before `down/0009_down.sql` if undoing both) |
| `migrations/0009_analytics.sql` | Studio analytics (impressions, artwork views, profile visits) and weekly reports (pg_cron on Mondays) |
| `migrations/down/0009_down.sql` | Undoes 0009 (run it before `down/0008_down.sql` if undoing both) |
| `migrations/0008_competitions.sql` | Artist Arena and Creative Challenges: competitions, entries, votes, results, notifications (pg_cron closes due competitions every 10 minutes) |
| `migrations/down/0008_down.sql` | Undoes 0008 (run it before `down/0007_down.sql` if undoing both) |
| `migrations/0007_ranking_integrity.sql` | Self-votes excluded, rate limits, server-side scores, integrity flags for moderators, server-earned achievements (with pg_cron every 10 minutes) |
| `migrations/down/0007_down.sql` | Undoes 0007 (run it before `down/0006_down.sql` if undoing both) |
| `migrations/0005_live_updates.sql` | Live updates (the public `community_pulse` row, sent by Supabase Realtime) and the shared hourly charts (`community_history`, `chart_baseline()`, an hourly pg_cron job) |
| `seed.sql` | The catalog (artists, artworks, starting battle ratings), generated from `src/core/seed.js` |
| `setup.sql` | Both of the above in one file, to paste into the SQL editor. Safe to run more than once |
| `test/auth_stub.sql` | A stand-in for Supabase's `auth` schema, used only by the local database tests |

Regenerate `seed.sql` and `setup.sql` after changing the catalog or the migration: `npm run gen:sql`.

## Turning on community mode

1. **Create the database.** In the Vercel dashboard, open the project and go to **Storage → Create Database → Supabase**, then connect it to the project. Vercel adds `SUPABASE_URL` and `SUPABASE_ANON_KEY` (or their `NEXT_PUBLIC_` variants) to the environment. You can also add those two variables yourself from an existing Supabase project.
2. **Create the tables.** In Supabase, open **SQL Editor**, paste all of `setup.sql`, and **Run**.
3. **Allow sign-in links back to the site.** In Supabase, go to **Authentication → URL Configuration**. Set **Site URL** to `https://abremi.vercel.app` and add `https://abremi.vercel.app/**` under **Redirect URLs**.
4. **Make yourself a moderator** (after signing in to the site once), so you can review Critic and Collector applications at `#admin`:
   ```sql
   insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
   ```
5. **Build with the keys.** Set the Vercel project's **Build Command** to `node scripts/write-config.js`, then redeploy. The build log should say `Abremi: community mode`.

`scripts/write-config.js` publishes only the public URL and the anon (publishable) key. It refuses to publish a `service_role` or `sb_secret_` key.

## Security model

- Row Level Security is on for every table. People read and write only their own reactions, follows and profile.
- The role on each vote (fan ×1, artist ×3, critic ×5, collector ×9) is stamped by the database from the voter's profile. A client cannot claim a heavier role.
- Anyone can choose Fan or Artist. **Critic** and **Collector** are applied for and granted by a moderator:
  - Members apply with `apply_for_role()`: a statement (40–1,500 characters) and up to five `https://` links. One pending application per role, three applications per 30 days. Applying grants nothing.
  - Moderators are the members listed in `public.admins`. Nobody can read or change that table through the API; add moderators in the SQL editor (see step 4 above).
  - `admin_role_queue()`, `decide_role_application()`, `admin_verified_members()` and `revoke_role()` refuse anyone who isn't a moderator. The queue shows the applicant's email and their activity totals (likes, saves, reviews, influence added), never anyone else's private data.
  - Members can read only their own applications, and can't write to the table directly. Revoking a role sets the member back to Fan; votes already cast keep the weight they had.
- **Audit trail:** role approvals, declines and removals, and artwork deletions are recorded in `audit_events`, which no API user can read or write. Moderators read it with `admin_audit_log()`.
- **Artist profiles and artwork details** change only through `update_artist_profile()` and `update_artwork()`, which act on the caller's own rows. Websites must be `https://`; portraits must be in the artist's own storage folder.
- **Collections** are private by default. Row Level Security lets only the owner create, change or delete collections and their items; a shared collection (`is_private = false`) can be read by anyone, through `public_collection()` with the curator's display name. Hidden (moderated) works drop out of shared collections.
- **Ranking integrity (0007):** rankings, leaderboards and achievements count only `counted_reactions`, `counted_follows` and `counted_reviews`: never activity on your own work or artist page, and never reactions a moderator excluded. Those views read everyone's rows, so the API can't query them. Members can't change the exclusion on their own reactions. Rate limits: 600 likes and saves and 200 follows per member per hour. `detect_suspicious_activity()` flags a work with 10+ likes in an hour, 60%+ from accounts under 3 days old; `resolve_integrity_flag()` (moderators only) excludes them or dismisses the flag, and both are written to the audit trail. `integrity_flags` has no API access.
- **Achievements (0007)** are awarded only by `award_achievements()` (pg_cron, and when a member opens their own). `member_achievements` rows record the evidence; members read only their own. Criteria are public in `achievement_definitions`; artist achievements are public through `artist_achievements()`.
- **Competitions (0008):** only moderators create or cancel competitions (both audited). Every other change goes through functions: `enter_competition()` (your own published work, while entries are open, matching the medium, country or emerging rule; one entry per artist), `withdraw_entry()`, and `cast_competition_vote()` (one vote per member, all roles equal, changeable until close, never for your own entry, accounts 3+ days old with 5+ counted likes). Members read only their own votes; totals are published by `finalize_competition()` when voting closes, which also awards achievements and writes notifications. `notifications` rows are readable only by their recipient.
- **Analytics (0009):** `analytics_events` has no API access. Events arrive only through `record_events()`, which counts each viewer once per work or page per day, ignores artists' own views and works without an owner, keeps guests (anonymous device key) apart from members, and accepts 2,000 events per viewer per hour. Artists read only their own totals through `studio_analytics()`; country breakdowns group countries with fewer than 3 people as "Other". `weekly_reports` rows are readable only by their artist. Events older than 400 days are deleted.
- **Inquiries (0010):** `inquiries` and `inquiry_messages` are readable only by the two participants; every write goes through `send_inquiry()`, `reply_inquiry()`, `set_inquiry_status()`, `set_block()` and `report_inquiry()`, which enforce the rules (accounts 3+ days old, never your own work or a sample artist, purchase only when available or on request, one open conversation per subject, 10 new a day, 100 messages a day, blocks). Moderators can read a conversation only through `admin_inquiry_reports()` once it has been reported; resolving is audited. No contact details are ever exposed.
- **Drops (0010):** works in an upcoming drop are invisible to everyone but their artist (the artworks select policy and `community_snapshot()` both check `release_at`) and can't be liked or reviewed early. `create_drop()` accepts only the caller's own works; `release_due_drops()` notifies followers and subscribers once.
- **Live updates** never broadcast who did what. A trigger bumps a single public counter (`community_pulse`, at most once a second) whenever totals change; apps subscribed through Supabase Realtime then refetch `community_snapshot()`. It's the only table in the `supabase_realtime` publication.
- **Hourly charts** (`community_history`) keep the same public totals as `community_snapshot()`, without the upload list, for 8 days. `chart_baseline()` returns the latest earlier chart from the past 24 hours, or nothing, in which case the app shows no movement. pg_cron keeps a chart at the top of every hour; without pg_cron, the first visit in each hour keeps it.
- Battle ratings change only through `cast_battle_vote()`. It applies the same maths as `src/core/elo.js`, allows one vote per second, and allows the same pair once per 10 minutes.
- `community_snapshot()` exposes totals only (counts per artwork and role). It never shows who voted. It also lists member artists and their published works.
- **Uploads:**
  - Only members with the Artist role can upload. Images go to the public `artworks` bucket (5 MB limit; WebP, JPEG or PNG), and each artist can only write to or delete from their own folder.
  - `publish_artwork()` checks that both files were really uploaded, validates the details, and allows 20 new works per artist per day.
  - `delete_artwork()` works for the owner only, and removes the work's likes, saves, reviews and battle rating along with it.
  - The app resizes photos and strips their metadata (such as GPS location) before upload.
- **Moderation:** to hide a work from everyone, run `update artworks set hidden = true where id = '…';` in the SQL editor.

## Email

Supabase's built-in email sender is limited to a few sign-in emails per hour. Before inviting real users, set up a custom SMTP provider under **Authentication → Emails → SMTP Settings**. Resend and Postmark both have free tiers.

To let people type a code instead of tapping the link (handy when the link opens in a different browser), add `{{ .Token }}` to the **Magic Link** email template under **Authentication → Emails → Templates**.

## Tests

```bash
npm test                                                     # unit tests
ABREMI_PG="-h <host> -p <port> -U postgres" npm run test:db  # migration + security rules on a real Postgres
npm start & npm run test:e2e                                 # sign-in and sync flows in a browser (needs Playwright)
```
