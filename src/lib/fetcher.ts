import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

const UA =
  "HexaManual/0.1 (personal archival tool; +https://booth.pm/) ";

export interface FetchResult {
  url: string;
  /** リダイレクト後の最終 URL */
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 直列 + 最小間隔つきの fetch。
 *
 * ドキュメントサイトは個人運営も多いので、並列度は上げない。
 * 直列 300ms で 200 ページ ≒ 1 分。体感で十分速い。
 */
export class Fetcher {
  private tail: Promise<unknown> = Promise.resolve();
  private lastAt = 0;
  private aborted = false;

  constructor(private readonly minIntervalMs = 300) {}

  abort() {
    this.aborted = true;
  }

  private gate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      if (this.aborted) throw new Error("aborted");
      const wait = this.minIntervalMs - (Date.now() - this.lastAt);
      if (wait > 0) await sleep(wait);
      this.lastAt = Date.now();
      return fn();
    });
    // 失敗しても後続を止めない
    this.tail = run.catch(() => undefined);
    return run;
  }

  async get(url: string, accept = "text/html,*/*"): Promise<FetchResult | null> {
    return this.gate(async () => {
      try {
        const res = await tauriFetch(url, {
          method: "GET",
          headers: { "User-Agent": UA, Accept: accept },
          connectTimeout: 15_000,
          redirect: "follow",
        });
        const body = await res.text();
        return {
          url,
          finalUrl: res.url || url,
          status: res.status,
          contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
          body,
        };
      } catch {
        return null;
      }
    });
  }
}

/**
 * SPA 対策。
 *
 * Docusaurus / VitePress / Next.js の多くは存在しないパスにも
 * 200 + index.html を返す。llms.txt / sitemap.xml の存在判定を
 * status だけで行うと、HTML を Markdown として読み込んで破綻する。
 */
export function isPlainText(r: FetchResult): boolean {
  if (r.status !== 200) return false;
  const head = r.body.slice(0, 400).trimStart().toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html")) return false;
  if (r.contentType.includes("text/html")) return false;
  return true;
}

export function isXml(r: FetchResult): boolean {
  if (r.status !== 200) return false;
  const head = r.body.slice(0, 400).trimStart().toLowerCase();
  return head.startsWith("<?xml") || head.startsWith("<urlset") ||
    head.startsWith("<sitemapindex");
}

/** 比較用に URL を正規化する。末尾スラッシュ / .html / hash / query を落とす */
export function normalizeUrl(raw: string, base?: string): string {
  try {
    const u = new URL(raw, base);
    u.hash = "";
    u.search = "";
    let p = u.pathname
      .replace(/\/index\.html?$/i, "/")
      .replace(/\.html?$/i, "");
    if (p.length > 1) p = p.replace(/\/+$/, "");
    u.pathname = p || "/";
    return u.toString();
  } catch {
    return raw;
  }
}

/** entry URL のディレクトリ部分。収集範囲を絞るのに使う */
export function scopePrefix(entryUrl: string): string {
  const u = new URL(entryUrl);
  const p = u.pathname.endsWith("/")
    ? u.pathname
    : u.pathname.replace(/\/[^/]*$/, "/");
  return `${u.origin}${p}`;
}
