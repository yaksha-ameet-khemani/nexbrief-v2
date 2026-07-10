# NexBrief-v2 — The Complete Story

*A detailed walkthrough of what this project is, why every technology in it was chosen, how the pieces fit together, and the real problems we ran into while building it. Written so that someone with little to no experience in web development or cloud infrastructure can read it top to bottom and actually understand — not just copy — what happened here.*

Last updated: 2026-07-10

---

## Table of Contents

1. [What This Project Is](#1-what-this-project-is)
2. [The Origin Story: NexBrief v1](#2-the-origin-story-nexbrief-v1)
3. [The Big Question: Can This Just Be React?](#3-the-big-question-can-this-just-be-react)
4. [The Architecture We Landed On](#4-the-architecture-we-landed-on)
5. [Every Technology Used — What It Is and Why We Used It](#5-every-technology-used--what-it-is-and-why-we-used-it)
6. [How Data Actually Flows Through the System](#6-how-data-actually-flows-through-the-system)
7. [Key Design Decisions and the Reasoning Behind Them](#7-key-design-decisions-and-the-reasoning-behind-them)
8. [Real Problems We Hit and How We Solved Them](#8-real-problems-we-hit-and-how-we-solved-them)
9. [Glossary — Terms Explained Simply](#9-glossary--terms-explained-simply)
10. [What a Beginner Can Learn From This Project](#10-what-a-beginner-can-learn-from-this-project)
11. [Quick Reference](#11-quick-reference)

---

## 1. What This Project Is

NexBrief is a personal news aggregator. It automatically pulls the latest articles from five news sources (cricket, general news, automobiles, and technology), reads the full article, uses an AI model to write a short summary of it, and generates ready-to-click "search this topic elsewhere" links (Google News, Cricbuzz, TechCrunch, etc. depending on the topic). The user opens one website and gets a digest of news across multiple beats, pre-summarized, without having to visit five different news sites.

**This document describes `NexBrief-v2`** — a from-scratch rebuild of an earlier version of this same idea (`NexBrief`, the original), redesigned specifically to be:

- **Free to host**, indefinitely, with no credit card required.
- **Database-free** — no server process to keep alive, no database to back up or pay for.
- **Fully automatic** — content refreshes on its own every hour, with nobody needing to visit the site or run anything manually.
- **Still a "real" React project** to build and deploy, which was one of the user's original goals.

---

## 2. The Origin Story: NexBrief v1

The original `NexBrief` (still sitting untouched in the sibling `NexBrief/` folder, in case anyone wants to look back at it) was built as a traditional web application:

- **Backend**: Java, Spring Boot framework, running as a long-lived server process.
- **Database**: PostgreSQL, storing every article ever fetched.
- **Scheduler**: Spring's `@Scheduled` annotation, which fires a function every hour *as long as the server process is running*.
- **Frontend**: React + TypeScript + Tailwind CSS, calling the Spring Boot backend over a REST API.

This worked, but it has a fundamental hosting problem: **a Spring Boot server has to be running 24/7** for the hourly scheduler to fire, and Postgres has to be running 24/7 to hold the data. Free hosting for an always-on server + database combination is either non-existent or comes with meaningful strings attached (sleep-after-inactivity, very limited free hours, etc.). The user's goal — "I want this free and easy to host forever" — was fundamentally in tension with "always-on server + database."

That tension is the entire reason `NexBrief-v2` exists.

---

## 3. The Big Question: Can This Just Be React?

The user's first instinct was: *what if I just built this in React, with no backend at all — a plain static website?* Static websites (just HTML/CSS/JS files, no server-side code) are trivially free to host anywhere (GitHub Pages, Cloudflare Pages, Netlify, Vercel, etc.), so this seemed like the simplest possible answer.

It turns out this **doesn't work**, for three specific, technical reasons — and understanding *why* is genuinely useful, because these three problems show up constantly in real-world web development.

### 3.1 CORS blocks a browser from fetching most other websites' data

**CORS** stands for **Cross-Origin Resource Sharing**. It's a security rule built into every web browser: a webpage running on `your-site.com` is *not allowed* to make a network request (via `fetch()` or similar) to `some-other-site.com` **unless** `some-other-site.com` explicitly says "yes, I allow requests from other websites" via special HTTP response headers.

This exists to protect users — without it, any website you visit could silently make requests to your bank's website using your logged-in session, read the response, and steal your data. Browsers block this by default.

The problem: NexBrief needs to (a) fetch RSS feeds from BBC, ESPNCricinfo, etc., and (b) fetch the full HTML of individual news articles to scrape the article text. Almost none of these sites configure their servers to allow arbitrary websites to fetch their content via browser JavaScript. If we tried to do this directly from React running in the user's browser, the browser would simply block the request and throw a CORS error — no amount of clever code on our side can bypass this, because the restriction is enforced by the *browser*, not by us.

**The fix**: this kind of fetching has to happen from a *server* (or something server-like), because CORS is a browser-only restriction — a server doesn't have a browser's CORS rules and can freely make outbound HTTP requests to anywhere.

### 3.2 The AI API key can't live in the browser

To generate AI summaries, we call Groq's API, which requires a secret API key sent with every request. If that key lived inside the React code running in the user's browser, **anyone** who opened their browser's developer tools (a completely standard, built-in browser feature — no hacking required) could see the key in plain text, copy it, and use it themselves — running up the account's usage/costs and quota with none of it belonging to legitimate use.

**The fix**: the API key must live somewhere that never gets sent to the browser — i.e., on a server, which keeps it secret and only sends back the *result* (the summary text) to the browser, never the key itself.

### 3.3 A static website can't run anything on a timer

The original design relies on something happening automatically every hour, *whether or not anyone is visiting the site at that moment*. A plain static website is just files sitting on a server waiting to be requested — there's no running process, so there's nothing to "wake up" once an hour and go fetch new articles. The only thing that can trigger code to run is a person's browser loading the page.

**The fix**: something needs to run on a schedule, independent of whether anyone's browser is open — which again requires *some* form of server-side execution, even if it's a very lightweight one.

### 3.4 The conclusion

All three problems point to the same fix: **some code needs to run outside the browser** — but that doesn't mean we need a traditional always-on server. This is exactly the gap that **serverless computing** fills, which leads to the architecture below.

---

## 4. The Architecture We Landed On

Instead of "no backend at all," the actual design is: **keep the React frontend, replace the traditional always-on Spring Boot server with a serverless function that only exists when it's actually doing something.**

```
┌─────────────────────────────────────────────────────────────┐
│  Cloudflare Cron Trigger (fires automatically every hour)     │
└───────────────────────────┬─────────────────────────────────┘
                             │ wakes up
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  nexbrief-worker (Cloudflare Worker — serverless function)    │
│  1. Fetch RSS feeds (5 news sources)                          │
│  2. Scrape full article text from each article's own page     │
│  3. Ask Groq's AI to summarize each article                   │
│  4. Ask Groq's AI for a short search query + build search links│
│  5. Save everything into a single shared cache                │
└───────────────────────────┬─────────────────────────────────┘
                             │ writes to
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  Cloudflare KV (a simple, fast key-value cache — not a real    │
│  database, no rows/tables/queries, just "store this JSON blob  │
│  under this name, read it back later")                        │
└───────────────────────────▲─────────────────────────────────┘
                             │ reads from (whenever anyone visits)
┌─────────────────────────────────────────────────────────────┐
│  nexbrief-worker's read API (same Worker, different job:      │
│  answer "give me the articles" requests instantly)            │
└───────────────────────────▲─────────────────────────────────┘
                             │ HTTP requests
┌─────────────────────────────────────────────────────────────┐
│  nexbrief-web (React frontend, static files)                  │
│  Hosted by Cloudflare, served to whoever visits the site       │
└─────────────────────────────────────────────────────────────┘
```

### 4.1 Why "serverless" solves this without breaking the "free and easy" goal

A **serverless function** (Cloudflare calls theirs a "Worker") is code that only actually runs — and only costs anything — while it's executing. Between runs, nothing is "on"; there's no idle server burning electricity and money 24/7 waiting for a request. Cloudflare's free plan gives a generous number of these executions per day for free, which is more than enough for "run once an hour" (24 times a day) plus however many times people visit the website to read articles.

This is the piece that makes "free hosting" and "hourly automatic refresh" compatible with each other, which a plain static site alone could never do.

### 4.2 Why Cloudflare specifically (and not another serverless provider)

Several companies offer free serverless hosting (Vercel, Netlify, AWS Lambda, Cloudflare, and others). We specifically picked **Cloudflare Workers**, for one very concrete reason discovered during planning: **Vercel's free ("Hobby") plan restricts scheduled/cron jobs to running at most once per day.** Since the whole point was hourly refreshes, that ruled Vercel out for the free tier. Cloudflare Workers' free plan supports cron jobs running as often as needed (down to once a minute, if you wanted), with no such restriction — which made it the correct fit for what we actually needed.

### 4.3 Why a key-value cache (KV) instead of a real database

A traditional database (like Postgres, which the original v1 used) is built for complex querying, relationships between data, and guarantees about consistency — powerful, but it's also a separate running service that needs to be paid for, backed up, and maintained. For this project, none of that complexity is actually needed: we just need to store "here's the current list of articles" as one blob of data, and read it back. That's exactly what a key-value store is for — think of it like a single giant labeled box: you put data in under a label ("articles"), and later ask for whatever's under that label. Cloudflare KV does exactly this, is free at this scale, and requires zero maintenance.

---

## 5. Every Technology Used — What It Is and Why We Used It

This section goes through *every* tool, platform, or technology involved in this project, explaining what each one is (assuming no prior knowledge) and specifically why it was the right choice here.

### 5.1 Cloudflare Workers

**What it is**: A platform for running small pieces of server-side JavaScript/TypeScript code "at the edge" — meaning the code runs on servers Cloudflare operates all around the world, so it executes physically close to whoever's making the request. It's Cloudflare's version of "serverless functions."

**Why we used it**: It's the piece that solves all three problems in [Section 3](#3-the-big-question-can-this-just-be-react) — it can make outbound network requests without any CORS restriction (CORS is a *browser* rule, and this isn't a browser), it can keep secrets (like the Groq API key) safely on the server side, and it supports being triggered on a schedule (see Cron Triggers, below). Free tier is generous, no credit card required.

### 5.2 Cloudflare Workers KV

**What it is**: A simple key-value storage service that Workers can read from and write to. "Key-value" means data is stored as pairs — a name (key) and whatever data you want (value) — with no query language, no tables, no relationships. You ask for a key, you get back whatever was stored there.

**Why we used it**: It's the simplest possible way to persist data between one hourly Worker run and the next, without running an actual database. The entire article list is stored as one JSON blob under a single key called `"articles"`. Cheap, free at this scale, zero setup or maintenance.

### 5.3 Cloudflare Cron Triggers

**What it is**: A scheduling feature built into Cloudflare Workers — you specify a schedule (using "cron syntax," a standard way of writing "run this at these times" used across many systems, e.g. `0 * * * *` means "at minute 0 of every hour") and Cloudflare automatically invokes your Worker's code at those times, with no server needed to keep the clock running.

**Why we used it**: This is what makes the pipeline run automatically every hour without anyone visiting the site or manually triggering anything — directly solving the "static sites can't run on a timer" problem from Section 3.3.

### 5.4 Cloudflare Workers Builds (the modern "Pages" equivalent)

**What it is**: Cloudflare's system for automatically building and deploying a website whenever you push new code to a connected GitHub repository. Historically this was a separate product called "Cloudflare Pages"; Cloudflare has been unifying it with their general Workers platform, so what you see in the dashboard today deploys the frontend as a special kind of Worker that just serves static files (see the "Real Problems" section below for the confusion this caused).

**Why we used it**: It's free, and it means the frontend redeploys itself automatically every time we push a code change to GitHub — no manual "upload the new version" step, ever.

### 5.5 Wrangler

**What it is**: Cloudflare's official command-line tool for developing, testing, and deploying Workers. It's how you log into your Cloudflare account from the terminal, create KV namespaces, set secrets, run a Worker locally for testing, and push it live.

**Why we used it**: It's the standard, official way to work with Cloudflare Workers — used both by a human typing commands and by our automated GitHub Action (see below).

### 5.6 Node.js and npm

**What it is**: Node.js is a JavaScript runtime that lets JavaScript run outside a web browser (e.g., directly on your computer, or on a server) — normally JavaScript only runs inside browsers. npm ("Node Package Manager") is the tool that comes with Node.js for installing other people's published code libraries ("packages") into your project, and for running project-defined scripts (like "build this project" or "start the dev server").

**Why we used it**: Virtually all modern JavaScript/TypeScript tooling (React, Vite, Wrangler, TypeScript itself) is built on Node.js and distributed via npm. It's the standard foundation for this kind of project.

### 5.7 TypeScript

**What it is**: A superset of JavaScript that adds optional *type checking* — meaning you can declare "this variable is always a string" or "this function always returns a number," and a tool checks your entire codebase for mismatches *before* the code ever runs, catching a whole category of bugs early.

**Why we used it**: Both the original project and this rebuild use TypeScript throughout (frontend and the Worker backend) specifically because it catches mistakes at build time rather than as a live bug a user encounters — e.g., if a function expects an `Article` object with a `title` field and you accidentally pass something without one, TypeScript flags it immediately in your editor rather than crashing silently for a real user later.

### 5.8 React

**What it is**: A JavaScript library (from Meta/Facebook) for building user interfaces out of reusable, self-contained pieces called "components." Instead of manually writing code to update the webpage every time data changes, you describe what the UI should look like *for a given set of data*, and React handles updating the actual page efficiently when that data changes.

**Why we used it**: It was already the frontend technology chosen for the original NexBrief, the user is building this specifically as a React learning/portfolio project, and it's an extremely widely-used, well-supported choice for building interactive websites.

### 5.9 Vite

**What it is**: A modern build tool for frontend web projects. During development, it serves your code instantly with near-zero delay when you save a file (via a technique called Hot Module Replacement); when you're ready to publish, it bundles and optimizes all your code into a small set of efficient files browsers can load quickly.

**Why we used it**: It's the standard, fast, low-friction way to develop and build a React + TypeScript project today, and (again) matches what the original project already used.

### 5.10 Tailwind CSS

**What it is**: A CSS framework built around small, single-purpose utility classes (e.g. `text-sm`, `bg-gray-900`, `rounded-xl`) that you combine directly in your HTML/JSX to style things, instead of writing separate custom CSS files with your own class names for every element.

**Why we used it**: Fast to build and adjust UI with (no context-switching between a JS file and a separate CSS file), and — again — it's what the original frontend already used, so the visual design carried over directly.

### 5.11 Axios

**What it is**: A small, popular JavaScript library that makes it easier to send HTTP requests (like "fetch this data from that API") from either a browser or Node.js, compared to using the browser's built-in, lower-level `fetch()` API directly.

**Why we used it**: Simple ergonomics for calling our own backend API from the React frontend (e.g., automatically turning query parameters into a proper URL, parsing JSON responses).

### 5.12 fast-xml-parser

**What it is**: A small npm package for parsing XML text into a JavaScript object you can easily read from.

**Why we used it**: RSS feeds (the format news sites publish their latest articles in) are written in XML. The original Java backend used a Java-specific library for this (Rome); since our Worker runs JavaScript/TypeScript instead, we needed an equivalent, and `fast-xml-parser` is a lightweight, dependency-free option that works correctly inside Cloudflare's Worker environment (which is not quite the same as a full Node.js environment, so not every npm package works here — this one does).

### 5.13 HTMLRewriter

**What it is**: A tool built directly into the Cloudflare Workers platform (not an npm package) for reading and transforming HTML as it streams through — you tell it "find elements matching this CSS selector" and it hands you the matching text/content.

**Why we used it**: To get a full, well-written AI summary, we need the *entire* article text, not just the short blurb RSS feeds provide. That means fetching each article's own webpage and pulling out just the article body from all the surrounding menus/ads/navigation. The original Java backend used a library called Jsoup for this; HTMLRewriter is Cloudflare's native equivalent, purpose-built to run efficiently inside a Worker.

### 5.14 RSS / Atom feeds

**What it is**: A long-standing, standardized web format (XML-based) that news sites and blogs publish, listing their most recent articles with a title, short description, publish date, and a link — specifically designed for other software to consume automatically (as opposed to a regular webpage, meant for humans reading in a browser).

**Why we used it**: It's the standard, official way to get a live feed of "what's new" from a news site without having to scrape the entire homepage — every source used (ESPNCricinfo, Dainik Bhaskar, Autocar India, Gadgets360, BBC) publishes one.

### 5.15 Groq (the AI API)

**What it is**: A company providing very fast API access to run large language models (LLMs) — the same category of AI model behind tools like ChatGPT — with an interface compatible with OpenAI's own API format. You send it text and instructions ("summarize this in 3-4 sentences"), and it sends back generated text.

**Why we used it**: It's what turns the raw scraped article text into a short, readable summary, and separately, into a short "search query" used to build the "search this elsewhere" links. This project specifically uses the `llama-3.3-70b-versatile` model via Groq — chosen in the original project (we kept the same choice), offering a solid balance of quality and speed on Groq's free tier.

### 5.16 Git and GitHub

**What it is**: Git is a *version control system* — software that tracks every change ever made to a project's files, letting you see history, undo mistakes, and collaborate without overwriting each other's work. GitHub is a website that hosts Git projects ("repositories") online, adds collaboration features (pull requests, issues), and — critically for this project — can trigger automated actions (like a deployment) whenever code is pushed.

**Why we used it**: Beyond just version-controlling the code (valuable on its own), pushing code to GitHub is the trigger that makes both the frontend and the Worker redeploy automatically — see GitHub Actions and Cloudflare Workers Builds above/below.

### 5.17 GitHub Actions

**What it is**: GitHub's built-in automation system — you write a "workflow" file describing a sequence of steps to run automatically in response to an event (like "code was pushed to the main branch"), and GitHub runs those steps on a temporary virtual machine it spins up for you.

**Why we used it**: The frontend auto-deploys via Cloudflare's own Git integration, but the Worker backend doesn't have that built in the same way — so we wrote a small GitHub Actions workflow (`.github/workflows/deploy-worker.yml`) that automatically runs `wrangler deploy` whenever Worker code changes get pushed, so both halves of the project redeploy themselves without any manual step.

### 5.18 GitHub Personal Access Tokens (PATs)

**What it is**: A long random string that acts like a password specifically scoped to let a tool (like the `git` command line, or an automated script) act on your behalf on GitHub, without using your actual account password (GitHub no longer accepts real passwords for this kind of access at all). You choose exactly what permissions ("scopes") the token grants — e.g., just read/write access to repositories, or also permission to manage GitHub Actions workflow files.

**Why we used it**: Needed so that `git push` from the command line could authenticate as the user without them re-entering a password (which GitHub doesn't even support for this anymore) — and specifically needed the `workflow` scope in addition to the basic `repo` scope, because pushing changes to a `.github/workflows/` file requires that extra explicit permission (a deliberate GitHub safety measure, since workflow files can run arbitrary automated code).

### 5.19 Cloudflare API Tokens

**What it is**: Similar concept to a GitHub PAT, but for authenticating *into Cloudflare's* API instead — a scoped credential that lets an external tool (in this case, the GitHub Action) deploy things to a Cloudflare account without needing the actual account login/password.

**Why we used it**: The GitHub Action needs to be able to run `wrangler deploy` on Cloudflare's behalf, without a human sitting there typing a password — this token is what lets it authenticate automatically and securely.

---

## 6. How Data Actually Flows Through the System

Every hour (and also whenever manually triggered for testing), the Worker runs a pipeline with four phases, directly inspired by the original Java backend's design:

1. **Phase 0 — Clear the backlog.** Before doing anything new, check for any articles from a *previous* run that got scraped but never got an AI summary (usually because Groq's rate limit was hit mid-run last time). Try to finish summarizing those first.
2. **Phase 1 — Fetch RSS.** Pull the latest items from all 5 RSS feeds, skipping any article URL we've already seen before (so the same article never gets processed twice).
3. **Phase 2 — Scrape.** For each genuinely new article, fetch its actual webpage and extract the full article text using source-specific rules (different news sites structure their HTML differently, so each source has its own set of CSS selectors to try, with generic fallbacks if those don't match).
4. **Phase 3 — Summarize.** Send the extracted text to Groq, asking for a short summary; then send the title + summary to Groq again, asking for a short search phrase, which is used to build a set of ready-made search links (different link sets depending on whether the article is about cricket, cars, tech, or general news).

Everything — new and old — gets merged together, trimmed to the last 5 days (so old articles eventually roll off), and written back to the single KV blob.

Separately, whenever a visitor loads the website, the Worker's *other* job (unrelated to the hourly schedule) is to instantly read that same KV blob, apply whatever filters the visitor asked for (a specific date, category, source, or keyword search), and hand back the matching articles as JSON — this read is fast and doesn't involve any RSS fetching, scraping, or AI calls at all, since all of that already happened ahead of time on the hourly schedule.

---

## 7. Key Design Decisions and the Reasoning Behind Them

### 7.1 One shared cache, not one cache per visitor

An earlier, simpler idea was: cache articles *in the visitor's own browser* for a day, so reopening the site the same day doesn't refetch anything. We deliberately moved away from this once it became clear the site might occasionally be shown to other people (a portfolio/demo use case) — a shared, server-side cache means the expensive work (scraping, AI calls) happens **once per hour, total**, no matter how many people visit, instead of once per hour *per visitor*. This is both cheaper (far fewer AI API calls) and safer (the AI API key never needs to touch a visitor's browser at all).

### 7.2 Search links are precomputed, not generated on click

In the original design, clicking "search the web" on an article triggered a live AI call at that moment to generate a search query, with a loading spinner while it waited. In this rebuild, that AI call happens once, during the hourly pipeline run, for every article — so by the time a visitor clicks the button, the links are already sitting there, ready instantly. This removed an entire API endpoint and a whole piece of loading-state logic from the frontend.

### 7.3 Articles show up immediately, even before their AI summary is ready

This was a deliberate fix made *after* noticing a real problem: Groq's free tier only allows a limited number of AI requests before temporarily refusing more (a "rate limit," explained in the Glossary). Originally, an article was completely hidden from the website until its AI summary finished — meaning if the rate limit was hit partway through processing 25 new articles, the unfinished ones were invisible, sometimes for over an hour, directly working against the user's whole goal of "I want to see all the news when I open the site." The fix: show every fetched article immediately, using the short RSS description as a stand-in ("Read Preview") until the real AI summary is ready, at which point it upgrades in place on the next hourly run ("Read Summary"). Real news is never hidden waiting on AI processing.

### 7.4 Pacing AI calls to avoid hitting the rate limit early

The original Java backend deliberately waited 2 seconds between each AI call, specifically to spread requests out and avoid triggering the rate limit prematurely. This detail was accidentally dropped during the rewrite, which we only discovered by testing against the live Groq API and watching it get rate-limited after roughly half the expected articles. Adding the same 2-second pacing back (see [Problem 8](#84-forgetting-to-pace-out-ai-requests)) meant each hourly run could get meaningfully further through its work before hitting the same ceiling.

### 7.5 A visible status page

Once the pipeline had several moving, sometimes-invisible parts (a backlog, a rate limit, a schedule), it became clear that "is everything working?" needed to be answerable at a glance rather than by reading server logs. The `/status` page exposes exactly that: how many articles exist, how many have real AI summaries vs. are still waiting (plus the actual titles of the pending ones, not just a count), when the pipeline last ran and whether it hit a rate limit, when it'll run next, and how much of Groq's quota is left (Groq helpfully includes this information in its API response headers, which we started capturing and displaying). It also auto-refreshes and live-ticks its own countdown/timestamps every second, rather than freezing at whatever it looked like the moment the page loaded — an early version didn't do this, and looked broken simply because it never updated itself (see [Problem 8.9](#89-a-background-task-was-silently-getting-killed-and-throwing-away-completed-work)).

### 7.6 Save progress incrementally, not all at once at the end

The pipeline originally only wrote its results to storage once, right at the very end of a run. This turned out to be a real bug, not just a stylistic choice — see [Problem 8.9](#89-a-background-task-was-silently-getting-killed-and-throwing-away-completed-work) for the full story. Now every single article is saved immediately after it's processed, in both the backlog-retry loop and the new-article loop. The cost is more individual write operations (still trivially within the free tier's limits at this project's scale); the benefit is that a run that gets interrupted for any reason keeps whatever work it actually finished, instead of losing everything back to the last checkpoint.

---

## 8. Real Problems We Hit and How We Solved Them

This section is deliberately honest about the messy, real parts of building this — the mistakes and dead ends are often the most useful part for someone learning.

### 8.1 GitHub's web "upload files" button silently drops hidden files

After pushing code the first time (or attempting to — see below), the user instead used GitHub's browser-based drag-and-drop upload feature. This silently skipped every "dotfile" (files starting with a `.`, like `.gitignore` and `.env.example`) because browser folder-upload dialogs commonly hide dotfiles by default, and it also picked up a `dist/` build-output folder that should never be committed at all. **Lesson**: browser-based file uploads and proper `git push` are not equivalent — always prefer the terminal `git` workflow for anything beyond a one-off single file, specifically because of this kind of silent, easy-to-miss data loss.

### 8.2 Vercel's free-tier cron limitation

Early in planning, Vercel was briefly considered for hosting, since it's a very popular, well-known platform. It was ruled out specifically because its free plan restricts scheduled functions to once per day — directly incompatible with the hourly-refresh requirement. **Lesson**: "free tier" doesn't mean equivalent capability across providers — always check the *specific* feature you need against each provider's specific free-tier limits, not just whether a free tier exists at all.

### 8.3 A GitHub Personal Access Token needs an extra scope to touch workflow files

The first attempt to push the GitHub Actions workflow file failed with a permissions error, specifically because GitHub requires the `workflow` scope (separate from the general `repo` scope) before a token is allowed to create or modify anything under `.github/workflows/` — a deliberate safety measure, since workflow files can execute arbitrary code on GitHub's infrastructure. **Lesson**: fine-grained permission scopes exist specifically to limit the blast radius of a leaked or misused credential — a token that can push code shouldn't automatically be able to define what automated jobs run, unless explicitly granted that.

### 8.4 Cloudflare's dashboard configured the frontend as a Worker deploy, not a plain static site

When first connecting the GitHub repo to Cloudflare for hosting, the dashboard's newer unified "Workers & Pages" flow set the project up with a `Deploy command: npx wrangler deploy` — which is meant for deploying actual server-side Worker code, not a plain static React build. The build failed outright, and then partially worked but deployed to the wrong URL, because Cloudflare's platform has been merging its "Pages" product into a more general "deploy anything via Workers" model, including static sites (served via a feature called "Workers Static Assets"). The fix required adding a small `wrangler.toml` file to the frontend project specifically telling it "this is a static site, serve the `dist` folder" via an `[assets]` configuration block. **Lesson**: cloud platforms evolve their UI and underlying models over time, sometimes making older written guides or assumptions (including ones from an AI's training data) outdated — when something doesn't behave as expected, read the actual error output carefully rather than assuming the first mental model was correct.

### 8.5 Environment variables set in the dashboard didn't affect the build

After fixing the above, the live site still didn't work — it turned out to be pointing at `localhost`, which obviously doesn't exist for other visitors. The Cloudflare dashboard has a "Variables and secrets" section that looked like the right place to set the backend's URL, but that section only controls *runtime* variables available to a deployed Worker while it's handling a live request — it has no effect on the separate *build* step (`npm run build`), which is when Vite actually reads environment variables and bakes them permanently into the generated JavaScript file. The reliable fix was committing a `.env.production` file directly into the frontend project, which Vite always reads automatically during any production build, regardless of dashboard configuration. **Lesson**: "environment variable" isn't one single concept — *when* and *where* a variable is read (build time vs. run time, browser vs. server) fundamentally changes what actually happens with it, and mixing these up is one of the most common real-world deployment bugs.

### 8.6 The deployed Worker's name didn't match what was configured

Cloudflare's CI system had already internally associated the project with the name `nexbrief-v2` (based on how it was first created), but the project's own `wrangler.toml` file said `name = "nexbrief-web"` — a mismatch that Cloudflare resolved automatically by overriding to its own expected name and printing a warning, resulting in the live URL being `nexbrief-v2.ameettechademy.workers.dev` rather than what might have been expected from reading the config file alone. Fixed by simply updating the config file to match reality. **Lesson**: when a system has multiple sources of truth for the same setting (a dashboard-side configuration vs. a config file in the repo), always double check which one is actually authoritative, especially after any change — don't assume the file you can see is the only thing in control.

### 8.7 Two real news websites block requests from Cloudflare's network

During testing, ESPNCricinfo and Gadgets360 both returned an outright `403 Forbidden` response specifically when the article-scraping request came from a Cloudflare Worker — even though the exact same URLs loaded completely normally from an ordinary computer's network connection. This is very likely deliberate bot-protection on those sites' end: Cloudflare's own IP address ranges are well-known and heavily used for exactly this kind of automated scraping across the entire internet, so some sites specifically block traffic coming from them. This isn't something fixable by changing request headers or being a "nicer" bot — it's an IP-address-level block. The practical fix: when full-page scraping fails, fall back to summarizing the shorter RSS description instead of giving up on the article entirely. **Lesson**: some problems in distributed systems aren't bugs in your own code at all — they're the deliberate, reasonable defensive behavior of someone else's system, and the right response is a graceful fallback, not endless debugging of your own code looking for a mistake that isn't there.

### 8.8 Forgetting to pace out AI requests

The original Java backend explicitly waited 2 seconds between each AI API call specifically to avoid triggering Groq's rate limit too quickly. This detail didn't make it into the initial TypeScript rewrite. The bug wasn't caught by code review or type-checking — TypeScript happily confirms code is internally consistent, but it has no way of knowing an external service enforces a *timing* rule that the code doesn't respect. It was only caught by actually running the real pipeline against the live Groq API and watching, in real time via live server logs, exactly when and why it got cut off early. **Lesson**: some classes of bugs (timing, rate limits, external service behavior) are invisible to static analysis and type checking entirely — they only show up by actually running the system against the real, live external world and observing what happens, which is why testing against production-like conditions matters even when everything "looks correct" on paper.

### 8.9 A background task was silently getting killed, and throwing away completed work

A batch of articles kept staying "pending" run after run, even though the status page showed Groq still had plenty of quota left (hundreds of requests and thousands of tokens remaining) — which didn't add up. The first instinct was that this had to still be some Groq rate-limit edge case; it wasn't. Watching a real, manually-triggered run through `wrangler tail` (Cloudflare's live log-streaming command) showed exactly what was happening: the pipeline successfully summarized 6 out of 8 pending articles — each one logged as a success — and then this line appeared: `waitUntil() tasks did not complete within the allowed time after invocation end and have been cancelled`.

Here's the mechanism: when the manual "refresh" endpoint is called, the Worker immediately sends back an HTTP response ("refresh started") so the person calling it isn't left waiting, and keeps the actual pipeline running afterward via `ctx.waitUntil(...)` — a Cloudflare API specifically for "keep this work going a bit after the response is sent." But that extension has a limited time budget, and once it runs out, Cloudflare simply cancels whatever's still in progress — no error thrown to catch, no graceful shutdown, it just stops. The pipeline code only saved its results to storage once, at the very end of the entire run — so when it got cancelled partway through, none of that run's 6 successfully-summarized articles were ever written down anywhere. They were correctly summarized, that work genuinely happened and genuinely cost real Groq API quota, and then it was thrown away completely, as if it had never happened. The next run would find the exact same 8 (now sometimes fewer, sometimes the same) articles still pending, with no way to tell from the outside that real work was happening and just quietly evaporating.

The fix: save each article to storage *immediately* after it's processed, not batched up for one save at the end. Now if a run gets cancelled partway through, everything up to that point is already safely stored — worst case, only the one article that was mid-save at the exact moment of cancellation might need redoing, not the entire batch. Verified by deliberately re-running the same scenario and watching the pending count actually drop (8 → 3) instead of staying frozen.

**Lesson**: "the operation finished successfully" and "the result was saved" are two different claims, and code that only makes the second claim true at the very end of a long process is fragile — anything that can interrupt execution partway through (a crash, a timeout, a killed background task, a deployment happening mid-run) turns completed, valid work into work that never happened at all, from the system's point of view. Saving incrementally, as progress is actually made, is a broadly useful pattern for anything long-running and interruptible — not just this specific Cloudflare quirk. It's also a good example of why "the numbers on a dashboard don't add up" is worth actually investigating with real logs rather than guessing at an explanation that merely sounds plausible.

---

## 9. Glossary — Terms Explained Simply

- **API (Application Programming Interface)**: A defined way for one piece of software to ask another piece of software to do something or hand back data — e.g., "give me the current weather" — usually over the internet using HTTP.
- **API key**: A secret password-like string that identifies who's making a request to an API, so the provider knows who to bill or restrict.
- **Background task (`waitUntil`)**: Work a serverless function keeps doing *after* it has already sent back its response, instead of making whoever's waiting sit through the whole thing. Cloudflare Workers offer this via `ctx.waitUntil(...)`, but it comes with a limited extra time budget — if the background work doesn't finish before that runs out, the platform cancels it outright, with no error to catch. See [Problem 8.9](#89-a-background-task-was-silently-getting-killed-and-throwing-away-completed-work).
- **CORS (Cross-Origin Resource Sharing)**: A browser security rule blocking a webpage from freely making requests to a different website's server unless that server explicitly allows it. See [Section 3.1](#31-cors-blocks-a-browser-from-fetching-most-other-websites-data).
- **Cron job / Cron trigger**: A way of scheduling code to run automatically at specific times or intervals, without a person manually starting it.
- **CSS selector**: A pattern used to identify specific elements on a webpage (e.g., "the `<div>` with class `article-body`"), used both for styling and, here, for extracting specific content while scraping.
- **Environment variable**: A named piece of configuration data (like a URL or a secret key) kept separate from the actual code, so the same code can behave differently depending on where it's running (e.g., local testing vs. the live website) without editing the code itself.
- **HTTP / HTTP request**: The standard protocol (set of rules) computers use to talk to each other over the web — every webpage load, API call, and file download is an HTTP request/response underneath.
- **JSON**: A simple, widely-used text format for representing structured data (objects, lists, text, numbers) that's easy for both humans to read and computers to parse — used constantly for API responses.
- **KV store (key-value store)**: A very simple form of data storage — just labeled slots holding data — without the complex querying capabilities of a full database. See [Section 5.2](#52-cloudflare-workers-kv).
- **Rate limit**: A cap an API provider enforces on how many requests you can make in a given time window, to prevent overload/abuse — going over it gets your request rejected until the window resets.
- **RSS feed**: A standardized, machine-readable format websites publish listing their latest content. See [Section 5.14](#514-rss--atom-feeds).
- **Scraping**: Automatically extracting information from a webpage's HTML, as opposed to reading it via an official API.
- **Serverless**: A way of running code where you don't manage an actual server that's always on — code runs on-demand, in response to specific triggers, and you're generally only charged for the time it's actually executing. See [Section 4.1](#41-why-serverless-solves-this-without-breaking-the-free-and-easy-goal).
- **SPA (Single-Page Application)**: A website that loads one HTML page and then uses JavaScript to change what's displayed as the user navigates, rather than requesting a whole new page from the server every time.
- **Static site**: A website made of plain, pre-built files (HTML/CSS/JS) with no server-side code running — extremely cheap and simple to host, but can't do anything requiring secret credentials or scheduled background work on its own.
- **TypeScript type-checking**: The process of verifying, before code ever runs, that the *shapes* of data being passed around match what each piece of code expects.
- **Version control (Git)**: A system for tracking every change made to a project's code over time. See [Section 5.16](#516-git-and-github).

---

## 10. What a Beginner Can Learn From This Project

- **"Can I build X in just React?" is usually really asking "does X need a secret, need to talk to other websites, or need to run on a schedule?"** — if yes to any of those, some form of server-side code is unavoidable, but that doesn't mean you need a traditional expensive always-on server; serverless functions exist specifically for this middle ground.
- **CORS, API key security, and background scheduling are three of the most common reasons a "simple frontend-only" idea turns out to need a backend.** Recognizing these three patterns early saves a lot of wasted effort trying to force a purely client-side solution to work.
- **"Free tier" varies enormously between providers for the exact feature you need** — always check the specific limitation (like Vercel's once-daily cron cap) rather than assuming all free tiers are roughly equivalent.
- **Environment variables aren't one uniform thing** — build-time vs. runtime, and browser vs. server, are different contexts that read configuration differently, and mixing them up is an extremely common real-world bug (see [Problem 8.5](#85-environment-variables-set-in-the-dashboard-didnt-affect-the-build)).
- **Not everything that goes wrong is your bug** — sometimes it's another system's deliberate, reasonable behavior (like a site blocking a known scraping IP range), and the right engineering response is a graceful fallback, not more debugging of code that was never broken.
- **Type-checking and code review can't catch everything** — timing-sensitive behavior and how external services actually behave under load can only be discovered by really running the system and watching it happen, which is why testing against real conditions (even manually, even once) matters.
- **Secrets (API keys, tokens, passwords) should never be pasted into a chat log, committed to a repository, or embedded in frontend code** — they should be entered directly into the tool that needs them (a terminal prompt, a platform's dedicated "secrets" UI), kept out of any place that might be logged, screenshotted, or shared.
- **Automating deployment (so pushing code automatically makes it live) removes an entire category of "I forgot to redeploy" mistakes** — investing a small amount of time in CI/CD (Continuous Integration/Continuous Deployment, i.e. automated build-and-deploy pipelines) pays off very quickly even on a small personal project.
- **"It ran successfully" and "the result was saved" are not the same claim** — any code that does a batch of work and only persists the results at the very end is one crash, timeout, or cancellation away from throwing all of it away, even work that completed correctly. Saving progress incrementally, as it actually happens, is a cheap and broadly useful habit for anything long-running (see [Problem 8.9](#89-a-background-task-was-silently-getting-killed-and-throwing-away-completed-work)).
- **When numbers on a dashboard don't logically add up, that's worth actually investigating with real logs, not explaining away with the first plausible-sounding guess** — the instinct here was "must still be the Groq rate limit," and the real cause turned out to be something else entirely that only became obvious by watching live execution logs.

---

## 11. Quick Reference

- **Live site**: https://nexbrief-v2.ameettechademy.workers.dev
- **Status/health page**: https://nexbrief-v2.ameettechademy.workers.dev/status
- **Backend API**: https://nexbrief-worker.ameettechademy.workers.dev
- **Source code**: https://github.com/yaksha-ameet-khemani/nexbrief-v2
- **Current live status / operational details**: see `STATUS.md` in this same folder — that file is the "what's true right now" document; this file is the "why does it work this way" document.
- **Original plan document (pre-build)**: see `PLAN.md` in this same folder.
