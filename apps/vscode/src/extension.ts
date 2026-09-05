import {
  canvasPositionReplacement,
  detachBlockToCanvas,
  type LintDiagnostic,
  type LintSeverity,
} from "@beamer-editor/core";
import * as vscode from "vscode";
import { LintController } from "./diagnostics";
import { FrameFoldCache, provideFrameFoldRanges } from "./frame-folding";
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
import { PreviewController } from "./preview-controller";
import { frameLensPositions, sourceHasFrameAt } from "./reveal-slide";
import { resolveSourceViewColumn } from "./source-navigation";
import { YenBackslashCodeActionProvider } from "./yen-code-actions";

let previewController: PreviewController | undefined;
const previewLifecycle = new ManagedPreviewLifecycle<PreviewController, vscode.TextDocument>();

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
  fallbackViewColumn: vscode.ViewColumn | undefined,
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
  const managedPatternCache = new Map<string, readonly string[]>();
  const frameFoldCache = new FrameFoldCache();
  const foldingRangesChanged = new vscode.EventEmitter<void>();
  const latexWorkshopSessionPrompted = new Set<string>();
  const lineFlash = createLineFlash();
  context.subscriptions.push(lineFlash, foldingRangesChanged);

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
    (document) => isManaged(document),
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

  const yenCodeActions = new YenBackslashCodeActionProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file", language: "latex" },
      {
        provideCodeActions(document, range, context, token) {
          return isManaged(document)
            ? yenCodeActions.provideCodeActions(document, range, context, token)
            : [];
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );

  context.subscriptions.push(
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
    const viewStateSubscription = panel.onDidChangeViewState(lockGroupIfActive);
    lockGroupIfActive();

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
        viewStateSubscription.dispose();
        if (!previewLifecycle.panelDisposed(document.uri, controller)) return;
        if (previewController === controller) previewController = undefined;
      },
      {
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
      },
    );
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
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => handleManagedDocument(editor?.document)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("beamerEditor.managedFiles")) return;
      managedPatternCache.clear();
      foldingRangesChanged.fire();
      lintController.refresh(vscode.workspace.textDocuments);
      for (const controller of previewLifecycle.managedFilesChanged(isManaged)) controller.close();
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

      openPreview(editor.document, false);
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
    vscode.commands.registerCommand("beamerEditor.revealSlide", (uri?: string, offset?: number) => {
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
    }),
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
                command: "beamerEditor.revealSlide",
                arguments: [document.uri.toString(), offset],
              }),
          );
        },
      },
    ),
  );

  return { _previewControllerForTest: () => previewController };
}

export function deactivate(): void {
  for (const controller of previewLifecycle.deactivate()) controller.close();
  previewController = undefined;
}
