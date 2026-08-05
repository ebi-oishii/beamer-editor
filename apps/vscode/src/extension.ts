import type { LintDiagnostic, LintSeverity } from "@beamer-editor/core";
import * as vscode from "vscode";
import { LintController } from "./diagnostics";
import {
  AutoPreviewDismissals,
  appendUniqueIgnorePatterns,
  DEFAULT_MANAGED_FILE_PATTERNS,
  globalOrDefaultArray,
  isManagedDocument,
  needsLatexWorkshopIgnorePrompt,
  PreviewRegistry,
} from "./managed-files";
import { PreviewController } from "./preview-controller";

let previewController: PreviewController | undefined;
const previewControllers = new PreviewRegistry<PreviewController, vscode.TextDocument>();
let latexWorkshopPrompted = false;
const dismissedAutoPreviewUris = new AutoPreviewDismissals();
const configurationClosedAutoPreviewUris = new Set<string>();

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
  const openDocumentUris = new Set(
    vscode.workspace.textDocuments.map((document) => document.uri.toString()),
  );
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
    (document) => isManagedDocument(document, managedPatterns(document), matchesManagedGlob),
  );
  context.subscriptions.push(diagnosticCollection, lintController);

  function managedPatterns(document: vscode.TextDocument): readonly string[] {
    return (
      vscode.workspace
        .getConfiguration("beamerEditor", document.uri)
        .get<readonly string[]>("managedFiles") ?? DEFAULT_MANAGED_FILE_PATTERNS
    );
  }

  function matchesManagedGlob(document: vscode.TextDocument, pattern: string): boolean {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const glob: vscode.GlobPattern = workspaceFolder
      ? new vscode.RelativePattern(workspaceFolder, pattern)
      : pattern;
    return vscode.languages.match({ scheme: "file", pattern: glob }, document) > 0;
  }

  async function offerLatexWorkshopIgnore(document: vscode.TextDocument): Promise<void> {
    if (latexWorkshopPrompted || !vscode.extensions.getExtension("James-Yu.latex-workshop")) return;
    const patterns = managedPatterns(document);
    const workshop = vscode.workspace.getConfiguration("latex-workshop", document.uri);
    const watchIgnore = globalOrDefaultArray(
      workshop.inspect<readonly string[]>("latex.watch.files.ignore"),
    );
    const autoBuildIgnore = globalOrDefaultArray(
      workshop.inspect<readonly string[]>("latex.autoBuild.onSave.files.ignore"),
    );
    if (!needsLatexWorkshopIgnorePrompt(watchIgnore, autoBuildIgnore, patterns)) return;
    latexWorkshopPrompted = true;

    const choice = await vscode.window.showInformationMessage(
      "Beamer Editor の managed slide files を LaTeX Workshop の自動監視・保存時自動ビルドから除外しますか？通常の .tex の設定は変更しません。",
      "Global Settings に追加",
    );
    if (choice !== "Global Settings に追加") return;
    await Promise.all([
      workshop.update(
        "latex.watch.files.ignore",
        appendUniqueIgnorePatterns(watchIgnore, patterns),
        vscode.ConfigurationTarget.Global,
      ),
      workshop.update(
        "latex.autoBuild.onSave.files.ignore",
        appendUniqueIgnorePatterns(autoBuildIgnore, patterns),
        vscode.ConfigurationTarget.Global,
      ),
    ]);
  }

  function openPreview(document: vscode.TextDocument, automatic: boolean): void {
    const uri = document.uri.toString();
    const existing = previewControllers.get(document.uri);
    if (existing) {
      if (!automatic) {
        previewControllers.promoteManual(document.uri);
        existing.controller.reveal();
        previewController = existing.controller;
      }
      return;
    }
    if (automatic && dismissedAutoPreviewUris.has(document.uri)) return;

    // 画像(includegraphics / deckimage / logo)は文書からの相対パスで参照される
    // ため、文書のあるフォルダだけを workspace 側のリソース範囲として開ける。
    const documentDir = vscode.Uri.joinPath(document.uri, "..");
    const panel = vscode.window.createWebviewPanel(
      "beamerEditor.preview",
      `Beamer Preview: ${document.fileName.split(/[\\/]/).pop()}`,
      automatic
        ? { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }
        : vscode.ViewColumn.Beside,
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
        const owner = previewControllers.get(document.uri);
        if (owner?.controller === controller && owner.automatic) {
          if (!configurationClosedAutoPreviewUris.delete(uri)) {
            dismissedAutoPreviewUris.dismiss(document.uri, openDocumentUris.has(uri));
          }
        }
        previewControllers.delete(document.uri);
        if (previewController === controller) previewController = undefined;
      },
      {
        onError: (message) => {
          void vscode.window.showErrorMessage(`Beamer preview: ${message}`);
        },
        navigate: (offset) => {
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
      },
    );
    previewControllers.add(document.uri, { controller, document, automatic });
    previewController = controller;
  }

  function handleManagedDocument(document: vscode.TextDocument | undefined): void {
    if (!document || !isManagedDocument(document, managedPatterns(document), matchesManagedGlob))
      return;
    openPreview(document, true);
    void offerLatexWorkshopIgnore(document).catch((error) => {
      void vscode.window.showErrorMessage(
        `Beamer Editor: LaTeX Workshop settings update failed: ${String(error)}`,
      );
    });
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      openDocumentUris.add(document.uri.toString());
      dismissedAutoPreviewUris.clear(document.uri);
      handleManagedDocument(document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      openDocumentUris.delete(document.uri.toString());
      dismissedAutoPreviewUris.clear(document.uri);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => handleManagedDocument(editor?.document)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("beamerEditor.managedFiles")) return;
      dismissedAutoPreviewUris.clearAll();
      latexWorkshopPrompted = false;
      lintController.refresh(vscode.workspace.textDocuments);
      for (const owner of previewControllers.automaticEntries()) {
        if (
          owner.automatic &&
          !isManagedDocument(owner.document, managedPatterns(owner.document), matchesManagedGlob)
        ) {
          configurationClosedAutoPreviewUris.add(owner.document.uri.toString());
          owner.controller.close();
        }
      }
      handleManagedDocument(vscode.window.activeTextEditor?.document);
    }),
  );
  handleManagedDocument(vscode.window.activeTextEditor?.document);

  context.subscriptions.push(
    vscode.commands.registerCommand("beamerEditor.openPreview", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.uri.scheme !== "file" || !editor.document.fileName.endsWith(".tex")) {
        void vscode.window.showErrorMessage("Open a .tex file before opening a Beamer preview.");
        return;
      }

      const existing = previewControllers.get(editor.document.uri);
      if (existing) {
        previewControllers.promoteManual(editor.document.uri);
        existing.controller.reveal();
        previewController = existing.controller;
        return;
      }
      openPreview(editor.document, false);
    }),
  );

  return { _previewControllerForTest: () => previewController };
}

export function deactivate(): void {
  for (const [, owner] of [...previewControllers.entries()]) owner.controller.close();
  previewController = undefined;
  dismissedAutoPreviewUris.clearAll();
  configurationClosedAutoPreviewUris.clear();
  latexWorkshopPrompted = false;
}
