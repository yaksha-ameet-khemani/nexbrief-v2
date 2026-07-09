# NexBrief → Cloudflare Workers + KV rebuild

## Context

NexBrief currently runs on Spring Boot + Postgres: an hourly `@Scheduled` pipeline fetches RSS (`RssFetcherService`), scrapes full article bodies with Jsoup (`ContentExtractorService`), summarizes via Groq (`AiSummaryService`), and generates search-query links on demand (`SearchLinkService`). The React frontend (`nexbrief-frontend`) calls this over REST.

The user wants to drop the database and the always-on server, since this is a personal project they also want to demo to others, and free/simple hosting matters. We agreed (across prior discussion) that pure client-side React can't work — CORS blocks browser-side RSS/scraping, and the Groq key can't be exposed client-side — so the plan is: keep the React frontend, replace the Spring Boot backend with a **Cloudflare Worker** that runs the same 3-phase pipeline on an **hourly Cron Trigger**, storing results in **Workers KV** (shared cache, no per-visitor cost, no database). The frontend reads from the Worker's HTTP endpoint instead of `localhost:8081`.

Cloudflare was chosen over Vercel because Vercel's free Hobby plan caps cron jobs at once/day; Cloudflare Workers Cron Triggers support hourly (or finer) on the free plan with no such restriction.

## Architecture

Both existing folders (`NexBrief/` Spring Boot backend, `nexbrief-frontend/` React app) stay **completely untouched** — no edits, just left as reference/fallback. Everything new lives in a brand-new parent folder, `NexBrief-v2/`, as a sibling to the old ones:

```
NexBrief-v2/
  PLAN.md                       # this plan, saved for reference
  nexbrief-worker/              (new — Cloudflare Worker, TypeScript)
    wrangler.toml                # KV binding, cron trigger "0 * * * *", secrets
    src/
      index.ts                   # exports { fetch, scheduled } entrypoints
      types.ts                   # Article shape, Env (KV + secret) bindings
      feeds.ts                   # RSS_FEEDS map (ported from RssFetcherService) + fetchAllFeeds()
      scrape.ts                  # SOURCE_SELECTORS map (ported from ContentExtractorService) + scrapeArticle() via HTMLRewriter
      groq.ts                    # summarize() + extractSearchQuery() + buildLinks() (ported from AiSummaryService/SearchLinkService)
      store.ts                   # KV read/merge-dedupe-by-url/trim-old/write
      api.ts                     # in-memory filter (source/category/keyword/date) + pagination + CORS, mirrors ArticleService/ArticleRepository query logic
  nexbrief-web/                 (new — fresh Vite + React + TS + Tailwind app)
    src/
      api/articleApi.ts          # fetchArticles() against the Worker URL (env-driven), no fetchSearchLinks needed
      components/ArticleCard.tsx, Navbar.tsx, SourceSection.tsx   # rebuilt fresh, same UX as the old frontend (source grouping, summary accordion, precomputed search-links, date/category/keyword filters)
      pages/Home.tsx
      types/Article.ts           # includes searchQuery + links fields directly (no separate on-demand DTO)
```

Old `NexBrief/` and `nexbrief-frontend/` are not deleted, not referenced by build tooling, and not deployed — purely there if you want to look back at them. `nexbrief-web` is written fresh, following the same UI/UX the old frontend already had (it was solid), rather than editing it in place.

Key design decisions:
- **One shared KV blob**, not per-user caching — the cron job runs once/hour for everyone, so Groq usage doesn't scale with visitors.
- **Search links precomputed during the cron run** (not on-demand per click like today). This removes an entire API route and the loading-spinner logic in `ArticleCard.tsx` — the frontend just renders links that are already in the article JSON.
- **HTMLRewriter** (native Workers API) replaces Jsoup for scraping; **fast-xml-parser** (pure-JS npm package) replaces Rome for RSS parsing — both run fine in the Workers runtime, unlike a JVM-based approach.
- Retention: keep a rolling window (~3-7 days) of articles in the KV blob so the existing "pick a date" UI still works, trimming anything older on each write to keep the blob small.
- Business logic (feed URLs, per-source CSS selectors, Groq prompts, MAX_ARTICLES_PER_SOURCE=5) is ported as-is from the Java services — it's already proven, just re-platformed.

## Implementation steps

0. **Create the new parent folder** `/home/administrator/Downloads/IntelliJ Projects/NexBrief-v2/` and save this plan there as `PLAN.md`, before any code is written. `nexbrief-worker/` and `nexbrief-web/` (below) live inside it. `NexBrief/` and `nexbrief-frontend/` remain untouched siblings, outside this folder.
1. **Scaffold `nexbrief-worker`**: `npm create cloudflare@latest` (or manual `wrangler.toml` + `package.json` + `tsconfig.json`), TypeScript "Hello World Worker" template.
2. **Port feed config + RSS fetch** (`feeds.ts`): same 5 feeds/sources/categories/languages as `RssFetcherService.RSS_FEEDS`, using `fast-xml-parser` to parse the fetched XML, same field-extraction rules (title, url via foreign markup fallback to link, description with tags stripped, thumbnail from media:content/thumbnail/enclosure, author from dc:creator, publishedAt).
3. **Port scraping** (`scrape.ts`): same `SOURCE_SELECTORS` map as `ContentExtractorService`, implemented with `HTMLRewriter` to collect text from matching elements, with the same fallback chain (`article`, `main`, `div[class*=content]`, etc.) and same "EXTRACTION_FAILED" sentinel behavior.
4. **Port Groq calls** (`groq.ts`): same prompts/params as `AiSummaryService.callGroq` (summarize) and `SearchLinkService.extractSearchQuery` + `buildLinks` (category-specific link sets), reading the API key from a Wrangler secret binding, never hardcoded.
5. **KV store logic** (`store.ts`): read existing JSON array from KV, dedupe new articles by URL, run scrape+summarize+search-link generation only for genuinely new articles, merge, drop entries older than the retention window, write back.
6. **Scheduled handler** (`index.ts` `scheduled()`): orchestrate fetch → scrape → summarize → store, mirroring `FetchScheduler.runPipeline()`'s phase order and logging.
7. **Fetch handler / API** (`api.ts` + `index.ts` `fetch()`): `GET /api/articles` reading the KV blob, applying source/category/keyword/date filters and pagination in JS (porting the logic from `ArticleService`/`ArticleRepository`), with CORS headers so the Pages-hosted frontend can call it. Add a `Page`-shaped response (`content`, `totalElements`, `totalPages`, `number`, `size`) to match what the frontend already expects.
8. **Add a manual-trigger test route** (e.g. `POST /api/refresh`, gated by a shared secret header) purely so we can exercise the pipeline during development without waiting for the hourly cron.
9. **Build `nexbrief-web`** fresh (Vite + React 19 + TS + Tailwind, matching the old frontend's dependency versions/tooling): `articleApi.ts` reads `VITE_API_BASE_URL` and only needs `fetchArticles()` (no separate search-links call — links come precomputed on each article); `ArticleCard`/`Navbar`/`SourceSection`/`Home` rebuilt with the same UX as the old frontend, with `ArticleCard` rendering `article.links` directly instead of a lazy fetch-on-click.
10. **Local verification** (see below), then walk through account setup and deployment together.

## Account setup / configuration walkthrough (to do together, not just handed over as commands)

1. Create a free Cloudflare account; install Wrangler (`npm install -g wrangler`) and run `wrangler login`.
2. `wrangler kv namespace create NEXBRIEF_KV` → wire the returned namespace id into `wrangler.toml`.
3. `wrangler secret put GROQ_API_KEY` → store the key securely (rotate the one currently sitting in `application.yml`, since it's been sitting in plaintext).
4. Set the cron trigger in `wrangler.toml` (`crons = ["0 * * * *"]`) and deploy with `wrangler deploy`; confirm the trigger appears in the Cloudflare dashboard and test it via the dashboard's "Trigger Cron" button or the `/api/refresh` test route.
5. Create a Cloudflare Pages project connected to the `nexbrief-web` GitHub repo (push it to GitHub first if it isn't already), set build command `npm run build` / output `dist`, and set `VITE_API_BASE_URL` to the deployed Worker's URL as a Pages environment variable.
6. Optional: a small GitHub Actions workflow using `wrangler-action` to auto-deploy the Worker on push, so both frontend (via Pages) and backend (via Actions) redeploy automatically from `git push`.

## Verification

- `wrangler dev --test-scheduled`, then `curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"` to manually fire the scheduled handler locally and confirm KV gets populated (Wrangler simulates KV locally) and logs show all phases completing.
- `curl http://localhost:8787/api/articles` and confirm the JSON shape/filters match what `articleApi.ts` expects.
- Point `nexbrief-web` at `http://localhost:8787/api` via `.env.local`, run `npm run dev`, and click through the actual UI: source grouping, summary accordion, search-links (now instant, no spinner), keyword search, category filter, date picker.
- After deploying: trigger the live cron once manually, verify KV populated in the Cloudflare dashboard, confirm the deployed Pages site loads real data end-to-end.
