import { type Article, SOURCE_LABELS } from "../types/Article";
import ArticleCard from "./ArticleCard";

interface SourceSectionProps {
  source: string;
  articles: Article[];
}

export default function SourceSection({
  source,
  articles,
}: SourceSectionProps) {
  if (articles.length === 0) return null;

  return (
    <div className="mb-10">
      {/* Source header */}
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-bold text-gray-800">
          {SOURCE_LABELS[source] ?? source}
        </h2>
        <div className="flex-1 h-px bg-gray-200" />
      </div>

      {/* Articles grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {articles.map((article) => (
          <ArticleCard key={article.id} article={article} />
        ))}
      </div>
    </div>
  );
}
