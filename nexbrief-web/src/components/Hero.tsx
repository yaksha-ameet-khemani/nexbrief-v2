import type { Article } from "../types/Article";
import { CATEGORY_LABELS } from "../types/Article";

interface HeroProps {
  articles: Article[];
}

// Picks the single most recent article from each of the 3 sources that
// currently have the freshest news, so the hero always shows a mix of
// outlets rather than e.g. 3 BBC articles back to back just because BBC
// happened to have a busy hour.
export function pickHeroArticles(articles: Article[]): Article[] {
  const mostRecentBySource = new Map<string, Article>();
  for (const a of articles) {
    const current = mostRecentBySource.get(a.source);
    if (!current || new Date(a.publishedAt).getTime() > new Date(current.publishedAt).getTime()) {
      mostRecentBySource.set(a.source, a);
    }
  }
  return [...mostRecentBySource.values()]
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
    <span className="inline-block text-[10px] font-bold tracking-wide uppercase text-[#cf412b] bg-[#cf412b]/10 border border-[#cf412b]/30 rounded px-2 py-0.5">
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
        className="relative overflow-hidden bg-[#1f1f1f] group h-72 lg:h-full min-h-[22rem] block"
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
          <h2 className="text-white text-xl lg:text-2xl leading-snug">{main.title}</h2>
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
            className="flex gap-4 bg-white hover:bg-[#f5f5f5]/60 transition-colors overflow-hidden p-3"
          >
            {a.thumbnailUrl ? (
              <img
                src={a.thumbnailUrl}
                alt={a.title}
                className="w-32 h-full min-h-[7rem] object-cover flex-shrink-0"
              />
            ) : (
              <div className="w-32 min-h-[7rem] bg-[#f5f5f5] flex-shrink-0" />
            )}
            <div className="flex flex-col gap-2 justify-center">
              <CategoryBadge category={a.category} />
              <h3 className="text-sm text-[#1f1f1f] leading-snug line-clamp-2">{a.title}</h3>
              <p className="text-xs text-[#6d6d6d]">{formatDate(a.publishedAt)}</p>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
