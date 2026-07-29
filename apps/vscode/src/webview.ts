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
  type WebviewToExtension,
} from "@beamer-editor/ui";
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

// ナビ状態(現在フレーム・step)だけを getState / setState で保存する(移植計画 VS-7)。
const host = createMessageShellHost(transport, {
  getState: () => api.getState(),
  setState: (state) => api.setState(state),
});
const container = document.getElementById("app");
if (container) {
  mountPreview(container, host);
  host.ready();
}
