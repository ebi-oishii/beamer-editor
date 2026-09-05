/**
 * Webview エントリ。packages/ui のプレビューを #app へマウントする。
 * ここは apps/vscode（Webview コンテキスト）なので acquireVsCodeApi を使ってよい。
 * webview グローバルは MessageTransport / WebviewStateStore に閉じ込め、ui へは持ち込まない。
 * acquireVsCodeApi の戻り値はモジュールスコープに留め、global へ公開しない(移植計画 VS-8)。
 */

import {
  createMessageShellHost,
  type ExtensionToWebview,
  type MessageTransport,
  mountPreview,
  parseExtensionToWebview,
  type RasterImage,
  type WebviewToExtension,
} from "@beamer-editor/ui";
import * as pdfjs from "pdfjs-dist";
// KaTeX の数式 CSS とフォント。esbuild が media/webview.css + フォントへ抽出する。
import "katex/dist/katex.min.css";

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

document.documentElement.dataset.beamerEditor = "preview";

const api = acquireVsCodeApi();

const transport: MessageTransport = {
  post: (msg: WebviewToExtension) => api.postMessage(msg),
  subscribe: (cb: (msg: ExtensionToWebview) => void) => {
    const handler = (event: MessageEvent) => {
      const msg = parseExtensionToWebview(event.data);
      if (msg) cb(msg);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  },
};

// ナビ状態(現在フレーム・step・zoom)だけを getState / setState で保存する(移植計画 VS-7)。
const host = createMessageShellHost(transport, {
  getState: () => api.getState(),
  setState: (state) => api.setState(state),
});
const container = document.getElementById("app");

// 生ブロックの部分コンパイル画像(#81): PDF を pdf.js で 3 倍解像度に描いて data URL にする。
// worker の URI は拡張側が #app の data-pdf-worker に入れる(別オリジンなので pdf.js が blob 経由で起動する)。
const pdfWorker = container?.dataset.pdfWorker;
if (pdfWorker) pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;
const RASTER_SCALE = 3;
async function rasterizePdf(pdf: Uint8Array): Promise<RasterImage> {
  const task = pdfjs.getDocument({ data: pdf });
  const loaded = await task.promise;
  try {
    const page = await loaded.getPage(1);
    const viewport = page.getViewport({ scale: RASTER_SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas 2D context を取得できません");
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
  } finally {
    await task.destroy();
  }
}

if (container) {
  mountPreview(container, { ...host, rasterizePdf });
  host.ready();
}
