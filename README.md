# NexBrief

A personal news aggregator that automatically pulls the latest articles from five news sources, scrapes the full article text, summarizes each one with AI, and generates ready-to-click "search this elsewhere" links — all refreshed automatically every hour, with **no database and no server to keep running**.

**🔴 Live**: [nexbrief-v2.ameettechademy.workers.dev](https://nexbrief-v2.ameettechademy.workers.dev) · [Status page](https://nexbrief-v2.ameettechademy.workers.dev/status)

---

## What this is

NexBrief-v2 is a from-scratch rebuild of an earlier version of this project (originally Spring Boot + PostgreSQL) that needed an always-on server and database, which meant it couldn't be hosted for free. This version runs entirely on serverless infrastructure — a Cloudflare Worker on an hourly schedule does all the work (fetch → scrape → summarize), storing results in a simple key-value cache instead of a database, and the whole thing costs nothing to host.

Want the full story — why this architecture, every tool used and why, and every real problem hit while building it? Read **[`PROJECT_EXPLAINED.md`](./PROJECT_EXPLAINED.md)** — a detailed, beginner-friendly deep dive intended to be readable by someone with little prior web/cloud experience.

For current live operational status (what's deployed, where, and known limitations right now), see **[`STATUS.md`](./STATUS.md)**.

## Features

- 📰 Aggregates news from 5 sources: ESPNCricinfo (cricket), Dainik Bhaskar (general, Hindi), Autocar India (automobile), Gadgets360 (technology), and BBC News (general)
- 🤖 AI-generated summaries for every article (via Groq, using `llama-3.3-70b-versatile`)
- 🔗 Auto-generated, category-aware "search this elsewhere" links (Cricbuzz/ESPNCricinfo for cricket, TechCrunch/The Verge for tech, etc.)
- 🔄 Fully automatic hourly refresh — no manual intervention, no visitor-triggered fetching
- 📊 A `/status` page showing pipeline health: article counts, last/next run time, Groq quota remaining
- 🗂️ Filter by date, category, source, or keyword search
- 💸 Runs entirely on free-tier cloud infrastructure — no database, no always-on server

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| Frontend | React 19 + TypeScript + Vite | Fast dev/build tooling, type safety |
| Styling | Tailwind CSS v4 | Utility-first, fast to iterate |
| HTTP client | Axios | Ergonomic API calls from the frontend |
| Backend | Cloudflare Workers (TypeScript) | Serverless — no CORS issues, keeps API keys secret, supports scheduled execution |
| Storage | Cloudflare Workers KV | Simple key-value cache — no database needed |
| Scheduling | Cloudflare Cron Triggers | Hourly pipeline runs, free tier allows sub-daily schedules (unlike some competitors) |
| HTML parsing | Cloudflare `HTMLRewriter` | Native streaming HTML parser for article scraping |
| XML parsing | `fast-xml-parser` | Parses RSS feeds into JS objects |
| AI summarization | Groq API (`llama-3.3-70b-versatile`) | Fast, free-tier-friendly LLM access, OpenAI-compatible API |
| Hosting (frontend) | Cloudflare Workers Builds | Git-connected, auto-deploys on push |
| Hosting (backend) | Cloudflare Workers + GitHub Actions | Auto-deploys via `wrangler deploy` on push |
| CI/CD | GitHub Actions | Automated Worker deployment on push |

See [`PROJECT_EXPLAINED.md`](./PROJECT_EXPLAINED.md#5-every-technology-used--what-it-is-and-why-we-used-it) for a detailed explanation of every entry in this table.

## Architecture

```
Cloudflare Cron Trigger (hourly)
        │
        ▼
nexbrief-worker (Cloudflare Worker)
  1. Fetch RSS from 5 sources
  2. Scrape full article text
  3. Summarize via Groq AI
  4. Generate search query + links via Groq AI
  5. Save to shared cache
        │
        ▼
Cloudflare Workers KV (shared cache, all visitors read the same data)
        ▲
        │  reads (on every visit — no live fetching/scraping/AI calls happen per-visit)
        │
nexbrief-worker's read API (/api/articles, /api/status)
        ▲
        │  HTTP
        │
nexbrief-web (React frontend, static site)
```

One shared cache (not per-visitor caching) means the expensive work — scraping and AI calls — happens once per hour total, regardless of how many people visit the site.

## Project structure

```
NexBrief-v2/
├── README.md                    ← you are here
├── STATUS.md                    ← current live operational state
├── PROJECT_EXPLAINED.md         ← detailed "why" deep-dive
├── PLAN.md                      ← original pre-build architecture plan
├── .github/workflows/
│   └── deploy-worker.yml        ← auto-deploys nexbrief-worker on push
├── nexbrief-worker/              Cloudflare Worker (backend)
│   ├── wrangler.toml             KV binding, cron schedule, config
│   └── src/
│       ├── index.ts              Entry point: fetch handler + scheduled pipeline
│       ├── feeds.ts              RSS feed config + parsing
│       ├── scrape.ts             Article content extraction
│       ├── groq.ts               AI summarization + search link generation
│       ├── store.ts              KV read/write logic
│       ├── api.ts                Read API (filtering, pagination, status)
│       └── types.ts              Shared TypeScript types
└── nexbrief-web/                 React frontend
    ├── wrangler.toml              Static asset deployment config
    └── src/
        ├── pages/
        │   ├── Home.tsx           Main article feed
        │   └── Status.tsx         Pipeline health dashboard
        ├── components/            ArticleCard, Navbar, SourceSection
        ├── api/articleApi.ts      Backend API client
        └── types/                 Shared TypeScript types
```

## Getting started (local development)

### Prerequisites

- Node.js 22+ and npm
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free) and a [Groq API key](https://console.groq.com) (free)

### Backend (`nexbrief-worker`)

```bash
cd nexbrief-worker
npm install
cp .dev.vars.example .dev.vars   # then fill in your real GROQ_API_KEY and REFRESH_SECRET
npx wrangler dev --local --test-scheduled
```

This starts a local server at `http://localhost:8787`. To manually trigger the pipeline instead of waiting for the (local-only, simulated) hourly schedule:

```bash
curl -X POST http://localhost:8787/api/refresh -H "X-Refresh-Secret: <value from .dev.vars>"
```

### Frontend (`nexbrief-web`)

```bash
cd nexbrief-web
npm install
npm run dev
```

Defaults to talking to `http://localhost:8787/api` — override with a `VITE_API_BASE_URL` environment variable if needed.

## Deployment

Both halves deploy automatically on `git push` to `main` — see [`STATUS.md`](./STATUS.md#deployment-all-free-tier-all-automatic) for the exact mechanics:

- Changes under `nexbrief-web/` → Cloudflare Workers Builds rebuilds and redeploys the frontend
- Changes under `nexbrief-worker/` → the GitHub Action in `.github/workflows/deploy-worker.yml` redeploys the Worker

Required secrets (never committed):
- Cloudflare Worker secrets (`GROQ_API_KEY`, `REFRESH_SECRET`) — set via `wrangler secret put <NAME>`
- GitHub repository secret (`CLOUDFLARE_API_TOKEN`) — set under repo Settings → Secrets and variables → Actions

## API reference

All endpoints are served by `nexbrief-worker`.

### `GET /api/articles`

Returns a paginated list of articles. All filters below are optional and combine together (AND'd) — e.g. `category=cricket&date=2026-07-10` returns only cricket articles published that day. Omitting `date` entirely returns everything currently in the ~5-day retention window, not just today.

| Query param | Type | Description |
|---|---|---|
| `keyword` | string | Full-text search in title/description |
| `source` | string | Filter by source (`espncricinfo`, `bhaskar`, `autocarindia`, `gadgets360`, `bbc`) |
| `category` | string | Filter by category (`cricket`, `automobile`, `technology`, `general`) |
| `date` | string (`YYYY-MM-DD`) | Filter by publish date (omit to show all cached articles) |
| `page` | number | Page number, 0-indexed (default `0`) |
| `size` | number | Page size (default `100`) |

### `GET /api/status`

Returns pipeline health: article counts (total/summarized/pending, overall and per-source), the titles of currently-pending articles, last/next run time, whether the last run hit a rate limit, and Groq's remaining quota. Powers the `/status` page, which auto-refreshes every 30s.

### `POST /api/refresh`

Manually triggers the fetch/scrape/summarize pipeline immediately, instead of waiting for the hourly cron. Requires an `X-Refresh-Secret` header matching the configured `REFRESH_SECRET`.

## Known limitations

- ESPNCricinfo and Gadgets360 block scraping requests from Cloudflare's IP ranges (403 responses) — worked around by falling back to the RSS description for AI summarization on those sources.
- Groq's free-tier rate limit means a large batch of new articles can take a couple of hours to all get real AI summaries (via automatic backlog retry on subsequent hourly runs) — articles are never hidden while waiting, they show with a "preview" (RSS description) in the meantime.
- A background-task time limit was silently discarding completed work on interrupted runs — fixed by saving each article immediately instead of batching the save until the end.

See [`STATUS.md`](./STATUS.md#known-limitations) for the current, up-to-date list.

## Documentation index

- [`PROJECT_EXPLAINED.md`](./PROJECT_EXPLAINED.md) — the complete story: why this architecture, every technology explained, key decisions, and real problems solved along the way. Written for readers with no prior background.
- [`STATUS.md`](./STATUS.md) — current live state: URLs, deployment mechanics, secrets locations, what's working.
- [`PLAN.md`](./PLAN.md) — the original architecture plan agreed before building.

## Acknowledgments

News content is sourced from the RSS feeds of ESPNCricinfo, Dainik Bhaskar, Autocar India, Gadgets360, and BBC News — all rights to article content belong to the respective publishers; NexBrief only links to and summarizes their public RSS feeds. AI summarization powered by [Groq](https://groq.com). Built with assistance from Claude Code.
