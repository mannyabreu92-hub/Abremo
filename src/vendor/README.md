# Vendored libraries

- `supabase.js`, `591.supabase.js`: `@supabase/supabase-js` 2.45.4, the unmodified UMD build from
  the npm package (`dist/umd/`). MIT licence: `supabase-js.LICENSE`. `591.supabase.js` is only
  used where there is no native WebSocket (never in browsers).

To update: `npm pack @supabase/supabase-js@<version>`, copy `package/dist/umd/*.js` here, and
run `npm run gen:sw`.
