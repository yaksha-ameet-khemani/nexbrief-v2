import { useEffect, useState, useCallback } from "react";
import type { Article } from "../types/Article";
import { fetchArticles } from "../api/articleApi";
import Navbar from "../components/Navbar";
import SourceSection from "../components/SourceSection";
import ArticleCard from "../components/ArticleCard";

const SOURCES = ["espncricinfo", "bhaskar", "autocarindia", "gadgets360", "bbc"];

export default function Home() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [keyword, setKeyword] = useState("");
  const [selectedCategory, setCategory] = useState("");
  // Empty by default = show everything currently cached (the KV store only
  // ever retains ~5 days anyway), not just today. The date picker is an
  // opt-in filter, not a default constraint.
  const [selectedDate, setDate] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadArticles = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchArticles({
        keyword: keyword || undefined,
        category: selectedCategory || undefined,
        date: selectedDate || undefined,
        size: 300,
      });
      setArticles(data.content);
    } catch {
      setError("Failed to load articles. Is the backend running?");
    } finally {
      setLoading(false);
    }
  }, [keyword, selectedCategory, selectedDate]);

  useEffect(() => {
    const timer = setTimeout(() => loadArticles(), 500);
    return () => clearTimeout(timer);
  }, [loadArticles]);

  const grouped = SOURCES.reduce<Record<string, Article[]>>((acc, source) => {
    acc[source] = articles.filter((a) => a.source === source);
    return acc;
  }, {});

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar
        keyword={keyword}
        onKeywordChange={setKeyword}
        selectedCategory={selectedCategory}
        onCategoryChange={setCategory}
        selectedDate={selectedDate}
        onDateChange={setDate}
      />

      <main className="max-w-7xl mx-auto px-4 py-8">
        {loading && (
          <p className="text-center text-gray-400 py-20">Loading articles...</p>
        )}
        {error && <p className="text-center text-red-400 py-20">{error}</p>}
        {!loading && !error && articles.length === 0 && (
          <p className="text-center text-gray-400 py-20">
            {selectedDate ? "No articles found for this date." : "No articles found."}
          </p>
        )}
        {!loading &&
          !error &&
          (keyword || selectedCategory ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {articles.map((a) => (
                <ArticleCard key={a.id} article={a} />
              ))}
            </div>
          ) : (
            SOURCES.map((source) => (
              <SourceSection
                key={source}
                source={source}
                articles={grouped[source]}
              />
            ))
          ))}
      </main>
    </div>
  );
}
