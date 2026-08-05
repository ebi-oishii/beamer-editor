import {
  canvasImagePositionReplacement,
  type LintDiagnostic,
  type LintSeverity,
} from "@beamer-editor/core";
import * as vscode from "vscode";
import { LintController } from "./diagnostics";
import { PreviewController } from "./preview-controller";

let previewController: PreviewController | undefined;

const LINT_SEVERITIES: Record<LintSeverity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

/** core の LintDiagnostic を VS Code の Diagnostic へ変換する(移植計画 VS-5)。 */
function toVscodeDiagnostic(
  document: vscode.TextDocument,
  lint: LintDiagnostic,
): vscode.Diagnostic {
  const range = new vscode.Range(
    document.positionAt(lint.span.start),
    document.positionAt(lint.span.end),
  );
  const diagnostic = new vscode.Diagnostic(range, lint.message, LINT_SEVERITIES[lint.severity]);
  diagnostic.code = lint.code;
  diagnostic.source = "beamer-editor";
  return diagnostic;
}

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

/** 統合テストからの観測用 API(activate の戻り値)。製品コードから参照しない。 */
export interface TestApi {
  _previewControllerForTest(): PreviewController | undefined;
}

export function activate(context: vscode.ExtensionContext): TestApi {
  const lineFlash = createLineFlash();
  context.subscriptions.push(lineFlash);

  // lint → Problems パネル・波線(VS-5)。開いている .tex 文書ごとに独立管理する。
  const diagnosticCollection = vscode.languages.createDiagnosticCollection("beamer-editor");
  const lintController = new LintController<vscode.TextDocument>(
    {
      onDidOpenTextDocument: (listener) => vscode.workspace.onDidOpenTextDocument(listener),
      onDidChangeTextDocument: (listener) => vscode.workspace.onDidChangeTextDocument(listener),
      onDidCloseTextDocument: (listener) => vscode.workspace.onDidCloseTextDocument(listener),
    },
    {
      set: (document, diagnostics) => {
        diagnosticCollection.set(
          document.uri,
          diagnostics.map((lint) => toVscodeDiagnostic(document, lint)),
        );
      },
      delete: (document) => diagnosticCollection.delete(document.uri),
    },
    vscode.workspace.textDocuments,
  );
  context.subscriptions.push(diagnosticCollection, lintController);

  context.subscriptions.push(
    vscode.commands.registerCommand("beamerEditor.openPreview", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.uri.scheme !== "file" || !editor.document.fileName.endsWith(".tex")) {
        void vscode.window.showErrorMessage("Open a .tex file before opening a Beamer preview.");
        return;
      }

      previewController?.close();
      const document = editor.document;
      // 画像(includegraphics / deckimage / logo)は文書からの相対パスで参照される
      // ため、文書のあるフォルダだけを workspace 側のリソース範囲として開ける。
      const documentDir = vscode.Uri.joinPath(document.uri, "..");
      const panel = vscode.window.createWebviewPanel(
        "beamerEditor.preview",
        `Beamer Preview: ${document.fileName.split(/[\\/]/).pop()}`,
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media"), documentDir],
        },
      );

      const mediaUri = (name: string) =>
        panel.webview
          .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", name))
          .toString();
      const controller = new PreviewController(
        panel,
        { scriptUri: mediaUri("webview.js"), styleUri: mediaUri("webview.css") },
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
          onWarning: (message) => {
            void vscode.window.showWarningMessage(`Beamer preview: ${message}`);
          },
          navigate: (offset) => {
            // タブを閉じて close された場合、元の TextDocument は凍結するため
            // 同じ uri の最新インスタンスを引き直してからジャンプする。
            const target =
              vscode.workspace.textDocuments.find(
                (candidate) => candidate.uri.toString() === document.uri.toString(),
              ) ?? document;
            void jumpToOffset(target, offset, lineFlash);
          },
          resolveResource: (path) => {
            const uri = path.startsWith("/")
              ? vscode.Uri.file(path)
              : vscode.Uri.joinPath(documentDir, path);
            return panel.webview.asWebviewUri(uri).toString();
          },
          moveCanvasElement: async (move) => {
            const target = vscode.workspace.textDocuments.find(
              (candidate) => candidate === move.document,
            );
            if (
              !target ||
              target.uri.toString() !== move.document.uri.toString() ||
              target.version !== move.version
            )
              return "cancelled";
            const original = target.getText().slice(move.sourceSpan.start, move.sourceSpan.end);
            if (original !== move.expectedOptions) return "cancelled";
            const replacement = canvasImagePositionReplacement(original, move.x, move.y);
            if (replacement === null) return "failed";
            if (replacement === original) return "unchanged";
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
              target.uri,
              new vscode.Range(
                target.positionAt(move.sourceSpan.start),
                target.positionAt(move.sourceSpan.end),
              ),
              replacement,
            );
            return (await vscode.workspace.applyEdit(edit)) ? "applied" : "failed";
          },
        },
      );
      previewController = controller;
    }),
  );

  return { _previewControllerForTest: () => previewController };
}

export function deactivate(): void {
  previewController?.close();
  previewController = undefined;
}
