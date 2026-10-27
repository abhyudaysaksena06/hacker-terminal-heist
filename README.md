# Hacker Terminal Heist

A playable retro-terminal hacking game. Five missions against the fictional Nexus Corp, watched by a security AI called SENTINEL. All game logic is deterministic server-side JavaScript. AI is an optional layer for SENTINEL's dialogue only.

Everything is simulated. Nothing scans networks, attacks passwords, or touches real systems.

**Stack:** React 19 + Vite + Tailwind CSS 4 (frontend), a Supabase Edge Function (game API) and Supabase Postgres (sessions, leaderboard, rate limits), with Supabase anonymous sign-in for players.

## Run locally (no Supabase needed)
```
npm install
npm run dev        # http://localhost:5173
npm test           # 42 tests: engine, parser, API, store, security
npm run build      # production build in dist/
npm run test:e2e   # 12 real-browser tests; needs `npm i -D playwright && npx playwright install chromium`
```
Node 20.19+ required. With `VITE_SUPABASE_URL` unset, Vite serves a local copy of the game API at the same path the Edge Function uses (`/functions/v1/game`), with the same engine and routes and an in-memory store. Sessions and the leaderboard then reset when you stop the dev server.

## Deploy to Supabase
1. Create a project at supabase.com. Under **Authentication > Sign In / Providers**, turn on **Anonymous sign-ins**.
2. Link this folder and create the tables:
   ```
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npm run db:push
   ```
3. Deploy the game API:
   ```
   npm run functions:deploy
   ```
4. Optional, for AI-written SENTINEL lines: `npx supabase secrets set ANTHROPIC_API_KEY=... SENTINEL_MODEL=claude-haiku-5-5`
5. Copy `.env.example` to `.env.local` and fill in the Project URL and anon (or publishable) key from **Project Settings > API**.
6. Host the frontend. On Vercel, import the repo (settings come from `vercel.json`, which also sets `X-Frame-Options: DENY`) and add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as environment variables. Elsewhere, `npm run build` and serve `dist/` with `X-Frame-Options: DENY`; the build already carries the rest of the CSP in a `<meta>` tag.

To run the whole Supabase stack locally instead (needs Docker): `npx supabase start`, `npx supabase functions serve game`, and point `.env.local` at the local URL and anon key it prints.

## Configure
| Where | Variable | Purpose |
|---|---|---|
| `.env.local` | `VITE_SUPABASE_URL` | Supabase project URL. Leave empty to use the local dev API |
| `.env.local` | `VITE_SUPABASE_ANON_KEY` | Anon / publishable key (safe to ship to browsers) |
| function secret | `ANTHROPIC_API_KEY` | Optional. Enables AI-written SENTINEL lines on lockouts, mission clears and high alert |
| function secret | `SENTINEL_MODEL` | Optional model override |

Thresholds, penalties, lockout length, scoring, session limits and rate limits live in `CONFIG` in `supabase/functions/_shared/engine/state.js`.

## Playing
`help` lists commands for the current mission. Syntax: `name arg --flag value` (or `--flag=value`). `notes` lists intel recovered from solved missions (free; stored server-side, so it survives a reload and mission 5 can always be finished). Alert rises on wrong answers, inapplicable commands and hints (5%; after a mission's third hint, further hints are free and repeat the last one). At 100% the terminal locks for 30 seconds (enforced by the server; refreshing does not help), and the wrong-answer streak resets. Mission 5 adds alert on every `scan`.

Spoiler-free nudges: read output carefully, and use `hint` if stuck (costs 5% alert and 250 points).

## Architecture
```
src/                      React app (App.jsx: all six screens), api.js (Supabase auth + API client), sounds.js
supabase/
  migrations/             Postgres schema: game_sessions, leaderboard, rate_limits (+ RLS, two SQL functions)
  functions/game/         Edge Function entry (Deno): wires the API to Postgres and Supabase Auth
  functions/_shared/      Runtime-neutral code, also used by the local dev API and the tests
    engine/               parser.js, levels.js (puzzles), state.js (alert, lockout, hints, scoring)
    ai/                   SENTINEL lines: scripted, or a Claude call for significant events
    api.js                Routes and auth rules
    http.js               Request/Response adapter: JSON errors, body limit, CORS, security headers
    pg-store.js           Postgres store (supabase-js, service role)
    memory-store.js       Same contract, in memory (dev and tests)
dev/                      Local dev API (Vite middleware) and the production CSP
```
- The server is the source of truth. The client never sends level, alert or score. `POST /mission/complete` only advances a mission the server has already marked solved.
- Players sign in anonymously with Supabase Auth. The Edge Function verifies the access token on every request and only loads sessions owned by that player (`X-Game-Session` header).
- RLS is on for every table. Only the leaderboard has a policy (public read). Sessions and rate limits are reachable only through the Edge Function's service role.
- Saves use optimistic locking (`version` column), so two overlapping requests cannot overwrite each other's progress.
- `ai/sentinel.js`: scripted lines by default. With a key, it calls the model for significant events only (3s timeout, output validated, length capped). Output never affects game state.

API (base `/functions/v1/game`): `POST /session`, `GET /state`, `POST /command`, `POST /hint`, `GET /sentinel`, `POST /mission/complete`, `POST /score`, `GET /leaderboard`. Errors are always `{"error": {"code", "message"}}`.

## Limits and troubleshooting
- The puzzle answers ship in this repo, so a determined player can script a perfect run. Treat the leaderboard as casual.
- Each player keeps their 5 most recent sessions; older ones are deleted when they start a new one. Sessions expire after 3 hours.
- Rate limit: 120 requests a minute per player (per IP for the public leaderboard). Supabase also limits anonymous sign-ins per IP (Authentication > Rate Limits).
- Expired rows in `rate_limits` and old `game_sessions` are not purged automatically. Add a `pg_cron` job if the tables grow.
- "Sign-in failed: Anonymous sign-ins are disabled": turn them on (Deploy, step 1).
- "Server unreachable": check `npm run dev` is running, or that the function is deployed and `VITE_SUPABASE_URL` is right.
- `[SESSION] expired or invalid`: the session expired or was replaced. Press restart.
- Fonts load from Google Fonts; offline it falls back to system monospace.
- The Edge Function entry (`supabase/functions/game/index.ts`) and `pg-store.js` run only on Supabase; the tests cover the same routes on the in-memory store.

## Planned competition extensions
- Mission 6 (Counter-Hack): add an entry to `LEVELS` with a per-turn hook beside the existing `tick` flag in `execute()`. Change the hardcoded "Five missions" in the briefing in `src/App.jsx`.
- Scoring hints: `hint` already exists, with alert and score penalties. Tune them in `CONFIG`.
