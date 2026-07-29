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
  readonly webview: Pick<vscode.Webview, "html"> & {
    postMessage(msg: unknown): Thenable<boolean>;
    onDidReceiveMessage(listener: (msg: unknown) => void): vscode.Disposable;
  };
  onDidDispose(listener: () => void): vscode.Disposable;
  dispose(): void;
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

export interface PreviewControllerOptions {
  /** レンダリングパイプラインの差し替え口(テスト用)。既定は renderDocument。 */
  render?: (text: string, version: number) => RenderOutcome;
  /** 予期しないレンダリング例外の通知先(既定は何もしない)。 */
  onError?: (message: string) => void;
  /**
   * ソースジャンプの実行先(元ソースの UTF-16 オフセットを受け取る)。
   * エディタ操作は vscode API が要るため extension.ts が注入する。既定は何もしない。
   */
  navigate?: (offset: number) => void;
}

export function emptyPreviewHtml(webviewScriptUri: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Beamer Editor Preview</title>
    <style>
      html, body { height: 100%; margin: 0; }
      #app { display: flex; height: 100%; }
    </style>
  </head>
  <body>
    <main id="app" aria-label="Beamer preview"></main>
    <script src="${webviewScriptUri}"></script>
  </body>
</html>`;
}

/** Owns every disposable associated with one preview panel. */
export class PreviewController implements vscode.Disposable {
  private readonly disposables: { dispose(): void }[];
  private readonly render: (text: string, version: number) => RenderOutcome;
  private readonly onError: (message: string) => void;
  private readonly navigate: (offset: number) => void;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /** 最後に成功したレンダリング結果。VS-4(ソースジャンプ)・VS-5(診断)が参照する。 */
  private latest: RenderOutcome | undefined;

  constructor(
    private readonly panel: PreviewPanel,
    webviewScriptUri: string,
    private readonly document: PreviewDocument,
    events: DocumentEvents,
    private readonly onDispose: () => void,
    options: PreviewControllerOptions = {},
  ) {
    this.render = options.render ?? renderDocument;
    this.onError = options.onError ?? (() => {});
    this.navigate = options.navigate ?? (() => {});
    this.panel.webview.html = emptyPreviewHtml(webviewScriptUri);
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
    }
    // activeFrameChanged はソース側カーソル追従(VS-5 以降)で使う予定(現状 no-op)。
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
      const outcome = this.render(this.document.getText(), this.document.version);
      this.latest = outcome;
      message = {
        type: "deckUpdated",
        deck: outcome.deck,
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
