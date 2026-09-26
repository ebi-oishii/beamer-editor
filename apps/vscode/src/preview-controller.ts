import {
  type CanvasFontSize,
  isCanvasFontSize,
  mapExpandedRangeToSourceExact,
  normalizeCanvasWidth,
  roundCanvasCoordinate,
} from "@beamer-editor/core";
import { DEFAULT_THEME, type RenderedCanvasElement } from "@beamer-editor/renderer";
import type { ExtensionToWebview } from "@beamer-editor/ui";
import { parseWebviewToExtension } from "@beamer-editor/ui";
import type * as vscode from "vscode";
import { type RenderOutcome, renderDocument } from "./document-controller";
import { frameIndexAtSourceOffset } from "./reveal-slide";
import { resolveJumpOffset } from "./source-navigation";

/**
 * PreviewController が必要とする Webview 面。実 vscode.Webview はこれらを満たす。
 * postMessage / onDidReceiveMessage を含め、Extension ↔ Webview の typed message を扱う。
 */
export interface PreviewPanel {
  readonly webview: Pick<vscode.Webview, "html" | "cspSource"> & {
    postMessage(msg: unknown): Thenable<boolean>;
    onDidReceiveMessage(listener: (msg: unknown) => void): vscode.Disposable;
  };
  onDidDispose(listener: () => void): vscode.Disposable;
  reveal(viewColumn?: vscode.ViewColumn, preserveFocus?: boolean): void;
  dispose(): void;
}

/** Webview へ読み込ませるビルド済みアセット(asWebviewUri 変換済みの URL)。 */
export interface WebviewAssets {
  scriptUri: string;
  styleUri: string;
  /** pdf.js の worker(部分コンパイル画像のラスタライズ。#81)。無ければ Webview は箱のまま表示する。 */
  pdfWorkerUri?: string;
}

/** プレビューが入力とする文書の最小面（vscode.TextDocument が満たす）。 */
export type PreviewDocument = Pick<vscode.TextDocument, "getText" | "version"> & {
  readonly uri: { toString(): string };
};

/** 文書変更イベントの最小面(vscode.TextDocumentChangeEvent が満たす)。 */
export interface PreviewDocumentChangeEvent {
  readonly document: PreviewDocument;
  readonly contentChanges: readonly unknown[];
}

/** 文書変更の購読口(vscode.workspace が満たす)。テストではフェイクを注入する。 */
export interface DocumentEvents {
  onDidChangeTextDocument(listener: (event: PreviewDocumentChangeEvent) => void): {
    dispose(): void;
  };
}

/** 連続入力を 1 回のレンダリングへまとめる待ち時間(移植計画 VS-3 は 100〜150ms)。 */
export const RENDER_DEBOUNCE_MS = 120;

/** 編集 host が canvas の移動・自由配置化の要求を処理した結果。 */
export type CanvasEditResult = "applied" | "unchanged" | "cancelled" | "failed";

/** 本文領域に対する正規化座標での箱の位置と幅(core の CanvasPlacement と同じ)。 */
export interface CanvasPlacement {
  x: number;
  y: number;
  width: number;
}

/**
 * スライド全体を 1 とした矩形を、本文領域(deckcanvas の座標系)の正規化値へ変換する。
 * Webview はテーマの幾何を知らないので、変換はここで行う。
 */
export function toCanvasPlacement(rect: { x: number; y: number; width: number }): CanvasPlacement {
  const { slideWidthPt, slideHeightPt, bodyAreaPt: body } = DEFAULT_THEME.metrics;
  return {
    x: (rect.x * slideWidthPt - body.left) / body.width,
    y: (rect.y * slideHeightPt - body.top) / body.height,
    width: (rect.width * slideWidthPt) / body.width,
  };
}

export interface PreviewControllerOptions {
  /** レンダリングパイプラインの差し替え口(テスト用)。既定は renderDocument。 */
  render?: (text: string, version: number) => RenderOutcome;
  /** 予期しないレンダリング例外の通知先(既定は何もしない)。 */
  onError?: (message: string) => void;
  /** 文書競合など、再試行可能な canvas image 編集中止の通知先。 */
  onWarning?: (message: string) => void;
  /**
   * ソースジャンプの実行先(元ソースの UTF-16 オフセットを受け取る)。
   * エディタ操作は vscode API が要るため extension.ts が注入する。既定は何もしない。
   */
  navigate?: (offset: number) => void;
  /** 描画が成功するたびに呼ぶ(生ブロックの部分コンパイルの起点。#81)。 */
  onRendered?: (outcome: RenderOutcome) => void;
  /**
   * Webview が (再)生成されて ready を送ったとき。差し込み済み画像の再送のために done を捨てる。
   */
  onWebviewReady?: () => void;
  /**
   * Webview からの取り消し / やり直し要求(Cmd/Ctrl+Z。#103)。エディタ操作は vscode API が要るため
   * extension.ts が注入する。既定は何もしない。
   */
  undoRedo?: (kind: "undo" | "redo") => void | Promise<void>;
  /**
   * 画像などローカルリソースのパスを Webview で読める URI へ変換する
   * (asWebviewUri。extension.ts が注入)。未指定なら書き換えない。
   */
  resolveResource?: (path: string) => string;
  /** 最新の編集可能なキャンバス要素を更新し、VS Code host の適用結果を返す。 */
  setCanvasFontSize?: (move: {
    frameIndex: number;
    elementId: string;
    version: number;
    size: CanvasFontSize;
    sourceSpan: { start: number; end: number };
    document: PreviewDocument;
    expectedOptions: string;
  }) => Promise<CanvasEditResult>;
  resizeCanvasElement?: (move: {
    frameIndex: number;
    elementId: string;
    version: number;
    width: number;
    sourceSpan: { start: number; end: number };
    document: PreviewDocument;
    expectedOptions: string;
  }) => Promise<CanvasEditResult>;
  moveCanvasElement?: (move: {
    frameIndex: number;
    elementId: string;
    version: number;
    x: number;
    y: number;
    sourceSpan: { start: number; end: number };
    document: PreviewDocument;
    expectedOptions: string;
  }) => Promise<CanvasEditResult>;
  /** フロー要素を deckcanvas へ移す(「自由配置にする」)。sourceSpan は元ソース上の範囲。 */
  detachToCanvas?: (request: {
    frameIndex: number;
    version: number;
    sourceSpan: { start: number; end: number };
    placement: CanvasPlacement;
    document: PreviewDocument;
  }) => Promise<CanvasEditResult>;
  /** 選択中のキャンバス要素を取り除く(Delete。#148)。sourceSpan は要素の options の範囲。 */
  deleteCanvasElement?: (request: {
    frameIndex: number;
    elementId: string;
    version: number;
    sourceSpan: { start: number; end: number };
    document: PreviewDocument;
    expectedOptions: string;
  }) => Promise<CanvasEditResult>;
  /** 選択中のキャンバス要素のソースをクリップボードへ写す(Cmd+C)。写せたら true。 */
  copyCanvasElement?: (request: {
    frameIndex: number;
    elementId: string;
    version: number;
    sourceSpan: { start: number; end: number };
    document: PreviewDocument;
    expectedOptions: string;
  }) => Promise<boolean>;
  /**
   * クリップボードのキャンバス要素を、frameOffset(元ソース上の位置)を含むフレームへ貼り付ける
   * (Cmd+V)。要素でなければ "cancelled"。
   */
  pasteCanvasElements?: (request: {
    frameIndex: number;
    version: number;
    frameOffset: number;
    document: PreviewDocument;
  }) => Promise<CanvasEditResult>;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] as string);
}

function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * deck HTML 内の <img src> をローカルリソース変換にかける(移植計画 VS-8 の
 * 「ローカルファイルは asWebviewUri で URL へ変換する」)。renderer は
 * includegraphics / deckimage / logo をエスケープ済みの生パスで出すため、
 * http(s) / data / vscode-webview 系以外を resolve へ通す。
 */
export function rewriteImageSources(html: string, resolve: (path: string) => string): string {
  return html.replace(/(<img\b[^>]*\bsrc=")([^"]*)(")/g, (whole, pre, src, post) => {
    if (/^(?:https?:|data:|vscode-webview|vscode-resource:)/i.test(src)) return whole;
    return `${pre}${escapeAttr(resolve(unescapeAttr(src)))}${post}`;
  });
}

/** 画像 URL に再読込世代を付ける(0 = 初期状態では付けない)。同じ HTML でも src が変わり再取得される。 */
export function withAssetGeneration(url: string, generation: number): string {
  if (generation === 0) return url;
  return `${url}${url.includes("?") ? "&" : "?"}v=${generation}`;
}

/**
 * Webview の HTML。CSP は `default-src 'none'` を基本に必要な源だけを開ける
 * (移植計画 VS-8)。script は nonce 必須、style は ui / deck.css が動的に
 * <style> を注入するため 'unsafe-inline' を許可、img は拡張リソースと data: のみ。
 */
export function emptyPreviewHtml(assets: WebviewAssets, cspSource: string, nonce: string): string {
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    // KaTeX の CSS は版によって data: URL のフォントを含むため許可する
    `font-src ${cspSource} data:`,
    // pdf.js の worker は拡張の media から読む。Webview とは別オリジンなので blob: 経由で起動される。
    `script-src 'nonce-${nonce}' ${cspSource}`,
    `worker-src blob: ${cspSource}`,
  ].join("; ");
  const pdfWorker = assets.pdfWorkerUri ? ` data-pdf-worker="${assets.pdfWorkerUri}"` : "";
  return `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Beamer Editor Preview</title>
    <link rel="stylesheet" href="${assets.styleUri}" />
    <style>
      html, body { height: 100%; margin: 0; }
      #app { display: flex; height: 100%; }
    </style>
  </head>
  <body>
    <main id="app" aria-label="Beamer preview"${pdfWorker}></main>
    <script nonce="${nonce}" src="${assets.scriptUri}"></script>
  </body>
</html>`;
}

/** CSP 用の nonce(リクエストごとに使い捨て)。 */
function createNonce(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

/** Owns every disposable associated with one preview panel. */
export class PreviewController implements vscode.Disposable {
  private readonly disposables: { dispose(): void }[];
  private readonly render: (text: string, version: number) => RenderOutcome;
  private readonly onError: (message: string) => void;
  private readonly onWarning: (message: string) => void;
  private readonly navigate: (offset: number) => void;
  private readonly undoRedo: (kind: "undo" | "redo") => void | Promise<void>;
  private readonly resolveResource: ((path: string) => string) | undefined;
  private readonly setCanvasFontSize: PreviewControllerOptions["setCanvasFontSize"];
  private readonly resizeCanvasElement: PreviewControllerOptions["resizeCanvasElement"];
  private readonly onRendered: (outcome: RenderOutcome) => void;
  private readonly onWebviewReady: () => void;
  private readonly moveCanvasElement: PreviewControllerOptions["moveCanvasElement"];
  private readonly detachToCanvas: PreviewControllerOptions["detachToCanvas"];
  private readonly deleteCanvasElement: PreviewControllerOptions["deleteCanvasElement"];
  private readonly copyCanvasElement: PreviewControllerOptions["copyCanvasElement"];
  private readonly pasteCanvasElements: PreviewControllerOptions["pasteCanvasElements"];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /** 最後に成功したレンダリング結果。VS-4(ソースジャンプ)・VS-5(診断)が参照する。 */
  private latest: RenderOutcome | undefined;
  /** 画像の再読込世代。refresh ごとに進め、送る <img src> の query に付ける。 */
  private assetGeneration = 0;
  /** latest を生成した TextDocument。URI/version が偶然一致しても別 object は拒否する。 */
  private latestDocument: PreviewDocument | undefined;
  /**
   * WorkspaceEdit の完了から文書変更による再描画まで、同じ旧 version に対する
   * 追加 move を拒否する。位置更新同士が古い sourceSpan を奪い合うのを防ぐ。
   */
  private editApplyPending = false;
  private editAwaitingVersion: number | undefined;
  /**
   * Clipboard API は非同期なので、同じ Webview tick で届いた copy / cut / paste を
   * 旧 sourceSpan のまま並行実行しない。失敗した要求も後続を止めない。
   */
  private clipboardQueue: Promise<void> = Promise.resolve();
  /**
   * 描画前、または文書の version が最新の描画より進んでいる間(debounce 中)に届いた
   * ソース位置の表示要求。古い ExpansionMap で解かず、次の描画後に適用する。
   */
  private pendingReveal: { offset: number; onlyIfChanged: boolean } | undefined;
  /** 直近にソース側から表示させたフレーム。カーソル追従で同じフレーム内の移動を無視する。 */
  private lastRevealedFrame: number | undefined;

  /**
   * プレビュー対象の文書。エディタタブを閉じると TextDocument は close され
   * getText() が凍結するため、変更イベントが届くたびに最新のインスタンスへ
   * 差し替える(close → 再オープンで別インスタンスになる)。
   */
  private document: PreviewDocument;

  constructor(
    private readonly panel: PreviewPanel,
    assets: WebviewAssets,
    document: PreviewDocument,
    events: DocumentEvents,
    private readonly onDispose: () => void,
    options: PreviewControllerOptions = {},
  ) {
    this.document = document;
    this.render = options.render ?? renderDocument;
    this.onError = options.onError ?? (() => {});
    this.onWarning = options.onWarning ?? (() => {});
    this.navigate = options.navigate ?? (() => {});
    this.undoRedo = options.undoRedo ?? (() => {});
    this.resolveResource = options.resolveResource;
    this.setCanvasFontSize = options.setCanvasFontSize;
    this.resizeCanvasElement = options.resizeCanvasElement;
    this.onRendered = options.onRendered ?? (() => {});
    this.onWebviewReady = options.onWebviewReady ?? (() => {});
    this.moveCanvasElement = options.moveCanvasElement;
    this.detachToCanvas = options.detachToCanvas;
    this.deleteCanvasElement = options.deleteCanvasElement;
    this.copyCanvasElement = options.copyCanvasElement;
    this.pasteCanvasElements = options.pasteCanvasElements;
    this.panel.webview.html = emptyPreviewHtml(assets, this.panel.webview.cspSource, createNonce());
    this.disposables = [
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((raw) => this.handleMessage(raw)),
      events.onDidChangeTextDocument((event) => this.handleDocumentChange(event)),
    ];
  }

  /** 最後に成功したレンダリング結果(未成功なら undefined)。 */
  get latestOutcome(): RenderOutcome | undefined {
    return this.latest;
  }

  /**
   * 元ソースの offset を含むフレームをプレビューで表示する(#66: CodeLens・コマンド・カーソル追従)。
   * まだ描画していなければ描画後に適用する。onlyIfChanged は直近に表示したフレームと同じなら
   * 何もしない(カーソル追従で同じフレーム内の移動のたびにスクロールしないため)。
   */
  revealSourceOffset(offset: number, options: { onlyIfChanged?: boolean } = {}): void {
    if (this.disposed) return;
    const latest = this.latest;
    // move / detach と同じく、latest が今の文書の今の version を描いたものでなければ使わない。
    // 通常の編集では TextDocument object は同じまま version だけが進むので object 比較では足りない。
    if (
      !latest ||
      this.latestDocument !== this.document ||
      latest.version !== this.document.version
    ) {
      this.pendingReveal = { offset, onlyIfChanged: options.onlyIfChanged ?? false };
      return;
    }
    const frameIndex = frameIndexAtSourceOffset(latest, offset);
    if (frameIndex === null) return;
    if (options.onlyIfChanged && frameIndex === this.lastRevealedFrame) return;
    this.lastRevealedFrame = frameIndex;
    const message: ExtensionToWebview = {
      type: "activeFrameChanged",
      frameIndex,
      version: latest.version,
    };
    void this.panel.webview.postMessage(message);
  }

  /**
   * 文書以外の入力(テンプレートの .sty や画像)が変わったときに再描画する。画像だけが変わった場合は
   * frame HTML が同じ文字列になり Webview は <img> を作り直さないので、世代を進めて src 自体を変える。
   */
  refresh(): void {
    this.assetGeneration += 1;
    this.sendDeck();
  }

  private handleMessage(raw: unknown): void {
    // Webview のイベント契約は void のまま保つ。統合テストだけは下の待機可能な入口を使う。
    void this.dispatchMessage(raw);
  }

  /** 統合テスト用。Webview と同じメッセージ経路が処理を終えるまで待機する。 */
  handleMessageForTest(raw: unknown): Promise<void> {
    return this.dispatchMessage(raw);
  }

  private async dispatchMessage(raw: unknown): Promise<void> {
    const msg = parseWebviewToExtension(raw);
    if (!msg) return;
    if (msg.type === "ready") {
      this.onWebviewReady();
      this.sendDeck();
    } else if (msg.type === "jumpToSource") {
      this.handleJump(msg.frameIndex, msg.version);
    } else if (msg.type === "resizeCanvasElement" || msg.type === "setCanvasFontSize") {
      await this.handleCanvasStyle(msg);
    } else if (msg.type === "moveCanvasElement") {
      await this.handleMove(msg);
    } else if (msg.type === "detachToCanvas") {
      await this.handleDetach(msg);
    } else if (msg.type === "deleteCanvasElement") {
      await this.handleDelete(msg);
    } else if (msg.type === "copyCanvasElement") {
      await this.enqueueClipboard(() => this.handleCopy(msg));
    } else if (msg.type === "pasteCanvasElements") {
      await this.enqueueClipboard(() => this.handlePaste(msg));
    } else if (msg.type === "undoRedo") {
      // 注入された処理は同期で呼び出し、同期の例外も非同期の rejection も onError へ回す。
      const report = () => this.onError(`failed to ${msg.kind} the source document.`);
      try {
        await this.undoRedo(msg.kind);
      } catch {
        report();
      }
    }
    // activeFrameChanged はソース側カーソル追従(VS-5 以降)で使う予定(現状 no-op)。
  }

  private enqueueClipboard(operation: () => Promise<void>): Promise<void> {
    const queued = this.clipboardQueue.then(operation);
    // 各 operation は通常内部で例外を処理するが、将来の例外でもキューを恒久的に壊さない。
    this.clipboardQueue = queued.catch(() => {});
    return queued;
  }

  private async handleCanvasStyle(
    move: {
      frameIndex: number;
      elementId: string;
      version: number;
    } & ({ width: number } | { size: CanvasFontSize }),
  ): Promise<void> {
    if (this.editApplyPending || this.editAwaitingVersion !== undefined) return;
    const latest = this.latest;
    const frame = latest?.deck.frames[move.frameIndex];
    const element = frame?.canvasElements?.find(
      (candidate) => candidate.id === move.elementId && candidate.editable,
    );
    if (
      !latest ||
      this.latestDocument !== this.document ||
      move.version !== this.document.version ||
      latest.version !== this.document.version ||
      !frame ||
      !element ||
      ("width" in move
        ? !Number.isFinite(move.width) || move.width <= 0
        : element.kind !== "text" || !isCanvasFontSize(move.size))
    ) {
      this.sendDeck();
      return;
    }
    const width = "width" in move ? normalizeCanvasWidth(move.width) : null;
    if (
      "width" in move
        ? width === null || element.position.width === width
        : element.invalidFontSize === undefined && element.fontSize === move.size
    ) {
      this.sendDeck();
      return;
    }
    const { frameIndex, elementId, version } = move;
    const document = this.document;
    const expectedOptions = document
      .getText()
      .slice(element.sourceSpan.start, element.sourceSpan.end);
    this.editApplyPending = true;
    try {
      const request = {
        frameIndex,
        elementId,
        version,
        sourceSpan: element.sourceSpan,
        document,
        expectedOptions,
      };
      const result =
        "width" in move && width !== null
          ? await this.resizeCanvasElement?.({ ...request, width })
          : "size" in move
            ? await this.setCanvasFontSize?.({ ...request, size: move.size })
            : "failed";
      this.editApplyPending = false;
      if (this.disposed) return;
      if (result === "applied") {
        this.editAwaitingVersion = version;
        // applyEdit の変更イベントが Promise 解決より先に届いていた場合も、
        // 更新後の descriptor で確実にロックを解除する。
        if (this.document.version !== version) this.sendDeck();
        return;
      }
      if (result === "unchanged") {
        this.sendDeck();
        return;
      }
      if (result === "cancelled") {
        this.onWarning(
          "size" in move
            ? "Canvas text size was not updated. Try selecting it again."
            : "Canvas element width was not updated. Try dragging it again.",
        );
        this.sendDeck();
        return;
      }
    } catch {
      this.editApplyPending = false;
      if (this.disposed) return;
    }
    if (!this.disposed) {
      this.onError("failed to update canvas element style.");
      this.sendDeck();
    }
  }

  private async handleMove(move: {
    frameIndex: number;
    elementId: string;
    version: number;
    x: number;
    y: number;
  }): Promise<void> {
    if (this.editApplyPending || this.editAwaitingVersion !== undefined) return;
    const latest = this.latest;
    const frame = latest?.deck.frames[move.frameIndex];
    const element = frame?.canvasElements?.find(
      (candidate) => candidate.id === move.elementId && candidate.editable,
    );
    if (
      !latest ||
      this.latestDocument !== this.document ||
      move.version !== this.document.version ||
      latest.version !== this.document.version ||
      !frame ||
      !element ||
      !Number.isFinite(move.x) ||
      !Number.isFinite(move.y)
    ) {
      this.sendDeck();
      return;
    }
    // 座標は本文領域で止めない(余白・ページ外へのはみ出しは許容し、L012 が警告する。#152)。
    // 書く値は正規形の小数 3 桁で、丸めて現在位置と同じなら書かない。
    const x = roundCanvasCoordinate(move.x);
    const y = roundCanvasCoordinate(move.y);
    if (element.position.x === x && element.position.y === y) return;
    const { frameIndex, elementId, version } = move;
    const document = this.document;
    const expectedOptions = document
      .getText()
      .slice(element.sourceSpan.start, element.sourceSpan.end);
    this.editApplyPending = true;
    try {
      const result = await this.moveCanvasElement?.({
        frameIndex,
        elementId,
        version,
        x,
        y,
        sourceSpan: element.sourceSpan,
        document,
        expectedOptions,
      });
      this.editApplyPending = false;
      if (this.disposed) return;
      if (result === "applied") {
        this.editAwaitingVersion = version;
        // applyEdit の変更イベントが Promise 解決より先に届いていた場合も、
        // 更新後の descriptor で確実にロックを解除する。
        if (this.document.version !== version) this.sendDeck();
        return;
      }
      if (result === "unchanged") {
        this.sendDeck();
        return;
      }
      if (result === "cancelled") {
        this.onWarning("Canvas element position was not updated. Try dragging it again.");
        this.sendDeck();
        return;
      }
    } catch {
      this.editApplyPending = false;
      if (this.disposed) return;
    }
    if (!this.disposed) {
      this.onError("failed to update canvas element position.");
      this.sendDeck();
    }
  }

  /**
   * 「自由配置にする」(フロー要素 → deckcanvas)。move と同じく最新 version の文書にだけ
   * 適用し、展開後 span を元ソースへ厳密に戻せない(マクロ本体由来の)要素は断る。
   */
  private async handleDetach(request: {
    frameIndex: number;
    version: number;
    sourceSpan: { start: number; end: number };
    rect: { x: number; y: number; width: number };
  }): Promise<void> {
    if (this.editApplyPending || this.editAwaitingVersion !== undefined) return;
    const latest = this.latest;
    if (
      !latest ||
      this.latestDocument !== this.document ||
      request.version !== this.document.version ||
      latest.version !== this.document.version ||
      !latest.deck.frames[request.frameIndex]
    ) {
      this.sendDeck();
      return;
    }
    const sourceSpan = mapExpandedRangeToSourceExact(latest.expansionMap, request.sourceSpan);
    if (sourceSpan === null) {
      this.onWarning("マクロ展開由来の要素は自由配置にできません。");
      return;
    }
    const { frameIndex, version } = request;
    const document = this.document;
    this.editApplyPending = true;
    try {
      const result = await this.detachToCanvas?.({
        frameIndex,
        version,
        sourceSpan,
        placement: toCanvasPlacement(request.rect),
        document,
      });
      this.editApplyPending = false;
      if (this.disposed) return;
      if (result === "applied") {
        this.editAwaitingVersion = version;
        if (this.document.version !== version) this.sendDeck();
        return;
      }
      if (result === "unchanged") {
        this.sendDeck();
        return;
      }
      if (result === "cancelled") {
        this.onWarning("この要素は自由配置にできませんでした。");
        this.sendDeck();
        return;
      }
    } catch {
      this.editApplyPending = false;
      if (this.disposed) return;
    }
    if (!this.disposed) {
      this.onError("failed to move the element to the canvas.");
      this.sendDeck();
    }
  }

  /**
   * 要求が指す editable なキャンバス要素の最新 descriptor。プレビューが古い版を見ていれば undefined
   * (move と同じ条件)。
   */
  private currentCanvasElement(request: {
    frameIndex: number;
    elementId: string;
    version: number;
  }): RenderedCanvasElement | undefined {
    const latest = this.latest;
    const frame = latest?.deck.frames[request.frameIndex];
    const element = frame?.canvasElements?.find(
      (candidate) => candidate.id === request.elementId && candidate.editable,
    );
    if (
      !latest ||
      this.latestDocument !== this.document ||
      request.version !== this.document.version ||
      latest.version !== this.document.version ||
      !frame ||
      !element
    )
      return undefined;
    return element;
  }

  /** 選択中のキャンバス要素を取り除く(Delete。#148)。move と同じく最新 version の文書にだけ適用する。 */
  private async handleDelete(request: {
    frameIndex: number;
    elementId: string;
    version: number;
  }): Promise<void> {
    if (this.editApplyPending || this.editAwaitingVersion !== undefined) return;
    const element = this.currentCanvasElement(request);
    if (!element) {
      this.sendDeck();
      return;
    }
    const { frameIndex, elementId, version } = request;
    const document = this.document;
    const expectedOptions = document
      .getText()
      .slice(element.sourceSpan.start, element.sourceSpan.end);
    this.editApplyPending = true;
    try {
      const result = await this.deleteCanvasElement?.({
        frameIndex,
        elementId,
        version,
        sourceSpan: element.sourceSpan,
        document,
        expectedOptions,
      });
      this.editApplyPending = false;
      if (this.disposed) return;
      if (result === "applied") {
        this.editAwaitingVersion = version;
        if (this.document.version !== version) this.sendDeck();
        return;
      }
      if (result === "unchanged") {
        this.sendDeck();
        return;
      }
      if (result === "cancelled") {
        this.onWarning("キャンバス要素を削除できませんでした。選び直してください。");
        this.sendDeck();
        return;
      }
    } catch {
      this.editApplyPending = false;
      if (this.disposed) return;
    }
    if (!this.disposed) {
      this.onError("failed to delete the canvas element.");
      this.sendDeck();
    }
  }

  /** 選択中のキャンバス要素のソースをクリップボードへ写す(Cmd+C)。cut(Cmd+X)なら続けて取り除く。 */
  private async handleCopy(request: {
    frameIndex: number;
    elementId: string;
    version: number;
    cut: boolean;
  }): Promise<void> {
    const element = this.currentCanvasElement(request);
    if (!element) {
      this.sendDeck();
      return;
    }
    const { frameIndex, elementId, version } = request;
    const document = this.document;
    const expectedOptions = document
      .getText()
      .slice(element.sourceSpan.start, element.sourceSpan.end);
    let copied = false;
    try {
      copied =
        (await this.copyCanvasElement?.({
          frameIndex,
          elementId,
          version,
          sourceSpan: element.sourceSpan,
          document,
          expectedOptions,
        })) === true;
    } catch {
      copied = false;
    }
    if (this.disposed) return;
    if (!copied) {
      this.onError("failed to copy the canvas element.");
      return;
    }
    if (request.cut) await this.handleDelete(request);
  }

  /** クリップボードのキャンバス要素を、表示中のフレームへ貼り付ける(Cmd+V。#148)。 */
  private async handlePaste(request: { frameIndex: number; version: number }): Promise<void> {
    if (this.editApplyPending || this.editAwaitingVersion !== undefined) return;
    const latest = this.latest;
    if (
      !latest ||
      this.latestDocument !== this.document ||
      request.version !== this.document.version ||
      latest.version !== this.document.version
    ) {
      this.sendDeck();
      return;
    }
    const frameOffset = resolveJumpOffset(latest, request.frameIndex);
    if (frameOffset === null) return;
    const { frameIndex, version } = request;
    const document = this.document;
    this.editApplyPending = true;
    try {
      const result = await this.pasteCanvasElements?.({
        frameIndex,
        version,
        frameOffset,
        document,
      });
      this.editApplyPending = false;
      if (this.disposed) return;
      if (result === "applied") {
        this.editAwaitingVersion = version;
        if (this.document.version !== version) this.sendDeck();
        return;
      }
      if (result === "unchanged") {
        this.sendDeck();
        return;
      }
      if (result === "cancelled") {
        this.onWarning("クリップボードにキャンバスの要素(decktext / deckimage)がありません。");
        return;
      }
    } catch {
      this.editApplyPending = false;
      if (this.disposed) return;
    }
    if (!this.disposed) {
      this.onError("failed to paste canvas elements.");
      this.sendDeck();
    }
  }

  /**
   * プレビューからのソースジャンプ(VS-4)。プレビューが古い文書バージョンを参照して
   * いた場合(未 debounce の編集が保留中の場合を含む)は移動せず、再描画だけを送る。
   */
  private handleJump(frameIndex: number, version: number): void {
    const latest = this.latest;
    if (!latest || version !== this.document.version || latest.version !== this.document.version) {
      this.sendDeck();
      return;
    }
    const offset = resolveJumpOffset(latest, frameIndex);
    if (offset === null) return;
    this.navigate(offset);
  }

  /**
   * 対象文書の内容変更だけを debounce して再レンダリングする(VS-3 手順 2〜3)。
   * 保存などで contentChanges が空のイベントは更新の条件にしない(VS-3 手順 5)。
   */
  private handleDocumentChange(event: PreviewDocumentChangeEvent): void {
    if (this.disposed) return;
    if (event.document.uri.toString() !== this.document.uri.toString()) return;
    // close → 再オープンで新しい TextDocument になっても追従できるよう差し替える。
    this.document = event.document;
    if (event.contentChanges.length === 0) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.sendDeck(), RENDER_DEBOUNCE_MS);
  }

  /**
   * debounce 発火時点の全文と version を読むため、古い内容を送ることはない
   * (レンダリングは同期で、送信順 = version 昇順が保たれる)。
   * 予期しない例外時は deckUpdated を送らず最後に成功したプレビューを残し、
   * error メッセージと onError で通知だけする(VS-3 のエラー方針)。
   */
  private sendDeck(): void {
    if (this.disposed) return;
    let message: ExtensionToWebview;
    try {
      const renderedDocument = this.document;
      const outcome = this.render(renderedDocument.getText(), renderedDocument.version);
      this.latest = outcome;
      this.latestDocument = renderedDocument;
      this.onRendered(outcome);
      if (this.editAwaitingVersion !== undefined && outcome.version !== this.editAwaitingVersion) {
        this.editAwaitingVersion = undefined;
      }
      const resolve = this.resolveResource;
      const generation = this.assetGeneration;
      const deck = resolve
        ? {
            ...outcome.deck,
            frames: outcome.deck.frames.map((frame) => ({
              ...frame,
              html: rewriteImageSources(frame.html, (path) =>
                withAssetGeneration(resolve(path), generation),
              ),
            })),
          }
        : outcome.deck;
      message = {
        type: "deckUpdated",
        deck,
        version: outcome.version,
        activeFrame: 0,
      };
    } catch (err) {
      const text = String(err);
      this.onError(text);
      message = { type: "error", message: text };
    }
    void this.panel.webview.postMessage(message);
    if (message.type === "deckUpdated") {
      // フレーム番号は描画ごとに変わり得るので、追従の既読は描画単位でリセットする。
      this.lastRevealedFrame = undefined;
      if (this.pendingReveal !== undefined) {
        const { offset, onlyIfChanged } = this.pendingReveal;
        this.pendingReveal = undefined;
        this.revealSourceOffset(offset, { onlyIfChanged });
      }
    }
  }

  close(): void {
    this.panel.dispose();
    this.dispose();
  }

  /** 生ブロックの部分コンパイル結果を Webview へ送る(#81)。 */
  postRawBlockReady(key: string, pdf: Uint8Array): void {
    if (this.disposed) return;
    const message: ExtensionToWebview = {
      type: "rawBlockReady",
      key,
      pdfBase64: Buffer.from(pdf).toString("base64"),
    };
    void this.panel.webview.postMessage(message);
  }

  postRawBlockFailed(key: string, message: string): void {
    if (this.disposed) return;
    const msg: ExtensionToWebview = { type: "rawBlockFailed", key, message };
    void this.panel.webview.postMessage(msg);
  }

  /** 部分コンパイルを切ったとき、Webview 側の差し込み済み画像を捨てる。 */
  postRawImagesCleared(): void {
    if (this.disposed) return;
    const message: ExtensionToWebview = { type: "rawImagesCleared" };
    void this.panel.webview.postMessage(message);
  }

  /**
   * 既存パネルを前面に出す(同じグループの別タブの後ろに隠れていても表示する)。
   * preserveFocus はソース側の操作(#66)から呼ぶときに使い、フォーカスをソースに残す。
   */
  reveal(preserveFocus = false): void {
    this.panel.reveal(undefined, preserveFocus);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.onDispose();
  }
}
