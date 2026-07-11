import { useEffect, useState, useCallback } from "react";
import type { Article } from "../types/Article";
import { fetchArticles } from "../api/articleApi";
import Navbar from "../components/Navbar";
import ArticleCard from "../components/ArticleCard";
import Hero, { pickHeroArticles } from "../components/Hero";
import NewsCarousel from "../components/NewsCarousel";

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

  const isBrowsing = !keyword && !selectedCategory;
  const heroIds = new Set(isBrowsing ? pickHeroArticles(articles).map((a) => a.id) : []);
  const remaining = articles.filter((a) => !heroIds.has(a.id));
  const feedArticles = [...remaining].sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );

  return (
    <div className="min-h-screen bg-[#fffefa]">
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
          <p className="text-center text-[#6d6d6d] py-20">Loading articles...</p>
        )}
        {error && <p className="text-center text-red-400 py-20">{error}</p>}
        {!loading && !error && articles.length === 0 && (
          <p className="text-center text-[#6d6d6d] py-20">
            {selectedDate ? "No articles found for this date." : "No articles found."}
          </p>
        )}
        {!loading &&
          !error &&
          (!isBrowsing ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {articles.map((a) => (
                <ArticleCard key={a.id} article={a} />
              ))}
            </div>
          ) : (
            <>
              <Hero articles={articles} />
              <NewsCarousel articles={remaining} />
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {feedArticles.map((a) => (
                  <ArticleCard key={a.id} article={a} />
                ))}
              </div>
            </>
          ))}
      </main>
    </div>
  );
}
