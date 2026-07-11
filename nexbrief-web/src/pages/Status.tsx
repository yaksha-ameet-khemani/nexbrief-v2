import { useEffect, useState, useCallback, useRef } from "react";
import { fetchStatus } from "../api/articleApi";
import type { StatusResponse } from "../types/Status";
import { SOURCE_LABELS } from "../types/Article";

const AUTO_REFRESH_MS = 30_000;

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function minutesUntil(iso: string, now: number): string {
  const diffMs = new Date(iso).getTime() - now;
  const mins = Math.max(0, Math.round(diffMs / 60000));
  if (mins === 0) return "any moment now";
  if (mins === 1) return "in 1 minute";
  return `in ${mins} minutes`;
}

function secondsAgo(then: number, now: number): string {
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 5) return "just now";
  return `${secs}s ago`;
}

function StatCard({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 flex flex-col gap-1">
      <span className="text-xs text-gray-400">{label}</span>
      <span className={`text-2xl font-bold ${tone ?? "text-gray-800"}`}>{value}</span>
    </div>
  );
}

export default function Status() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return; // avoid overlapping fetches if one is slow
    loadingRef.current = true;
    setLoading(true);
    setError("");
    try {
      setStatus(await fetchStatus());
      setLastFetchedAt(Date.now());
    } catch {
      setError("Failed to load status. Is the backend running?");
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, []);

  // Initial load, then auto-refresh the actual data every 30s.
  useEffect(() => {
    load();
    const interval = setInterval(load, AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [load]);

  // Separate 1s clock so "next run in X minutes" and "updated Xs ago" tick
  // live between data refreshes, instead of freezing at whenever this page
  // happened to last fetch.
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, []);

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-[#fffefa] text-[#1f1f1f] px-6 py-4 sticky top-0 z-50 border-b border-[#eaeaea]">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <a href="/" className="text-2xl tracking-tight text-[#1f1f1f]">
            Nex<span className="text-[#cf412b]">Brief</span>{" "}
            <span className="text-[#6d6d6d] text-lg font-normal">/ Status</span>
          </a>
          <div className="flex items-center gap-3">
            {lastFetchedAt && (
              <span className="text-xs text-[#6d6d6d]">
                {loading ? "Refreshing…" : `Updated ${secondsAgo(lastFetchedAt, now)}`}
              </span>
            )}
            <button
              onClick={load}
              className="text-sm px-4 py-1.5 rounded-full bg-[#f5f5f5] text-[#3d3d3d] hover:bg-[#eaeaea] transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-4xl mx-auto px-4 py-8 flex flex-col gap-6">
        {loading && !status && (
          <p className="text-center text-gray-400 py-20">Loading status...</p>
        )}
        {error && <p className="text-center text-red-400 py-20">{error}</p>}

        {status && (
          <>
            <p className="text-xs text-gray-400 text-center">
              Auto-refreshes every 30 seconds — no need to reload the page.
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <StatCard label="Total articles" value={status.totalArticles} />
              <StatCard label="Summarized" value={status.summarized} tone="text-green-600" />
              <StatCard
                label="Pending AI summary"
                value={status.pending}
                tone={status.pending > 0 ? "text-amber-600" : "text-gray-800"}
              />
              <StatCard
                label="Last run"
                value={status.lastRunRateLimited ? "Rate-limited" : "Clear"}
                tone={status.lastRunRateLimited ? "text-amber-600" : "text-green-600"}
              />
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 flex flex-col gap-3">
              <h2 className="text-sm font-bold text-gray-800">Pipeline schedule</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-gray-400">Last run: </span>
                  <span className="text-gray-700">{formatDateTime(status.lastRunAt)}</span>
                </div>
                <div>
                  <span className="text-gray-400">Next run: </span>
                  <span className="text-gray-700">
                    {formatDateTime(status.nextRunAt)} ({minutesUntil(status.nextRunAt, now)})
                  </span>
                </div>
                <div>
                  <span className="text-gray-400">New articles found last run: </span>
                  <span className="text-gray-700">{status.lastRunNewArticles ?? "—"}</span>
                </div>
                <div>
                  <span className="text-gray-400">Backlog cleared last run: </span>
                  <span className="text-gray-700">{status.lastRunBacklogCleared ?? "—"}</span>
                </div>
              </div>
              <p className="text-xs text-gray-400">
                Times shown in your local timezone — the pipeline runs on the hour in UTC, which
                may not land on a round hour for you.
              </p>
              {status.lastRunRateLimited && (
                <p className="text-xs text-amber-600 bg-amber-50 rounded-lg p-3">
                  Groq's free-tier rate limit was hit during the last run — any articles still
                  pending a summary will be picked up automatically on the next hourly run.
                </p>
              )}
            </div>

            {status.pendingArticles.length > 0 && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 flex flex-col gap-3">
                <h2 className="text-sm font-bold text-gray-800">
                  Pending AI summary ({status.pendingArticles.length})
                </h2>
                <p className="text-xs text-gray-400 -mt-2">
                  These are already live on the site, showing their RSS preview — the AI summary
                  will replace it automatically once Groq catches up.
                </p>
                <ul className="flex flex-col divide-y divide-gray-50">
                  {status.pendingArticles.map((a) => (
                    <li key={a.url} className="py-2 flex items-center justify-between gap-3 text-sm">
                      <a
                        href={a.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-gray-700 hover:text-blue-500 hover:underline line-clamp-1"
                      >
                        {a.title}
                      </a>
                      <span className="text-xs text-amber-600 bg-amber-50 rounded-full px-2 py-0.5 shrink-0">
                        {SOURCE_LABELS[a.source] ?? a.source}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {status.groqRateLimit && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 flex flex-col gap-3">
                <h2 className="text-sm font-bold text-gray-800">Groq quota (as of last call)</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-gray-400">Requests remaining: </span>
                    <span className="text-gray-700">
                      {status.groqRateLimit.remainingRequests ?? "—"} /{" "}
                      {status.groqRateLimit.limitRequests ?? "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-400">Requests reset: </span>
                    <span className="text-gray-700">{status.groqRateLimit.resetRequests ?? "—"}</span>
                  </div>
                  <div>
                    <span className="text-gray-400">Tokens remaining: </span>
                    <span className="text-gray-700">
                      {status.groqRateLimit.remainingTokens ?? "—"} /{" "}
                      {status.groqRateLimit.limitTokens ?? "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-400">Tokens reset: </span>
                    <span className="text-gray-700">{status.groqRateLimit.resetTokens ?? "—"}</span>
                  </div>
                </div>
                <p className="text-xs text-gray-400">
                  Captured {formatDateTime(status.groqRateLimit.capturedAt)}
                </p>
              </div>
            )}

            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <h2 className="text-sm font-bold text-gray-800 mb-3">By source</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="text-gray-400 border-b border-gray-100">
                      <th className="py-2 pr-4 font-medium">Source</th>
                      <th className="py-2 pr-4 font-medium">Total</th>
                      <th className="py-2 pr-4 font-medium">Summarized</th>
                      <th className="py-2 pr-4 font-medium">Pending</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(status.bySource).map(([source, stats]) => (
                      <tr key={source} className="border-b border-gray-50 last:border-0">
                        <td className="py-2 pr-4 text-gray-700">{SOURCE_LABELS[source] ?? source}</td>
                        <td className="py-2 pr-4 text-gray-700">{stats.total}</td>
                        <td className="py-2 pr-4 text-green-600">{stats.summarized}</td>
                        <td className="py-2 pr-4 text-amber-600">{stats.pending}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="text-xs text-gray-400 text-center">
              Server time: {formatDateTime(status.serverTime)}
            </p>
          </>
        )}
      </main>
    </div>
  );
}
