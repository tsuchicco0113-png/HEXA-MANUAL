import { Readability } from "@mozilla/readability";
import type { ExtractedPage } from "./types";

/**
 * ドキュメントサイト特有のノイズ。
 * Readability は記事ページ向けなので、ページ内 TOC や
 * 「前へ / 次へ」ナビは残しがち。明示的に落とす。
 */
const NOISE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "iframe",
  "nav",
  "header",
  "footer",
  "aside",
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  ".pagination-nav", // Docusaurus 前後ナビ
  ".theme-doc-toc-desktop",
  ".theme-doc-toc-mobile",
  ".theme-doc-breadcrumbs",
  ".tableOfContents",
  ".table-of-contents",
  ".VPDocFooter",
  ".VPDocAsideOutline",
  ".md-sidebar",
  ".md-footer",
  ".edit-this-page",
  ".theme-edit-this-page",
  '[class*="feedback" i]',
  '[class*="cookie" i]',
  "#carbonads",
  ".hash-link", // 見出し横の # アンカー
  ".headerlink",
];

/** アンカー付き見出しから hash-link のテキストが混ざるのを防ぐ */
function stripNoise(doc: Document) {
  for (const sel of NOISE_SELECTORS) {
    doc.querySelectorAll(sel).forEach((n) => n.remove());
  }
}

/**
 * DOMParser で解析し、<base> を差し込んで baseURI を確定させる。
 * これをやらないと Readability が相対 URL を解決できず、
 * 画像と内部リンクが全滅する。
 */
function parseWithBase(html: string, url: string): Document {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const head = doc.head ?? doc.documentElement;
  const existing = head.querySelector("base");
  if (existing) existing.remove();
  const base = doc.createElement("base");
  base.setAttribute("href", url);
  head.insertBefore(base, head.firstChild);
  return doc;
}

/** <h1> をページタイトルとして拾い、本文からは取り除く */
function takeTitle(doc: Document, fallback: string): string {
  const h1 = doc.querySelector("article h1, main h1, h1");
  const t = h1?.textContent?.trim();
  if (t) return t;

  const og = doc
    .querySelector('meta[property="og:title"]')
    ?.getAttribute("content")
    ?.trim();
  if (og) return og;

  // "Installation | My Docs" の右側を落とす
  const title = doc.title?.trim() ?? "";
  const cut = title.split(/\s+[|·—–-]\s+/)[0]?.trim();
  return cut || title || fallback;
}

export interface ExtractOptions {
  /** コードハイライトの class を残す。PDF の可読性に直結するので既定 true */
  keepClasses?: boolean;
  charThreshold?: number;
}

/**
 * 1 ページ分の HTML から本文を抽出する。
 * 抽出できなければ null（呼び出し側でスキップ扱い）。
 */
export function extractPage(
  html: string,
  url: string,
  id: string,
  opts: ExtractOptions = {},
): ExtractedPage | null {
  const probe = parseWithBase(html, url);
  const title = takeTitle(probe, url);

  // Readability は doc を破壊するので、抽出用に別インスタンスを作る
  const doc = parseWithBase(html, url);
  stripNoise(doc);

  let article: ReturnType<Readability["parse"]> = null;
  try {
    article = new Readability(doc, {
      keepClasses: opts.keepClasses ?? true,
      charThreshold: opts.charThreshold ?? 200,
      // ドキュメントは <article> や <main> に入っていることが多い
      // Readability の既定スコアリングで概ね当たる
    }).parse();
  } catch {
    article = null;
  }

  let contentHtml = article?.content ?? "";

  // Readability が失敗した場合の保険。main / article を直接使う
  if (!contentHtml || contentHtml.length < 200) {
    const fallbackDoc = parseWithBase(html, url);
    stripNoise(fallbackDoc);
    const main =
      fallbackDoc.querySelector("main article") ??
      fallbackDoc.querySelector("article") ??
      fallbackDoc.querySelector("main") ??
      fallbackDoc.querySelector(".markdown, .theme-doc-markdown, .content");
    contentHtml = main?.innerHTML ?? "";
  }

  if (!contentHtml || contentHtml.trim().length < 80) return null;

  return {
    url,
    id,
    title,
    contentHtml,
    byline: article?.byline ?? undefined,
  };
}
