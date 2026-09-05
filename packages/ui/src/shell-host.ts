/**
 * 環境非依存の ShellHost 契約と、Webview 向けの汎用実装。
 *
 * `packages/ui` は `vscode` API も webview グローバル（acquireVsCodeApi）も知らない。
 * Webview 上では apps/vscode が用意した MessageTransport を注入することで、
 * webview グローバルを ui に持ち込まずに Extension と通信する。
 */

import type { RenderedDeck } from "@beamer-editor/renderer";
import type { ExtensionToWebview, WebviewToExtension } from "./messages.js";
import { parseZoom, type ZoomState } from "./preview/zoom.js";

/**
 * プレビューのナビ状態。Webview の getState/setState で保存する最小限で、
 * ソース本文や AST は含めない(移植計画 VS-7)。
 */
export interface NavState {
  /** 現在フレーム(0 起点)。 */
  current: number;
  /** オーバーレイの現在ステップ(1 起点)。 */
  step: number;
  /** スライドの表示倍率。旧 state には無く、無い場合は fit とする。 */
  zoom: ZoomState;
}

export type RawBlockImageResult = { pdfBase64: string } | { error: string };

/** ラスタライズした画像。width / height はピクセル(縦横比の計算に使う)。 */
export interface RasterImage {
  dataUrl: string;
  width: number;
  height: number;
}

export interface ShellHost {
  /** ホストからの deck 更新を購読する。unsubscribe を返す。 */
  subscribe(listener: (deck: RenderedDeck, version: number) => void): () => void;
  /**
   * ホスト → ui: 指定フレームを表示する要求(ソース側の CodeLens・コマンド・カーソル追従)。
   * version は要求の基になった deck の document version。表示中の版と違えば ui は無視する。
   */
  onRevealFrame?(listener: (frameIndex: number, version: number) => void): () => void;
  /**
   * ホスト → ui: 生ブロックの部分コンパイル結果(#81)。key はプレースホルダの data-raw-key。
   * 成功なら PDF(base64)、失敗ならメッセージ。
   */
  onRawBlockImage?(listener: (key: string, result: RawBlockImageResult) => void): () => void;
  /**
   * PDF のバイト列を画像にする(pdf.js などホスト固有の実装)。無いホストでは箱のまま残す。
   */
  rasterizePdf?(pdf: Uint8Array): Promise<RasterImage>;
  /** 前回のナビ状態(パネル再表示時の復元用)。無ければ undefined。 */
  loadNavState?(): NavState | undefined;
  /** ナビ状態の保存。current / step 以外を渡さない。 */
  saveNavState?(state: NavState): void;
  /**
   * ui → ホスト: 対象フレームのソースへ移動要求。version は表示中 deck の document
   * version(ホスト側で古い版からのジャンプを検出し、移動せず再描画を要求する。VS-4)。
   */
  jumpToSource(frameIndex: number, version: number): void;
  /** ui → ホスト: プレビュー内でアクティブフレームが変わった通知。 */
  notifyActiveFrame(frameIndex: number): void;
  moveCanvasElement?(
    frameIndex: number,
    elementId: string,
    version: number,
    x: number,
    y: number,
  ): void;
  /**
   * ui → ホスト: フロー要素(段落・リスト・画像)を同じフレームの deckcanvas へ移す要求
   * (「自由配置にする」)。sourceSpan は展開後ソース、rect はスライド全体を 1 とした
   * 左上座標と幅。実装しないホストではメニューを出さない。
   */
  detachToCanvas?(
    frameIndex: number,
    version: number,
    sourceSpan: { start: number; end: number },
    rect: { x: number; y: number; width: number },
  ): void;
}

/**
 * Webview グローバルを抽象化した通信路。apps/vscode 側で acquireVsCodeApi から生成する。
 * `subscribe` の受信は parseExtensionToWebview で検証済みのメッセージのみを渡す契約。
 */
export interface MessageTransport {
  post(msg: WebviewToExtension): void;
  subscribe(cb: (msg: ExtensionToWebview) => void): () => void;
}

/** Webview の getState / setState を抽象化した保存先(acquireVsCodeApi の戻り値が満たす)。 */
export interface WebviewStateStore {
  getState(): unknown;
  setState(state: unknown): void;
}

/** getState の戻り値を NavState として検証する(壊れた zoom は fit へ戻す)。 */
function parseNavState(raw: unknown): NavState | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { current, step } = raw as Record<string, unknown>;
  if (typeof current !== "number" || !Number.isInteger(current) || current < 0) return undefined;
  if (typeof step !== "number" || !Number.isInteger(step) || step < 1) return undefined;
  return { current, step, zoom: parseZoom((raw as Record<string, unknown>).zoom) };
}

/** MessageTransport から Webview 用の ShellHost を作る。 */
export function createMessageShellHost(
  transport: MessageTransport,
  state?: WebviewStateStore,
): ShellHost & { ready(): void } {
  // 非同期処理の完了順が入れ替わっても古いプレビューへ戻らないよう、
  // 現在値より古い document version の deckUpdated は捨てる(移植計画 §6)。
  let lastVersion = Number.NEGATIVE_INFINITY;
  return {
    subscribe(listener) {
      return transport.subscribe((msg) => {
        if (msg.type === "deckUpdated") {
          if (msg.version < lastVersion) return;
          lastVersion = msg.version;
          listener(msg.deck, msg.version);
        }
      });
    },
    onRevealFrame(listener) {
      return transport.subscribe((msg) => {
        if (msg.type === "activeFrameChanged") listener(msg.frameIndex, msg.version);
      });
    },
    onRawBlockImage(listener) {
      return transport.subscribe((msg) => {
        if (msg.type === "rawBlockReady") listener(msg.key, { pdfBase64: msg.pdfBase64 });
        else if (msg.type === "rawBlockFailed") listener(msg.key, { error: msg.message });
      });
    },
    jumpToSource(frameIndex, version) {
      transport.post({ type: "jumpToSource", frameIndex, version });
    },
    notifyActiveFrame(frameIndex) {
      transport.post({ type: "activeFrameChanged", frameIndex });
    },
    moveCanvasElement(frameIndex, elementId, version, x, y) {
      transport.post({ type: "moveCanvasElement", frameIndex, elementId, version, x, y });
    },
    detachToCanvas(frameIndex, version, sourceSpan, rect) {
      transport.post({ type: "detachToCanvas", frameIndex, version, sourceSpan, rect });
    },
    loadNavState() {
      return parseNavState(state?.getState());
    },
    saveNavState(nav) {
      state?.setState({ current: nav.current, step: nav.step, zoom: nav.zoom });
    },
    ready() {
      transport.post({ type: "ready" });
    },
  };
}
