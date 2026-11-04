# Abremi beta: launch-week checklist

For the owner and moderators. Tick these off in order.

## Before inviting anyone
- [ ] Custom SMTP set up in Supabase (Authentication → Emails → SMTP). The built-in sender only sends a few emails an hour.
- [ ] Two-factor sign-in on every Supabase and Vercel account.
- [ ] Anthropic monthly spend limit set; ideally the exposed AI key swapped for a new one.
- [ ] Moderator page → Beta: decide whether sign-ups need an invite code. Create codes with a sensible number of uses.
- [ ] You are a moderator (the `admins` table), and so is at least one other trusted person.

## Inviting
- [ ] Start with artists: send them `https://abremi.vercel.app/#join` and an invite code. Aim for 20–50 artists, each with 3+ strong works with clear photos, medium, size, year and price.
- [ ] Then collectors and art lovers: send them the home page. Their admirations and treasures are what bring the Index and rankings to life.
- [ ] Ask artists to share their works with the share card (the download icon on their own artwork) and a link back to their page.

## Every day of launch week
- [ ] Moderator page → Applications: approve or decline Critic and Collector applications (check the links).
- [ ] Galleries, Exhibitions and Opportunities queues: verify or decline.
- [ ] Beta → Feedback: read and resolve. Beta → App errors: anything repeated is worth fixing first.
- [ ] Integrity flags: bursts of admirations from brand-new accounts. Exclude if coordinated.
- [ ] Reported inquiries, and (once selling is on) problems with orders.
- [ ] Guide usage: replies, members who came back, and what people did with suggestions.

## End of the week
- [ ] Monday: check the first real Abremi Index. Congratulate ranked artists and remind them about their badge (Studio).
- [ ] Grant Pro to the most active beta artists (Moderator page → Plans) as a thank-you, with an end date.
- [ ] Decide with your CPA about sales tax, then test and switch on selling (`supabase/README.md` → Selling artworks).
