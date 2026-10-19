import { marked } from "marked";
import { Fetcher } from "./fetcher";
import { discover } from "./discover";
import { extractPage } from "./extract";
import { buildDocument } from "./build";
import type { ExtractedPage, ProgressFn } from "./types";

export interface RunOptions {
  maxPages?: number;
  minIntervalMs?: number;
  scopeToPath?: boolean;
  docTitle?: string;
  onProgress?: ProgressFn;
}

export interface RunResult {
  html: string;
  source: string;
  pageCount: number;
  skipped: string[];
  log: string[];
}

export async function run(
  entryUrl: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  const fetcher = new Fetcher(opts.minIntervalMs ?? 300);
  const progress = opts.onProgress;

  const found = await discover(entryUrl, fetcher, {
    maxPages: opts.maxPages ?? 400,
    scopeToPath: opts.scopeToPath ?? true,
    onProgress: progress,
  });

  const docTitle = opts.docTitle ?? new URL(entryUrl).hostname;

  // --- llms-full.txt が引けた場合: fetch も抽出も不要 --------------------
  if (found.source === "llms-full" && found.fullMarkdown) {
    const pages = markdownToPages(found.fullMarkdown, entryUrl);
    progress?.({
      phase: "build",
      current: pages.length,
      total: pages.length,
      message: "llms-full.txt から生成中",
    });
    return {
      html: buildDocument(pages, { docTitle, sourceUrl: entryUrl }),
      source: found.source,
      pageCount: pages.length,
      skipped: [],
      log: found.log,
    };
  }

  // --- 通常経路: 取得 → 抽出 --------------------------------------------
  const extracted: ExtractedPage[] = [];
  const skipped: string[] = [];
  const total = found.pages.length;

  for (let i = 0; i < total; i++) {
    const ref = found.pages[i];
    progress?.({
      phase: "fetch",
      current: i + 1,
      total,
      message: ref.title ?? ref.url,
    });

    const res = await fetcher.get(ref.url);
    if (!res || res.status !== 200) {
      skipped.push(`${ref.url} (取得失敗)`);
      continue;
    }

    const page = extractPage(res.body, res.finalUrl, `p${extracted.length + 1}`);
    if (!page) {
      skipped.push(`${ref.url} (本文抽出できず)`);
      continue;
    }
    if (ref.title && !page.title) page.title = ref.title;
    extracted.push(page);
  }

  progress?.({
    phase: "build",
    current: extracted.length,
    total: extracted.length,
    message: "連結 HTML を生成中",
  });

  return {
    html: buildDocument(extracted, { docTitle, sourceUrl: entryUrl }),
    source: found.source,
    pageCount: extracted.length,
    skipped,
    log: found.log,
  };
}

/**
 * llms-full.txt は全文が 1 本の Markdown。
 * トップレベル見出し（`# `）で章に割り、それぞれを 1 ページとして扱う。
 */
function markdownToPages(md: string, sourceUrl: string): ExtractedPage[] {
  const chunks: { title: string; body: string }[] = [];
  const lines = md.split(/\r?\n/);
  let current: { title: string; body: string[] } | null = null;
  let inFence = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;

    const h1 = !inFence && /^#\s+(.+)$/.exec(line);
    if (h1) {
      if (current) chunks.push({ title: current.title, body: current.body.join("\n") });
      current = { title: h1[1].trim(), body: [] };
      continue;
    }
    if (!current) current = { title: "はじめに", body: [] };
    current.body.push(line);
  }
  if (current) chunks.push({ title: current.title, body: current.body.join("\n") });

  return chunks
    .filter((c) => c.body.trim().length > 40)
    .map((c, i) => ({
      url: sourceUrl,
      id: `p${i + 1}`,
      title: c.title,
      contentHtml: marked.parse(c.body, { async: false }) as string,
    }));
}
