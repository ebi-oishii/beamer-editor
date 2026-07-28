/**
 * 環境非依存の ShellHost 契約と、Webview 向けの汎用実装。
 *
 * `packages/ui` は `vscode` API も webview グローバル（acquireVsCodeApi）も知らない。
 * Webview 上では apps/vscode が用意した MessageTransport を注入することで、
 * webview グローバルを ui に持ち込まずに Extension と通信する。
 */

import type { RenderedDeck } from "@beamer-editor/renderer";
import type { ExtensionToWebview, WebviewToExtension } from "./messages.js";

export interface ShellHost {
  /** ホストからの deck 更新を購読する。unsubscribe を返す。 */
  subscribe(listener: (deck: RenderedDeck, version: number) => void): () => void;
  /** ui → ホスト: 対象フレームのソースへ移動要求（VS-2 は frameIndex。span は VS-4/PR#14 で拡張）。 */
  jumpToSource(frameIndex: number): void;
  /** ui → ホスト: プレビュー内でアクティブフレームが変わった通知。 */
  notifyActiveFrame(frameIndex: number): void;
}

/**
 * Webview グローバルを抽象化した通信路。apps/vscode 側で acquireVsCodeApi から生成する。
 * `subscribe` の受信は parseExtensionToWebview で検証済みのメッセージのみを渡す契約。
 */
export interface MessageTransport {
  post(msg: WebviewToExtension): void;
  subscribe(cb: (msg: ExtensionToWebview) => void): () => void;
}

/** MessageTransport から Webview 用の ShellHost を作る。 */
export function createMessageShellHost(transport: MessageTransport): ShellHost & { ready(): void } {
  return {
    subscribe(listener) {
      return transport.subscribe((msg) => {
        if (msg.type === "deckUpdated") {
          listener(msg.deck, msg.version);
        }
      });
    },
    jumpToSource(frameIndex) {
      transport.post({ type: "jumpToSource", frameIndex });
    },
    notifyActiveFrame(frameIndex) {
      transport.post({ type: "activeFrameChanged", frameIndex });
    },
    ready() {
      transport.post({ type: "ready" });
    },
  };
}
