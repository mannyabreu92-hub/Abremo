# Abremi

**A gallery without walls, where every work is seen on its own merit.** People discover art one work at a time, and their considered taste shapes what others discover next.

Abremi is a mobile-first web app where people swipe through paintings, illustrations, sculpture,
photography, NFTs, digital art, street art, AI art and mixed media. Every swipe trains your feed and
moves the global and country charts. A like counts for more when it comes from a heavier role.

> People don't wake up saying "I want to upload art." They wake up saying "Show me something amazing."

## Run it

```bash
npm start         # http://localhost:5173  (no runtime dependencies, Node 18+; sends the production security headers)
npm install       # developer tools only: ESLint and TypeScript (for type-checking the JavaScript)
npm run check     # syntax check, lint, type check and unit tests
npm run lint      # ESLint
npm run typecheck # TypeScript checks the JavaScript through JSDoc (app.js joins as it is split into src/ui/views/)
npm test          # unit tests for scoring, Elo, feed, marketplace, badges, charts, recognition, sync
npm run test:db   # Supabase migration + security rules on a real Postgres (set ABREMI_PG)
npm run test:e2e  # Phase 7 (the Abremi Guide), Phase 6 (Plans, galleries, invites, feedback), Phase 5 (Career Coach, Passport, Opportunities), Phase 4 (Collector Radar, Drops), Phase 3 (Studio analytics), Phase 2B (Arena competitions), Phase 2A (ranking integrity, achievements), Phase 1 (profiles, artwork details, collections, sample catalog), sign-in/sync, artist uploads, the culture engine, leaderboards, role applications, live updates and offline/install/update flows in a browser
```

### Accounts and the shared database
With no configuration, Abremi runs in **demo mode**, and everything stays on the visitor's device.
Add a Supabase database and it switches to **community mode**:
- **Sign-in:** by email link or code.
- **Shared rankings:** everyone's likes, saves, follows, reviews and battle votes add up into the same rankings.
- **Security:** row-level security, vote roles stamped by the server, and Critic/Collector granted only by a moderator after an application.
- **Guests:** they can still swipe, and what they liked is added to their account when they sign in.
- **Artist uploads:** members with the Artist role publish photos of their work from Profile → Studio. Photos are resized on the phone (a 1600px image plus a 480px thumbnail) and stripped of location data. Published works join the feed, rankings and Art Battles for everyone, and images are cached for offline viewing.

- **Honest numbers:** the starter catalog is shown as clearly labelled *sample* works and artists, with none of the demo's simulated likes, followers, reviews or battle ratings. Only works and artists with real activity get a rank; sample works can't be bought or contacted.
- **Artist profiles:** portrait, city, bio, artist statement, website and Instagram, edited from Studio → Artist profile and shown on the public artist page.
- **Artwork details:** description, size and availability (available, price on request, sold, not for sale; "sold" is reported by the artist, not verified). Artists edit their works after publishing. Every work has a shareable page: `#art/<id>`.
- **Collections with your account:** private by default; share one and anyone with the link (`#collection/<id>`) can see it. Collections made as a guest move to the account on sign-in, and signing out removes them from the device.
- **Fair rankings (Phase 2A):** the server calculates five separate scores (artwork popularity, artist reputation, critic credibility, collector interest, battle performance) and publishes how ("How rankings work" on Rankings). Rankings show All Time, **Trending This Week** (each like halves in value every 7 days) and **Collectors' Picks**. Your own likes, saves, reviews, follows and battle votes never count; there are hourly rate limits; bursts of likes from brand-new accounts go to moderators, who can exclude them (recorded, never deleted).
- **Artist Arena and Creative Challenges (Phase 2B):** Arena → Competitions. Moderators create daily, weekly, medium, country, emerging-artist and themed competitions from templates. Artists enter one of their own works; every eligible member (account 3+ days old, 5+ likes) has one vote, equal for every role, changeable until close and never for their own entry. Vote totals stay hidden until the server closes the competition on schedule, publishes places (ties share), awards First Entry, Podium Finish and Competition Winner, and notifies entrants and the winners' followers. History lists past results.
- **Artist Studio analytics (Phase 3):** Studio → Analytics (`#studio`). Totals for 7, 30 or 90 days against the period before: impressions, artwork views and profile visits (each person once a day; members and guests shown apart, guests approximate; your own views never count), likes, saves and new followers. Pro and Elite add a one-year view. Daily charts with table views, per-work figures, and the audience by role and by country (from members' profile countries; countries with fewer than 3 people grouped as Other; never who). A weekly report arrives every Monday. Free for every artist until subscriptions are verified on the server.
- **Collector Radar (Phase 4):** **Inquire** opens a real, private conversation with the artist about a work (buying, a question) or about the artist (a commission, sponsorship); there are no simulated purchases with real accounts. Only the two people can read it; each sees the other's display name, never an email. Members whose accounts are 3+ days old can write (10 new conversations a day); artists reply, decline or close from their **Inbox**; anyone can block or report. The Studio shows inquiries and verified collectors' saves per work (counts only).
- **Drops (Phase 4):** artists schedule releases of 1 to 12 works (Studio → Schedule a drop), 1 upcoming drop at a time on Artist Free and 3 on Pro and Elite. Until the release the works are hidden from everyone else; the drop page shows a countdown and a blurred teaser, followers are notified at announcement and release, and anyone can tap **Notify me**. Drops appear on Home.
- **Career Coach (Phase 5):** Studio → Coach (`#coach`). Artists ask Claude for a first draft of a bio, an artist statement, an artwork description (with alt text), a summary of their own numbers, social captions, or an application letter for a listed opportunity. Drafts are written only from the artist's own profile, works, verified exhibitions and recorded numbers: missing facts are left as `[add: …]` gaps, and the Coach never gives prices or valuations. Each draft says what it was based on, and nothing is saved or published automatically. A Pro and Elite feature (60 and 150 requests a month; 100 on Gallery), plus a site-wide daily cap. On Artist Free the Coach page explains this and points to Plans. The AI call runs on the server (`api/coach.js`); the API key never reaches the app.
- **Artist Passport (Phase 5):** a Passport tab on each member artist's page: exhibitions verified by a moderator (artists submit them with a public link; pending ones stay private), competition placings, earned achievements and milestones taken from Abremi's own records. Sales will appear only once they come from Abremi checkout.
- **Opportunities (Phase 5):** `#opportunities` lists open calls, exhibitions, residencies and prizes, with any application fee shown up front. Moderators publish listings; members (accounts 3+ days old) suggest them for review. Save a listing and you get a reminder 3 days before the deadline; artists can ask the Coach for an application draft.
- **Plans (Phase 6):** `#plans` describes Artist Free, Pro, Elite and Gallery. The database decides what each account gets (Coach requests, a year of analytics, upcoming drops, priority review of exhibitions, a Pro or Elite badge, direct listings for galleries); the app only shows it. **Payments are off**: there are no prices and nothing can be bought until the product, provider, tax and refund reviews are done. Meanwhile moderators can grant a plan for a fixed period (recorded). Plans never change rankings, and the database tests prove it.
- **Gallery accounts (Phase 6):** members apply from Plans; a moderator checks the website and verifies the gallery, which then gets a public page (`#gallery/<id>`) listing its open opportunities. On the Gallery plan, its listings publish without review.
- **Beta tools (Phase 6):** moderators can require invite codes for new sign-ups (existing members are unaffected) and create codes with a set number of uses. Members send feedback from the menu, Profile or the footer. App errors are reported to the moderators' log without accounts, emails or IP addresses, and deleted after 30 days.
- **Achievements:** earned on the server, each with a published rule and a record of why it was earned. Artist achievements show on artist pages; member achievements stay private.
- **Following feed:** Home → Following shows the newest work from artists you follow.
- **Abremi Guide (Phase 7):** *Ask Abremi* (bottom right; not on the swipe deck) opens one assistant with three modes: **Discover** (find works and artists you'll love), **Collect** (explore, organize collections, read Abremi's signals) and **For artists** (how your work appears, what your numbers show, presentation tips). It knows the artwork, artist, collection, ranking, Art Battle or competition you're viewing, and can describe an uploaded photo (saying what is observation and what is on record). Suggestions appear as cards with a reason and the usual actions (view, follow, save to a collection, search), and only ever point to real, visible works and artists. It never values art, judges authenticity or promises outcomes. Signed-in members only: 30 messages a day on Free (60 Pro, 100 Elite, 60 Gallery). Personalization uses only your own follows, likes, saves and stated interests; switch it off or reset it in the Guide's settings. Conversations aren't saved; moderators see counts only (what people opened, followed, saved, searched, and who came back).
- **Discovery to ownership (Phase 8):** every member work offers a next step: **Make an offer** (an offer amount sent through the inquiry system; nothing is charged, you agree the details with the artist) or, for works that aren't available, **Notify me if available**. Treasuring a work or joining its waitlist means you're told when it becomes available or changes price, and when its artist announces a drop. After a few swipes, an optional step asks which mediums, regions and price range you'd like (changeable from Profile); it shapes your own Discover and the Guide, never the rankings. Home shows **Emerging artists**: those who joined in the last 60 days, one work each, in a fair daily rotation. Price sorting uses real listed prices only.
- **The Abremi Index:** `#index` is a public weekly chart, frozen every Monday from the past week's admirations and treasures (weighted by verified role; your own activity never counts; sample works never included; plans never read). It has charts overall, by medium and by artist country, plus an archive. Ranked artists find an embeddable badge in their Studio (`/api/badge?artist=ID`) that updates weekly and links back to their page. Moderators can publish the current week early.
- **Checkout (built, switched off):** when switched on, member works with a listed price get **Buy** (or **Buy a print** for editions). Payment is by Stripe; artists set up payouts from **Orders** and Stripe pays them directly; Abremi keeps 20%. Orders track shipping, delivery and problems; verified sales appear on the Passport. See `supabase/README.md` → Selling artworks.
- **Seasons, leagues and streaks:** the member boards (Top Discoverers, Collectors, Critics) can be viewed all-time or for a season (a calendar month, UTC) and narrowed to a country or a medium. On the 1st of each month, last month's top 10 on each board is frozen and becomes a permanent achievement (e.g. "Top 10 Discoverer · November 2026"). Your profile shows a daily Art Battle streak (one vote a day; one missed day a week is forgiven) with achievements at 7, 30 and 100 days. Opted-out members stay hidden, your own work never counts, and plans are never read.
- **Founding artists:** moderators can mark member artists as Founding artists (a button on the artist's page). They appear in a clearly labelled section on Home and get a badge. It's editorial only: no ranking, chart or the Index reads it.
- **Languages:** English, Spanish, French, Portuguese and Simplified Chinese. The visitor's browser language is used on the first visit; the globe button in the top bar (showing EN, ES…) or the footer switches it (remembered on the device). Phase 1 covers what customers see: menus, Home, Discover, Explore, artwork and artist pages, search, sign-in, inquiries, buying, Orders, certificates and #join. English text is the key (`t('…')` in `src/ui/i18n.js`, translations in `src/i18n/`); `tests/i18n.test.js` fails if any of those screens' text is missing in a language. What members write (titles, bios, messages) isn't translated.
- **Upload several works at once:** in the Studio, "Upload several works at once" takes up to 20 photos. Each work gets its own title, price, materials, size, year, medium, availability and description, with "Apply to all" for what they share. Problems are shown per work before anything is published, and works are then published one after another.
- **Verified artists and certificates:** moderators can verify an artist's identity (optionally noting that the family manages the studio); a ✓ Verified badge shows on their page and works. Every paid sale gets a certificate of authenticity with a unique code (ABR-XXXX-XXXX-XXXX). Buyer and artist open it from Orders and can print it or save it as a PDF, and anyone can check a code at `#certificate`. A certificate never shows the buyer, and it's marked void after a refund.
- **Beta launch kit:** first-time visitors see a small welcome card on Home with a 3-step tour (shown once, skippable); `#join` is the page to send artists (why Abremi, the 20% commission, the Index, drops, the Passport); artists can download a 1080×1350 share card of their own work for Instagram. The launch-week checklist for moderators is in [`docs/launch-checklist.md`](docs/launch-checklist.md).
- **Security review:** see [`docs/security-review.md`](docs/security-review.md) for what was checked, the findings and the owner checklist.
- **Security headers:** a strict Content-Security-Policy (scripts from this site only; supabase-js is served from `src/vendor/`), plus frame, referrer, permissions and HSTS headers, set in `vercel.json` and applied by `npm start` too.

Setup takes four steps: see [`supabase/README.md`](supabase/README.md).

### Install it as an app
Abremi is an installable web app (PWA):
- **Android and desktop Chrome/Edge:** an **Install** button in Profile, on the home page and in the menu.
- **iPhone and iPad:** a short Share → *Add to Home Screen* guide.

Once installed it opens full screen with its own icon and shortcuts (Discover, Battles, Rankings, Scan).
- **Offline:** a service worker (`sw.js`) precaches the app, so it opens and browses with no connection. Live data and sign-in always go to the network.
- **Updates:** each deploy gets a new cache version, and the app offers **Refresh** when one is ready.
- After changing app files, run `npm run gen:sw` (the deploy build does this automatically). Run `npm run gen:icons` to redraw the icons and install screenshots.

Any static file server also works. Open it on a phone, or use the browser's mobile emulator.

## What's in the prototype

| Route | Feature |
| --- | --- |
| **Home** (`#home`) | Editorial landing page: hero, artwork of the hour, trending and new works, featured artists, a live Art Battle and the top-5 rankings. |
| **Discover** | Swipe deck. → / ♥ = Like, ← / ✕ = Pass, ↑ / ★ = Super Like (Collect), **+ Follow** = subscribe to the artist's journey, **$** = buy or contact the artist. Critics also get ✍︎ Review. |
| **Explore** (`#explore`) | The whole catalog as a grid, filtered by medium, movement and country, with five sort orders. |
| **Artists** (`#artists`) | Artist cards filtered by country and discipline, with a follow button on each. |
| **Collections** (`#collections`) | Your saved, liked and purchased works, plus curated sets by movement and by country. |
| **Battle** | Art Battles: two random artworks by different artists. You vote, and Elo ratings update. Winners gain points; losers lose only 75% as much. |
| **Charts** | Top Artworks (the default: artwork first), Top Artists and Battle Champions. Filter by 🌎 Global or any of 12 countries, and by category. Rank movement ▲▼ is measured against the chart from the previous hour. |
| **Scan** | Artwork recognition: take a photo, and Abremi guesses the style and medium, then suggests similar artists and works. |
| **Profile** | Role (Fan / Artist / Critic / Collector), badges, a taste profile, your collection, who you follow, an artist studio (upload, analytics), and plans. |

### Weighted Influence

| Role | Weight | |
| --- | --- | --- |
| ❤️ Fan | 1 | like, share, comment, follow |
| 🎨 Artist | 3 | uploads art, earns from likes / follows / collects / reviews |
| 📝 Critic | 5 | verified reviewers; a 5★ review = 10 pts |
| 💎 Collector | 9 | buys, collects, sponsors |

`Influence = Σ weight × (likes + 2 × collects) + critic reviews (2 × 5 × stars/5)`

Example from the pitch: 100 fan + 20 artist + 10 critic + 5 collector likes = 100 + 60 + 50 + 45 = **255**.
`Artist score = Σ influence of their works + Σ weight × followers`.

### Personalized feed
Like, Collect and Pass each adjust your style, category and artist affinities. Once you have a taste profile,
about **80%** of cards come from your top styles. The other 20% explores trending work, so the feed doesn't
turn into an echo chamber. Every card shows why it was picked ("Because you like Impressionism").

### Badges
🏅 Rising Artist · 🏆 Top 100 Country · 🌎 Top 100 Global · 💎 Collector Elite · 📝 Master Critic · 🎨 Trend Setter.
The thresholds are set in `src/core/badges.js`.

### Monetization
Everything essential stays free: publishing, discovery, rankings, Art Battles, competitions, inquiries, the Passport and Studio analytics. Paid plans add tools (see Plans above) and are not on sale yet; prices will be set when payments are switched on. Paying never changes rankings. The demo's checkout preview shows how a marketplace commission could work (`src/core/marketplace.js`); no commission is taken.

## The culture engine
Every number comes from real activity: likes, Super Likes, follows, reviews and battle votes. None of it is invented.

- **Taste Score (0–100):** how early your eye is. It combines three things: how often you find work outside the top quarter of the rankings (*hidden gems*), how far the works you found have climbed since (*foresight*), and how many movements you explore (*range*). It unlocks after five discoveries. Tiers: Emerging Eye, Cultural Scout, Trend Hunter, Elite Cultural Scout, Global Tastemaker. `src/core/taste.js`
- **Cultural Influence:** the weight you've added to the rankings (Fan 1, Artist 3, Critic 5, Collector 9; a Super Like counts double). Each like shows "+N Influence added", and how many places the work climbed.
- **Credibility:** shown next to popularity in the rankings. It's the share of a work's score that comes from critics and collectors. Rankings are organic, and nobody can pay to move them.
- **Signals:**
  - 🔥 *Rising Artist*: climbing 10 or more places in an hour, or a recent debut with exceptional influence for the size of their following
  - ↗ *Trending Globally*: in the global top 100 and moving up
  - ⭐ *Collector Attention*: 25% or more of their influence comes from collectors
  
  `src/core/insights.js`
- **Daily Masterpiece:** one work a day, picked from the 60 most influential works and weighted towards those critics and collectors rate highly. It never repeats on consecutive days, and a countdown shows the time until the next reveal at local midnight.
- **Achievements:**
  - First Discovery, Hidden Gem Finder, Trend Hunter, Cultural Scout, Master Curator, Global Tastemaker
  - **Early Believer**, at 1K / 10K / 100K: you followed an artist before they reached that many followers, and they got there
- **Member leaderboards:** Top Discoverers, Top Collectors and Top Critics, worldwide or for your country. The server computes them (`member_leaderboards()`, mirrored in `src/core/leaderboards.js` and checked against it in the tests):
  - **Discovery Score:** credit for liking work before others do, weighted by who came later (Fan 1 … Collector 9), so throwaway accounts barely count.
  - **Collectors and critics:** ranked by the influence they added in that role, with critics' reviews included.
- **Critic & Collector applications:** on Profile, tapping Critic or Collector opens an application (a statement, links, and a pledge not to game the rankings). Moderators review them at `#admin` (shown in the menu only for moderators), with the applicant's activity alongside, and approve, decline with a note, or later remove the role. Applicants are told in the app when a decision is made. Demo mode, with no database, keeps the old local role switcher.
- **Live updates:** with accounts on, Rankings shows **● Live**. When anyone likes, saves, follows, votes or uploads, every open app refreshes the totals within seconds, with no reload and without revealing who did what. Rank movement (↑ 3) compares with a shared hourly chart kept by the server, so everyone sees the same movement. When there is no earlier chart, no movement is shown.
  - **Privacy:** members appear by display name and country only. New members get a neutral name ("Member 3F2A") rather than part of their email, and anyone can opt out in Profile while still seeing their own position.
  - **Demo mode:** shows no boards, because there are no real members to rank.
- **Cultural Influence by Country:** each country's artists' combined score, with its leading artist and work.
- **Collections:** Super Likes, Liked and Acquired, plus named collections you create (Personal Museum, Hidden Gems, Masterpieces and more), which can be private. They're stored on the device for now.

## Architecture

```
index.html            app shell + tab bar
src/core/             pure, tested logic (no DOM)
  scoring.js          role weights, influence, artist score
  elo.js              Art Battles rating
  feed.js             taste model + 80/20 personalized picker
  rankings.js         charts, hourly snapshots, movement
  badges.js           badge rules
  marketplace.js      plans, commission
  recognition.js      image features → style/medium → similar artists
  seed.js             deterministic demo world (240 artists, 12 countries, ~600 works)
  world.js            merges seed + user actions into a queryable model
src/ui/               browser layer
  app.js              views, routing, swipe gestures, modals, search, notifications
  components.js       reusable components: ArtworkCard, ArtworkGrid, FeaturedArtwork, ArtistCard,
                      CategoryFilter, ArtBattleCard, CollectionCard, PremiumButton, SearchBar,
                      EmptyState, LoadingSkeleton, Icons
  art.js              procedural SVG artwork generator (original, per style/medium)
  store.js            localStorage persistence (user actions stored as deltas)
  cloud.js            Supabase adapter: auth, reactions, follows, reviews, battle votes
src/config.js         Supabase URL + anon key, written at build time (empty = demo mode)
src/core/community.js server totals ↔ app state mapping, member uploads, guest → account import
src/core/media.js     upload rules (sizes, limits, validation) shared with the database
src/core/taste.js     Taste Score, personal influence, weekly activity, achievements
src/core/insights.js  credibility, artist signals, momentum, country standings, Daily Masterpiece
src/core/leaderboards.js  member leaderboards and Discovery Score (reference for the SQL)
src/ui/images.js      on-device image pipeline: rotate, resize, re-encode (strips metadata), thumbnail
supabase/             migration, generated seed, one-file setup, setup guide
scripts/write-config.js  build step: env vars → src/config.js (refuses secret keys)
scripts/gen-seed-sql.js  catalog → supabase/seed.sql and setup.sql
manifest.webmanifest  app name, icons, shortcuts, install screenshots
sw.js                 service worker: offline app shell, update flow (list + version generated)
src/ui/pwa.js         registration, install prompts, update prompt, offline indicator
icons/                app icons (any + maskable), Apple touch icon, install screenshots
scripts/gen-sw.js     stamps sw.js with the precache list and a content hash version
scripts/gen-icons.cjs renders icons and screenshots with Playwright
  styles.css          design system: tokens, type scale, components, responsive rules
tests/                node:test suites
```

## Prototype limits (what production needs)
- **Backend:** accounts and the shared database are built (see above). Ranking integrity covers self-votes, rate limits and new-account bursts; more fraud signals (shared devices, vote rings) are still to come.
- **Recognition:** uses on-device pixel statistics today. Production would use a vision model behind the same `features → prediction → matches` interface.
- **Payments** are not taken. Subscription billing is built but switched off (see `supabase/README.md` → Plans and payments). Inquiries are real conversations; artwork purchases remain a demo-mode preview, and the Passport shows no sales until a verified checkout exists.
- **Performance:** measured with Lighthouse (simulated slow mobile, local server compressing like Vercel): Performance 82–84, Accessibility 100, Best Practices 100, SEO 100. Most of the remaining load time is building the catalog on the phone's processor.
- **Catalog art** is generated procedurally, so the demo ships no copyrighted images. Uploaded images are stored in localStorage (about 5 MB limit).

See [`docs/PITCH.md`](docs/PITCH.md) for the investor pitch.

## Design system
The design system lives in `src/ui/styles.css`:
- **Colours:** dark surfaces (`#08090B` to `#1B1D22`), hairline borders at `rgba(255,255,255,.09)`, warm off-white text, and champagne gold `#C8A96B` used sparingly as the accent.
- **Typography:** Inter for the interface and Playfair Display for headlines (both open-licensed and served from Abremi itself, in `fonts/`, with system fallbacks).
- **Atmosphere:** very soft radial light behind the page.
- **Motion:** 200–300 ms transitions, View Transitions between pages where the browser supports them, and full support for `prefers-reduced-motion`.
- **Keyboard:** `/` or ⌘K opens search, Esc closes overlays, ← → ↑ swipe in Discover, and ← → vote in Art Battles.
