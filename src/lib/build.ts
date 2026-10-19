import { normalizeUrl } from "./fetcher";
import type { ExtractedPage } from "./types";

export interface BuildOptions {
  docTitle: string;
  sourceUrl: string;
  generatedAt?: Date;
  includeToc?: boolean;
  /** 見出しを何段下げるか。1 ならページタイトルが h1、本文 h1 は h2 になる */
  demoteBy?: number;
  fontStack?: string;
}

/**
 * 抽出済みページ群を 1 本の印刷用 HTML に連結する。
 *
 * ページごとに PDF 化して結合する方式は採らない。通しページ番号が
 * 振れず、しおりも付かず、遅い。連結してから一度だけ印刷するのが正解。
 */
export function buildDocument(
  pages: ExtractedPage[],
  opts: BuildOptions,
): string {
  const demote = opts.demoteBy ?? 1;

  // URL → ページ ID。内部リンクをアンカーに張り替えるのに使う
  const urlToId = new Map<string, string>();
  for (const p of pages) urlToId.set(normalizeUrl(p.url), p.id);

  const sections: string[] = [];
  const tocRows: string[] = [];

  for (const page of pages) {
    const doc = new DOMParser().parseFromString(
      `<div id="wrap">${page.contentHtml}</div>`,
      "text/html",
    );
    const wrap = doc.getElementById("wrap")!;

    namespaceIds(wrap, page.id);
    const headings = demoteHeadings(wrap, demote, page.id);
    rewriteLinks(wrap, page, urlToId);
    normalizeImages(wrap, page.url);
    tagCodeBlocks(wrap);

    sections.push(
      `<section class="doc-page" id="${page.id}">
  <h1 class="page-title" id="${page.id}--title">${esc(page.title)}</h1>
  <p class="page-source">${esc(page.url)}</p>
  ${wrap.innerHTML}
</section>`,
    );

    tocRows.push(
      `<li class="toc-l1"><a href="#${page.id}">${esc(page.title)}</a></li>` +
        headings
          .filter((h) => h.level <= demote + 2) // h1/h2 相当まで
          .map(
            (h) =>
              `<li class="toc-l2"><a href="#${h.id}">${esc(h.text)}</a></li>`,
          )
          .join(""),
    );
  }

  const stamp = (opts.generatedAt ?? new Date()).toLocaleString("ja-JP");

  const toc =
    opts.includeToc === false
      ? ""
      : `<section class="toc-page">
  <h1>目次</h1>
  <ul class="toc">${tocRows.join("\n")}</ul>
</section>`;

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${esc(opts.docTitle)}</title>
<style>${printCss(opts.fontStack)}</style>
</head>
<body>
<section class="cover">
  <h1>${esc(opts.docTitle)}</h1>
  <p class="cover-src">${esc(opts.sourceUrl)}</p>
  <p class="cover-meta">${esc(stamp)} 時点 / 全 ${pages.length} ページ</p>
  <p class="cover-note">個人利用のために生成されたアーカイブです。再配布はできません。</p>
</section>
${toc}
${sections.join("\n")}
</body>
</html>`;
}

// ---------------------------------------------------------------------------

/**
 * ページ内 id を名前空間化する。
 * 200 ページ連結すると id="installation" が何度も衝突し、
 * アンカーが全部先頭ページに飛ぶ。
 */
function namespaceIds(root: Element, pageId: string) {
  root.querySelectorAll("[id]").forEach((el) => {
    const old = el.getAttribute("id")!;
    el.setAttribute("id", `${pageId}--${old}`);
    el.setAttribute("data-original-id", old);
  });
}

interface HeadingInfo {
  id: string;
  text: string;
  level: number;
}

/**
 * 見出しを demote 段下げる。
 * ページタイトルを h1 にするため、本文中の h1 は h2 に落とす。
 * これで Playwright の outline: true が正しい階層のしおりを生成する。
 */
function demoteHeadings(
  root: Element,
  demote: number,
  pageId: string,
): HeadingInfo[] {
  const out: HeadingInfo[] = [];
  let counter = 0;

  root.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
    const from = Number(h.tagName[1]);
    const to = Math.min(6, from + demote);

    const replacement = h.ownerDocument!.createElement(`h${to}`);
    for (const attr of [...h.attributes]) {
      replacement.setAttribute(attr.name, attr.value);
    }
    replacement.innerHTML = h.innerHTML;

    if (!replacement.id) {
      replacement.id = `${pageId}--h${++counter}`;
    }
    h.replaceWith(replacement);

    out.push({
      id: replacement.id,
      text: (replacement.textContent ?? "").trim(),
      level: to,
    });
  });

  return out;
}

/**
 * リンクの張り替え。
 *  - 収集済みページへのリンク → 文書内アンカー
 *  - 外部リンク → 絶対 URL 化（CSS で URL を併記する）
 */
function rewriteLinks(
  root: Element,
  page: ExtractedPage,
  urlToId: Map<string, string>,
) {
  root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
    const href = a.getAttribute("href")!;

    // 同一ページ内アンカー
    if (href.startsWith("#")) {
      a.setAttribute("href", `#${page.id}--${href.slice(1)}`);
      a.classList.add("internal-link");
      return;
    }

    let abs: URL;
    try {
      abs = new URL(href, page.url);
    } catch {
      return;
    }

    const targetId = urlToId.get(normalizeUrl(abs.toString()));
    if (targetId) {
      const frag = abs.hash ? `${targetId}--${abs.hash.slice(1)}` : targetId;
      a.setAttribute("href", `#${frag}`);
      a.classList.add("internal-link");
    } else {
      a.setAttribute("href", abs.toString());
      a.classList.add("external-link");
    }
  });
}

/** 画像を絶対 URL 化し、印刷で崩れる srcset / lazy を外す */
function normalizeImages(root: Element, pageUrl: string) {
  root.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const src = img.getAttribute("src");
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
    img.removeAttribute("loading");
    if (!src) return;
    try {
      img.setAttribute("src", new URL(src, pageUrl).toString());
    } catch {
      /* noop */
    }
  });
}

/** 長いコードブロックは改ページを許可しないと 1 行も入らない紙が出る */
function tagCodeBlocks(root: Element) {
  root.querySelectorAll("pre").forEach((pre) => {
    const lines = (pre.textContent ?? "").split("\n").length;
    if (lines > 25) pre.classList.add("pre-long");
  });
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------

function printCss(fontStack?: string): string {
  const font =
    fontStack ??
    `"Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif`;

  return `
@page { size: A4; margin: 20mm 18mm 18mm; }

:root { --fg: #1a1a1a; --muted: #666; --rule: #ddd; --code-bg: #f6f7f9; }

* { box-sizing: border-box; }

body {
  font-family: ${font};
  color: var(--fg);
  font-size: 10.5pt;
  line-height: 1.75;
  margin: 0;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* --- 表紙 / 目次 --------------------------------------------------- */
.cover { height: 240mm; display: flex; flex-direction: column; justify-content: center; }
.cover h1 { font-size: 26pt; line-height: 1.4; border: none; margin: 0 0 12mm; }
.cover-src { font-family: ui-monospace, monospace; font-size: 9pt; color: var(--muted); word-break: break-all; }
.cover-meta { font-size: 10pt; color: var(--muted); }
.cover-note { margin-top: 20mm; font-size: 8.5pt; color: var(--muted); }

.toc-page { break-before: page; }
.toc { list-style: none; padding: 0; font-size: 9.5pt; }
.toc a { text-decoration: none; color: var(--fg); }
.toc-l1 { margin-top: 3mm; font-weight: 600; }
.toc-l2 { padding-left: 6mm; color: var(--muted); font-weight: 400; }

/* --- 本文 ----------------------------------------------------------- */
.doc-page { break-before: page; }
.page-title {
  font-size: 19pt;
  line-height: 1.4;
  margin: 0 0 1mm;
  padding-bottom: 2mm;
  border-bottom: 2px solid var(--fg);
}
.page-source {
  font-family: ui-monospace, monospace;
  font-size: 7.5pt;
  color: var(--muted);
  margin: 0 0 8mm;
  word-break: break-all;
}

h2 { font-size: 14pt; margin: 9mm 0 3mm; padding-bottom: 1.5mm; border-bottom: 1px solid var(--rule); }
h3 { font-size: 12pt; margin: 7mm 0 2mm; }
h4, h5, h6 { font-size: 10.5pt; margin: 5mm 0 2mm; }

/* 見出しだけがページ末尾に取り残されるのを防ぐ */
h2, h3, h4, h5, h6 { break-after: avoid; break-inside: avoid; }
p, li { orphans: 3; widows: 3; }

/* --- コード --------------------------------------------------------- */
pre {
  background: var(--code-bg);
  border: 1px solid var(--rule);
  border-radius: 3px;
  padding: 3mm 4mm;
  font-size: 8.5pt;
  line-height: 1.55;
  /* 紙は横スクロールできない。折り返しを強制する */
  white-space: pre-wrap;
  word-break: break-all;
  overflow-wrap: anywhere;
  break-inside: avoid;
}
pre.pre-long { break-inside: auto; }
code {
  font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
  font-size: 0.9em;
}
:not(pre) > code {
  background: var(--code-bg);
  padding: 0.5mm 1.2mm;
  border-radius: 2px;
  word-break: break-all;
}

/* --- 表 / 画像 ------------------------------------------------------- */
table { width: 100%; border-collapse: collapse; font-size: 9pt; margin: 4mm 0; break-inside: avoid; }
th, td { border: 1px solid var(--rule); padding: 1.5mm 2.5mm; text-align: left; vertical-align: top; }
th { background: var(--code-bg); font-weight: 600; }
thead { display: table-header-group; }

img { max-width: 100%; height: auto; break-inside: avoid; }
figure { margin: 4mm 0; break-inside: avoid; }

blockquote {
  margin: 4mm 0;
  padding: 1mm 0 1mm 4mm;
  border-left: 3px solid var(--rule);
  color: #333;
}

/* --- リンク ---------------------------------------------------------- */
a { color: #0b5cad; text-decoration: none; }
a.internal-link { color: #0b5cad; }

/* 紙では外部リンクが死ぬので URL を併記する */
a.external-link::after {
  content: " (" attr(href) ")";
  font-family: ui-monospace, monospace;
  font-size: 0.72em;
  color: var(--muted);
  word-break: break-all;
}
/* 画像リンクには付けない */
a.external-link:has(img)::after { content: ""; }
`;
}
