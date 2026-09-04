# NexBrief-v2 — Status

Last updated: 2026-09-04

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
  Trigger (`0 * * * *`) that: **fetches RSS from 6 sources (ESPNCricinfo,
  Dainik Bhaskar, Autocar India, Gadgets360, BBC, BBC Urdu) first** (throttled
  per source by current backlog depth) → repairs any BBC Urdu article stuck
  half-translated from a previous failed attempt → migrates any
  still-native-script BBC Urdu article to English → completes any pending
  backlog summaries from earlier runs → (BBC Urdu only) translates
  title/description of each new article to English *before* anything else
  touches it → scrapes full article text via `HTMLRewriter` → (BBC Urdu only)
  translates the scraped content too → summarizes via Groq
  (`openai/gpt-oss-120b`) primary, falling back to Cloudflare Workers AI
  (`@cf/meta/llama-3.1-8b-instruct-fast`) the moment Groq is unavailable for
  the run — rate-limited (429) *or* rejecting the request (any 4xx, e.g. a
  retired model) → generates a search query + category-specific search links →
  stores everything as one JSON blob in Workers KV (no database). Also serves
  the read API and manual-trigger/admin test routes. **The RSS fetch runs
  before the AI-heavy phases deliberately** — see the 2026-09-03 entry under
  "Key design decisions" for why.
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
- Translation uses a Workers AI binding (`AI`, declared in `wrangler.toml`'s
  `[ai]` block) — no separate API key needed, it's account-level and billed
  (free tier) separately from Groq.
- GitHub repo secret: `CLOUDFLARE_API_TOKEN` (scoped via the "Edit Cloudflare
  Workers" token template).
- The original Groq key is still also sitting in plaintext in
  `NexBrief/src/main/resources/application.yml` (the old Spring Boot
  project) — user was offered a rotation and declined for now.
- **(2026-09-03)** The GitHub PAT embedded in `.git/config`'s `origin` URL
  (leaked long ago in a chat log, rotation previously declined) finally
  expired — `git push` started failing with `could not read Password ... No
  such device or address`. Replaced with a fresh classic PAT (`repo` +
  `workflow` scopes) via `git remote set-url`. The old token should be
  revoked at github.com/settings/tokens.

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
- **BBC Urdu added as a 6th source** (`feeds.bbci.co.uk/urdu/rss.xml`,
  source key `bbcurdu`, category `general`, language `ur`). Its article
  pages use a different template than BBC's English site (no `<article>`
  tag, no `data-component` attributes) — verified by inspecting real page
  HTML, the body is plain `<p>` tags inside `<main>`. Not blocked by
  Cloudflare's IP ranges (unlike ESPNCricinfo/Gadgets360). Groq summarization
  now also has an explicit Urdu instruction (previously only Hindi was
  special-cased; everything else defaulted to English).
- **New articles are processed round-robin across sources, not
  source-by-source.** A run rarely gets through every article it finds
  before hitting Groq's rate limit or Cloudflare's `waitUntil` time limit,
  and previously articles were processed strictly in source order (all of
  espncricinfo, then all of bhaskar, ...) — so a source late in that list
  (BBC Urdu, added last) could get starved indefinitely: it found 5 new
  articles every run but never actually got scraped/saved across several
  consecutive runs because earlier sources kept consuming the whole
  per-run budget first. Fixed by interleaving one article from each source
  before processing (applied to both the new-article loop and the Phase 0
  backlog-retry loop), so every source gets an early turn each run
  regardless of its position in the source list.
- **New-article discovery (Phase 1) no longer waits on backlog
  summarization (Phase 0) succeeding.** Previously, if Phase 0 hit Groq's
  rate limit, the whole pipeline returned immediately — Phase 1 (fetching
  RSS for brand-new articles) never ran that hour at all. This silently
  starved BBC Urdu (added when there was a large pending backlog): its
  fast-moving feed kept rotating past whatever was missed before the next
  run got a chance, so it sat at 1-2 total articles for hours after being
  added despite the feed clearly having fresh items. Fixed by always
  running Phase 1 — new articles are scraped and saved as pending
  (skipping the Groq call once a rate limit is already known) rather than
  never being fetched at all.
- **(2026-07-16, superseding the original toggle-based design below) BBC
  Urdu is translated to English *before* anything else happens to it, and
  nothing native ever reaches the site** — no toggle, no Urdu shown at any
  point, including while an article is still pending its AI summary. Title,
  RSS description, and scraped article body are all translated via
  Cloudflare Workers AI (`@cf/meta/m2m100-1.2b`) immediately after fetch,
  and Groq then summarizes the already-English content directly (so the
  summary comes out in English natively — no separate summary-translation
  step needed). `Article.language` flips to `"en"` once an article has been
  translated. A `normalizeTranslatedSources()` pass at the very start of
  every pipeline run (`index.ts`) also catches any article still marked
  non-English — whether already-summarized (legacy, from before this
  change) or still pending — translates it in place, and flips its
  language, so old cached BBC Urdu articles self-migrate to English over
  the next few runs without needing a separate one-off backfill script. A
  partial translation failure (e.g. title translates but content doesn't)
  leaves `language` untouched so the article gets retried whole on a later
  run, rather than getting stuck half-native with no way to be picked up
  again. The old design (Groq summarized in Urdu, then a separate
  Workers-AI pass produced `titleEn`/`summaryEn` for an opt-in "Translate to
  English ◑" toggle on the card) is gone — those fields no longer exist on
  `Article`. Scoped to BBC Urdu only for now (see `TRANSLATE_SOURCES` in
  `index.ts`); Hindi (Dainik Bhaskar) could get the same treatment later if
  wanted, though it'd currently still show native Hindi since it was never
  part of `TRANSLATE_SOURCES`.
- **(2026-07-17) Proportional per-source fetch throttle, replacing the old
  binary auto-pause.** `MAX_ARTICLES_PER_SOURCE` (5, in `constants.ts`) is now
  the single source of truth for both fetch-limiting and status display (was
  previously two separately-tracked constants that could drift). Each run,
  after backlog-clearing, `fetchLimit = max(0, MAX_ARTICLES_PER_SOURCE -
  pendingCount)` per source, so new-article intake tapers smoothly as backlog
  grows instead of hard-cutting at a threshold. `/api/status`'s
  `autoPausedSources` is derived from the same constant so it can't disagree
  with the real fetch-zero condition.
- **(2026-07-17) Cloudflare Workers AI as a second summarization lane.**
  `summarizeWithFallback()` tries Groq first; once Groq 429s during a run (a
  `groqState` flag shared across the whole pipeline execution), remaining
  summarization for that run routes through Cloudflare Workers AI
  (`@cf/meta/llama-3.1-8b-instruct-fast`) instead of leaving articles pending
  until the next hour. `processBacklog` no longer halts the entire backlog
  phase on a Groq rate limit — it falls through to Cloudflare and keeps
  clearing. `Article.summarizedBy: "groq"|"cloudflare"|null` records which
  lane produced each summary; `/api/status` and the Status page show the
  split globally, per-source, and per-run. Live-tested result: pending
  dropped from 35% to 7.5% within ~2h20m of a fresh trial, with Cloudflare
  doing ~3x Groq's volume during a period Groq was frequently rate-limited.
  (The first Cloudflare model picked, `@cf/meta/llama-3.1-8b-instruct`
  unqualified, turned out deprecated — errored immediately. Swapped to the
  `-fast` variant, which is confirmed working and reused for translation
  below. Lesson: verify a Workers AI model isn't deprecated before assuming a
  plausible-sounding ID works.)
- **(2026-07-17→07-18) BBC Urdu translation quality, fixed in two passes.**
  The original translator (`@cf/meta/m2m100-1.2b`, a dedicated NMT model) has
  no real-world knowledge and statistically guessed at unfamiliar proper
  nouns — confirmed live, nearly every headline had a garbled place/person
  name (e.g. "Ziarat, Balochistan" → "Zirconia, Belgrade"). First fix: swapped
  to an LLM-prompted translation via `@cf/meta/llama-3.1-8b-instruct-fast`
  with a system prompt instructing accurate name/place preservation — grammar
  improved a lot, but confident-but-wrong name hallucinations continued
  (a UK PM candidate rendered as "Andy Bernanke"). Second, resolving fix:
  routed translation through Groq's `llama-3.3-70b-versatile` (same model
  already used for summarization) as the primary translator via
  `translateGroq()` in `groq.ts`, falling back to the Cloudflare 8B model only
  once Groq's rate limit is hit this run — mirrors `summarizeWithFallback`
  exactly, sharing the same `groqState` flag. Zero new cost/credentials by
  design (an external translation API like Google/Azure was discussed and
  explicitly declined — the user didn't want a new credential on top of the
  one already-leaked, unrotated GitHub PAT in `.git/config`).
- **(2026-07-18) Guard against silent no-op translations.** Both Groq and
  Cloudflare could return the original native-script text unchanged (or
  partially translated) instead of erroring, and the old code treated "got a
  non-empty string back" as success — permanently flipping `article.language`
  to `"en"` even on a failed translation, which made the article invisible to
  `normalizeTranslatedSources()`'s retry (it only retries non-`"en"`
  articles), i.e. **permanently stuck** showing raw Urdu. Fixed via
  `looksTranslated(text, language)` in `translate.ts` — a Unicode
  script-range check (Arabic block for Urdu, Devanagari for Hindi) that
  rejects a "translation" still containing source-script characters, checked
  at both the Groq and Cloudflare stages. A new `repairStuckTranslations()`
  ("Phase -2", runs before `normalizeTranslatedSources()`) scans
  already-`"en"`-flagged `TRANSLATE_SOURCES` articles field-by-field for
  leftover native script and retries just the broken fields, using a new
  `SOURCE_LANGUAGES` map (`feeds.ts`) to recover the original language since
  it's no longer stored on the article once overwritten to `"en"`.
- **(2026-07-17) `POST /api/admin/clear-all`** wipes every article
  (summarized + pending), gated by the same `X-Refresh-Secret` as
  `/api/refresh`/`/api/sources/toggle`. Surfaced as a red "Danger zone" card
  on the Status page (admin-unlocked only), with a `window.confirm()` guard.
  There's no per-source equivalent yet — only a full wipe.
- **(2026-07-18, 2026-07-28) Homepage restyled to match the reference
  template (`websitedemos.net/news-blog-04`, "Nexus News") more closely,**
  after direct side-by-side comparisons against the live template caught
  concrete deltas rather than a vague "make it look better": nav pills
  switched from category to actual **source** names; category badges changed
  from a light outlined pill to a solid filled red rectangle (matching the
  template's `.uael-post__terms` styling exactly — solid `#cf412b` bg, white
  text, no border-radius); hero's two secondary-story titles bumped to the
  same font size as the main headline (the template uses one consistent size
  for all three, ours had the secondary titles noticeably smaller); secondary
  story images made edge-to-edge with no padding (padding moved to the text
  column only) and their text top-aligned instead of vertically centered,
  matching the template's card layout; nav bar's source links converted from
  rounded-pill buttons to plain text links with a red underline for the
  active selection, matching the template's minimal text-link nav styling
  (confirmed via computed-style inspection of the live template, not just
  visual guesswork — e.g. its nav font is Lexend/500/16px with no pill
  background at all).
- **(2026-09-03) Groq retired `llama-3.3-70b-versatile` and it silently
  froze the entire pipeline for ~16 days.** Groq announced that model's
  deprecation on 2026-06-17 and stopped serving it in Aug 2026; from roughly
  2026-08-18 onward *every* Groq call — summarization and translation alike —
  returned HTTP 404. Three separate weaknesses turned that into a total
  stall:
  1. `callGroqWithRetry` treated a 404 as a transient error — 3 attempts with
     5s/10s backoff, ~15s + 3 subrequests burned per call — and, because only
     a 429 set the run's `groqState.rateLimited` flag, it never switched to
     the Cloudflare lane. Every article and every translation field re-hit
     the dead model all run long.
  2. The translation-repair (`Phase -2`) and normalize (`Phase -1`) phases,
     which fire many Groq calls up front, exhausted the Worker invocation's
     **50-subrequest free-plan cap** before `Phase 1` (RSS fetch) ran — so
     `fetchAllFeeds` then failed every source with "Too many subrequests" and
     **0 new articles were discovered, every hour, for 16 days**.
  3. `saveMeta` (which sets `lastRunAt`) is the last thing a run does and it
     kept succeeding, so `/status` showed a fresh timestamp the whole time —
     the outage was invisible from the dashboard. Only `wrangler tail` on a
     live run showed the `Groq API HTTP error: 404` → subrequest-exhaustion
     chain.

  Three-part fix (commit `51f1d99`):
  - **`GROQ_API_MODEL` → `openai/gpt-oss-120b`** in `wrangler.toml` (Groq's
    own recommended migration target for the retired 70B model; large enough
    to keep the proper-noun accuracy the BBC Urdu translation path needs).
  - **Any non-429 4xx from Groq (400/401/403/404) is now fatal.** New
    `GroqUnavailableError` base class; `RateLimitError` extends it; new
    `GroqRequestError` for the 4xx case. `callGroq` raises `GroqRequestError`
    for those and `callGroqWithRetry` no longer retries it — and
    `summarizeWithFallback` / `translateWithFallback` now catch the base
    class (not just `RateLimitError`), so the first bad response flips
    `groqState` and the rest of the run routes through Cloudflare instead of
    hammering a broken model or key. Groq error messages now also include a
    snippet of the response body (e.g. `model_decommissioned`).
  - **`runPipeline` reordered** so `Phase 1` (RSS fetch) runs *before* the
    repair / normalize / backlog phases. New-article discovery can no longer
    be starved by AI-call failures eating the subrequest budget — the feeds
    are always fetched, and new articles save as `pending` and get their
    summaries from `Phase 0` on later runs regardless. Tradeoff: each
    source's per-run fetch limit is now derived from its pending count
    *before* `Phase 0` clears backlog (was recomputed after) — minor, the
    throttle only needs to be roughly right.

  First recovered run (2026-09-03 08:00 UTC, verified live): `Phase 1` found
  10 new articles, `Phase 0` cleared 9 backlog, 2 summaries came back via
  Groq directly — pipeline unwedged. **Lesson (recurring in this project):
  "the call returned" ≠ "the call did what I asked", and a health signal
  that only proves the run *ended* — not that it *did anything* — hides
  exactly this class of failure.**
- **(2026-09-04) Dedup is now canonical-URL-based for Dainik Bhaskar only.**
  Bhaskar's RSS feed serves the same story under two path forms that differ
  only by a `/g/` segment right after the host
  (`bhaskar.com/national/news/…-<id>.html` vs
  `bhaskar.com/g/national/news/…-<id>.html`) and flips between them from one
  hourly run to the next. The dedup check (`existingUrlSet` in `store.ts`,
  consumed by `fetchFeed` in `feeds.ts`) was an exact string match, so the
  second form came in as a brand-new article with its own UUID — re-scraped
  and re-summarized (burning a second Groq/Cloudflare call), then both copies
  showed on the site. Found 6 duplicate pairs live. Fix (all bhaskar-scoped,
  every other source untouched — they emit stable canonical URLs):
  - **`canonicalizeUrl(url, source)` in `feeds.ts`** strips a leading `/g/`
    path segment; a no-op unless `source === "bhaskar"`. `fetchFeed` now
    compares and *stores* the canonical form; `existingUrlSet` canonicalizes
    each stored URL when building the lookup set, so a stored `/g/` URL still
    matches the plain form off the feed and vice-versa.
  - **`dedupeBhaskarArticles()` in `index.ts`** runs at the top of every
    `runPipeline` (before fetch-dedup / backlog / throttle math). Cheap
    in-memory group-by-canonical-URL, no AI calls: collapses existing `/g/`
    duplicate pairs, keeping the more complete copy (finished summary beats
    pending; else earlier `createdAt` — the one the site's been showing, with
    `links`/`searchQuery` populated) and rewriting survivors' URLs to
    canonical. Saves only when something changed. Doubles as an ongoing
    safety net if the feed ever produces a new pair before Phase 1 sees it.
    Array order isn't preserved — fine, every downstream reader re-sorts.

## Open questions / paused work

- **(2026-07-10, still not decided)** Whether to additionally cap how many
  articles *per source* are kept in storage at once, since cricket
  (espncricinfo) naturally accumulates far more total articles over time
  than slower-moving sources like Autocar India — not because of unfair
  processing (fetching is now proportionally throttled per source, and
  processing is round-robin/fair), but because cricket's RSS feed simply
  produces more *distinct new* articles per hour, so its share of the ~5-day
  retention window grows faster. Different question from the fetch throttle
  above (that's about run-to-run fairness, this is about long-term storage
  balance).
- **(2026-07-18, paused mid-implementation, nothing built yet)** Make the
  homepage (navbar + hero + carousel) fit within one screen with **zero
  page-level vertical scrolling**, on a typical screen. User confirmed via
  follow-up questions this means the literal whole page, not just hiding the
  scrollbar cosmetically. Flagged risk: a true zero-scroll fixed-viewport
  layout is fragile across different screen heights, so it'll need
  viewport-relative sizing (`vh`/`h-screen` + flex with `overflow-hidden`)
  rather than the current fixed `rem` heights on `Hero.tsx`, and should be
  tested at more than one window height before calling it done.
- **Stale `lastRunAt` / possibly-cut-short scheduled runs** — seen multiple
  times (last run time trailing the expected hourly slot by hours), same root
  cause suspected as the `waitUntil` execution-time-limit issue below, but
  never confirmed live via `wrangler tail` watching a full run start-to-end.
  Heavier per-run workload since 2026-07-17 (throttle math, dual-lane
  summarization, translation repair) makes it bite more often.
  **(2026-09-03 update)** The 2026-08-18 → 09-03 freeze *looked* like this
  symptom (runs landing ~:08 past the hour, nothing progressing) but had a
  distinct, now-fixed root cause — a decommissioned Groq model driving the
  subrequest budget to exhaustion (see "Key design decisions"). The generic
  `waitUntil` cutoff on genuinely heavy runs is still not root-caused.

## Known limitations

- **ESPNCricinfo and Gadgets360 return 403 to Cloudflare's IP ranges**
  (bot-detection against datacenter IPs, discovered during testing — not a
  selector bug). Worked around by falling back to the RSS description for
  summarization when full-page scraping is blocked.
- **Groq free-tier rate limit** means a big batch of new articles (e.g. the
  initial 25-article bootstrap burst) can take a couple of hours to fully
  get AI summaries, via the Phase 0 backlog-retry mechanism on subsequent
  hourly runs. Articles are never hidden while waiting (see above).
- **(Partially fixed) Cloudflare's `ctx.waitUntil()` execution-time limit
  still cuts some background pipeline runs off early** — but they no longer
  lose completed work when it happens. `ctx.waitUntil()` (how the pipeline
  keeps running after the HTTP response is sent) has a limited execution
  window; Cloudflare cancels it if it runs past that. Originally this
  silently discarded all completed-but-unsaved work for the whole run
  (confirmed live via `wrangler tail`: 6 of 8 summarized articles thrown
  away because the save only happened once at the very end) — fixed by
  saving to KV immediately after each article instead of batching the save.
  The underlying cutoff itself is still not root-caused, though — it's been
  reconfirmed multiple times since (most recently on heavier runs after the
  2026-07-17 throttle/dual-lane/translation-repair work added more per-run
  work), and shows up as a stale `lastRunAt` lagging the expected hourly
  slot. See "Open questions" above — would need a dedicated `wrangler tail`
  session watching a full run start-to-finish to pin down exactly where it
  cuts off.
- No visual/browser UI testing was done by Claude directly (no browser tool
  available in that environment) — verified via curl/API responses and the
  user checking the live site themselves. **Update 2026-07-11:** browser
  testing became possible in a later session (Playwright + downloaded
  Chromium, driven directly rather than via the `chromium-cli` skill tool
  which wasn't available) — used to verify the translation feature's
  frontend changes didn't regress card rendering.
- **(Resolved 2026-07-16)** Existing BBC Urdu articles used to not get a
  retroactive translation under the old toggle-based design. The
  `normalizeTranslatedSources()` migration pass now catches these
  automatically (see above) — no one-off backfill script was needed.
- **(2026-09-03) The 5-day retention trim wiped the store to ~10 articles on
  recovery.** `saveArticles` drops any article whose `publishedAt` is older
  than `RETENTION_DAYS` (5) on every write. After the 16-day model outage
  every cached article was >5 days old, so the first successful write
  post-fix collapsed the store from 448 to the ~10 fetched that run.
  Expected, not a bug — it refills over the following hours as each run
  fetches and `Phase 0` summarizes — but the site looks sparse in the
  interim.
- **(2026-09-03) Cloudflare's 50-subrequest-per-invocation free-plan cap is
  the current throughput ceiling.** With a large backlog to grind through, a
  run can still hit it partway — remaining new articles just save as
  `pending` and get summarized by `Phase 0` on later runs (the intended
  "show now, summarize later" behavior — no longer a wedge, since `Phase 1`
  runs first now). The Workers Paid plan raises this limit to 1000; trimming
  `BACKLOG_LIMIT` or the 2s inter-call Groq pacing is the no-cost lever.

## Local development

- `nexbrief-worker/`: `npm install`, copy `.dev.vars.example` → `.dev.vars`
  with real values, `npx wrangler dev --local --test-scheduled`. The `AI`
  binding always hits the real Cloudflare account even in `--local` mode
  (Workers AI has no local emulation) — this incurs real (free-tier) usage
  during local testing.
- `nexbrief-web/`: `npm install`, `npm run dev` (defaults to
  `http://localhost:8787/api` unless `VITE_API_BASE_URL` is set).
- If `.dev.vars`'s `GROQ_API_KEY` goes stale (401s instead of successful
  summaries when testing the pipeline locally), regenerate it from the Groq
  console — it won't self-resolve by waiting. Since 2026-09-03 a 401/403/404
  from Groq is caught as a fatal `GroqRequestError` (distinct from a 429
  `RateLimitError`) and the run falls straight to the Cloudflare lane rather
  than retrying, so locally you'll see Cloudflare-summarized articles and a
  `Groq API HTTP error: 4xx` log line rather than a wedged pipeline.

## Possible next steps (not yet done, not requested)

- Rotate the Groq key that's still exposed in the old `application.yml`.
- Consider deleting the old `NexBrief/` and `nexbrief-frontend/` folders
  once confident the new stack fully replaces them (currently kept as
  untouched reference/fallback).
