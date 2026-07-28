import { parseDeck } from "@beamer-editor/core";
import { renderDeck } from "@beamer-editor/renderer";
import type { ExtensionToWebview } from "@beamer-editor/ui";
import { parseWebviewToExtension } from "@beamer-editor/ui";
import type * as vscode from "vscode";

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
export type PreviewDocument = Pick<vscode.TextDocument, "getText" | "version">;

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
  private readonly disposables: vscode.Disposable[];
  private disposed = false;

  constructor(
    private readonly panel: PreviewPanel,
    webviewScriptUri: string,
    private readonly document: PreviewDocument,
    private readonly onDispose: () => void,
  ) {
    this.panel.webview.html = emptyPreviewHtml(webviewScriptUri);
    this.disposables = [
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((raw) => this.handleMessage(raw)),
    ];
  }

  /**
   * VS-2 の最小 seam: Webview の ready を受けたら 1 回だけ render して deck を送る。
   * live な onDidChangeTextDocument 追従・debounce・version staleness は VS-3 の範囲（ここでは入れない）。
   * jumpToSource / activeFrameChanged は VS-3/VS-4 で実装するため現状 no-op。
   */
  private handleMessage(raw: unknown): void {
    const msg = parseWebviewToExtension(raw);
    if (!msg) return;
    if (msg.type === "ready") {
      this.sendDeck();
    }
    // jumpToSource / activeFrameChanged: VS-3/VS-4 で実装（現状 no-op）。
  }

  private sendDeck(): void {
    let message: ExtensionToWebview;
    try {
      const deck = renderDeck(parseDeck(this.document.getText()));
      message = { type: "deckUpdated", deck, version: this.document.version, activeFrame: 0 };
    } catch (err) {
      message = { type: "error", message: String(err) };
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
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.onDispose();
  }
}
