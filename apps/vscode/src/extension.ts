import { realpathSync } from "node:fs";
import * as path from "node:path";
import {
  buildFragmentDocument,
  compileFragment,
  compilePdf,
  FRAGMENT_DOCUMENT_VERSION,
  fragmentDependencies,
  PdfExportError,
  type PdfExportResult,
  type PdfReviewArtifact,
  pdfFileIdentity,
  publishPdf,
} from "@beamer-editor/compiler";
import {
  canvasFontSizeReplacement,
  canvasObjectSource,
  canvasPositionReplacement,
  canvasWidthReplacement,
  detachBlockToCanvas,
  fragmentHash,
  graphicsPathsOf,
  type LintDiagnostic,
  type LintOptions,
  type LintSeverity,
  parseDeck,
  pasteCanvasObjects,
  removeCanvasObject,
} from "@beamer-editor/core";
import {
  editingPreviewOptions,
  nodeTemplateFileSystem,
  templateStatuses,
} from "@beamer-editor/html-export";
import type { PreviewSourceDiagnostic } from "@beamer-editor/renderer";
import { MAX_RAW_PDF_BYTES } from "@beamer-editor/ui";
import * as vscode from "vscode";
import { canvasHoverAt } from "./canvas-hover";
import { LintController } from "./diagnostics";
import { type RenderOutcome, renderDocument } from "./document-controller";
import {
  ExportController,
  type ExportDocument,
  type ExportUri,
  MAX_CONFIRMATION_PDF_BYTES,
  normalizeTectonicPath,
  resolveExportDocument,
} from "./export-controller";
import { FrameFoldCache, provideFrameFoldRanges } from "./frame-folding";
import { ImagePasteEditProvider } from "./image-paste-provider";
import { LintFixCodeActionProvider } from "./lint-fix-code-actions";
import {
  appendUniqueIgnorePatterns,
  chooseLatexWorkshopTarget,
  DEFAULT_MANAGED_FILE_PATTERNS,
  effectiveArray,
  isManagedDocument,
  latexWorkshopPromptInputChanged,
  latexWorkshopPromptSignature,
  ManagedPreviewLifecycle,
  needsLatexWorkshopIgnorePrompt,
} from "./managed-files";
import { PdfPublications } from "./pdf-publications";
import { PreviewController } from "./preview-controller";
import { executeHistoryCommand, PreviewHistory } from "./preview-history";
import {
  affectsRawBlockCompile,
  dependencyFingerprint,
  RawBlockCompiler,
} from "./raw-block-compiler";
import { frameLensPositions, sourceHasFrameAt } from "./reveal-slide";
import { resolveSlideCommandTarget, SlideEditController } from "./slide-edit-controller";
import {
  hasSlideOutlineContentChanges,
  managedOutlineDocument,
  type SlideOutlineEntry,
  SlideOutlineRefreshScheduler,
  SlideOutlineState,
} from "./slide-outline";
import { resolveSourceViewColumn } from "./source-navigation";
import { detectBundledTectonic, resolveTectonicPath } from "./tectonic";
import { YenBackslashCodeActionProvider } from "./yen-code-actions";

let previewController: PreviewController | undefined;
const previewLifecycle = new ManagedPreviewLifecycle<PreviewController, vscode.TextDocument>();
type FinishPdfExport = (
  review?: PdfExportResult["review"],
  dependencyChanged?: boolean,
  pdfOnlyChanged?: boolean,
  publication?: Pick<PdfExportResult, "overwritten">,
) => void;
interface PendingPdfExport {
  output: string;
  /** True once the saved text changed after this Export accepted its input. */
  savedInputChanged: boolean;
  tectonicSettingsChanged: boolean;
  changedPaths: Set<string>;
  /** A PDF appeared while this Export was compiling, outside its own output. */
  externalPdfCreated: boolean;
  finishPanel?: FinishPdfExport;
  dispose(): void;
}
const pdfConfirmationExports = new Map<string, (output: string) => FinishPdfExport>();
const pendingPdfExports = new Map<string, PendingPdfExport>();

const LINT_SEVERITIES: Record<LintSeverity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

/** core の LintDiagnostic を VS Code の Diagnostic へ変換する(移植計画 VS-5)。 */
function toVscodeDiagnostic(
  document: vscode.TextDocument,
  lint: LintDiagnostic | PreviewSourceDiagnostic,
  frame: PreviewSourceDiagnostic["frame"] = "frame" in lint ? lint.frame : null,
): vscode.Diagnostic {
  const range = new vscode.Range(
    document.positionAt(lint.span.start),
    document.positionAt(lint.span.end),
  );
  const label = frame?.label ? ` [${frame.label}]` : "";
  const message = frame ? `${lint.message} (フレーム ${frame.number}${label})` : lint.message;
  const diagnostic = new vscode.Diagnostic(range, message, LINT_SEVERITIES[lint.severity]);
  diagnostic.code = lint.code;
  diagnostic.source = "category" in lint ? "beamer-editor preview" : "beamer-editor";
  return diagnostic;
}

/**
 * Problems パネルと PDF 書き出しの失敗報告で共有する lint オプション。
 * テンプレート(.sty)参照の解決結果を L022 / L023 へ渡す(#70)。参照は `text`(既定は今の本文)から読む。
 */
function deckLintOptions(
  document: vscode.TextDocument,
  text: string = document.getText(),
): LintOptions {
  if (document.uri.scheme !== "file") return {};
  const files = nodeTemplateFileSystem(path.dirname(document.uri.fsPath));
  return { fileExists: files.isFile, templates: templateStatuses(parseDeck(text), files) };
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
  fallbackViewColumn: vscode.ViewColumn | undefined,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const viewColumn =
    resolveSourceViewColumn(
      document.uri,
      vscode.window.visibleTextEditors.map((editor) => ({
        documentUri: editor.document.uri,
        viewColumn: editor.viewColumn,
      })),
      fallbackViewColumn,
    ) ?? vscode.ViewColumn.One;
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn,
    preserveFocus: false,
  });
  if (!isCurrent()) return;
  const position = document.positionAt(offset);
  const range = document.lineAt(position.line).range;
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  lineFlash.flash(editor, range);
}

/** 統合テストからの観測用 API(activate の戻り値)。製品コードから参照しない。 */
export interface TestApi {
  _previewControllerForTest(): PreviewController | undefined;
  _slideItemsForTest(): unknown[];
  _imagePasteProviderForTest(): ImagePasteEditProvider;
}

export function activate(context: vscode.ExtensionContext): TestApi {
  // プラットフォーム別 VSIX に同梱した Tectonic(#130)。設定で上書きされない限りこれを使う。
  const bundledTectonic = detectBundledTectonic(context.extensionPath);
  // 書き出しと部分コンパイルは、同じ設定スコープ・優先順位で実行ファイルを選ぶ。
  const tectonicPathFor = (uri: vscode.Uri) => {
    const value = vscode.workspace
      .getConfiguration("beamerEditor", uri)
      .get<unknown>("tectonicPath");
    return resolveTectonicPath(normalizeTectonicPath(value), bundledTectonic);
  };
  const managedPatternCache = new Map<string, readonly string[]>();
  const frameFoldCache = new FrameFoldCache();
  const foldingRangesChanged = new vscode.EventEmitter<void>();
  const latexWorkshopSessionPrompted = new Set<string>();
  const lineFlash = createLineFlash();
  const previewSources = new Map<vscode.WebviewPanel, vscode.TextDocument>();
  // Webview からの undo / redo(#103)。対象のソースへフォーカスを移してコマンドを実行し、終わったら
  // Webview へ戻す。要求は拡張全体で直列にし、押下時点の panel と文書に対して実行する。
  /** プレビューからの undo / redo を試す回数と、効かなかったときの待ち(ms)。 */
  const HISTORY_ATTEMPTS = 3;
  const HISTORY_RETRY_DELAY_MS = 50;
  const previewHistory = new PreviewHistory<{
    panel: vscode.WebviewPanel;
    uri: vscode.Uri;
    viewColumn: vscode.ViewColumn | undefined;
  }>({
    apply: async (kind, target) => {
      const document =
        vscode.workspace.textDocuments.find(
          (candidate) => candidate.uri.toString() === target.uri.toString(),
        ) ?? (await vscode.workspace.openTextDocument(target.uri));
      // フォーカスの移動とやり直しの判断は executeHistoryCommand(preview-history.ts)にある。
      await executeHistoryCommand(
        kind,
        {
          focusEditor: async () => {
            await vscode.window.showTextDocument(document, {
              preserveFocus: false,
              preview: false,
              ...(target.viewColumn !== undefined ? { viewColumn: target.viewColumn } : {}),
            });
            await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
          },
          execute: async (command) => {
            await vscode.commands.executeCommand(command);
          },
          version: () => document.version,
          onDidChange: (listener) =>
            vscode.workspace.onDidChangeTextDocument((event) => {
              if (event.document === document) listener();
            }),
        },
        { attempts: HISTORY_ATTEMPTS, retryDelayMs: HISTORY_RETRY_DELAY_MS },
      );
    },
    isOpen: (panel) => previewSources.has(panel),
    reveal: (panel) => panel.reveal(undefined, false),
    onError: (error, kind) => {
      void vscode.window.showErrorMessage(
        `Beamer preview: ${kind} に失敗しました: ${String(error)}`,
      );
    },
  });
  const exportOutput = vscode.window.createOutputChannel("Beamer Editor: Export");
  context.subscriptions.push(lineFlash, foldingRangesChanged, exportOutput);

  const exportController = new ExportController(
    {
      get isWorkspaceTrusted() {
        return vscode.workspace.isTrusted;
      },
      chooseFormat: async () => {
        const selection = await vscode.window.showQuickPick(["PDF", "HTML（プレビュー相当）"], {
          title: "Beamer Editor: Export",
        });
        return selection === "PDF"
          ? "pdf"
          : selection === "HTML（プレビュー相当）"
            ? "html"
            : undefined;
      },
      chooseOutput: (defaultUri, format) =>
        format === "html"
          ? vscode.window
              .showOpenDialog({
                defaultUri: vscode.Uri.file(path.dirname(defaultUri.fsPath)),
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                title: "HTML 出力先の親フォルダーを選択",
              })
              .then((uris) =>
                uris?.[0]
                  ? (vscode.Uri.joinPath(uris[0], path.basename(defaultUri.fsPath)) as ExportUri)
                  : undefined,
              )
          : (vscode.window.showSaveDialog({
              defaultUri: defaultUri as vscode.Uri,
              filters: { PDF: ["pdf"] },
              title: "Export PDF",
            }) as Thenable<ExportUri | undefined>),
      outputExists: async (uri) => {
        try {
          await vscode.workspace.fs.stat(uri as vscode.Uri);
          return true;
        } catch {
          return false;
        }
      },
      withProgress: (task) =>
        vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Beamer Editor: 書き出し中",
            cancellable: true,
          },
          (progress, token) => task(token, (message) => progress.report({ message })),
        ),
      showInformation: (message, ...actions) =>
        vscode.window.showInformationMessage(message, ...actions),
      showError: (message, ...actions) => vscode.window.showErrorMessage(message, ...actions),
      showWarning: (message, ...actions) => vscode.window.showWarningMessage(message, ...actions),
      openPdf: (uri) => vscode.env.openExternal(uri as vscode.Uri),
      openHtml: (uri) => vscode.env.openExternal(uri as vscode.Uri),
      revealInFileManager: (uri) =>
        vscode.commands.executeCommand("revealFileInOS", uri as vscode.Uri),
      openTectonicSettings: () =>
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "beamerEditor.tectonicPath",
        ),
      showExportDetails: (detail) => {
        exportOutput.clear();
        exportOutput.appendLine(detail);
        exportOutput.show(true);
      },
      showProblems: () => vscode.commands.executeCommand("workbench.actions.view.problems"),
      showsProblems: (document) => isManaged(document as vscode.TextDocument),
      lintOptions: (document, text) => deckLintOptions(document as vscode.TextDocument, text),
      uriForFile: (path) => vscode.Uri.file(path) as ExportUri,
      tectonicPath: (document) => tectonicPathFor(document.uri as vscode.Uri),
      timeoutMs: (document) => {
        const seconds = vscode.workspace
          .getConfiguration("beamerEditor", document.uri as vscode.Uri)
          .get<number>("pdfExport.timeoutSeconds", 300);
        const normalized = Number.isFinite(seconds) ? Math.trunc(seconds) : 300;
        return Math.max(5, Math.min(1800, normalized)) * 1000;
      },
      beginPdfExport: (document, output) => {
        const key = document.uri.toString();
        let sourceText: string | undefined;
        try {
          sourceText = document.getText();
        } catch {
          sourceText = undefined;
        }
        const operation: PendingPdfExport = {
          output: output.fsPath,
          savedInputChanged: false,
          tectonicSettingsChanged: false,
          changedPaths: new Set(),
          externalPdfCreated: false,
          dispose: () => {},
        };
        const recordSavedInput = (saved: ExportDocument) => {
          if (saved.uri.toString() !== key || sourceText === undefined) return;
          try {
            if (saved.getText() !== sourceText) operation.savedInputChanged = true;
          } catch {
            // The export result remains usable when VS Code cannot read a
            // transient document; do not invent a stale saved revision.
          }
        };
        const saveSubscription = vscode.workspace.onDidSaveTextDocument((saved) =>
          recordSavedInput(saved as ExportDocument),
        );
        const cleanReloadSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
          if (!event.document.isDirty && event.contentChanges.length)
            recordSavedInput(event.document as ExportDocument);
        });
        const settingsSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
          if (
            event.affectsConfiguration("beamerEditor.tectonicPath", document.uri as vscode.Uri) ||
            event.affectsConfiguration(
              "beamerEditor.pdfExport.timeoutSeconds",
              document.uri as vscode.Uri,
            )
          )
            operation.tectonicSettingsChanged = true;
        });
        // Start observing dependencies with Export itself, even when no panel
        // exists yet. This closes the compile-to-panel attachment window.
        const dependencyWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(
            vscode.Uri.file(path.dirname(document.uri.fsPath)),
            "**/*.{sty,png,jpg,jpeg,pdf}",
          ),
        );
        const recordDependency = (uri: vscode.Uri) =>
          operation.changedPaths.add(path.resolve(uri.fsPath));
        const recordCreatedDependency = (uri: vscode.Uri) => {
          const created = path.resolve(uri.fsPath);
          if (
            path.extname(created).toLowerCase() === ".pdf" &&
            created !== path.resolve(operation.output)
          )
            operation.externalPdfCreated = true;
          operation.changedPaths.add(created);
        };
        const dependencySubscriptions = [
          dependencyWatcher.onDidChange(recordDependency),
          dependencyWatcher.onDidCreate(recordCreatedDependency),
          dependencyWatcher.onDidDelete(recordDependency),
        ];
        operation.dispose = () => {
          saveSubscription.dispose();
          cleanReloadSubscription.dispose();
          settingsSubscription.dispose();
          for (const subscription of dependencySubscriptions) subscription.dispose();
          dependencyWatcher.dispose();
        };
        pendingPdfExports.set(key, operation);
        const finishPanel = pdfConfirmationExports.get(key)?.(output.fsPath);
        if (finishPanel) operation.finishPanel = finishPanel;
        return {
          finish: (review, publication) => {
            pendingPdfExports.delete(key);
            operation.dispose();
            const dependencyChanged =
              operation.changedPaths.size > 0 &&
              (review?.dependencyPaths === undefined ||
                [...operation.changedPaths].some((changed) =>
                  review.dependencyPaths?.some((dependency) => dependency === changed),
                ));
            if (operation.finishPanel)
              operation.finishPanel(
                review,
                dependencyChanged || operation.tectonicSettingsChanged,
                operation.externalPdfCreated,
                publication,
              );
            else void review?.content?.dispose();
          },
        };
      },
    },
    {
      htmlKatexAssetsPath: path.join(context.extensionPath, "media", "html-export", "katex"),
    },
  );
  context.subscriptions.push(exportController);

  const slideOutlineState = new SlideOutlineState<vscode.TextDocument>();
  const slideOutlineChanged = new vscode.EventEmitter<void>();
  const slideOutlineRefresh = new SlideOutlineRefreshScheduler(slideOutlineState, () =>
    slideOutlineChanged.fire(),
  );
  context.subscriptions.push(slideOutlineChanged, slideOutlineRefresh);

  // lint → Problems パネル・波線(VS-5)。開いている .tex 文書ごとに独立管理する。
  const diagnosticCollection = vscode.languages.createDiagnosticCollection("beamer-editor");
  const latestLint = new WeakMap<
    vscode.TextDocument,
    { version: number; diagnostics: LintDiagnostic[] }
  >();
  const latestPreview = new WeakMap<vscode.TextDocument, RenderOutcome>();
  function publishProblems(document: vscode.TextDocument): void {
    const lint = latestLint.get(document);
    const preview = latestPreview.get(document);
    const rendered = preview?.version === document.version ? preview.diagnostics : undefined;
    const byKey = new Map(
      (rendered ?? []).map((diagnostic) => [diagnosticKey(diagnostic), diagnostic]),
    );
    // A current render resolves expanded image paths. Retain matching source
    // lint entries so their existing Quick Fix remains available.
    const diagnostics = (lint?.version === document.version ? lint.diagnostics : []).filter(
      (diagnostic) => {
        const previewImageCode =
          diagnostic.code === "L004" || diagnostic.code === "L015" || diagnostic.code === "L023";
        return !previewImageCode || !rendered || byKey.has(diagnosticKey(diagnostic));
      },
    );
    const existing = new Set(diagnostics.map(diagnosticKey));
    diagnosticCollection.set(document.uri, [
      ...diagnostics.map((diagnostic) =>
        toVscodeDiagnostic(document, diagnostic, byKey.get(diagnosticKey(diagnostic))?.frame),
      ),
      ...(rendered ?? [])
        .filter((diagnostic) => !existing.has(diagnosticKey(diagnostic)))
        .map((diagnostic) => toVscodeDiagnostic(document, diagnostic)),
    ]);
  }
  function diagnosticKey(diagnostic: LintDiagnostic | PreviewSourceDiagnostic): string {
    return `${diagnostic.code}:${diagnostic.span.start}:${diagnostic.span.end}:${diagnostic.message}`;
  }
  // L004(画像パス)・L025(管理プリアンブル)の Quick Fix は最新の lint 結果の fix を引く。
  const lintFixActions = new LintFixCodeActionProvider();
  const lintController = new LintController<vscode.TextDocument>(
    {
      onDidOpenTextDocument: (listener) => vscode.workspace.onDidOpenTextDocument(listener),
      onDidChangeTextDocument: (listener) => vscode.workspace.onDidChangeTextDocument(listener),
      onDidCloseTextDocument: (listener) => vscode.workspace.onDidCloseTextDocument(listener),
    },
    {
      set: (document, diagnostics) => {
        lintFixActions.record(document, diagnostics);
        latestLint.set(document, { version: document.version, diagnostics });
        publishProblems(document);
      },
      delete: (document) => {
        lintFixActions.forget(document);
        latestLint.delete(document);
        latestPreview.delete(document);
        diagnosticCollection.delete(document.uri);
      },
    },
    vscode.workspace.textDocuments,
    (document) => isManaged(document),
    (document) => deckLintOptions(document),
  );
  context.subscriptions.push(diagnosticCollection, lintController);

  function managedPatterns(document: vscode.TextDocument): readonly string[] {
    if (document.uri.scheme !== "file") return [];
    const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() ?? "outside";
    const cached = managedPatternCache.get(folder);
    if (cached) return cached;
    const patterns =
      vscode.workspace
        .getConfiguration("beamerEditor", document.uri)
        .get<readonly string[]>("managedFiles") ?? DEFAULT_MANAGED_FILE_PATTERNS;
    managedPatternCache.set(folder, patterns);
    return patterns;
  }

  function matchesManagedGlob(document: vscode.TextDocument, pattern: string): boolean {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const glob: vscode.GlobPattern = workspaceFolder
      ? new vscode.RelativePattern(workspaceFolder, pattern)
      : pattern;
    return vscode.languages.match({ scheme: "file", pattern: glob }, document) > 0;
  }

  function isManaged(document: vscode.TextDocument): boolean {
    return isManagedDocument(document, managedPatterns(document), matchesManagedGlob);
  }

  class SlideOutlineItem extends vscode.TreeItem {
    constructor(readonly entry: SlideOutlineEntry<vscode.TextDocument>) {
      super(`${entry.frameNumber}. ${entry.title}`, vscode.TreeItemCollapsibleState.None);
      this.contextValue = "beamerSlide";
      if (entry.label) this.description = `label: ${entry.label}`;
      else if (entry.raw) this.description = "raw";
      this.tooltip = entry.raw
        ? `${entry.frameNumber}. ${entry.title} (raw frame)`
        : `${entry.frameNumber}. ${entry.title}`;
      this.command = {
        command: "beamerEditor.revealSlide",
        title: "Reveal slide source",
        arguments: [this],
      };
    }
  }

  const slideOutlineProvider: vscode.TreeDataProvider<SlideOutlineItem> = {
    onDidChangeTreeData: slideOutlineChanged.event,
    getTreeItem: (item) => item,
    getChildren: () => slideOutlineState.getEntries().map((entry) => new SlideOutlineItem(entry)),
  };
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("beamerEditor.slides", slideOutlineProvider),
    vscode.commands.registerCommand("beamerEditor.revealSlide", async (item: unknown) => {
      if (!(item instanceof SlideOutlineItem) || !slideOutlineState.isCurrent(item.entry)) return;
      await jumpToOffset(
        item.entry.document,
        item.entry.start,
        lineFlash,
        vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
        () => slideOutlineState.isCurrent(item.entry),
      );
    }),
  );

  const slideEdits = new SlideEditController(slideOutlineState, {
    isEditable: (document) =>
      !document.isClosed &&
      isManaged(document) &&
      vscode.workspace.fs.isWritableFileSystem(document.uri.scheme) !== false,
    apply: async (document, edits) => {
      const workspaceEdit = new vscode.WorkspaceEdit();
      for (const { span, text } of edits) {
        workspaceEdit.replace(
          document.uri,
          new vscode.Range(document.positionAt(span.start), document.positionAt(span.end)),
          text,
        );
      }
      return vscode.workspace.applyEdit(workspaceEdit);
    },
    changed: (document) => {
      if (slideOutlineState.hasDocument(document)) updateSlideOutline(document);
    },
    warn: (message) => {
      void vscode.window.showWarningMessage(message);
    },
  });
  // View title actions may receive the focused tree item. Appending must ignore it.
  context.subscriptions.push(
    vscode.commands.registerCommand("beamerEditor.slides.append", () =>
      slideEdits.execute("insert"),
    ),
  );
  for (const action of ["moveUp", "moveDown", "duplicate", "delete", "insert"] as const) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`beamerEditor.slides.${action}`, async (item: unknown) => {
        const target = await resolveSlideCommandTarget(
          action,
          item instanceof SlideOutlineItem ? item.entry : item === undefined ? undefined : "other",
          slideOutlineState.getEntries(),
          async (entries, placeHolder) =>
            (
              await vscode.window.showQuickPick(
                entries.map((entry) => ({ label: `${entry.frameNumber}. ${entry.title}`, entry })),
                { placeHolder },
              )
            )?.entry,
        );
        return target.kind === "run" && slideEdits.execute(action, target.entry);
      }),
    );
  }

  function updateSlideOutline(document: vscode.TextDocument | undefined): void {
    slideOutlineRefresh.cancel();
    if (slideOutlineState.setDocument(document)) slideOutlineChanged.fire();
    void vscode.commands.executeCommand(
      "setContext",
      "beamerEditor.hasSlideOutlineDocument",
      document !== undefined,
    );
  }

  const yenCodeActions = new YenBackslashCodeActionProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file", language: "latex" },
      {
        provideCodeActions(document, range, context, token) {
          return isManaged(document)
            ? [
                ...yenCodeActions.provideCodeActions(document, range, context, token),
                ...lintFixActions.provideCodeActions(document, range, context, token),
              ]
            : [];
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );

  // Cmd/Ctrl+V の画像(#153)。managed な文書だけで、他の provider と同じ絞り方。
  const imagePaste = new ImagePasteEditProvider();
  context.subscriptions.push(
    vscode.languages.registerDocumentPasteEditProvider(
      { scheme: "file", language: "latex" },
      {
        provideDocumentPasteEdits(document, ranges, dataTransfer, pasteContext, token) {
          return isManaged(document)
            ? imagePaste.provideDocumentPasteEdits(
                document,
                ranges,
                dataTransfer,
                pasteContext,
                token,
              )
            : undefined;
        },
      },
      ImagePasteEditProvider.metadata,
    ),
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { scheme: "file", language: "latex" },
      {
        provideHover(document, position, _token) {
          if (!isManaged(document)) return undefined;
          const hover = canvasHoverAt(document, position);
          if (!hover) return undefined;
          const markdown = new vscode.MarkdownString(hover.documentation.markdown);
          return new vscode.Hover(
            markdown,
            new vscode.Range(
              document.positionAt(hover.range.start),
              document.positionAt(hover.range.end),
            ),
          );
        },
      },
    ),
    vscode.languages.registerFoldingRangeProvider(
      { scheme: "file", language: "latex" },
      {
        onDidChangeFoldingRanges: foldingRangesChanged.event,
        provideFoldingRanges(document, _context, token) {
          const ranges = provideFrameFoldRanges(document, isManaged, token, frameFoldCache);
          return ranges?.map((range) => new vscode.FoldingRange(range.start, range.end));
        },
      },
    ),
  );

  async function offerLatexWorkshopIgnore(document: vscode.TextDocument): Promise<void> {
    if (!vscode.extensions.getExtension("James-Yu.latex-workshop")) return;
    // Consent is asynchronous: use an uncached value here, then resolve it again before writing.
    const readManagedPatterns = () =>
      vscode.workspace
        .getConfiguration("beamerEditor", document.uri)
        .get<readonly string[]>("managedFiles") ?? DEFAULT_MANAGED_FILE_PATTERNS;
    const patterns = readManagedPatterns();
    if (patterns.length === 0) return;
    const workshop = vscode.workspace.getConfiguration("latex-workshop", document.uri);
    const readSettings = () => {
      const managed = vscode.workspace
        .getConfiguration("beamerEditor", document.uri)
        .inspect<readonly string[]>("managedFiles");
      const watch = workshop.inspect<readonly string[]>("latex.watch.files.ignore");
      const autoBuild = workshop.inspect<readonly string[]>("latex.autoBuild.onSave.files.ignore");
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      return {
        managed,
        watch,
        autoBuild,
        watchIgnore: effectiveArray(watch),
        autoBuildIgnore: effectiveArray(autoBuild),
        input: {
          patterns: readManagedPatterns(),
          watchTarget: chooseLatexWorkshopTarget(managed, watch, !!folder),
          autoBuildTarget: chooseLatexWorkshopTarget(managed, autoBuild, !!folder),
        },
      };
    };
    const settings = readSettings();
    const currentPatterns = settings.input.patterns;
    if (
      !needsLatexWorkshopIgnorePrompt(
        settings.watchIgnore,
        settings.autoBuildIgnore,
        currentPatterns,
      )
    )
      return;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const targetIdentity = (scope: string) => {
      if (scope === "global") return "global";
      if (scope === "workspaceFolder") return `workspaceFolder:${folder?.uri.toString() ?? "none"}`;
      return `workspace:${vscode.workspace.workspaceFile?.toString() ?? folder?.uri.toString() ?? "none"}`;
    };
    const signature = latexWorkshopPromptSignature(
      {
        watch: targetIdentity(settings.input.watchTarget),
        autoBuild: targetIdentity(settings.input.autoBuildTarget),
      },
      currentPatterns,
    );
    const refusalKey = `latexWorkshopIgnoreRefused:${signature}`;
    if (latexWorkshopSessionPrompted.has(signature) || context.globalState.get<boolean>(refusalKey))
      return;
    latexWorkshopSessionPrompted.add(signature);
    const scopeName = (scope: string) =>
      scope === "workspaceFolder"
        ? "Workspace Folder"
        : scope === "workspace"
          ? "Workspace"
          : "Global";
    const target = (scope: string): vscode.ConfigurationTarget =>
      scope === "workspaceFolder"
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : scope === "workspace"
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;

    const choice = await vscode.window.showInformationMessage(
      `Beamer Editor の managed slide files を LaTeX Workshop の自動監視・保存時自動ビルドから除外しますか？ ${scopeName(settings.input.watchTarget)} / ${scopeName(settings.input.autoBuildTarget)} Settings を更新します。`,
      "追加",
      "今はしない",
      "今後表示しない",
    );
    if (choice === "今後表示しない") {
      await context.globalState.update(refusalKey, true);
      return;
    }
    if (choice !== "追加") return;
    const latest = readSettings();
    if (latexWorkshopPromptInputChanged(settings.input, latest.input)) {
      // The consent text no longer describes the write targets or managed input.
      latexWorkshopSessionPrompted.delete(signature);
      return offerLatexWorkshopIgnore(document);
    }
    await Promise.all([
      workshop.update(
        "latex.watch.files.ignore",
        appendUniqueIgnorePatterns(latest.watchIgnore, latest.input.patterns),
        target(latest.input.watchTarget),
      ),
      workshop.update(
        "latex.autoBuild.onSave.files.ignore",
        appendUniqueIgnorePatterns(latest.autoBuildIgnore, latest.input.patterns),
        target(latest.input.autoBuildTarget),
      ),
    ]);
  }

  /** preserveFocus はソース側の操作(#66)から開くときに使う。既定は自動オープンのときだけ保つ。 */
  function openPreview(
    document: vscode.TextDocument,
    automatic: boolean,
    preserveFocus = automatic,
  ): void {
    const prepared = previewLifecycle.prepareOpen(document.uri, automatic);
    if (prepared.kind === "existing") {
      if (!automatic) {
        // 同じグループの別タブの後ろに隠れていても表示する。preserveFocus ならフォーカスはソースに残す。
        prepared.controller.reveal(preserveFocus);
        previewController = prepared.controller;
      }
      return;
    }
    if (prepared.kind === "dismissed") return;
    const sourceViewColumn = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === document.uri.toString(),
    )?.viewColumn;

    // 画像(includegraphics / deckimage / logo)は文書からの相対パスで参照される
    // ため、文書のあるフォルダだけを workspace 側のリソース範囲として開ける。
    const documentDir = vscode.Uri.joinPath(document.uri, "..");
    const panel = vscode.window.createWebviewPanel(
      "beamerEditor.preview",
      `Beamer Preview: ${document.fileName.split(/[\\/]/).pop()}`,
      preserveFocus
        ? { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }
        : vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media"), documentDir],
      },
    );
    previewSources.set(panel, document);

    // #94: プレビューが表示されているエディタグループをロックし、他のファイルが同じグループに
    // 開かないようにする(ロック中のグループには新しいエディタが開かない)。ロックはアクティブな
    // グループにしか掛けられないので、パネルが初めてフォーカスされたとき(手動オープン直後か、利用者
    // がプレビューをクリックしたとき)に 1 回だけ行い、自動オープンでフォーカスを奪わない。
    // 問題が起きるのは「プレビューがアクティブなときに別ファイルを開く」場面だけなのでこれで足りる。
    // lockEditorGroup は「その時点でアクティブなグループ」に掛かる。パネル作成直後は workbench 側の
    // 切り替えが終わっておらずソース側がまだアクティブなことがあるため、アクティブなタブがこの
    // パネルであることを確かめてから実行する(違うグループをロックしない)。
    let groupLocked = false;
    const lockGroupIfActive = (): void => {
      if (groupLocked || !panel.active) return;
      if (vscode.window.tabGroups.activeTabGroup.activeTab?.label !== panel.title) return;
      const enabled =
        vscode.workspace.getConfiguration("beamerEditor").get<boolean>("preview.lockGroup") ?? true;
      if (!enabled) return;
      groupLocked = true;
      void vscode.commands.executeCommand("workbench.action.lockEditorGroup");
    };
    let previewViewStateChanged = (): void => {};
    const viewStateSubscription = panel.onDidChangeViewState(() => {
      lockGroupIfActive();
      if (panel.active) updateSlideOutline(isManaged(document) ? document : undefined);
      previewViewStateChanged();
    });
    lockGroupIfActive();

    const mediaUri = (name: string) =>
      panel.webview
        .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", name))
        .toString();
    // テンプレート(.sty)と preamble-extra から土台スタイルを取り、%% style で上書きする(#70)。
    const templateFs = nodeTemplateFileSystem(path.dirname(document.uri.fsPath));
    let publishedPreview: { document: vscode.TextDocument; outcome: RenderOutcome } | undefined;
    const clearPreviewProblems = () => {
      const published = publishedPreview;
      publishedPreview = undefined;
      if (!published || latestPreview.get(published.document) !== published.outcome) return;
      latestPreview.delete(published.document);
      publishProblems(published.document);
    };
    // .sty や画像が変わったらプレビューと診断を作り直す(キャッシュは持たない)。
    const templateWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(documentDir, "**/*.{sty,png,jpg,jpeg,pdf}"),
    );
    // 生ブロックの部分コンパイル(#81)。Workspace Trust が無いときと設定で切ったときは起動しない。
    // PDF は globalStorage の下に「組み立て方の版 / デッキのディレクトリ」ごとに分けて置く(別プロジェクトの
    // 同じ TeX が別の画像や .sty を参照していても混ざらない)。Webview へは base64 で渡す(リソース許可を広げない)。
    const rawCacheDir = vscode.Uri.joinPath(
      context.globalStorageUri,
      "raw-blocks",
      `v${FRAGMENT_DOCUMENT_VERSION}`,
      fragmentHash(documentDir.fsPath),
    );
    const statDependency = async (target: string) => {
      try {
        const info = await vscode.workspace.fs.stat(vscode.Uri.file(target));
        return info.type & vscode.FileType.File ? { mtimeMs: info.mtime, size: info.size } : null;
      } catch {
        return null;
      }
    };
    let pdfTabVisible = false;
    let rawResultsPending = false;
    let rawClearPending = false;
    const rawBlockCompiler = new RawBlockCompiler({
      cacheDir: rawCacheDir.fsPath,
      fs: {
        readFile: async (target) => vscode.workspace.fs.readFile(vscode.Uri.file(target)),
        writeFile: async (target, data) =>
          vscode.workspace.fs.writeFile(vscode.Uri.file(target), data),
        mkdir: async (target) => vscode.workspace.fs.createDirectory(vscode.Uri.file(target)),
        exists: async (target) => (await statDependency(target)) !== null,
        rename: async (from, to) =>
          vscode.workspace.fs.rename(vscode.Uri.file(from), vscode.Uri.file(to), {
            overwrite: true,
          }),
      },
      buildDocument: buildFragmentDocument,
      // 生ブロックと前置きが参照する画像・.sty などの更新時刻と大きさ。変わればキャッシュを作り直す。
      fingerprint: (tex, preamble) =>
        dependencyFingerprint(
          fragmentDependencies(`${preamble}\n${tex}`),
          (name) => (path.isAbsolute(name) ? name : path.join(documentDir.fsPath, name)),
          statDependency,
          fragmentHash,
          graphicsPathsOf(`${preamble}\n${tex}`),
        ),
      // Tectonic が無い・壊れているときは、ブロックごとに赤枠にせず一度だけ案内する(元 #119)。
      isUnavailable: (error) =>
        error instanceof PdfExportError &&
        (error.code === "E_TECTONIC_NOT_FOUND" || error.code === "E_TECTONIC_VERSION"),
      onUnavailable: (message) => {
        void vscode.window
          .showWarningMessage(
            `Beamer preview: 生ブロックの部分コンパイルを止めました。${message}`,
            "設定を開く",
          )
          .then((action) => {
            if (action === "設定を開く")
              return vscode.commands.executeCommand(
                "workbench.action.openSettings",
                "beamerEditor.tectonicPath",
              );
            return undefined;
          });
      },
      compile: async (fragment, signal) => {
        const config = vscode.workspace.getConfiguration("beamerEditor", document.uri);
        const seconds = config.get<number>("pdfExport.timeoutSeconds", 300);
        const normalized = Number.isFinite(seconds) ? Math.trunc(seconds) : 300;
        const tectonicPath = tectonicPathFor(document.uri);
        const result = await compileFragment({
          document: fragment,
          cwd: documentDir.fsPath,
          signal,
          timeoutMs: Math.max(5, Math.min(1800, normalized)) * 1000,
          maxOutputBytes: MAX_RAW_PDF_BYTES,
          ...(tectonicPath ? { tectonicPath } : {}),
        });
        return result.pdf;
      },
      onReady: (key, pdf) => {
        if (pdfTabVisible) rawResultsPending = true;
        else controller.postRawBlockReady(key, pdf);
      },
      onFailed: (key, message) => {
        if (pdfTabVisible) rawResultsPending = true;
        else controller.postRawBlockFailed(key, message);
      },
    });
    const rawBlocksEnabled = () =>
      vscode.workspace.isTrusted &&
      vscode.workspace
        .getConfiguration("beamerEditor", document.uri)
        .get<boolean>("preview.compileRawBlocks", true);
    let controller: PreviewController;
    let pdfBytes: Uint8Array | undefined;
    let pdfArtifactId = 0;
    let pdfRevision = 0;
    let pdfRequest = 0;
    let pdfExportRequest: number | undefined;
    let pdfOpened = false;
    let sentPdfArtifactId: number | undefined;
    let pdfDirty = document.isDirty;
    let pdfFailure: string | undefined;
    let pdfTooLarge = false;
    let pdfAbort: AbortController | undefined;
    let pdfInputRevision = 0;
    let pdfCompiledRevision = 0;
    /** Saved-source and shared-input generation used by the HTML-side dependency snapshot. */
    let editingInputsRevision = 0;
    let compiledEditingInputsRevision = 0;
    let editingDependencyPaths: readonly string[] | undefined;
    let panelDisposed = false;
    let pdfDependencyPaths: readonly string[] | undefined;
    let pendingPdf:
      | {
          content: NonNullable<PdfReviewArtifact["content"]>;
          inputRevision: number;
          dependencyPaths: readonly string[] | undefined;
          loading: boolean;
        }
      | undefined;
    const pdfPublications = new PdfPublications();
    const requestRawBlocks = (outcome: ReturnType<typeof renderDocument>) => {
      if (pdfTabVisible || !rawBlocksEnabled()) return;
      rawBlockCompiler.request(outcome.deck.rawBlocks ?? [], outcome.deck.fragmentPreamble ?? "");
      // request が pause 中の最後の本文を置き換えてから再開する。
      rawBlockCompiler.resume();
    };
    const postPdf = () => {
      if (!pdfOpened) return;
      const stale = pdfBytes !== undefined && pdfCompiledRevision !== pdfInputRevision;
      const status = !vscode.workspace.isTrusted
        ? "restricted"
        : pdfAbort || pdfExportRequest === pdfRequest || pendingPdf?.loading
          ? "compiling"
          : pdfFailure !== undefined || pdfTooLarge
            ? "failed"
            : stale
              ? "stale"
              : pdfBytes
                ? "ready"
                : "idle";
      const labels: string[] = [];
      if (status === "compiling")
        labels.push(
          pdfAbort || pdfExportRequest === pdfRequest
            ? "Tectonic で組版中です。"
            : "PDF を読み込んでいます。",
        );
      if (status === "failed")
        labels.push(
          pdfTooLarge
            ? "64 MiB を超える PDF は確認タブで開けません。通常の PDF 書き出しから確認できます。"
            : `組版に失敗しました。 ${pdfFailure}`,
        );
      if (status !== "restricted") {
        if (stale) labels.push("要更新。");
        if (pdfBytes) {
          labels.push(
            stale || pdfFailure !== undefined || pdfTooLarge
              ? "前回成功した保存済みの版を表示しています。"
              : "保存済みの版を表示しています。",
          );
        }
        if (pdfDirty) labels.push("未保存の編集があります。");
      }
      const deliver =
        pdfTabVisible &&
        panel.visible !== false &&
        pdfBytes &&
        sentPdfArtifactId !== pdfArtifactId &&
        status !== "restricted";
      if (deliver) sentPdfArtifactId = pdfArtifactId;
      controller.postPdfState(status, ++pdfRevision, {
        ...(labels.length ? { message: labels.join(" ") } : {}),
        ...(deliver && pdfBytes ? { pdf: pdfBytes, artifactId: pdfArtifactId } : {}),
      });
    };
    const markPdfStale = (editingInputsChanged = true) => {
      if (editingInputsChanged) editingInputsRevision += 1;
      pdfInputRevision += 1;
      postPdf();
    };
    const pdfSaveSubscription = vscode.workspace.onDidSaveTextDocument?.((saved) => {
      if (saved.uri.toString() !== document.uri.toString()) return;
      pdfDirty = saved.isDirty;
      markPdfStale();
    });
    const pdfExternalChangeSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== document.uri.toString()) return;
      const wasDirty = pdfDirty;
      pdfDirty = event.document.isDirty;
      // A clean buffer can be reloaded from disk. Unsaved changes only affect the label.
      if (!pdfDirty && !wasDirty && event.contentChanges.length) markPdfStale();
      else if (wasDirty !== pdfDirty) postPdf();
    });
    const discardPendingPdfContent = () => {
      const candidate = pendingPdf;
      pendingPdf = undefined;
      void candidate?.content.dispose();
    };
    const setCompiledPdf = (
      artifact: PdfReviewArtifact,
      inputRevision: number,
      compiledEditingRevision: number,
    ) => {
      pdfFailure = undefined;
      pdfTooLarge = artifact.size > MAX_CONFIRMATION_PDF_BYTES;
      discardPendingPdfContent();
      if (artifact.content) {
        pendingPdf = {
          content: artifact.content,
          inputRevision,
          dependencyPaths: artifact.dependencyPaths,
          loading: false,
        };
      } else if (!pdfTooLarge) {
        pdfFailure =
          "書き出した PDF を確認タブに読み込めませんでした。更新して再試行してください。";
      }
      if (compiledEditingRevision === editingInputsRevision) {
        compiledEditingInputsRevision = compiledEditingRevision;
        editingDependencyPaths = artifact.dependencyPaths;
      }
      postPdf();
    };
    const loadPendingPdf = async () => {
      const candidate = pendingPdf;
      if (
        !candidate ||
        candidate.loading ||
        !pdfTabVisible ||
        panel.visible === false ||
        !vscode.workspace.isTrusted
      )
        return;
      candidate.loading = true;
      postPdf();
      try {
        const bytes = await candidate.content.read();
        if (pendingPdf !== candidate) return;
        pdfBytes = bytes;
        pdfArtifactId += 1;
        pdfCompiledRevision = candidate.inputRevision;
        pdfDependencyPaths = candidate.dependencyPaths;
      } catch {
        if (pendingPdf !== candidate) return;
        pdfFailure =
          "書き出した PDF を確認タブに読み込めませんでした。更新して再試行してください。";
      } finally {
        if (pendingPdf === candidate) {
          pendingPdf = undefined;
          postPdf();
        }
        await candidate.content.dispose();
      }
    };
    const compilePdfConfirmation = async () => {
      if (!vscode.workspace.isTrusted) {
        postPdf();
        return;
      }
      const request = ++pdfRequest;
      const inputRevision = pdfInputRevision;
      const compiledEditingRevision = editingInputsRevision;
      pdfAbort?.abort();
      const abort = new AbortController();
      pdfAbort = abort;
      pdfFailure = undefined;
      pdfTooLarge = false;
      postPdf();
      const config = vscode.workspace.getConfiguration("beamerEditor", document.uri);
      const seconds = config.get<number>("pdfExport.timeoutSeconds", 300);
      const normalized = Number.isFinite(seconds) ? Math.trunc(seconds) : 300;
      const tectonicPath = tectonicPathFor(document.uri);
      try {
        const compiled = await compilePdf({
          inputPath: document.uri.fsPath,
          maxPdfBytes: MAX_CONFIRMATION_PDF_BYTES,
          signal: abort.signal,
          timeoutMs: Math.max(5, Math.min(1800, normalized)) * 1000,
          ...(tectonicPath === undefined ? {} : { tectonicPath }),
        });
        if (request !== pdfRequest) return;
        pdfAbort = undefined;
        discardPendingPdfContent();
        pdfFailure = undefined;
        // Confirmation compiles are already requested by a visible PDF tab.
        pdfBytes = compiled.pdf;
        pdfArtifactId += 1;
        pdfCompiledRevision = inputRevision;
        pdfDependencyPaths = compiled.dependencyPaths;
        if (compiledEditingRevision === editingInputsRevision) {
          compiledEditingInputsRevision = compiledEditingRevision;
          editingDependencyPaths = compiled.dependencyPaths;
        }
        postPdf();
      } catch (error) {
        if (request !== pdfRequest) return;
        pdfAbort = undefined;
        pdfTooLarge = error instanceof PdfExportError && error.code === "E_LIMIT";
        if (!pdfTooLarge) pdfFailure = error instanceof Error ? error.message : String(error);
        postPdf();
      }
    };
    const mayReadPdfOutput = (output: string, dependencies: readonly string[] | undefined) => {
      if (dependencies === undefined) return true;
      const lexical = path.resolve(output);
      // `publishPdf` atomically replaces the final entry. Resolve only its
      // parent so a pre-existing symlink leaf keeps its lexical identity while
      // an aliased directory still matches a resolved dependency target.
      let parentAlias: string | undefined;
      try {
        parentAlias = path.join(realpathSync(path.dirname(lexical)), path.basename(lexical));
      } catch {
        parentAlias = undefined;
      }
      return dependencies.some(
        (dependency) => dependency === lexical || dependency === parentAlias,
      );
    };
    /**
     * 初回作成の PDF は直前の Tectonic 入力一覧に無くても、TeX の条件分岐や
     * マクロ展開で次の組版内容を変えられる。deck 配下に新設した PDF だけを
     * PDF確認の要更新へ倒す。既存ファイルへの上書きと deck 外の出力は既存の
     * 依存一覧照合に委ねる。
     */
    const isNewWatchedPdfOutput = (output: string, overwritten: boolean | undefined) => {
      if (overwritten || path.extname(output).toLowerCase() !== ".pdf") return false;
      const within = (candidate: string, root: string) => {
        const relative = path.relative(root, candidate);
        return (
          relative === "" ||
          (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        );
      };
      const lexical = path.resolve(output);
      if (within(lexical, documentDir.fsPath)) return true;
      try {
        return within(
          path.join(realpathSync(path.dirname(lexical)), path.basename(lexical)),
          realpathSync(documentDir.fsPath),
        );
      } catch {
        return false;
      }
    };
    /**
     * FileSystemWatcher の通知先は原子的な公開先とは違い、別名の symlink leaf
     * になることがある。公開先の照合規則は変えず、監視時だけ既存 leaf の実体も照合する。
     */
    const watchesPdfInput = (changed: string, dependencies: readonly string[]) => {
      if (mayReadPdfOutput(changed, dependencies)) return true;
      try {
        return dependencies.includes(realpathSync(changed));
      } catch {
        return false;
      }
    };
    const watcherDependencies = () => {
      if (pdfDirty) return undefined;
      if (pendingPdf?.inputRevision === pdfInputRevision) return pendingPdf.dependencyPaths;
      if (pdfBytes !== undefined && pdfCompiledRevision === pdfInputRevision)
        return pdfDependencyPaths;
      return undefined;
    };
    /**
     * PDF 確認だけが古くなった後も、最後に成功した保存済み入力の依存一覧は
     * 編集プレビューの更新を絞り込む根拠に使える。本文・設定・既知の依存が
     * 変わった場合は generation を進めてこの根拠を捨てる。
     */
    const editingWatcherDependencies = () =>
      !pdfDirty && compiledEditingInputsRevision === editingInputsRevision
        ? editingDependencyPaths
        : undefined;
    const isTextualDependency = (entry: string) => /\.(?:tex|sty|cls|def)$/i.test(entry);
    const isImageDependency = (entry: string) => /\.(?:png|jpe?g)$/i.test(entry);
    const MAX_WATCH_TEXT_BYTES = 1024 * 1024;
    const dynamicExistenceProbe =
      /\\(?:IfFileExists|InputIfFileExists|openin)\b(?!\s*(?:\[[^\]]*\]\s*)?\{[^{}\\#]*\})/;
    /**
     * Tectonic が前回読まなかった PDF でも、作成によって extensionless の画像や
     * IfFileExists が解決することがある。保存済み入力とそのローカル文字列依存に
     * basename が無ければ無関係とみなす。式で組み立てた名前はこの初期段階では
     * 静的に証明できないため、存在確認系の動的引数は更新側へ倒す。
     */
    const mayReferenceCreatedPdf = async (changed: string, dependencies: readonly string[]) => {
      const stem = path.basename(changed, path.extname(changed)).toLowerCase();
      // `\includegraphics{figure}` が以前は PNG を選んでいても、新しい
      // `figure.pdf` が探索順で選ばれることがある。本文に stem が無いマクロ経由の
      // 参照もあるため、既知の画像入力の basename も保守的に照合する。
      if (
        dependencies.some(
          (dependency) =>
            isImageDependency(dependency) &&
            path.basename(dependency, path.extname(dependency)).toLowerCase() === stem,
        )
      )
        return true;
      const hasReference = (input: string) => {
        const lower = input.toLowerCase();
        return lower.includes(stem) || dynamicExistenceProbe.test(input);
      };
      const currentDocument =
        vscode.workspace.textDocuments.find(
          (candidate) => candidate.uri.toString() === document.uri.toString(),
        ) ?? document;
      if (hasReference(currentDocument.getText())) return true;
      try {
        for (const dependency of dependencies) {
          if (path.resolve(dependency) === path.resolve(document.uri.fsPath)) continue;
          if (!isTextualDependency(dependency)) continue;
          const info = await vscode.workspace.fs.stat(vscode.Uri.file(dependency));
          if (info.size > MAX_WATCH_TEXT_BYTES) return true;
          const text = new TextDecoder("utf-8", { fatal: true }).decode(
            await vscode.workspace.fs.readFile(vscode.Uri.file(dependency)),
          );
          if (hasReference(text)) return true;
        }
      } catch {
        return true;
      }
      return false;
    };
    const saveDisplayedPdf = async (artifactId: number | undefined) => {
      const displayed = pdfBytes;
      if (!vscode.workspace.isTrusted || !displayed) return;
      if (artifactId !== pdfArtifactId) {
        void vscode.window.showWarningMessage(
          "PDF が更新されました。表示を確認してから再度保存してください。",
        );
        return;
      }
      const earlier =
        pdfCompiledRevision !== pdfInputRevision || pdfFailure !== undefined || pdfTooLarge;
      const output = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(
          path.join(
            path.dirname(document.uri.fsPath),
            `${path.basename(document.uri.fsPath, ".tex")}.pdf`,
          ),
        ),
        filters: { PDF: ["pdf"] },
        title: earlier ? "前回成功した PDF を保存" : "表示中の PDF を保存",
      });
      if (!output) return;
      let overwrite = false;
      try {
        await vscode.workspace.fs.stat(output);
        overwrite =
          (await vscode.window.showWarningMessage("既存の PDF を上書きしますか？", "上書き")) ===
          "上書き";
        if (!overwrite) return;
      } catch {
        // The destination does not exist.
      }
      const finishPublication = pdfPublications.begin(output.fsPath);
      try {
        const published = await publishPdf({
          pdf: displayed,
          outputPath: output.fsPath,
          sourcePath: document.uri.fsPath,
          overwrite,
        });
        finishPublication(published.writtenFileIdentity);
        if (mayReadPdfOutput(output.fsPath, pdfDependencyPaths)) markPdfStale();
        else if (isNewWatchedPdfOutput(output.fsPath, published.overwritten)) markPdfStale(false);
        void vscode.window.showInformationMessage(`表示中の PDF を保存しました: ${output.fsPath}`);
      } catch (error) {
        finishPublication();
        void vscode.window.showErrorMessage(
          `PDF の保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    controller = new PreviewController(
      panel,
      {
        scriptUri: mediaUri("webview.js"),
        styleUri: mediaUri("webview.css"),
        pdfWorkerUri: mediaUri("pdf.worker.mjs"),
      },
      document,
      {
        onDidChangeTextDocument: (listener) => vscode.workspace.onDidChangeTextDocument(listener),
      },
      () => {
        panelDisposed = true;
        const key = document.uri.toString();
        pdfConfirmationExports.delete(key);
        const operation = pendingPdfExports.get(key);
        if (operation) delete operation.finishPanel;
        pdfRequest += 1;
        pdfAbort?.abort();
        discardPendingPdfContent();
        pdfSaveSubscription?.dispose();
        pdfExternalChangeSubscription.dispose();
        previewSources.delete(panel);
        rawBlockCompiler.dispose();
        clearPreviewProblems();
        rawBlockSettings.dispose();
        templateWatcher.dispose();
        viewStateSubscription.dispose();
        if (!previewLifecycle.panelDisposed(document.uri, controller)) return;
        if (previewController === controller) previewController = undefined;
      },
      {
        previewTabChanged: (tab, retryPdfId, deckChanged) => {
          pdfTabVisible = tab === "pdf";
          if (!pdfTabVisible) {
            if (retryPdfId !== undefined && retryPdfId === sentPdfArtifactId)
              sentPdfArtifactId = undefined;
            if (rawClearPending) controller.postRawImagesCleared();
            rawClearPending = false;
            if (rawResultsPending || deckChanged) {
              rawResultsPending = false;
              rawBlockCompiler.forgetDelivered();
            }
            const outcome = controller.latestOutcome;
            if (outcome) requestRawBlocks(outcome);
            return;
          }
          // Full-deck Tectonic より先に、待機中/前処理中の fragment を止める。
          // 成功キャッシュは保持し、編集タブで最新本文だけ復帰する。
          rawBlockCompiler.pause();
        },
        render: (text, version) =>
          renderDocument(text, version, (doc) => editingPreviewOptions(doc, templateFs)),
        onRendered: (outcome, source) => {
          const current = source as vscode.TextDocument;
          if (current.version === outcome.version) {
            if (publishedPreview?.document !== current) clearPreviewProblems();
            publishedPreview = { document: current, outcome };
            latestPreview.set(current, outcome);
            publishProblems(current);
          }
          requestRawBlocks(outcome);
        },
        onWebviewReady: () => {
          rawBlockCompiler.forgetDelivered();
          sentPdfArtifactId = undefined;
          pdfOpened = false;
          pdfTabVisible = false;
          rawResultsPending = false;
          rawClearPending = false;
        },
        pdfAction: (action, artifactId) => {
          if (action === "save") {
            void saveDisplayedPdf(artifactId);
            return;
          }
          if (!pdfTabVisible) return;
          pdfOpened = true;
          if (
            action === "refresh" ||
            (vscode.workspace.isTrusted &&
              !pdfBytes &&
              !pendingPdf &&
              !pdfAbort &&
              !pdfFailure &&
              !pdfTooLarge &&
              pdfExportRequest !== pdfRequest)
          )
            void compilePdfConfirmation();
          else if (pendingPdf && !pendingPdf.loading && panel.visible !== false)
            void loadPendingPdf();
          else postPdf();
        },
        onError: (message) => {
          void vscode.window.showErrorMessage(`Beamer preview: ${message}`);
        },
        onWarning: (message) => {
          void vscode.window.showWarningMessage(`Beamer preview: ${message}`);
        },
        navigate: (offset) => {
          const target =
            vscode.workspace.textDocuments.find(
              (candidate) => candidate.uri.toString() === document.uri.toString(),
            ) ?? document;
          void jumpToOffset(target, offset, lineFlash, sourceViewColumn);
        },
        // Webview からの Cmd/Ctrl+Z(#103)。押下時点の panel と文書を固定して列に入れる。
        undoRedo: (kind) =>
          previewHistory.request(kind, { panel, uri: document.uri, viewColumn: sourceViewColumn }),
        resolveResource: (path) => {
          const uri = path.startsWith("/")
            ? vscode.Uri.file(path)
            : vscode.Uri.joinPath(documentDir, path);
          return panel.webview.asWebviewUri(uri).toString();
        },
        setCanvasFontSize: async (move) => {
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
          const replacement = canvasFontSizeReplacement(original, move.size);
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
        resizeCanvasElement: async (move) => {
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
          const replacement = canvasWidthReplacement(original, move.width);
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
          const replacement = canvasPositionReplacement(original, move.x, move.y);
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
        detachToCanvas: async (request) => {
          const target = vscode.workspace.textDocuments.find(
            (candidate) => candidate === request.document,
          );
          if (
            !target ||
            target.uri.toString() !== request.document.uri.toString() ||
            target.version !== request.version
          )
            return "cancelled";
          const result = detachBlockToCanvas(
            target.getText(),
            request.sourceSpan,
            request.placement,
          );
          if (result === null) return "cancelled";
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            target.uri,
            new vscode.Range(
              target.positionAt(result.span.start),
              target.positionAt(result.span.end),
            ),
            result.text,
          );
          return (await vscode.workspace.applyEdit(edit)) ? "applied" : "failed";
        },
        editSlide: async (request) => {
          const target = vscode.workspace.textDocuments.find(
            (candidate) => candidate === request.document,
          );
          if (!target || target.version !== request.version) return { applied: false };
          return slideEdits.executeAt(request.action, target, request.version, request.frameOffset);
        },
        // スライド一覧が別の文書を表示していても、プレビュー自身の文書で判定する。実行時の照合と
        // 同じ判定(管理対象・閉じていない・書き込み可を含む)を使う。
        isSlideEditable: (target, version, start) => {
          const document = vscode.workspace.textDocuments.find((candidate) => candidate === target);
          return document !== undefined && slideEdits.canMoveAt(document, version, start);
        },
        // プレビューからの削除・コピー・貼り付け(#148)。対象は要求時の version の文書だけ。
        deleteCanvasElement: async (request) => {
          const target = liveDocument(request.document, request.version);
          if (!target) return "cancelled";
          const text = target.getText();
          if (
            text.slice(request.sourceSpan.start, request.sourceSpan.end) !== request.expectedOptions
          )
            return "cancelled";
          const result = removeCanvasObject(text, request.sourceSpan);
          if (result === null) return "cancelled";
          return (await applyReplacement(target, result)) ? "applied" : "failed";
        },
        copyCanvasElement: async (request) => {
          const target = liveDocument(request.document, request.version);
          if (!target) return false;
          const text = target.getText();
          if (
            text.slice(request.sourceSpan.start, request.sourceSpan.end) !== request.expectedOptions
          )
            return false;
          const source = canvasObjectSource(text, request.sourceSpan);
          if (source === null) return false;
          await vscode.env.clipboard.writeText(source);
          return true;
        },
        pasteCanvasElements: async (request) => {
          const clipboard = await vscode.env.clipboard.readText();
          // クリップボードを読む間に文書が進んでいたら書かない。
          const target = liveDocument(request.document, request.version);
          if (!target) return "cancelled";
          const result = pasteCanvasObjects(target.getText(), request.frameOffset, clipboard);
          if (result === null) return "notCanvas";
          return (await applyReplacement(target, result)) ? "applied" : "failed";
        },
      },
    );
    previewViewStateChanged = () => {
      const visible = pdfOpened && pdfTabVisible && panel.visible;
      if (!visible) return;
      void loadPendingPdf();
      postPdf();
    };
    const beginPanelExport = (output: string, savedInputChanged = false): FinishPdfExport => {
      // A normal Export saves first. Its later result must outrank an older
      // confirmation compile that happens to finish afterwards.
      const request = ++pdfRequest;
      pdfExportRequest = request;
      const inputRevision = pdfInputRevision;
      const compiledEditingRevision = editingInputsRevision;
      pdfAbort?.abort();
      pdfAbort = undefined;
      pdfFailure = undefined;
      pdfTooLarge = false;
      // A normal Export may have started before this panel existed. Only a
      // later saved/reloaded input makes that result stale; unsaved edits have
      // their own label and must not change the saved revision.
      if (savedInputChanged) markPdfStale();
      postPdf();
      const finishPublication = pdfPublications.begin(output);
      return (review, dependencyChanged = false, pdfOnlyChanged = false, publication) => {
        finishPublication(review?.writtenFileIdentity);
        if (pdfExportRequest === request) pdfExportRequest = undefined;
        const shouldDisplay = request === pdfRequest;
        // A later Export can still overwrite a file read by the currently shown PDF.
        // Its own output is reliable evidence even after this request was superseded.
        const outputChangedCurrentPdf =
          pdfBytes !== undefined &&
          pdfDependencyPaths !== undefined &&
          mayReadPdfOutput(output, pdfDependencyPaths);
        const outputChangedAdoptedPdf =
          shouldDisplay &&
          review?.dependencyPaths !== undefined &&
          mayReadPdfOutput(output, review.dependencyPaths);
        const inputChanged =
          (shouldDisplay && dependencyChanged) ||
          outputChangedAdoptedPdf ||
          outputChangedCurrentPdf;
        const createdWatchedPdf =
          publication !== undefined && isNewWatchedPdfOutput(output, publication.overwritten);
        if (inputChanged) markPdfStale();
        else if ((shouldDisplay && pdfOnlyChanged) || createdWatchedPdf) markPdfStale(false);
        if (shouldDisplay && review) {
          setCompiledPdf(review, inputRevision, compiledEditingRevision);
          if (pdfTabVisible) void loadPendingPdf();
        } else {
          void review?.content?.dispose();
          if (shouldDisplay && pdfOpened && !pdfBytes)
            pdfFailure = "PDF 書き出しが完了しませんでした。更新して再試行できます。";
          postPdf();
        }
      };
    };
    const pdfDocumentKey = document.uri.toString();
    pdfConfirmationExports.set(pdfDocumentKey, beginPanelExport);
    const pendingPdfExport = pendingPdfExports.get(pdfDocumentKey);
    if (pendingPdfExport)
      pendingPdfExport.finishPanel = beginPanelExport(
        pendingPdfExport.output,
        pendingPdfExport.savedInputChanged,
      );
    const refreshEditingInputs = () => {
      editingInputsRevision += 1;
      clearPreviewProblems();
      // 画像や .sty が足されたり直ったりしたときは、失敗していた生ブロックも次の描画で再試行する。
      rawBlockCompiler.resetFailures();
      controller.refresh();
      lintController.refresh(vscode.workspace.textDocuments);
    };
    const refreshTemplates = (
      changed: vscode.Uri,
      ownChange = pdfPublications.ownChange(changed.fsPath, () => pdfFileIdentity(changed.fsPath)),
    ) => {
      if (panelDisposed) return;
      const refresh = () => {
        refreshEditingInputs();
        markPdfStale(false);
      };
      if (!ownChange) {
        refresh();
        return;
      }
      // Ignore our own unrelated publication before it can reset raw output,
      // transfer hidden HTML, or refresh diagnostics.
      void ownChange.then((matches) => {
        if (panelDisposed) return;
        const affectsDisplayed = pdfBytes && mayReadPdfOutput(changed.fsPath, pdfDependencyPaths);
        const affectsPending =
          pendingPdf && mayReadPdfOutput(changed.fsPath, pendingPdf.dependencyPaths);
        if (!matches || affectsDisplayed || affectsPending || (!pdfBytes && !pendingPdf)) refresh();
      });
    };
    const refreshCreatedPdfEditingInputs = (changed: vscode.Uri) => {
      const dependencies = editingWatcherDependencies();
      const editingRevision = editingInputsRevision;
      if (dependencies === undefined || watchesPdfInput(changed.fsPath, dependencies)) {
        refreshEditingInputs();
        return;
      }
      void mayReferenceCreatedPdf(changed.fsPath, dependencies).then((mayReference) => {
        // PDF だけを古くした通知は、このスナップショットを無効にしない。
        if (
          mayReference &&
          !panelDisposed &&
          !pdfDirty &&
          editingInputsRevision === editingRevision
        )
          refreshEditingInputs();
      });
    };
    const refreshChangedPdfInputs = (
      changed: vscode.Uri,
      ownChange = pdfPublications.ownChange(changed.fsPath, () => pdfFileIdentity(changed.fsPath)),
    ) => {
      const currentDependencies = watcherDependencies();
      const editingDependencies = editingWatcherDependencies();
      const affectsPdf =
        currentDependencies === undefined || watchesPdfInput(changed.fsPath, currentDependencies);
      const affectsEditing =
        editingDependencies === undefined || watchesPdfInput(changed.fsPath, editingDependencies);
      const refresh = () => {
        // An in-flight compile has no current dependency proof. It becomes stale
        // even if the older HTML snapshot proves the change irrelevant.
        if (affectsPdf) markPdfStale(false);
        if (affectsEditing) refreshEditingInputs();
      };
      if (!ownChange) {
        refresh();
        return;
      }
      void ownChange.then((matches) => {
        if (panelDisposed) return;
        const affectsKnownInput =
          (currentDependencies !== undefined &&
            watchesPdfInput(changed.fsPath, currentDependencies)) ||
          (editingDependencies !== undefined &&
            watchesPdfInput(changed.fsPath, editingDependencies));
        if (matches && !affectsKnownInput) return;
        refresh();
      });
    };
    const onTemplateChanged = (kind: "create" | "change" | "delete") => (changed: vscode.Uri) => {
      // FileSystemWatcher は外部で作られた PDF も通知する。現在の組版ログで
      // 非参照と証明できるものは、部分コンパイル失敗の解除や画像 URL の世代更新より前に捨てる。
      if (kind !== "create") {
        if (path.extname(changed.fsPath).toLowerCase() === ".pdf") refreshChangedPdfInputs(changed);
        else refreshTemplates(changed);
        return;
      }
      // 公開記録は通知を受けた時点で取得する。静的走査を待つ間に有効期限を越えないようにする。
      const ownChange = pdfPublications.ownChange(changed.fsPath, () =>
        pdfFileIdentity(changed.fsPath),
      );
      if (path.extname(changed.fsPath).toLowerCase() !== ".pdf") {
        refreshTemplates(changed, ownChange);
        return;
      }
      const external = () => {
        if (panelDisposed) return;
        // Tectonic が前回読まなかったファイルでも TeX の条件分岐やマクロ展開で
        // 内容を変えられる。PDF の版は直ちに古くし、編集側の再生成だけを別途絞る。
        markPdfStale(false);
        refreshCreatedPdfEditingInputs(changed);
      };
      if (!ownChange) {
        external();
        return;
      }
      void ownChange.then((matches) => {
        if (panelDisposed) return;
        const dependencies = editingWatcherDependencies();
        const affectsEditing =
          dependencies === undefined || watchesPdfInput(changed.fsPath, dependencies);
        if (matches && !affectsEditing) return;
        if (matches) refreshTemplates(changed, ownChange);
        else external();
      });
    };
    templateWatcher.onDidChange(onTemplateChanged("change"));
    templateWatcher.onDidCreate(onTemplateChanged("create"));
    templateWatcher.onDidDelete(onTemplateChanged("delete"));
    // Tectonic の場所や部分コンパイルの有効/無効が変わったら、エンジンの判定と失敗を捨てて描画し直す
    // (プレビューを開き直さずに再試行できる)。
    const rawBlockSettings = vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("beamerEditor.tectonicPath", document.uri) ||
        event.affectsConfiguration("beamerEditor.pdfExport.timeoutSeconds", document.uri)
      )
        markPdfStale();
      if (!affectsRawBlockCompile((section) => event.affectsConfiguration(section, document.uri)))
        return;
      rawBlockCompiler.reset();
      if (!rawBlocksEnabled()) {
        if (pdfTabVisible) rawClearPending = true;
        else controller.postRawImagesCleared();
      }
      controller.refresh();
    });
    context.subscriptions.push(templateWatcher, rawBlockSettings);
    previewLifecycle.register(document.uri, controller, document, automatic);
    previewController = controller;
  }

  function handleManagedDocument(document: vscode.TextDocument | undefined): void {
    if (!document || !isManaged(document)) return;
    openPreview(document, true);
    void offerLatexWorkshopIgnore(document).catch((error) => {
      void vscode.window.showErrorMessage(
        `Beamer Editor: LaTeX Workshop settings update failed: ${String(error)}`,
      );
    });
  }

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      previewLifecycle.sourceClosed(document.uri)?.close();
      if (slideOutlineState.hasDocument(document)) updateSlideOutline(undefined);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (
        hasSlideOutlineContentChanges(event.contentChanges) &&
        slideOutlineState.hasDocument(event.document)
      )
        slideOutlineRefresh.schedule(event.document);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      // Webview focus では editor が undefined になる。対応する panel の view-state
      // listener が source を設定するので、ここで空にして一覧をちらつかせない。
      if (editor) updateSlideOutline(isManaged(editor.document) ? editor.document : undefined);
      handleManagedDocument(editor?.document);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("beamerEditor.managedFiles")) return;
      managedPatternCache.clear();
      foldingRangesChanged.fire();
      lintController.refresh(vscode.workspace.textDocuments);
      for (const controller of previewLifecycle.managedFilesChanged(isManaged)) controller.close();
      const activeDocument = vscode.window.activeTextEditor?.document;
      updateSlideOutline(
        managedOutlineDocument(activeDocument, slideOutlineState.getDocument(), isManaged),
      );
      handleManagedDocument(activeDocument);
    }),
  );
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor)
    updateSlideOutline(isManaged(activeEditor.document) ? activeEditor.document : undefined);
  handleManagedDocument(vscode.window.activeTextEditor?.document);

  context.subscriptions.push(
    vscode.commands.registerCommand("beamerEditor.openPreview", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.uri.scheme !== "file" || !editor.document.fileName.endsWith(".tex")) {
        void vscode.window.showErrorMessage("Open a .tex file before opening a Beamer preview.");
        return;
      }

      openPreview(editor.document, false);
    }),
    vscode.commands.registerCommand("beamerEditor.export", async (uri?: vscode.Uri) => {
      const isTex = (candidate: vscode.Uri | undefined): candidate is vscode.Uri =>
        candidate?.scheme === "file" && candidate.fsPath.endsWith(".tex");
      let explicit: vscode.TextDocument | undefined;
      if (isTex(uri)) {
        const sourceUri = uri;
        explicit =
          vscode.workspace.textDocuments.find(
            (document) => document.uri.toString() === sourceUri.toString(),
          ) ?? (await vscode.workspace.openTextDocument(sourceUri));
      }
      const source = resolveExportDocument(
        explicit,
        [...previewSources].map(([panel, document]) => ({ active: panel.active, document })),
        vscode.window.activeTextEditor?.document,
      );
      await exportController.export(source as ExportDocument | undefined);
    }),
  );

  // ---- ソース → プレビュー(#66): CodeLens・コマンド・キーバインド・カーソル追従 ----
  const FOLLOW_SETTING = "beamerEditor.preview.followCursor";
  const followCursorEnabled = (): boolean =>
    vscode.workspace.getConfiguration("beamerEditor").get<boolean>("preview.followCursor") ?? true;
  const syncFollowContext = (): void => {
    void vscode.commands.executeCommand(
      "setContext",
      "beamerEditor.followCursor",
      followCursorEnabled(),
    );
  };
  syncFollowContext();

  /**
   * offset を含むフレームをプレビューで表示する。プレビューが無ければ開く(フォーカスはソースに残す)。
   * managed でない文書と、フレーム外(プリアンブル・フレーム間)の位置では何もしない(#66 の対象外)。
   */
  function revealSlide(document: vscode.TextDocument, offset: number, onlyIfChanged = false): void {
    if (!isManaged(document)) return;
    if (!onlyIfChanged) {
      if (!sourceHasFrameAt(document.getText(), offset)) return;
      // 明示的な操作なので、閉じられていたプレビューも開き直す。
      previewLifecycle.dismissals.clear(document.uri);
      openPreview(document, false, true);
    }
    previewLifecycle.registry
      .get(document.uri)
      ?.controller.revealSourceOffset(offset, { onlyIfChanged });
  }

  /**
   * 追従の切り替え。effective value を決めている scope へ書く(workspace が上書きしていれば
   * workspace、そうでなければ user)。Global だけ書くと workspace の値が勝ってボタンが効かない。
   * 設定の scope は window なので folder 単位の値は無い。
   */
  async function setFollowCursor(enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration("beamerEditor");
    const target =
      config.inspect<boolean>("preview.followCursor")?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await config.update("preview.followCursor", enabled, target);
    syncFollowContext();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "beamerEditor.revealSlideInPreview",
      (uri?: string, offset?: number) => {
        const editor = vscode.window.activeTextEditor;
        const document = uri
          ? vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri)
          : editor?.document;
        if (!document) return;
        const at =
          typeof offset === "number"
            ? offset
            : editor && editor.document === document
              ? document.offsetAt(editor.selection.active)
              : 0;
        revealSlide(document, at);
      },
    ),
    vscode.commands.registerCommand("beamerEditor.followCursor.enable", () =>
      setFollowCursor(true),
    ),
    vscode.commands.registerCommand("beamerEditor.followCursor.disable", () =>
      setFollowCursor(false),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(FOLLOW_SETTING)) syncFollowContext();
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (!followCursorEnabled()) return;
      // プレビュー → ソースのジャンプなどプログラムによる選択変更には追従しない(往復を避ける)。
      if (event.kind === undefined || event.kind === vscode.TextEditorSelectionChangeKind.Command)
        return;
      const document = event.textEditor.document;
      if (!previewLifecycle.registry.get(document.uri)) return;
      const selection = event.selections[0];
      if (!selection) return;
      revealSlide(document, document.offsetAt(selection.active), true);
    }),
    vscode.languages.registerCodeLensProvider(
      { scheme: "file", language: "latex" },
      {
        provideCodeLenses(document) {
          if (!isManaged(document)) return [];
          return frameLensPositions(document.getText(), (offset) =>
            document.positionAt(offset),
          ).map(
            ({ offset, line }) =>
              new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
                title: "プレビューで表示",
                command: "beamerEditor.revealSlideInPreview",
                arguments: [document.uri.toString(), offset],
              }),
          );
        },
      },
    ),
  );

  return {
    _previewControllerForTest: () => previewController,
    _slideItemsForTest: () =>
      slideOutlineState.getEntries().map((entry) => new SlideOutlineItem(entry)),
    _imagePasteProviderForTest: () => imagePaste,
  };
}

/** プレビューが編集要求の基にした文書が、今も同じ version で開かれていればそれを返す。 */
function liveDocument(
  document: { uri: { toString(): string } },
  version: number,
): vscode.TextDocument | undefined {
  const target = vscode.workspace.textDocuments.find((candidate) => candidate === document);
  return target && target.uri.toString() === document.uri.toString() && target.version === version
    ? target
    : undefined;
}

/** span をテキストで置き換える 1 つの WorkspaceEdit を適用する(1 操作 = 1 undo)。 */
async function applyReplacement(
  target: vscode.TextDocument,
  replacement: { span: { start: number; end: number }; text: string },
): Promise<boolean> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    target.uri,
    new vscode.Range(
      target.positionAt(replacement.span.start),
      target.positionAt(replacement.span.end),
    ),
    replacement.text,
  );
  return vscode.workspace.applyEdit(edit);
}

export function deactivate(): void {
  for (const controller of previewLifecycle.deactivate()) controller.close();
  previewController = undefined;
}
