/**
 * Extension（Host）↔ Webview 間の tagged union メッセージと、その検証（移植計画 §6）。
 *
 * - メッセージは JSON シリアライズ可能な値だけで表現し、VS Code 固有型を含めない。
 * - 受信側は必ず parse* を通し、未知の type や型不一致は `null`（=破棄）にする。
 * - deck の内部構造までは深く検証せず、`type` と number / string フィールドの
 *   存在・型のみを確認する（信頼できる送信元だが最低限のガードは張る）。
 */

import type { RenderedDeck } from "@beamer-editor/renderer";

export type ExtensionToWebview =
  | { type: "deckUpdated"; deck: RenderedDeck; version: number; activeFrame: number }
  | { type: "activeFrameChanged"; frameIndex: number; version: number }
  | { type: "error"; message: string };

export type WebviewToExtension =
  | { type: "ready" }
  | { type: "jumpToSource"; frameIndex: number }
  | { type: "activeFrameChanged"; frameIndex: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Extension → Webview を検証する。不正なら null。 */
export function parseExtensionToWebview(raw: unknown): ExtensionToWebview | null {
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case "deckUpdated":
      if (
        isRecord(raw.deck) &&
        typeof raw.version === "number" &&
        typeof raw.activeFrame === "number"
      ) {
        return {
          type: "deckUpdated",
          deck: raw.deck as unknown as RenderedDeck,
          version: raw.version,
          activeFrame: raw.activeFrame,
        };
      }
      return null;
    case "activeFrameChanged":
      if (typeof raw.frameIndex === "number" && typeof raw.version === "number") {
        return { type: "activeFrameChanged", frameIndex: raw.frameIndex, version: raw.version };
      }
      return null;
    case "error":
      if (typeof raw.message === "string") {
        return { type: "error", message: raw.message };
      }
      return null;
    default:
      return null;
  }
}

/** Webview → Extension を検証する。不正なら null。 */
export function parseWebviewToExtension(raw: unknown): WebviewToExtension | null {
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case "ready":
      return { type: "ready" };
    case "jumpToSource":
      if (typeof raw.frameIndex === "number") {
        return { type: "jumpToSource", frameIndex: raw.frameIndex };
      }
      return null;
    case "activeFrameChanged":
      if (typeof raw.frameIndex === "number") {
        return { type: "activeFrameChanged", frameIndex: raw.frameIndex };
      }
      return null;
    default:
      return null;
  }
}
