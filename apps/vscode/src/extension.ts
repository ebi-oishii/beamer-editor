import * as vscode from "vscode";
import { PreviewController } from "./preview-controller";

let previewController: PreviewController | undefined;

/**
 * ジャンプ先の行を短時間だけ強調する decoration(VS-4)。選択だけだと移動に気づき
 * にくいため、テーマの検索ハイライト色で 500ms 光らせる。エディタ全体は光らせない。
 */
function createLineFlash(): { flash(editor: vscode.TextEditor, range: vscode.Range): void } & {
  dispose(): void;
} {
  const decoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
    isWholeLine: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastEditor: vscode.TextEditor | undefined;
  return {
    flash(editor, range) {
      clearTimeout(timer);
      lastEditor?.setDecorations(decoration, []);
      editor.setDecorations(decoration, [range]);
      lastEditor = editor;
      timer = setTimeout(() => {
        editor.setDecorations(decoration, []);
        lastEditor = undefined;
      }, 500);
    },
    dispose() {
      clearTimeout(timer);
      decoration.dispose();
    },
  };
}

/**
 * 元ソースの UTF-16 オフセットへエディタを移動する(移植計画 VS-4 手順 2〜7)。
 * AST の offset は JavaScript 文字列と同じ UTF-16 なので、境界変換は
 * TextDocument.positionAt に任せ、独自の行・列計算を持たない。
 */
async function jumpToOffset(
  document: vscode.TextDocument,
  offset: number,
  lineFlash: ReturnType<typeof createLineFlash>,
): Promise<void> {
  const editor = await vscode.window.showTextDocument(document);
  const position = document.positionAt(offset);
  const range = document.lineAt(position.line).range;
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  lineFlash.flash(editor, range);
}

export function activate(context: vscode.ExtensionContext): void {
  const lineFlash = createLineFlash();
  context.subscriptions.push(lineFlash);
  context.subscriptions.push(
    vscode.commands.registerCommand("beamerEditor.openPreview", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.uri.scheme !== "file" || !editor.document.fileName.endsWith(".tex")) {
        void vscode.window.showErrorMessage("Open a .tex file before opening a Beamer preview.");
        return;
      }

      previewController?.close();
      const document = editor.document;
      const panel = vscode.window.createWebviewPanel(
        "beamerEditor.preview",
        `Beamer Preview: ${document.fileName.split(/[\\/]/).pop()}`,
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
        },
      );

      const webviewScriptUri = panel.webview
        .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "webview.js"))
        .toString();
      const controller = new PreviewController(
        panel,
        webviewScriptUri,
        document,
        {
          onDidChangeTextDocument: (listener) => vscode.workspace.onDidChangeTextDocument(listener),
        },
        () => {
          if (previewController === controller) {
            previewController = undefined;
          }
        },
        {
          onError: (message) => {
            void vscode.window.showErrorMessage(`Beamer preview: ${message}`);
          },
          navigate: (offset) => {
            void jumpToOffset(document, offset, lineFlash);
          },
        },
      );
      previewController = controller;
    }),
  );
}

export function deactivate(): void {
  previewController?.close();
  previewController = undefined;
}
