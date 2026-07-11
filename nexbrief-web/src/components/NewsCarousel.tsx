import { useEffect, useRef, useState } from "react";
import type { Article } from "../types/Article";

interface NewsCarouselProps {
  articles: Article[];
}

const VISIBLE = 4;
const ADVANCE_MS = 4000;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export default function NewsCarousel({ articles }: NewsCarouselProps) {
  const [index, setIndex] = useState(0);
  const paused = useRef(false);

  useEffect(() => {
    if (articles.length <= VISIBLE) return;
    const timer = setInterval(() => {
      if (!paused.current) {
        setIndex((i) => (i + 1) % articles.length);
      }
    }, ADVANCE_MS);
    return () => clearInterval(timer);
  }, [articles.length]);

  if (articles.length === 0) return null;

  // Wrap around so there's always VISIBLE cards to show, even near the end.
  const visible = Array.from({ length: Math.min(VISIBLE, articles.length) }, (_, i) => articles[(index + i) % articles.length]);

  return (
    <div className="mb-10">
      <div className="flex items-center gap-3 mb-4">
        <span className="text-xs font-bold uppercase tracking-wide text-white bg-red-600 rounded px-2 py-1">
          Latest
        </span>
        <div className="flex-1 h-px bg-gray-200" />
      </div>

      <div
        className="grid grid-cols-2 lg:grid-cols-4 gap-4"
        onMouseEnter={() => (paused.current = true)}
        onMouseLeave={() => (paused.current = false)}
      >
        {visible.map((a) => (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-white rounded-xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow overflow-hidden"
          >
            {a.thumbnailUrl ? (
              <img src={a.thumbnailUrl} alt={a.title} className="w-full h-28 object-cover" />
            ) : (
              <div className="w-full h-28 bg-gray-100" />
            )}
            <div className="p-3 flex flex-col gap-1">
              <h4 className="text-xs font-semibold text-gray-800 leading-snug line-clamp-2">{a.title}</h4>
              <p className="text-[11px] text-gray-400">{formatDate(a.publishedAt)}</p>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
