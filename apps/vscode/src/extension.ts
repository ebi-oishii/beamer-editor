import * as vscode from "vscode";
import { PreviewController } from "./preview-controller";

let previewController: PreviewController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("beamerEditor.openPreview", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.uri.scheme !== "file" || !editor.document.fileName.endsWith(".tex")) {
        void vscode.window.showErrorMessage("Open a .tex file before opening a Beamer preview.");
        return;
      }

      previewController?.close();
      const panel = vscode.window.createWebviewPanel(
        "beamerEditor.preview",
        `Beamer Preview: ${editor.document.fileName.split(/[\\/]/).pop()}`,
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
        },
      );

      const webviewScriptUri = panel.webview
        .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "webview.js"))
        .toString();
      const controller = new PreviewController(panel, webviewScriptUri, editor.document, () => {
        if (previewController === controller) {
          previewController = undefined;
        }
      });
      previewController = controller;
    }),
  );
}

export function deactivate(): void {
  previewController?.close();
  previewController = undefined;
}
