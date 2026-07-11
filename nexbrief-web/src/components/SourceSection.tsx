import { type Article, SOURCE_LABELS } from "../types/Article";
import ArticleCard from "./ArticleCard";

interface SourceSectionProps {
  source: string;
  articles: Article[];
}

// Homepage teaser only shows the latest 4 — "View All" links to the full
// per-source page for everything else, same as the reference layout.
const TEASER_COUNT = 4;

export default function SourceSection({
  source,
  articles,
}: SourceSectionProps) {
  if (articles.length === 0) return null;
  const teaser = articles.slice(0, TEASER_COUNT);

  return (
    <div className="mb-10">
      {/* Source header */}
      <div className="flex items-center gap-3 mb-4">
        <div className="w-1 h-5 bg-red-600 rounded-full" />
        <h2 className="text-lg font-bold text-gray-800">
          {SOURCE_LABELS[source] ?? source}
        </h2>
        <div className="flex-1 h-px bg-gray-200" />
        <a
          href={`/source/${source}`}
          className="text-sm font-medium text-red-600 hover:underline flex items-center gap-1 flex-shrink-0"
        >
          View All →
        </a>
      </div>

      {/* Articles grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {teaser.map((article) => (
          <ArticleCard key={article.id} article={article} />
        ))}
      </div>
    </div>
  );
}
