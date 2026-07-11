import type { Article } from "../types/Article";
import { CATEGORY_LABELS } from "../types/Article";

interface ArticleListItemProps {
  article: Article;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function ArticleListItem({ article }: ArticleListItemProps) {
  const isAiSummary = article.summary != null;
  const excerpt = article.summary ?? article.description;

  return (
    <a
      href={article.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block bg-white rounded-xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow overflow-hidden"
    >
      {article.thumbnailUrl ? (
        <img src={article.thumbnailUrl} alt={article.title} className="w-full h-44 object-cover" />
      ) : (
        <div className="w-full h-44 bg-gray-100" />
      )}
      <div className="p-4 flex flex-col gap-2">
        <span className="inline-block self-start text-[10px] font-bold tracking-wide uppercase text-red-700 bg-red-50 border border-red-200 rounded px-2 py-0.5">
          {CATEGORY_LABELS[article.category] ?? article.category}
        </span>
        <h3 className="text-base font-bold text-gray-800 leading-snug">{article.title}</h3>
        <div className="flex items-center gap-2">
          <p className="text-xs text-gray-400">{formatDate(article.publishedAt)}</p>
          {!isAiSummary && (
            <span className="text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
              AI summary pending
            </span>
          )}
        </div>
        {excerpt && <p className="text-sm text-gray-600 leading-relaxed line-clamp-3">{excerpt}</p>}
      </div>
    </a>
  );
}
