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
| `migrations/0018_seasons.sql` | Seasons (monthly boards, frozen top 10 as achievements, pg_cron on the 1st), medium leagues, and daily Art Battle streaks |
| `migrations/down/0018_down.sql` | Undoes 0018 |
| `migrations/0017_checkout.sql` | Checkout (off until switched on): payout accounts, orders, 20% commission, editions, shipping and disputes, verified sales on the Passport |
| `migrations/down/0017_down.sql` | Undoes 0017 |
| `migrations/0016_index.sql` | The Abremi Index: weekly frozen charts (pg_cron every Monday 00:17 UTC), the archive, and artists' badges |
| `migrations/down/0016_down.sql` | Undoes 0016 |
| `migrations/0015_discovery_loop.sql` | Offers on purchase inquiries, waitlists, availability and price alerts, drop alerts for treasurers, collector interests |
| `migrations/down/0015_down.sql` | Undoes 0015 |
| `migrations/0014_teasers_badges.sql` | Drop teasers show a colour veil (no image) until release; artists can hide their plan badge |
| `migrations/down/0014_down.sql` | Undoes 0014 |
| `migrations/0013_assistant.sql` | The Abremi Guide: who may ask and how often (daily allowance per plan), the context it may see, personalization preferences, request and event counts (pruned after 400 days by pg_cron) |
| `migrations/down/0013_down.sql` | Undoes 0013 (run it before `down/0012_down.sql` if undoing both) |
| `migrations/0012_plans_galleries_beta.sql` | Plans and entitlements (payments off), gallery accounts, invite codes, feedback, the app error log (pruned daily by pg_cron), billing hooks for the service role |
| `migrations/down/0012_down.sql` | Undoes 0012 and restores the earlier Coach, analytics, drops and opportunities functions (run it before `down/0011_down.sql` if undoing both) |
| `migrations/0011_coach_passport_opportunities.sql` | Artist Passport (verified exhibitions), Opportunities (listings, suggestions, saves, deadline reminders by pg_cron daily) and the Career Coach's limits and context |
| `migrations/down/0011_down.sql` | Undoes 0011 (run it before `down/0010_down.sql` if undoing both) |
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
- **Passport (0011):** `exhibitions` rows are public only once a moderator verifies them; artists see their own pending and rejected rows. Writes go through `submit_exhibition()` (artists only, https source link, 10 pending at most) and `delete_exhibition()`; `review_exhibition()` is moderator-only, audited, and notifies the artist. `artist_passport()` returns only verified exhibitions, finished competition placings, earned achievements and milestones from existing records.
- **Opportunities (0011):** only approved, open listings are readable. `suggest_opportunity()` publishes directly for moderators (audited) and queues a member's suggestion (accounts 3+ days old, 5 a day). Saves are private; `send_deadline_reminders()` notifies each saver once, 3 days before the deadline.
- **Career Coach (0011):** the server function calls `begin_coach_request()` with the artist's own session token, so the database decides who may use it (artists only), enforces 20 requests a month per artist and 400 a day overall, and returns only that artist's own data (and a chosen work only if it is theirs). Failed requests don't count. `coach_requests` keeps the tool, time and outcome, never the draft.
- **Plans (0012):** `subscriptions` has no member writes. `current_plan()` reads it on the server, and every plan-dependent limit (Coach, analytics range, upcoming drops, review order, direct listings) calls it. `admin_grant_plan()` is moderator-only, needs an end date within a year, is audited and never overwrites a paid plan. `apply_billing_event()` is executable only by the service role, applies each event once, and refuses everything while `app_settings.payments_enabled` is false. No ranking function reads plans (tested).
- **Galleries (0012):** only verified galleries are public; `apply_gallery()` needs an account 3+ days old; `review_gallery()` is moderator-only, audited and notifies the applicant. Renaming a verified gallery sends it back for review.
- **Beta (0012):** invite codes are readable only through moderator functions; `check_invite()` reveals only yes or no. While `app_settings.invite_required` is on, the `abremi_guard_invite` trigger on `auth.users` refuses new accounts without a valid code. `feedback` rows are readable by their author and moderators; `client_errors` has no API access and stores no account, email or IP.
- **Guide (0013):** the server function calls `begin_assistant_request()` with the member's own session token. Signed-in members only; the artist mode only for artists; the plan's daily allowance plus 2,000 replies a day overall; failed replies don't count. The context is `assistant_catalog()` (visible works and artists with public totals: never hidden or unreleased works, owners or contact details) and `assistant_page_context()` (the page being viewed; private collections only for their owner, shared ones without the owner's name), plus the member's own follows, likes, saves and interests if personalization is on, their own collections in the collector mode, and their own Studio numbers in the artist mode. Neither function reads plans (tested). Conversations are never stored: `assistant_requests` keeps mode, time and outcome; `assistant_events` keeps counts of what people did with suggestions; both are readable only through moderator metrics.
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

## Career Coach (AI)

The Coach runs in a Vercel server function (`api/coach.js`) that calls Claude. To switch it on:

1. Create an API key at console.anthropic.com and set a monthly spend limit there (Settings → Limits).
2. In Vercel: Project → Settings → Environment Variables, add `ANTHROPIC_API_KEY` for Production (and Preview if you want it there), then redeploy.

Never paste the key into the app, the repository or a chat. Without the key, the Coach says it isn't set up yet and nothing else is affected. The Coach is a paid-plan feature to keep AI costs down: 60 requests a month on Pro, 150 on Elite, 100 on Gallery, none on Artist Free (set in migration 0013; while payments are off, moderators grant Pro or Elite). Requests use the API's server-side fallback: if the main model declines a request, the API retries on its fallback model. To turn that off, remove `betas` and `fallbacks` from `buildRequest()` in `api/coach.js`.

## Abremi Guide (AI)

The Guide runs in `api/assistant.js` and uses the same Anthropic connection and key as the Career Coach (`api/_ai.js`). If `ANTHROPIC_API_KEY` is set in Vercel (see Career Coach above), the Guide works too; without it, the Guide says it isn't switched on yet. It uses a faster, lower-cost model for chat (`claude-sonnet-5-5`); the Coach keeps `claude-opus-5-5` for drafts. Replies stream in, so the function needs Vercel's Node runtime (the default) and has up to 60 seconds.

Daily allowance: 30 messages on Artist Free, 60 on Pro, 100 on Elite, 60 on Gallery (the `plans.assistant_daily` column), plus 2,000 a day across the site (in `begin_assistant_request()`). Your Anthropic spend limit is the final safeguard. Usage is on the moderator page under **Guide**.

## Plans and payments

Plans work now: moderators grant them from the moderator page (Plans → Grant a plan) for a fixed period. **Payments are switched off** and stay off until the product requirements, payment provider, taxes and refund policy have been reviewed. When you're ready, in this order:

1. In Stripe, create a product with a monthly price for each of Pro, Elite and Gallery (test mode first).
2. Add a webhook endpoint `https://<your site>/api/stripe-webhook` for `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`.
3. In Vercel → Settings → Environment Variables (Production only), add `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_ELITE`, `STRIPE_PRICE_GALLERY`, `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Settings → API; server only, never in the app), `SITE_URL`, and `BILLING_ENABLED=true`. Add `STRIPE_AUTOMATIC_TAX=true` once Stripe Tax is set up. Redeploy.
4. In the Supabase SQL editor: `update app_settings set payments_enabled = true;`
5. Buy and cancel a plan with Stripe's test cards, and check the plan appears and lapses on Plans.

To switch payments off again at any time: `update app_settings set payments_enabled = false;` (or set `BILLING_ENABLED=false`).

## Selling artworks (checkout)

Built and **switched off**. Buyers pay with Stripe Checkout; artists are paid by **Stripe Connect Express** (Stripe verifies them and pays them directly; Abremi never holds their money) and Abremi keeps a **20% commission**. Artists ship and add tracking; buyers confirm delivery and can report a problem up to 14 days after; moderators decide (refunds are made in the Stripe dashboard and recorded automatically). Editions are prints the artist makes and ships (set the edition size when editing a work). **Taxes are not calculated by Abremi**: agree how sales tax/VAT is handled with your accountant before switching on.

To switch on (test mode first):

1. In Stripe, enable **Connect** (Express accounts) and complete the platform profile.
2. Add a webhook endpoint `https://<your site>/api/stripe-webhook` for `checkout.session.completed` and `charge.refunded`, and a second endpoint (same URL, "Events on Connected accounts") for `account.updated`.
3. In Vercel (Production): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (first endpoint), `STRIPE_CONNECT_WEBHOOK_SECRET` (second endpoint), `SUPABASE_SERVICE_ROLE_KEY`, `SITE_URL`, and `SALES_ENABLED=true`. Redeploy.
4. In the Supabase SQL editor: `update app_settings set sales_enabled = true;`
5. As an artist: Orders → Set up payouts (Stripe's test onboarding). As another member: buy with a test card (`4242 4242 4242 4242`), then ship, confirm delivery and try a refund.

To switch off at any time: `update app_settings set sales_enabled = false;`

## Seasons and streaks
Migration `0018_seasons.sql` adds:
- `member_leaderboards(p_country, p_limit, p_season, p_medium)`: pass any date in a month as `p_season` for that month's boards, and a medium id (`oil`, `sculpture`, …) as `p_medium`.
- `close_season(date)`: freezes a finished month's top 10 per board into `season_results` and awards the achievements. pg_cron runs it at 00:23 UTC on the 1st (`abremi-season-close`). Running it again for the same month changes nothing. To close a month by hand: `select close_season('2026-11-01');` (only for finished months).
- `my_battle_streak()`: the signed-in member's daily Art Battle streak. Milestone achievements (7, 30, 100 days) are awarded as votes arrive.

## Beta testing

- **Invite-only sign-up:** Moderator page → Beta → *Require invite codes*, then *Create invite code* (choose how many uses and for how long). Share the code; new members type it when they sign in. Existing members are unaffected. *Open sign-ups* switches it off.
- **Feedback:** members use *Send feedback* (phone menu, Profile, or the footer). It appears under Beta on the moderator page until resolved.
- **App errors:** the browser reports errors it hits (at most 5 per visit), grouped on the moderator page by message, for the last 7 days.

## Email

Supabase's built-in email sender is limited to a few sign-in emails per hour. Before inviting real users, set up a custom SMTP provider under **Authentication → Emails → SMTP Settings**. Resend and Postmark both have free tiers.

To let people type a code instead of tapping the link (handy when the link opens in a different browser), add `{{ .Token }}` to the **Magic Link** email template under **Authentication → Emails → Templates**.

## Tests

```bash
npm test                                                     # unit tests
ABREMI_PG="-h <host> -p <port> -U postgres" npm run test:db  # migration + security rules on a real Postgres
npm start & npm run test:e2e                                 # sign-in and sync flows in a browser (needs Playwright)
```
