/**
 * Webview エントリ。packages/ui のプレビューを #app へマウントする。
 * ここは apps/vscode（Webview コンテキスト）なので acquireVsCodeApi を使ってよい。
 * webview グローバルは MessageTransport に閉じ込め、ui へは持ち込まない。
 */

import {
  createMessageShellHost,
  type ExtensionToWebview,
  type MessageTransport,
  mountPreview,
  parseExtensionToWebview,
  type WebviewToExtension,
} from "@beamer-editor/ui";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

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

const host = createMessageShellHost(transport);
const container = document.getElementById("app");
if (container) {
  mountPreview(container, host);
  host.ready();
}
