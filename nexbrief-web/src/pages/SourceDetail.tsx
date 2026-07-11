import { useEffect, useState } from "react";
import type { Article } from "../types/Article";
import { SOURCE_LABELS } from "../types/Article";
import { fetchArticles } from "../api/articleApi";
import ArticleListItem from "../components/ArticleListItem";

interface SourceDetailProps {
  source: string;
}

export default function SourceDetail({ source }: SourceDetailProps) {
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    fetchArticles({ source, size: 100 })
      .then((data) => setArticles(data.content))
      .catch(() => setError("Failed to load articles. Is the backend running?"))
      .finally(() => setLoading(false));
  }, [source]);

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-gray-900 text-white px-6 py-4 sticky top-0 z-50 shadow-lg">
        <div className="max-w-7xl mx-auto flex items-center gap-3">
          <a href="/" className="text-2xl font-bold tracking-tight text-white">
            Nex<span className="text-blue-400">Brief</span>
          </a>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-1 h-7 bg-red-600 rounded-full" />
          <h1 className="text-2xl font-bold text-gray-800">{SOURCE_LABELS[source] ?? source}</h1>
          <div className="flex-1 h-px bg-gray-200" />
          <a href="/" className="text-sm font-medium text-red-600 hover:underline flex-shrink-0">
            ← Back to Home
          </a>
        </div>

        {loading && <p className="text-center text-gray-400 py-20">Loading articles...</p>}
        {error && <p className="text-center text-red-400 py-20">{error}</p>}
        {!loading && !error && articles.length === 0 && (
          <p className="text-center text-gray-400 py-20">No articles found for this source.</p>
        )}
        {!loading && !error && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {articles.map((a) => (
              <ArticleListItem key={a.id} article={a} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
