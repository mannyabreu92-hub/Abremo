# Abremi community backend (Supabase)

Abremi runs in two modes:

- **Demo mode** (no configuration): everything a visitor does stays on their device.
- **Community mode**: accounts plus one shared database, so everyone's likes, saves, follows,
  reviews and Art Battle votes add up into the same rankings.

## Files

| File | Purpose |
| --- | --- |
| `migrations/0001_community.sql` | Tables, Row Level Security, role stamping, battle voting, community totals |
| `seed.sql` | The catalog (artists, artworks, starting battle ratings), generated from `src/core/seed.js` |
| `setup.sql` | Both of the above in one file, to paste into the SQL editor. Safe to run more than once |
| `test/auth_stub.sql` | A stand-in for Supabase's `auth` schema, used only by the local database tests |

Regenerate `seed.sql` and `setup.sql` after changing the catalog or the migration: `npm run gen:sql`.

## Turning on community mode

1. **Create the database.** In the Vercel dashboard, open the project and go to **Storage → Create Database → Supabase**, then connect it to the project. Vercel adds `SUPABASE_URL` and `SUPABASE_ANON_KEY` (or their `NEXT_PUBLIC_` variants) to the environment. You can also add those two variables yourself from an existing Supabase project.
2. **Create the tables.** In Supabase, open **SQL Editor**, paste all of `setup.sql`, and **Run**.
3. **Allow sign-in links back to the site.** In Supabase, go to **Authentication → URL Configuration**. Set **Site URL** to `https://abremi.vercel.app` and add `https://abremi.vercel.app/**` under **Redirect URLs**.
4. **Build with the keys.** Set the Vercel project's **Build Command** to `node scripts/write-config.js`, then redeploy. The build log should say `Abremi: community mode`.

`scripts/write-config.js` publishes only the public URL and the anon (publishable) key. It refuses to publish a `service_role` or `sb_secret_` key.

## Security model

- Row Level Security is on for every table. People read and write only their own reactions, follows and profile.
- The role on each vote (fan ×1, artist ×3, critic ×5, collector ×9) is stamped by the database from the voter's profile. A client cannot claim a heavier role.
- Anyone can choose Fan or Artist. **Critic** and **Collector** can only be granted by an admin, from the SQL editor or with the service role:
  ```sql
  update profiles set role = 'critic' where id = (select id from auth.users where email = 'name@example.com');
  ```
- Battle ratings change only through `cast_battle_vote()`. It applies the same maths as `src/core/elo.js`, allows one vote per second, and allows the same pair once per 10 minutes.
- `community_snapshot()` exposes totals only (counts per artwork and role). It never shows who voted.

## Email

Supabase's built-in email sender is limited to a few sign-in emails per hour. Before inviting real users, set up a custom SMTP provider under **Authentication → Emails → SMTP Settings**. Resend and Postmark both have free tiers.

To let people type a code instead of tapping the link (handy when the link opens in a different browser), add `{{ .Token }}` to the **Magic Link** email template under **Authentication → Emails → Templates**.

## Tests

```bash
npm test                                                     # unit tests
ABREMI_PG="-h <host> -p <port> -U postgres" npm run test:db  # migration + security rules on a real Postgres
npm start & npm run test:e2e                                 # sign-in and sync flows in a browser (needs Playwright)
```
