import {
  Fetcher,
  isPlainText,
  isXml,
  normalizeUrl,
  scopePrefix,
} from "./fetcher";
import type { Discovery, PageRef, ProgressFn } from "./types";

export interface DiscoverOptions {
  maxPages?: number;
  /** entry のディレクトリ配下だけに絞る。false ならオリジン全体 */
  scopeToPath?: boolean;
  onProgress?: ProgressFn;
}

/**
 * 4 段フォールバックでページ一覧を得る。
 * 上から順に試し、成立したらそこで打ち切る。
 */
export async function discover(
  entryUrl: string,
  fetcher: Fetcher,
  opts: DiscoverOptions = {},
): Promise<Discovery> {
  const maxPages = opts.maxPages ?? 400;
  const scopeToPath = opts.scopeToPath ?? true;
  const log: string[] = [];
  const origin = new URL(entryUrl).origin;
  const prefix = scopeToPath ? scopePrefix(entryUrl) : origin + "/";

  const note = (m: string) => {
    log.push(m);
    opts.onProgress?.({ phase: "discover", current: 0, total: 0, message: m });
  };

  // --- 1. llms-full.txt --------------------------------------------------
  for (const path of ["/llms-full.txt", "/llms.txt"]) {
    const isFull = path === "/llms-full.txt";
    const r = await fetcher.get(origin + path, "text/plain,text/markdown,*/*");
    if (!r || !isPlainText(r)) {
      note(`${path}: なし`);
      continue;
    }

    if (isFull && r.body.length > 2000) {
      note(`${path}: 検出 (${Math.round(r.body.length / 1024)}KB) — 取得完了`);
      return { source: "llms-full", pages: [], fullMarkdown: r.body, log };
    }

    // llms.txt はリンク集。ここから URL を拾う
    const pages = parseLlmsIndex(r.body, origin, prefix, scopeToPath);
    if (pages.length >= 3) {
      note(`${path}: ${pages.length} 件のリンクを検出`);
      return { source: "llms", pages: pages.slice(0, maxPages), log };
    }
    note(`${path}: リンクが少なすぎるため不採用 (${pages.length})`);
  }

  // --- 2. sitemap.xml ----------------------------------------------------
  const sitemapUrls = await collectSitemap(origin, fetcher, note);
  if (sitemapUrls.length > 0) {
    let urls = sitemapUrls;
    if (scopeToPath) {
      const scoped = urls.filter((u) => u.startsWith(prefix));
      // 絞った結果が極端に減るなら prefix 判定が外れている
      if (scoped.length >= 3) urls = scoped;
      else note("sitemap: パス絞り込みが効かないためオリジン全体を採用");
    }
    urls = dedupe(urls).slice(0, maxPages);

    // sitemap の並びは意味を持たない。サイドバーの並び順で並べ直す
    const ordered = await reorderByNav(entryUrl, urls, fetcher, note);
    note(`sitemap.xml: ${ordered.length} ページを採用`);
    return {
      source: "sitemap",
      pages: ordered.map((url) => ({ url })),
      log,
    };
  }

  // --- 3. ナビゲーションからクロール --------------------------------------
  note("sitemap なし — ナビゲーションからクロールします");
  const crawled = await crawl(entryUrl, prefix, fetcher, maxPages, opts.onProgress);
  note(`クロール完了: ${crawled.length} ページ`);
  return { source: "crawl", pages: crawled.map((url) => ({ url })), log };
}

// ---------------------------------------------------------------------------

/** `- [Title](url): description` 形式の Markdown リンク集を解析 */
function parseLlmsIndex(
  md: string,
  origin: string,
  prefix: string,
  scoped: boolean,
): PageRef[] {
  const out: PageRef[] = [];
  const seen = new Set<string>();
  const re = /\[([^\]]+)\]\(\s*(<?)([^)\s>]+)\2[^)]*\)/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(md)) !== null) {
    const title = m[1].trim();
    let href = m[3].trim();
    if (!href || href.startsWith("#") || href.startsWith("mailto:")) continue;

    let abs: string;
    try {
      abs = new URL(href, origin + "/").toString();
    } catch {
      continue;
    }
    if (!abs.startsWith("http")) continue;
    if (new URL(abs).origin !== origin) continue;
    if (scoped && !normalizeUrl(abs).startsWith(normalizeUrl(prefix))) {
      // llms.txt は docs 以外も混ぜることがあるが、除外しすぎると
      // 取りこぼすのでここは緩く扱い、同一オリジンなら通す
    }

    const key = normalizeUrl(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: abs, title });
  }
  return out;
}

/** sitemap.xml（sitemapindex の再帰含む）から URL を集める */
async function collectSitemap(
  origin: string,
  fetcher: Fetcher,
  note: (m: string) => void,
): Promise<string[]> {
  const candidates = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap-index.xml`,
  ];

  for (const c of candidates) {
    const urls = await readSitemap(c, fetcher, 0);
    if (urls.length > 0) return urls;
  }

  // robots.txt の Sitemap: ディレクティブを最後に見る
  const robots = await fetcher.get(`${origin}/robots.txt`, "text/plain");
  if (robots && isPlainText(robots)) {
    const found = [...robots.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map(
      (m) => m[1],
    );
    for (const s of found) {
      const urls = await readSitemap(s, fetcher, 0);
      if (urls.length > 0) {
        note(`robots.txt から sitemap を発見: ${s}`);
        return urls;
      }
    }
  }
  return [];
}

async function readSitemap(
  url: string,
  fetcher: Fetcher,
  depth: number,
): Promise<string[]> {
  if (depth > 2) return [];
  const r = await fetcher.get(url, "application/xml,text/xml,*/*");
  if (!r || !isXml(r)) return [];

  const doc = new DOMParser().parseFromString(r.body, "application/xml");
  if (doc.querySelector("parsererror")) return [];

  // sitemapindex なら子を辿る（子は最大 5 本まで）
  const children = [...doc.querySelectorAll("sitemapindex > sitemap > loc")]
    .map((n) => n.textContent?.trim() ?? "")
    .filter(Boolean)
    .slice(0, 5);

  if (children.length > 0) {
    const all: string[] = [];
    for (const c of children) all.push(...(await readSitemap(c, fetcher, depth + 1)));
    return all;
  }

  return [...doc.querySelectorAll("urlset > url > loc")]
    .map((n) => n.textContent?.trim() ?? "")
    .filter((u) => u.startsWith("http"));
}

/**
 * sitemap は並び順に意味がない（多くはアルファベット順）。
 * エントリページのサイドバー DOM 順を「正しい章立て」とみなして並べ替え、
 * サイドバーに出てこないページは末尾に回す。
 *
 * ここが PDF の読みやすさを一番左右する。
 */
async function reorderByNav(
  entryUrl: string,
  urls: string[],
  fetcher: Fetcher,
  note: (m: string) => void,
): Promise<string[]> {
  const r = await fetcher.get(entryUrl);
  if (!r || r.status !== 200) return urls;

  const order = extractNavOrder(r.body, r.finalUrl);
  if (order.length < 3) {
    note("サイドバーを検出できず — sitemap の順序をそのまま使用");
    return urls;
  }

  const rank = new Map<string, number>();
  order.forEach((u, i) => {
    const k = normalizeUrl(u);
    if (!rank.has(k)) rank.set(k, i);
  });

  const listed: string[] = [];
  const unlisted: string[] = [];
  for (const u of urls) {
    (rank.has(normalizeUrl(u)) ? listed : unlisted).push(u);
  }
  listed.sort(
    (a, b) => rank.get(normalizeUrl(a))! - rank.get(normalizeUrl(b))!,
  );
  unlisted.sort();

  note(
    `サイドバー順で並べ替え: ${listed.length} 件が一致 / ${unlisted.length} 件は末尾`,
  );
  return [...listed, ...unlisted];
}

const NAV_SELECTORS = [
  ".theme-doc-sidebar-container a[href]", // Docusaurus
  ".VPSidebar a[href]", // VitePress
  ".md-nav--primary a[href]", // MkDocs Material
  ".sidebar a[href]",
  "aside a[href]",
  'nav[aria-label*="ocs" i] a[href]',
  '[role="navigation"] a[href]',
  "nav a[href]",
];

/** サイドバーのリンクを DOM 順に取得する */
export function extractNavOrder(html: string, baseUrl: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const sel of NAV_SELECTORS) {
    const nodes = [...doc.querySelectorAll<HTMLAnchorElement>(sel)];
    if (nodes.length < 3) continue;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const a of nodes) {
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#")) continue;
      let abs: string;
      try {
        abs = new URL(href, baseUrl).toString();
      } catch {
        continue;
      }
      const k = normalizeUrl(abs);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(abs);
    }
    if (out.length >= 3) return out;
  }
  return [];
}

/** 幅優先クロール。同一オリジン + prefix 配下のみ */
async function crawl(
  entryUrl: string,
  prefix: string,
  fetcher: Fetcher,
  maxPages: number,
  onProgress?: ProgressFn,
): Promise<string[]> {
  const origin = new URL(entryUrl).origin;
  const normPrefix = normalizeUrl(prefix);
  const seen = new Set<string>([normalizeUrl(entryUrl)]);
  const queue = [entryUrl];
  const out: string[] = [];

  while (queue.length > 0 && out.length < maxPages) {
    const url = queue.shift()!;
    const r = await fetcher.get(url);
    if (!r || r.status !== 200 || !r.contentType.includes("html")) continue;

    out.push(url);
    onProgress?.({
      phase: "discover",
      current: out.length,
      total: maxPages,
      message: `クロール中: ${url}`,
    });

    for (const href of extractNavOrder(r.body, r.finalUrl)) {
      const k = normalizeUrl(href);
      if (seen.has(k)) continue;
      if (new URL(href).origin !== origin) continue;
      if (!k.startsWith(normPrefix)) continue;
      if (/\.(pdf|zip|png|jpe?g|svg|gif|webp|mp4|json|xml)$/i.test(k)) continue;
      seen.add(k);
      queue.push(href);
    }
  }
  return out;
}

function dedupe(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const k = normalizeUrl(u);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}
