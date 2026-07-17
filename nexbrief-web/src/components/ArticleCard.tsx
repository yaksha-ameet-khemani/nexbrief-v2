import { useState } from "react";
import type { Article } from "../types/Article";

interface ArticleCardProps {
  article: Article;
}

export default function ArticleCard({ article }: ArticleCardProps) {
  const [showSummary, setShowSummary] = useState(false);
  const [showLinks, setShowLinks] = useState(false);

  const formattedDate = new Date(article.publishedAt).toLocaleDateString(
    "en-IN",
    {
      day: "numeric",
      month: "short",
      year: "numeric",
    },
  );

  // AI summary isn't always ready yet (Groq's free-tier rate limit means it
  // can lag an hour or two behind) — fall back to the RSS description so the
  // article still shows up instead of being hidden until it's polished.
  const isAiSummary = article.summary != null;
  const summaryText = article.summary ?? article.description;
  // Devanagari reads smaller than Latin script at the same pixel size, so
  // Hindi articles (bhaskar) get a 2-step bump on the Tailwind text scale.
  const isHindi = article.language === "hi";

  return (
    <div className="bg-white hover:bg-[#f5f5f5]/60 transition-colors overflow-hidden">
      {/* Thumbnail */}
      {article.thumbnailUrl ? (
        <img
          src={article.thumbnailUrl}
          alt={article.title}
          className="w-full h-44 object-cover"
          onError={(e) => (e.currentTarget.style.display = "none")}
        />
      ) : (
        <div className="w-full h-44 bg-[#f5f5f5] flex items-center justify-center text-[#6d6d6d] text-sm">
          No Image
        </div>
      )}

      {/* Content */}
      <div className="p-4 flex flex-col gap-3">
        {/* Title */}
        <h3
          className={`${isHindi ? "text-lg" : "text-sm"} text-[#1f1f1f] leading-snug line-clamp-2`}
        >
          {article.title}
        </h3>

        {/* Date + pending badges — visible at a glance, no click needed */}
        <div className="flex items-center gap-2">
          <p className="text-xs text-[#6d6d6d]">{formattedDate}</p>
          {!isAiSummary && (
            <span className="text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
              AI summary pending
            </span>
          )}
        </div>

        {/* Summary accordion — real AI summary if ready, RSS description otherwise */}
        {summaryText && (
          <div>
            <button
              onClick={() => setShowSummary(!showSummary)}
              className="text-xs text-blue-500 font-medium hover:underline"
            >
              {showSummary
                ? "Hide Summary ▲"
                : isAiSummary
                  ? "Read Summary ▼"
                  : "Read Preview ▼"}
            </button>
            {showSummary && (
              <div
                className={`mt-2 ${isHindi ? "text-base" : "text-xs"} text-[#3d3d3d] leading-relaxed bg-blue-50 rounded-lg p-3`}
              >
                {!isAiSummary && (
                  <p className="text-blue-400 italic mb-1">
                    AI summary pending — showing quick preview
                  </p>
                )}
                <p>{summaryText}</p>
              </div>
            )}
          </div>
        )}

        {/* Search Web — links are precomputed server-side, so this is instant */}
        {article.links && Object.keys(article.links).length > 0 && (
          <div>
            <button
              onClick={() => setShowLinks(!showLinks)}
              className="text-xs text-purple-500 font-medium hover:underline text-left"
            >
              {showLinks ? "Hide Search Links ▲" : "Search Web ▼"}
            </button>
            {showLinks && (
              <div className="flex flex-col gap-1 mt-2">
                {article.searchQuery && (
                  <p className="text-xs text-[#6d6d6d] italic mb-1">
                    "{article.searchQuery}"
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {Object.entries(article.links).map(([label, url]) => (
                    <a
                      key={label}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs px-2 py-1 rounded-full bg-[#f5f5f5] text-[#3d3d3d] hover:bg-purple-100 hover:text-purple-700 transition-colors"
                    >
                      {label}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Read full article */}
        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-center bg-[#1f1f1f] text-white rounded-lg py-2 hover:bg-[#3d3d3d] transition-colors"
        >
          Read Full Article →
        </a>
      </div>
    </div>
  );
}
