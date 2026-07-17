// Per-run, per-source cap on how many new RSS items to fetch. Also doubles
// as the ceiling for each source's proportional fetch throttle in index.ts
// (a source's actual per-run budget shrinks by however many articles it
// already has pending, reaching zero once pending is at or past this cap)
// and the "auto-paused" display cutoff in api.ts. Shared here so fetching,
// throttling, and status-reporting can't drift out of sync.
export const MAX_ARTICLES_PER_SOURCE = 5;
