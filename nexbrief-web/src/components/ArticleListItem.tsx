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
      className="block bg-white hover:bg-[#f5f5f5]/60 transition-colors overflow-hidden"
    >
      {article.thumbnailUrl ? (
        <img src={article.thumbnailUrl} alt={article.title} className="w-full h-44 object-cover" />
      ) : (
        <div className="w-full h-44 bg-[#f5f5f5]" />
      )}
      <div className="p-4 flex flex-col gap-2">
        <span className="inline-block self-start text-[10px] font-bold tracking-wide uppercase text-[#cf412b] bg-[#cf412b]/10 border border-[#cf412b]/30 rounded px-2 py-0.5">
          {CATEGORY_LABELS[article.category] ?? article.category}
        </span>
        <h3 className="text-base text-[#1f1f1f] leading-snug">{article.title}</h3>
        <div className="flex items-center gap-2">
          <p className="text-xs text-[#6d6d6d]">{formatDate(article.publishedAt)}</p>
          {!isAiSummary && (
            <span className="text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
              AI summary pending
            </span>
          )}
        </div>
        {excerpt && <p className="text-sm text-[#3d3d3d] leading-relaxed line-clamp-3">{excerpt}</p>}
      </div>
    </a>
  );
}
