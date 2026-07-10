// Ported from ContentExtractorService (NexBrief Spring Boot backend), using
// Cloudflare's native HTMLRewriter instead of Jsoup — same per-source CSS
// selectors and the same generic fallback chain / 200-char threshold.

export const SOURCE_SELECTORS: Record<string, string[]> = {
  espncricinfo: ["div.ci-article__body", "div[class*='article-body']"],
  bhaskar: ["div.article-body", "div[class*='story-content']"],
  autocarindia: ["div.article-body", "div[class*='ArticleBody']"],
  gadgets360: ["div[class*='article__details']", "div[itemprop='articleBody']"],
  bbc: ["article", "div[data-component='text-block']"],
  // BBC Urdu's page template has no <article> tag and no data-component
  // attributes (a different rendering system than BBC's English site) — the
  // article body is just plain <p> tags inside <main>, verified by
  // inspecting a real page's HTML rather than guessing.
  bbcurdu: ["main p"],
};

const FALLBACK_SELECTORS = ["article", "main", "div[class*='content']", "div[class*='body']"];

export const EXTRACTION_FAILED = "EXTRACTION_FAILED";

async function collectText(html: string, selectors: string[]): Promise<string> {
  let text = "";
  let rewriter = new HTMLRewriter();

  for (const selector of selectors) {
    rewriter = rewriter.on(selector, {
      text(chunk) {
        text += chunk.text;
      },
    });
  }

  const transformed = rewriter.transform(new Response(html));
  await transformed.text(); // drain the stream so the handlers actually run
  return text.trim();
}

export async function scrapeArticle(url: string, source: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    if (!res.ok) {
      console.warn(`Scrape: non-OK status ${res.status} for ${url}`);
      return EXTRACTION_FAILED;
    }

    const html = await res.text();

    const selectors = SOURCE_SELECTORS[source];
    if (selectors) {
      const text = await collectText(html, selectors);
      if (text.length > 0) return text;
    }

    for (const fallback of FALLBACK_SELECTORS) {
      const text = await collectText(html, [fallback]);
      if (text.length > 200) return text;
    }

    return EXTRACTION_FAILED;
  } catch (err) {
    console.error(`Scrape failed for ${url}: ${(err as Error).message}`);
    return EXTRACTION_FAILED;
  }
}
