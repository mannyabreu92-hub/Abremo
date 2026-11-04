# Abremi security review (Phase 6)

Date: November 2026. Scope: the whole app as of migration 0012: the Supabase schema (migrations
0001–0012), the three server functions (`api/coach.js`, `api/billing.js`, `api/stripe-webhook.js`),
the browser app, the Vercel configuration and the dependencies.

## How it was checked

- **Automated, on every test run** (`npm run test:db`, both table-exposure modes):
  - every table in `public` has row-level security switched on;
  - every `security definer` function pins its `search_path`;
  - guests (`anon`) can run only an explicit allow-list of 17 public functions;
  - all 28 moderator functions (`admin_*`, `review_*`, `resolve_*`, `decide_*`, role and competition
    management) check `is_admin()` themselves;
  - direct writes to protected tables (subscriptions, galleries, exhibitions, coach requests, and
    others) are refused for members;
  - private rows (feedback, invite codes, the error log, other members' plans) are invisible to
    other members and guests;
  - plans never change rankings: scores, the public snapshot and the leaderboards are byte-identical
    before and after a plan is applied, and no ranking function reads plan data;
  - each migration can be undone and re-applied.
- **Server functions:** unit tests with stand-ins (`tests/coach.test.js`, `tests/billing.test.js`)
  cover sign-in requirements, Stripe signature checks (wrong secret, tampering, replay older than 5
  minutes), the switched-off state, and that the plan comes from the price ID, never from request data
  or metadata.
- **Code review** of the new and changed code: escaping of every value put into HTML, links
  (`rel="noopener noreferrer nofollow"`, https only), and where keys live.
- **Secret scan** of the repository: no service-role keys, Stripe keys, webhook secrets or JWTs. The
  build refuses to publish a `service_role` or `sb_secret_` key (`scripts/write-config.js`).
- **Dependencies:** `npm audit --omit=dev` reports 0 vulnerabilities in what ships.

## Findings

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | Medium | The Profile page still showed the demo's plan picker in community mode, with prices and a "Choose" button that changed the plan only in the browser. No server feature depended on it, but it contradicted "never grant paid benefits based on client-side state" and showed prices that were never decided. | **Fixed:** removed. Plans now come only from the database (`my_plan()`), and the Plans page shows no prices. |
| 2 | Low | A drop's teaser image is blurred by the browser only. Someone who opens the image address directly sees the unblurred teaser before release. Other works in the drop stay hidden: their rows are invisible, file names are random, and folder listing is limited to the owner. | **Open.** The artist picks the teaser to preview, so this is accepted for now. Fix later by generating a blurred copy at upload time. |
| 3 | Low | Moderators see applicants' email addresses in the Critic/Collector review queue (since Phase 1). That's useful for checking identity, but it is personal data. | **Open, by design.** Keep the moderator list small. The new plan-grant search shows display names only. |
| 4 | Low | Pro and Elite badges are public, so they show which artists hold a plan (paid or granted). | **Open, by design.** Consider an opt-out before payments go live. |
| 5 | Info | `npm audit` lists 5 moderate advisories in ESLint's development-only dependencies (minimatch). They never reach the site. The suggested fix downgrades ESLint to version 4. | **Accepted.** Upgrade when ESLint ships a fixed release. |
| 6 | Info | Element IDs built from member IDs were used in CSS selectors without escaping. That's harmless with UUIDs, but fragile. | **Fixed:** escaped with `CSS.escape`. |

Nothing critical or high was found.

## How the main protections work

- **Accounts and data:** row-level security on every table. Writes go through `security definer`
  functions that check who is calling, ownership, limits and the account's age. The browser holds
  only the public (anon) key.
- **Plans:** `current_plan()` reads the `subscriptions` row, and members can't write to it. Moderator
  grants always have an end date and are recorded in the audit log. Paid plans can only be recorded by
  the signed Stripe webhook, using the service role key, which lives only in Vercel's server
  environment. Each event is applied once, and nothing applies while `app_settings.payments_enabled` is
  false.
- **Invite-only sign-up:** a database trigger on `auth.users` refuses new accounts without a valid code
  while invites are required. A code has limited uses, an optional expiry, and can be revoked.
- **App error log:** stores the message, the file and the page (query strings removed), with no
  account, email or IP address. It is capped at 500 errors an hour and deleted after 30 days.
- **AI Coach:** the Anthropic key lives only in Vercel. The database decides who can use the Coach and
  hands over only the caller's own data.
- **Browser:** a strict Content-Security-Policy (scripts from this site only), HSTS, no framing, and a
  strict referrer policy.

## Phase 7 addendum: the Abremi Guide

- **Data boundaries:** the Guide's context comes only from database functions that run as the signed-in member: the public catalog, the page being viewed, and the member's own data. Database tests cover hidden and unreleased works, private collections, owner names, contact details, and personalization being switched off.
- **Invented references:** every work or artist the Guide recommends is checked against the visible catalog on the server before it's shown. Lines with invented IDs are dropped (unit tested).
- **Prompt injection:** catalog text (titles, bios, descriptions) and the member's messages go into the conversation as marked data, never into the instructions. The instructions say to ignore any instructions found in that data. Messages are limited to text, 2,000 characters each, and the last 12 turns.
- **Privacy:** conversations are kept only in the open browser tab. The database stores only that a request happened (mode, time, outcome) and counts of what people did with suggestions. Moderators see totals only. Members can reset personalization, which also deletes their suggestion history.
- **Cost and abuse:** members only, with a daily allowance per plan and a site-wide daily cap. Failed replies don't count. Errors shown to people never include the provider's error text.
- **Rankings:** the choice of suggestions never reads plans or badges (database and unit tests).

## Owner checklist (things only you can do)

1. **Supabase**
   - Keep pg_cron enabled. It runs the scheduled jobs, including error-log cleanup and deadline reminders.
   - Set up custom SMTP before inviting real users.
   - Turn on two-factor sign-in for every dashboard account.
   - Check that backups are on.
2. **Vercel and Anthropic**
   - Set a monthly spend limit on the Anthropic key.
   - Keep `SUPABASE_SERVICE_ROLE_KEY` and the Stripe keys out of Preview deployments unless you're
     testing payments.
3. **Before switching payments on**
   - Do the product, tax and refund-policy reviews.
   - Test the whole flow in Stripe test mode (see `supabase/README.md`).
   - Run `update app_settings set payments_enabled = true;` only after that.
4. **Keys**
   - Rotate any key that has ever been pasted somewhere public, such as a chat, an issue or a screenshot.
