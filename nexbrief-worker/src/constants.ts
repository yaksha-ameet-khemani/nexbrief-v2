// A source stops having new articles fetched for it once its own pending
// (unsummarized) backlog exceeds this count — Phase 0 keeps clearing that
// source's backlog as normal, so fetching resumes automatically once it
// drops back to the threshold. Prevents any one source's backlog from
// growing unbounded when Groq's small per-minute token budget can't keep up
// with combined new-article inflow across all sources. Shared between the
// pipeline (index.ts, to decide what to skip) and the status API (api.ts,
// to report it) so the two can't drift out of sync.
export const AUTO_PAUSE_PENDING_THRESHOLD = 5;
