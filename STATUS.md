# NexBrief-v2 — Status

Last updated: 2026-07-10

## What this is

A rebuild of the original `NexBrief` (Spring Boot + Postgres, in the sibling
`NexBrief/` folder) as a database-free, free-to-host personal news reader.
The user wanted: no server to babysit, no database, free hosting, and content
that refreshes automatically without the user having to do anything. Original
`NexBrief/` and `nexbrief-frontend/` folders were left completely untouched —
this is a fresh parallel build. See `PLAN.md` in this folder for the original
architecture plan agreed before building.

## Live URLs

- **Frontend**: https://nexbrief-v2.ameettechademy.workers.dev
- **Status/health page**: https://nexbrief-v2.ameettechademy.workers.dev/status
- **Backend API**: https://nexbrief-worker.ameettechademy.workers.dev
  (e.g. `/api/articles`, `/api/status`, `POST /api/refresh`)
- **GitHub repo**: https://github.com/yaksha-ameet-khemani/nexbrief-v2
- **Cloudflare account**: ameettechademy@gmail.com

## Architecture

- `nexbrief-worker/` — Cloudflare Worker (TypeScript). Runs an hourly Cron
  Trigger (`0 * * * *`) that: fetches RSS from 5 sources (ESPNCricinfo,
  Dainik Bhaskar, Autocar India, Gadgets360, BBC) → scrapes full article text
  via `HTMLRewriter` → summarizes via Groq (`llama-3.3-70b-versatile`) →
  generates a search query + category-specific search links → stores
  everything as one JSON blob in Workers KV (no database). Also serves the
  read API and a manual-trigger test route.
- `nexbrief-web/` — Fresh Vite + React 19 + TypeScript + Tailwind frontend.
  Fetches from the Worker's API. Includes a `/status` page showing pipeline
  health (article counts, last/next run, Groq quota, and the actual titles
  of currently-pending articles), which auto-refreshes every 30s and
  live-ticks its countdown/timestamps rather than freezing at page-load.

## Deployment (all free tier, all automatic)

- **Frontend**: Cloudflare Workers Builds, Git-connected to the GitHub repo.
  Push to `main` touching `nexbrief-web/` → auto-builds (`npm run build`) →
  auto-deploys (`npx wrangler deploy`, using `nexbrief-web/wrangler.toml`'s
  `[assets]` config to serve the static build as a Worker).
- **Worker**: GitHub Action at `.github/workflows/deploy-worker.yml`. Push to
  `main` touching `nexbrief-worker/` → auto-deploys via `wrangler-action`.
  Needs the `CLOUDFLARE_API_TOKEN` repo secret (already configured in GitHub
  repo settings → Secrets and variables → Actions).
- Both deploy independently based on which subfolder changed.

## Secrets (never committed — set via `wrangler secret put` or GitHub secrets)

- Cloudflare Worker secrets: `GROQ_API_KEY`, `REFRESH_SECRET` (gates
  `POST /api/refresh`, the manual pipeline trigger for testing).
- GitHub repo secret: `CLOUDFLARE_API_TOKEN` (scoped via the "Edit Cloudflare
  Workers" token template).
- The original Groq key is still also sitting in plaintext in
  `NexBrief/src/main/resources/application.yml` (the old Spring Boot
  project) — user was offered a rotation and declined for now.

## Key design decisions

- **Shared KV cache, not per-visitor caching** — the hourly cron populates
  one shared JSON blob; every visitor reads the same cache, so Groq usage
  doesn't scale with traffic.
- **Search links precomputed during the cron run**, not on-demand per click
  like the original — removes a whole API route and a loading spinner.
- **Articles show immediately, even before their AI summary is ready** —
  originally an article was hidden from the API until summarized, which
  meant Groq's free-tier rate limit could hide real news for up to an hour.
  Now `/api/articles` returns every fetched article; the frontend falls back
  to the RSS description (labeled "Read Preview", with a visible amber
  "AI summary pending" badge on the card itself, not just hidden inside the
  expandable accordion) until the real AI summary lands, then it upgrades
  in place.
- **2-second pacing between Groq calls** (re-added after being dropped
  during the port from the original Java `AiSummaryService`) so each hourly
  run clears more of the backlog before hitting Groq's rate limit.
- **Every article is saved to KV immediately after it's processed**, not
  batched up and saved once at the end of a run. This was a real bug fix,
  not just a preference — see "Known limitations" below.
- **`/api/status`** reports total/summarized/pending article counts (overall
  and per source), the actual titles of pending articles, last run time +
  outcome, next scheduled run time, and Groq's remaining request/token quota
  (captured from the last API response's rate-limit headers).
- **The site shows everything currently cached by default, not just today.**
  Originally `/api/articles` defaulted to today's date when no date param
  was given, and picking a category/source silently *replaced* that date
  scope entirely rather than combining with it — so "All" showed only a
  handful of today's articles while any category showed the full 5-day
  history, which looked broken (inconsistent scroll/content amount between
  views). Per user feedback, the date picker is now purely opt-in: with
  nothing selected, every filter (keyword/source/category/date) is
  independent and combines freely, and no date filter at all means "show
  everything in the retention window."

## Known limitations

- **ESPNCricinfo and Gadgets360 return 403 to Cloudflare's IP ranges**
  (bot-detection against datacenter IPs, discovered during testing — not a
  selector bug). Worked around by falling back to the RSS description for
  summarization when full-page scraping is blocked.
- **Groq free-tier rate limit** means a big batch of new articles (e.g. the
  initial 25-article bootstrap burst) can take a couple of hours to fully
  get AI summaries, via the Phase 0 backlog-retry mechanism on subsequent
  hourly runs. Articles are never hidden while waiting (see above).
- **(Fixed) Cloudflare was killing background pipeline runs before they
  finished, and it was silently discarding completed work, not Groq's rate
  limit.** `ctx.waitUntil()` — how the pipeline keeps running after the
  `/api/refresh` HTTP response is sent — has a limited execution window;
  Cloudflare cancels it if it runs past that. Confirmed live via
  `wrangler tail`: a run successfully summarized 6 of 8 pending articles,
  logged every one, then got killed by "waitUntil() tasks did not complete
  within the allowed time" before the code ever reached the save step —
  so all 6 (and the Groq quota spent producing them) were thrown away, and
  the article stayed stuck "pending" indefinitely despite clearly having
  enough Groq quota. Fixed by saving to KV immediately after each article
  instead of batching the save until the end of the run — a cut-off run now
  keeps whatever it finished instead of losing all of it.
- No visual/browser UI testing was done by Claude directly (no browser tool
  available in that environment) — verified via curl/API responses and the
  user checking the live site themselves.

## Local development

- `nexbrief-worker/`: `npm install`, copy `.dev.vars.example` → `.dev.vars`
  with real values, `npx wrangler dev --local --test-scheduled`.
- `nexbrief-web/`: `npm install`, `npm run dev` (defaults to
  `http://localhost:8787/api` unless `VITE_API_BASE_URL` is set).

## Possible next steps (not yet done, not requested)

- Rotate the Groq key that's still exposed in the old `application.yml`.
- Consider deleting the old `NexBrief/` and `nexbrief-frontend/` folders
  once confident the new stack fully replaces them (currently kept as
  untouched reference/fallback).
