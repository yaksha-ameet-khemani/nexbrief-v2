import type { Article } from "../types/Article";
import { CATEGORY_LABELS } from "../types/Article";

interface HeroProps {
  articles: Article[];
}

// Picks the single most recent article from each of the 3 categories that
// currently have the freshest news, so the hero always shows a mix of
// topics rather than e.g. 3 cricket articles back to back just because
// cricket happened to have a busy hour.
export function pickHeroArticles(articles: Article[]): Article[] {
  const mostRecentByCategory = new Map<string, Article>();
  for (const a of articles) {
    const current = mostRecentByCategory.get(a.category);
    if (!current || new Date(a.publishedAt).getTime() > new Date(current.publishedAt).getTime()) {
      mostRecentByCategory.set(a.category, a);
    }
  }
  return [...mostRecentByCategory.values()]
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, 3);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function CategoryBadge({ category }: { category: string }) {
  return (
    <span className="inline-block text-[10px] font-bold tracking-wide uppercase text-red-700 bg-red-50 border border-red-200 rounded px-2 py-0.5">
      {CATEGORY_LABELS[category] ?? category}
    </span>
  );
}

export default function Hero({ articles }: HeroProps) {
  const [main, ...rest] = pickHeroArticles(articles);
  if (!main) return null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-10">
      {/* Large featured story */}
      <a
        href={main.url}
        target="_blank"
        rel="noopener noreferrer"
        className="relative rounded-xl overflow-hidden bg-gray-900 group h-72 lg:h-full min-h-[22rem] block"
      >
        {main.thumbnailUrl && (
          <img
            src={main.thumbnailUrl}
            alt={main.title}
            className="absolute inset-0 w-full h-full object-cover opacity-80 group-hover:opacity-90 transition-opacity"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 p-6 flex flex-col gap-2">
          <CategoryBadge category={main.category} />
          <h2 className="text-white text-xl lg:text-2xl font-bold leading-snug">{main.title}</h2>
          <p className="text-gray-300 text-xs">{formatDate(main.publishedAt)}</p>
        </div>
      </a>

      {/* Two smaller stories stacked */}
      <div className="grid grid-rows-2 gap-4">
        {rest.map((a) => (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex gap-4 bg-white rounded-xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow overflow-hidden p-3"
          >
            {a.thumbnailUrl ? (
              <img
                src={a.thumbnailUrl}
                alt={a.title}
                className="w-32 h-full min-h-[7rem] object-cover rounded-lg flex-shrink-0"
              />
            ) : (
              <div className="w-32 min-h-[7rem] bg-gray-100 rounded-lg flex-shrink-0" />
            )}
            <div className="flex flex-col gap-2 justify-center">
              <CategoryBadge category={a.category} />
              <h3 className="text-sm font-bold text-gray-800 leading-snug line-clamp-2">{a.title}</h3>
              <p className="text-xs text-gray-400">{formatDate(a.publishedAt)}</p>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
