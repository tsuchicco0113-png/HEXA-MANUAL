/**
 * 共通型定義
 */

/** ページ発見の経路。上ほど信頼度が高い */
export type DiscoverySource = "llms-full" | "llms" | "sitemap" | "crawl";

/** 収集対象ページ 1 件 */
export interface PageRef {
  /** 正規化前の実 URL（fetch に使う） */
  url: string;
  /** 目次表示用のタイトル。発見段階で判れば入れる */
  title?: string;
}

/** discover() の結果 */
export interface Discovery {
  source: DiscoverySource;
  pages: PageRef[];
  /**
   * llms-full.txt が引けた場合のみ。
   * 全ドキュメントが 1 本の Markdown として入っている。
   */
  fullMarkdown?: string;
  /** UI に出す診断メッセージ（どこを試して何が落ちたか） */
  log: string[];
}

/** Readability 抽出後の 1 ページ */
export interface ExtractedPage {
  url: string;
  /** 連結後の HTML 内で使う一意 ID（p1, p2, ...） */
  id: string;
  title: string;
  /** 本文のみの HTML。見出しレベルは元のまま */
  contentHtml: string;
  byline?: string;
}

export interface ProgressEvent {
  phase: "discover" | "fetch" | "extract" | "build";
  current: number;
  total: number;
  message: string;
}

export type ProgressFn = (e: ProgressEvent) => void;
