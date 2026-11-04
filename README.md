# Abremi

**The Tinder and TikTok of Art.** Instead of matching people, users match with art.

Abremi is a mobile-first web app where people swipe through paintings, illustrations, sculpture,
photography, NFTs, digital art, street art, AI art and mixed media. Every swipe trains your feed and
moves the global and country charts. A like counts for more when it comes from a heavier role.

> People don't wake up saying "I want to upload art." They wake up saying "Show me something amazing."

## Run it

```bash
npm start         # http://localhost:5173  (zero dependencies, Node 18+)
npm run check     # syntax check of the UI modules + unit tests
npm test          # unit tests for scoring, Elo, feed, marketplace, badges, charts, recognition, sync
npm run test:db   # Supabase migration + security rules on a real Postgres (set ABREMI_PG)
npm run test:e2e  # sign-in/sync, artist uploads, the culture engine, leaderboards, role applications, live updates and offline/install/update flows in a browser
```

### Accounts and the shared database
With no configuration, Abremi runs in **demo mode**, and everything stays on the visitor's device.
Add a Supabase database and it switches to **community mode**:
- **Sign-in:** by email link or code.
- **Shared rankings:** everyone's likes, saves, follows, reviews and battle votes add up into the same rankings.
- **Security:** row-level security, vote roles stamped by the server, and Critic/Collector granted only by a moderator after an application.
- **Guests:** they can still swipe, and what they liked is added to their account when they sign in.
- **Artist uploads:** members with the Artist role publish photos of their work from Profile → Studio. Photos are resized on the phone (a 1600px image plus a 480px thumbnail) and stripped of location data. Published works join the feed, rankings and Art Battles for everyone, and images are cached for offline viewing.

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
Free to upload, swipe and see basic rankings. **Pro $7.99/mo**: analytics, who liked your work, sales insights.
**Studio $19.99/mo**: promotion tools and a portfolio website. Marketplace commission slides from **10% → 5%**
as the price rises (`src/core/marketplace.js`).

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
- **Backend:** accounts and the shared database are built (see above). Still to come: fraud detection beyond the role and vote limits.
- **Recognition:** uses on-device pixel statistics today. Production would use a vision model behind the same `features → prediction → matches` interface.
- **Payments and messaging** are simulated and stay on the device. A real version needs Stripe Connect or similar for payouts.
- **Catalog art** is generated procedurally, so the demo ships no copyrighted images. Uploaded images are stored in localStorage (about 5 MB limit).

See [`docs/PITCH.md`](docs/PITCH.md) for the investor pitch.

## Design system
The design system lives in `src/ui/styles.css`:
- **Colours:** dark surfaces (`#08090B` to `#1B1D22`), hairline borders at `rgba(255,255,255,.09)`, warm off-white text, and champagne gold `#C8A96B` used sparingly as the accent.
- **Typography:** Inter for the interface and Playfair Display for headlines (both from Google Fonts, with system fallbacks).
- **Atmosphere:** very soft radial light behind the page.
- **Motion:** 200–300 ms transitions, View Transitions between pages where the browser supports them, and full support for `prefers-reduced-motion`.
- **Keyboard:** `/` or ⌘K opens search, Esc closes overlays, ← → ↑ swipe in Discover, and ← → vote in Art Battles.
