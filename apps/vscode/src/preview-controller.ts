import { mapExpandedRangeToSourceExact } from "@beamer-editor/core";
import { DEFAULT_THEME } from "@beamer-editor/renderer";
import type { ExtensionToWebview } from "@beamer-editor/ui";
import { parseWebviewToExtension } from "@beamer-editor/ui";
import type * as vscode from "vscode";
import { type RenderOutcome, renderDocument } from "./document-controller";
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
  onDidChangeViewState(
    listener: (event: { webviewPanel: { active: boolean } }) => void,
  ): vscode.Disposable;
  reveal(): void;
  dispose(): void;
}

/** Webview へ読み込ませるビルド済みアセット(asWebviewUri 変換済みの URL)。 */
export interface WebviewAssets {
  scriptUri: string;
  styleUri: string;
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
  /**
   * 画像などローカルリソースのパスを Webview で読める URI へ変換する
   * (asWebviewUri。extension.ts が注入)。未指定なら書き換えない。
   */
  resolveResource?: (path: string) => string;
  /** 有効な canvas image の source update。VS Code host の結果を返す。 */
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
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
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
    <main id="app" aria-label="Beamer preview"></main>
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
  private readonly resolveResource: ((path: string) => string) | undefined;
  private readonly moveCanvasElement: PreviewControllerOptions["moveCanvasElement"];
  private readonly detachToCanvas: PreviewControllerOptions["detachToCanvas"];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /** 最後に成功したレンダリング結果。VS-4(ソースジャンプ)・VS-5(診断)が参照する。 */
  private latest: RenderOutcome | undefined;
  /** latest を生成した TextDocument。URI/version が偶然一致しても別 object は拒否する。 */
  private latestDocument: PreviewDocument | undefined;
  /**
   * WorkspaceEdit の完了から文書変更による再描画まで、同じ旧 version に対する
   * 追加 move を拒否する。位置更新同士が古い sourceSpan を奪い合うのを防ぐ。
   */
  private editApplyPending = false;
  private editAwaitingVersion: number | undefined;

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
    this.resolveResource = options.resolveResource;
    this.moveCanvasElement = options.moveCanvasElement;
    this.detachToCanvas = options.detachToCanvas;
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

  private handleMessage(raw: unknown): void {
    const msg = parseWebviewToExtension(raw);
    if (!msg) return;
    if (msg.type === "ready") {
      this.sendDeck();
    } else if (msg.type === "jumpToSource") {
      this.handleJump(msg.frameIndex, msg.version);
    } else if (msg.type === "moveCanvasElement") {
      void this.handleMove(msg);
    } else if (msg.type === "detachToCanvas") {
      void this.handleDetach(msg);
    }
    // activeFrameChanged はソース側カーソル追従(VS-5 以降)で使う予定(現状 no-op)。
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
    if (element.position.x === move.x && element.position.y === move.y) return;
    const { frameIndex, elementId, version, x, y } = move;
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
      if (this.editAwaitingVersion !== undefined && outcome.version !== this.editAwaitingVersion) {
        this.editAwaitingVersion = undefined;
      }
      const resolve = this.resolveResource;
      const deck = resolve
        ? {
            ...outcome.deck,
            frames: outcome.deck.frames.map((frame) => ({
              ...frame,
              html: rewriteImageSources(frame.html, resolve),
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
  }

  close(): void {
    this.panel.dispose();
    this.dispose();
  }

  /** 既存パネルを前面に出す。手動 Open Preview の再実行時に使う。 */
  reveal(): void {
    this.panel.reveal();
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
