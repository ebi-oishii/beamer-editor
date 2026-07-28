import type * as vscode from "vscode";

export interface PreviewPanel {
  readonly webview: Pick<vscode.Webview, "html">;
  onDidDispose(listener: () => void): vscode.Disposable;
  dispose(): void;
}

export function emptyPreviewHtml(webviewScriptUri: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Beamer Editor Preview</title>
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
    private readonly onDispose: () => void,
  ) {
    this.panel.webview.html = emptyPreviewHtml(webviewScriptUri);
    this.disposables = [this.panel.onDidDispose(() => this.dispose())];
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
