import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { run } from "./lib/pipeline";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const urlEl = $<HTMLInputElement>("url");
const maxEl = $<HTMLInputElement>("maxPages");
const intervalEl = $<HTMLInputElement>("interval");
const scopeEl = $<HTMLInputElement>("scope");
const goBtn = $<HTMLButtonElement>("go");
const htmlBtn = $<HTMLButtonElement>("htmlOnly");
const statusEl = $<HTMLDivElement>("status");
const logEl = $<HTMLTextAreaElement>("log");
const warnEl = $<HTMLDivElement>("warn");

function log(line: string) {
  logEl.value += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

// 起動時にブラウザの有無を確認しておく。
// PDF 生成の直前に落ちるより、最初に判っているほうが親切。
invoke<string>("detect_browser")
  .then((p) => log(`browser: ${p}`))
  .catch((e) => {
    warnEl.textContent = `PDF 生成には Chrome または Edge が必要です — ${e}`;
    goBtn.disabled = true;
  });

async function pipeline() {
  logEl.value = "";
  const entry = urlEl.value.trim();
  if (!entry) return null;

  const t0 = performance.now();
  const result = await run(entry, {
    maxPages: Number(maxEl.value),
    minIntervalMs: Number(intervalEl.value),
    scopeToPath: scopeEl.checked,
    docTitle: new URL(entry).hostname,
    onProgress: (e) => {
      statusEl.textContent =
        e.total > 0
          ? `[${e.phase}] ${e.current}/${e.total} — ${e.message}`
          : `[${e.phase}] ${e.message}`;
    },
  });

  for (const l of result.log) log(l);
  log("");
  log(`経路: ${result.source} / 採用 ${result.pageCount} ページ / ${Math.round((performance.now() - t0) / 1000)} 秒`);
  if (result.skipped.length) {
    log(`スキップ ${result.skipped.length} 件:`);
    for (const s of result.skipped) log(`  - ${s}`);
  }
  return result;
}

goBtn.onclick = async () => {
  goBtn.disabled = htmlBtn.disabled = true;
  try {
    const result = await pipeline();
    if (!result || result.pageCount === 0) {
      statusEl.textContent = "ページを取得できませんでした";
      return;
    }

    const outPath = await save({
      defaultPath: `${new URL(urlEl.value.trim()).hostname}.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!outPath) return;

    statusEl.textContent = "PDF 生成中（Chrome を起動しています）…";
    const pdf = await invoke<{ path: string; bytes: number; imageCount: number }>(
      "generate_pdf",
      {
        html: result.html,
        outPath,
        options: { outline: true, pageNumbers: true, timeoutSecs: 300 },
      },
    );
    statusEl.textContent = `完了: ${pdf.path}`;
    log(`PDF: ${Math.round(pdf.bytes / 1024)} KB / 画像 ${pdf.imageCount} 点`);
  } catch (e) {
    statusEl.textContent = "";
    log(`ERROR: ${e}`);
  } finally {
    goBtn.disabled = htmlBtn.disabled = false;
  }
};

// CSS を詰めるとき用。連結 HTML を保存して Chrome で開き、
// Ctrl+P のプレビューで確認するのが一番速い。
htmlBtn.onclick = async () => {
  goBtn.disabled = htmlBtn.disabled = true;
  try {
    const result = await pipeline();
    if (!result) return;
    const outPath = await save({
      defaultPath: "preview.html",
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (!outPath) return;
    await invoke("save_text", { path: outPath, contents: result.html });
    statusEl.textContent = `保存: ${outPath}`;
  } catch (e) {
    log(`ERROR: ${e}`);
  } finally {
    goBtn.disabled = htmlBtn.disabled = false;
  }
};
