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
  /** version はプレビューが表示中の deck の document version(古い版からのジャンプ検出に使う)。 */
  | { type: "jumpToSource"; frameIndex: number; version: number }
  | { type: "activeFrameChanged"; frameIndex: number }
  /** Webview にフォーカスがあるときの Cmd/Ctrl+Z(undo)/ Shift+Cmd+Z・Ctrl+Y(redo)。ソース文書に対して実行する(#103)。 */
  | { type: "undoRedo"; kind: "undo" | "redo" }
  | {
      type: "moveCanvasElement";
      frameIndex: number;
      elementId: string;
      version: number;
      x: number;
      y: number;
    }
  /** フロー要素を deckcanvas へ移す(「自由配置にする」)。 */
  | {
      type: "detachToCanvas";
      frameIndex: number;
      /** 表示中 deck の document version。 */
      version: number;
      /** 展開後ソース上の対象ブロック範囲(renderer の data-source-start / end)。 */
      sourceSpan: { start: number; end: number };
      /** スライド全体を 1 とした左上座標と幅。ホストが本文領域座標へ変換する。 */
      rect: { x: number; y: number; width: number };
    };

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

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
      if (typeof raw.frameIndex === "number" && typeof raw.version === "number") {
        return { type: "jumpToSource", frameIndex: raw.frameIndex, version: raw.version };
      }
      return null;
    case "activeFrameChanged":
      if (typeof raw.frameIndex === "number") {
        return { type: "activeFrameChanged", frameIndex: raw.frameIndex };
      }
      return null;
    case "undoRedo":
      if (raw.kind === "undo" || raw.kind === "redo") return { type: "undoRedo", kind: raw.kind };
      return null;
    case "moveCanvasElement":
      if (
        typeof raw.frameIndex === "number" &&
        Number.isInteger(raw.frameIndex) &&
        raw.frameIndex >= 0 &&
        typeof raw.elementId === "string" &&
        typeof raw.version === "number" &&
        Number.isInteger(raw.version) &&
        typeof raw.x === "number" &&
        Number.isFinite(raw.x) &&
        typeof raw.y === "number" &&
        Number.isFinite(raw.y)
      ) {
        return {
          type: "moveCanvasElement",
          frameIndex: raw.frameIndex,
          elementId: raw.elementId,
          version: raw.version,
          x: raw.x,
          y: raw.y,
        };
      }
      return null;
    case "detachToCanvas": {
      const { sourceSpan, rect } = raw;
      if (
        isNonNegativeInteger(raw.frameIndex) &&
        typeof raw.version === "number" &&
        Number.isInteger(raw.version) &&
        isRecord(sourceSpan) &&
        isNonNegativeInteger(sourceSpan.start) &&
        isNonNegativeInteger(sourceSpan.end) &&
        sourceSpan.end > sourceSpan.start &&
        isRecord(rect) &&
        isFiniteNumber(rect.x) &&
        isFiniteNumber(rect.y) &&
        isFiniteNumber(rect.width)
      ) {
        return {
          type: "detachToCanvas",
          frameIndex: raw.frameIndex,
          version: raw.version,
          sourceSpan: { start: sourceSpan.start, end: sourceSpan.end },
          rect: { x: rect.x, y: rect.y, width: rect.width },
        };
      }
      return null;
    }
    default:
      return null;
  }
}
