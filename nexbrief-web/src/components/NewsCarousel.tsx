import type { Article } from "../types/Article";

interface NewsCarouselProps {
  articles: Article[];
}

// Seconds of animation per card — tuned so the strip reads as a steady
// drift rather than a race, regardless of how many articles feed it.
const SEC_PER_CARD = 5;
const MIN_DURATION = 40;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function Card({ article }: { article: Article }) {
  // Matches ArticleCard's title size (text-sm) — this was previously text-xs,
  // a step smaller than the main grid for no reason other than drift.
  const isHindi = article.language === "hi";

  return (
    <a
      href={article.url}
      target="_blank"
      rel="noopener noreferrer"
      className="w-64 flex-shrink-0 bg-white hover:bg-[#f5f5f5]/60 transition-colors overflow-hidden"
    >
      {article.thumbnailUrl ? (
        <img src={article.thumbnailUrl} alt={article.title} className="w-full h-32 object-cover" />
      ) : (
        <div className="w-full h-32 bg-[#f5f5f5]" />
      )}
      <div className="p-3 flex flex-col gap-1">
        <h4
          className={`${isHindi ? "text-lg" : "text-sm"} text-[#1f1f1f] leading-snug line-clamp-2`}
        >
          {article.title}
        </h4>
        <p className="text-xs text-[#6d6d6d]">{formatDate(article.publishedAt)}</p>
      </div>
    </a>
  );
}

export default function NewsCarousel({ articles }: NewsCarouselProps) {
  if (articles.length === 0) return null;

  // The track renders the article list twice back-to-back and animates a
  // translateX(-50%) loop — since both halves are identical, the seam is
  // invisible and the strip appears to scroll forever.
  const duration = Math.max(articles.length * SEC_PER_CARD, MIN_DURATION);

  return (
    <div className="mb-10">
      <div className="flex items-center gap-3 mb-4">
        <span className="text-xs font-bold uppercase tracking-wide text-white bg-[#cf412b] rounded px-2 py-1">
          Latest
        </span>
        <div className="flex-1 h-px bg-[#eaeaea]" />
      </div>

      <div className="marquee-viewport overflow-hidden">
        <div className="flex gap-4 w-max animate-marquee" style={{ animationDuration: `${duration}s` }}>
          {articles.map((a) => (
            <Card key={`a-${a.id}`} article={a} />
          ))}
          {articles.map((a) => (
            <Card key={`b-${a.id}`} article={a} />
          ))}
        </div>
      </div>
    </div>
  );
}
