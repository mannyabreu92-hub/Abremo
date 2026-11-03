# Gabangi

**The Tinder and TikTok of Art.** Instead of matching people, users match with art.

Gabangi is a mobile-first web app where people swipe through paintings, illustrations, sculpture,
photography, NFTs, digital art, street art, AI art and mixed media. Every swipe trains your feed and
moves the global and country charts. A like counts for more when it comes from a heavier role.

> People don't wake up saying "I want to upload art." They wake up saying "Show me something amazing."

## Run it

```bash
npm start      # http://localhost:5173  (zero dependencies, Node 18+)
npm test       # unit tests for scoring, Elo, feed, marketplace, badges, charts, recognition
```

Any static file server also works. Open it on a phone, or use the browser's mobile emulator.

## What's in the prototype

| Tab | Feature |
| --- | --- |
| **Discover** | Swipe deck. → / ♥ = Like, ← / ✕ = Pass, ↑ / ★ = Super Like (Collect), **+ Follow** = subscribe to the artist's journey, **$** = buy or contact the artist. Critics also get ✍︎ Review. |
| **Battle** | Art Battles: two random artworks by different artists. You vote, and Elo ratings update. Winners gain points; losers lose only 75% as much. |
| **Charts** | Top Artworks (the default: artwork first), Top Artists and Battle Champions. Filter by 🌎 Global or any of 12 countries, and by category. Rank movement ▲▼ is measured against the chart from the previous hour. |
| **Scan** | Artwork recognition: take a photo, and Gabangi guesses the style and medium, then suggests similar artists and works. |
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
  app.js              views, swipe gestures, sheets
  art.js              procedural SVG artwork generator (original, per style/medium)
  store.js            localStorage persistence (user actions stored as deltas)
  styles.css
tests/                node:test suites
```

## Prototype limits (what production needs)
- **Backend:** accounts, real-time counters, an hourly chart job, fraud detection, and verification for critics and collectors (roles can be switched freely in the demo).
- **Recognition:** uses on-device pixel statistics today. Production would use a vision model behind the same `features → prediction → matches` interface.
- **Payments and messaging** are simulated and stay on the device. A real version needs Stripe Connect or similar for payouts.
- **Catalog art** is generated procedurally, so the demo ships no copyrighted images. Uploaded images are stored in localStorage (about 5 MB limit).

See [`docs/PITCH.md`](docs/PITCH.md) for the investor pitch.
