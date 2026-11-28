import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { compileFragment, PdfReviewContent } from "@beamer-editor/compiler";
import { managedPreambleBlock } from "@beamer-editor/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { ExportDocument, ExportHost } from "../src/export-controller";
import type { PreviewControllerOptions } from "../src/preview-controller";
import type { RawBlockCompilerOptions } from "../src/raw-block-compiler";

const state = vi.hoisted(() => ({
  bundled: undefined as string | undefined,
  configured: undefined as unknown,
  exportHost: undefined as ExportHost | undefined,
  rawHost: undefined as RawBlockCompilerOptions | undefined,
  previewOptions: undefined as PreviewControllerOptions | undefined,
  activeEditor: undefined as vscode.TextEditor | undefined,
  commands: new Map<string, () => void>(),
  compile: vi.fn<typeof compileFragment>(),
  compilePdf: vi.fn<typeof import("@beamer-editor/compiler").compilePdf>(),
  publishPdf: vi.fn<typeof import("@beamer-editor/compiler").publishPdf>(),
  postPdfState: vi.fn(),
  setDiagnostics: vi.fn<(uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[]) => void>(),
  getConfiguration: vi.fn(),
  fileChanges: [] as Array<(uri: vscode.Uri) => void>,
  fileCreates: [] as Array<(uri: vscode.Uri) => void>,
  fileDeletes: [] as Array<(uri: vscode.Uri) => void>,
  watchedFiles: new Map<string, Uint8Array>(),
  temporaryDirectories: [] as string[],
  refreshPreview: vi.fn(),
  pdfIdentity: vi.fn<() => Promise<string | undefined>>(),
  saveDialog: vi.fn(),
  saveListeners: [] as Array<(document: vscode.TextDocument) => void>,
  openListeners: [] as Array<(document: vscode.TextDocument) => void>,
  changeListeners: [] as Array<(event: vscode.TextDocumentChangeEvent) => void>,
  configurationListeners: [] as Array<(event: vscode.ConfigurationChangeEvent) => void>,
}));

vi.mock("vscode", () => {
  const disposable = () => ({ dispose() {} });
  const listener = <T>(listeners: T[], value: T) => {
    listeners.push(value);
    return { dispose: () => listeners.splice(listeners.indexOf(value), 1) };
  };
  const file = (fsPath: string) => ({ scheme: "file", fsPath, toString: () => `file://${fsPath}` });
  return {
    Uri: {
      file,
      joinPath: (base: { fsPath: string }, ...parts: string[]) =>
        file(resolve(base.fsPath, ...parts)),
    },
    EventEmitter: class {
      event = disposable;
      fire() {}
      dispose() {}
    },
    ThemeColor: class {},
    Range: class {
      constructor(
        readonly startLine: number,
        readonly startCharacter: number,
        readonly endLine: number,
        readonly endCharacter: number,
      ) {}
    },
    TreeItem: class {},
    RelativePattern: class {},
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    Diagnostic: class {
      constructor(
        readonly range: unknown,
        readonly message: string,
        readonly severity: number,
      ) {}
    },
    CodeActionKind: { QuickFix: "quickfix" },
    DocumentDropOrPasteEditKind: {
      Empty: { append: (...parts: string[]) => ({ value: parts.join(".") }) },
    },
    ViewColumn: { One: 1, Beside: -2 },
    window: {
      get activeTextEditor() {
        return state.activeEditor;
      },
      visibleTextEditors: [],
      createTextEditorDecorationType: disposable,
      createOutputChannel: disposable,
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      registerTreeDataProvider: disposable,
      onDidChangeActiveTextEditor: disposable,
      onDidChangeTextEditorSelection: disposable,
      createWebviewPanel: () => ({
        active: false,
        visible: true,
        onDidChangeViewState: disposable,
        webview: { asWebviewUri: (uri: unknown) => uri },
      }),
      showSaveDialog: state.saveDialog,
    },
    workspace: {
      isTrusted: true,
      textDocuments: [],
      getConfiguration: state.getConfiguration,
      getWorkspaceFolder: () => undefined,
      onDidOpenTextDocument: (callback: (document: vscode.TextDocument) => void) =>
        listener(state.openListeners, callback),
      onDidChangeTextDocument: (callback: (event: vscode.TextDocumentChangeEvent) => void) =>
        listener(state.changeListeners, callback),
      onDidSaveTextDocument: (callback: (document: vscode.TextDocument) => void) =>
        listener(state.saveListeners, callback),
      onDidCloseTextDocument: disposable,
      onDidChangeConfiguration: (callback: (event: vscode.ConfigurationChangeEvent) => void) =>
        listener(state.configurationListeners, callback),
      createFileSystemWatcher: () => ({
        ...disposable(),
        onDidChange: (callback: (uri: vscode.Uri) => void) => listener(state.fileChanges, callback),
        onDidCreate: (callback: (uri: vscode.Uri) => void) => listener(state.fileCreates, callback),
        onDidDelete: (callback: (uri: vscode.Uri) => void) => listener(state.fileDeletes, callback),
      }),
      fs: {
        stat: async (uri: { fsPath: string }) => {
          const data = state.watchedFiles.get(uri.fsPath);
          if (!data) throw new Error("not found");
          return { type: 1, mtime: 0, size: data.byteLength };
        },
        readFile: async (uri: { fsPath: string }) => {
          const data = state.watchedFiles.get(uri.fsPath);
          if (!data) throw new Error("not found");
          return data;
        },
      },
    },
    languages: {
      createDiagnosticCollection: () => ({ ...disposable(), set: state.setDiagnostics }),
      match: () => 1,
      registerCodeActionsProvider: disposable,
      registerFoldingRangeProvider: disposable,
      registerHoverProvider: disposable,
      registerCodeLensProvider: disposable,
      registerDocumentPasteEditProvider: disposable,
    },
    commands: {
      executeCommand: vi.fn(),
      registerCommand: (name: string, callback: () => void) => {
        state.commands.set(name, callback);
        return disposable();
      },
    },
  };
});

vi.mock("@beamer-editor/compiler", async (original) => ({
  ...(await original<typeof import("@beamer-editor/compiler")>()),
  compileFragment: state.compile,
  compilePdf: state.compilePdf,
  pdfFileIdentity: state.pdfIdentity,
  publishPdf: state.publishPdf,
}));
vi.mock("../src/tectonic", async (original) => ({
  ...(await original<typeof import("../src/tectonic")>()),
  detectBundledTectonic: () => state.bundled,
}));
vi.mock("../src/export-controller", async (original) => ({
  ...(await original<typeof import("../src/export-controller")>()),
  ExportController: class {
    constructor(host: ExportHost) {
      state.exportHost = host;
    }
    dispose() {}
  },
}));
vi.mock("../src/raw-block-compiler", async (original) => ({
  ...(await original<typeof import("../src/raw-block-compiler")>()),
  RawBlockCompiler: class {
    constructor(host: RawBlockCompilerOptions) {
      state.rawHost = host;
    }
    dispose() {}
    pause() {}
    resume() {}
    forgetDelivered() {}
    resetFailures() {}
  },
}));
vi.mock("../src/preview-controller", () => ({
  PreviewController: class {
    constructor(
      _panel: unknown,
      _assets: unknown,
      _document: unknown,
      _events: unknown,
      readonly close: () => void,
      options: PreviewControllerOptions,
    ) {
      state.previewOptions = options;
    }
    postPdfState = state.postPdfState;
    refresh = state.refreshPreview;
  },
}));

import { Range, Uri } from "vscode";
import { activate, deactivate } from "../src/extension";

describe("extension の Tectonic 接続", () => {
  const subscriptions: vscode.Disposable[] = [];
  afterEach(() => {
    deactivate();
    for (const item of subscriptions.splice(0)) item.dispose();
    state.activeEditor = undefined;
    state.commands.clear();
    state.saveListeners.splice(0);
    state.openListeners.splice(0);
    state.fileChanges.splice(0);
    state.fileCreates.splice(0);
    state.fileDeletes.splice(0);
    state.watchedFiles.clear();
    for (const directory of state.temporaryDirectories.splice(0))
      rmSync(directory, { recursive: true, force: true });
    state.changeListeners.splice(0);
    state.configurationListeners.splice(0);
    state.saveDialog.mockResolvedValue(undefined);
    vi.clearAllMocks();
  });

  it.each([
    "/extension/bin/tectonic",
    undefined,
  ])("同梱=%s: 書き出しと部分コンパイルへ同じパスを渡し、文書設定の変更を反映する", async (bundled) => {
    state.bundled = bundled;
    state.configured = "";
    state.getConfiguration.mockImplementation(() => ({
      get: (name: string, fallback: unknown) =>
        name === "tectonicPath" ? state.configured : fallback,
    }));
    state.compile.mockResolvedValue({ pdf: new Uint8Array([1]), engineVersion: "Tectonic 0.17.0" });
    const document = {
      uri: Uri.file("/project/deck.slide.tex"),
      fileName: "/project/deck.slide.tex",
    } as vscode.TextDocument;
    activate({
      extensionPath: "/extension",
      extensionUri: Uri.file("/extension"),
      globalStorageUri: Uri.file("/storage"),
      subscriptions,
    } as vscode.ExtensionContext);
    state.activeEditor = { document } as vscode.TextEditor;
    state.commands.get("beamerEditor.openPreview")?.();
    expect(state.rawHost).toBeDefined();

    for (const [configured, expected] of [
      ["", bundled],
      ["  /custom/tectonic  ", "/custom/tectonic"],
      [" \t ", bundled],
    ]) {
      state.configured = configured;
      const signal = new AbortController().signal;
      await state.rawHost?.compile("fragment", signal);
      expect(state.compile).toHaveBeenLastCalledWith({
        document: "fragment",
        cwd: "/project",
        signal,
        timeoutMs: 300_000,
        maxOutputBytes: expect.any(Number),
        ...(expected ? { tectonicPath: expected } : {}),
      });
      expect(state.exportHost?.tectonicPath(document as ExportDocument)).toBe(expected);
      expect(state.getConfiguration).toHaveBeenLastCalledWith("beamerEditor", document.uri);
    }
  });

  it("現在の描画だけを Problems に表示し、画像作成後に診断を更新する", () => {
    openPdfTestDocument();
    state.getConfiguration.mockImplementation(() => ({
      get: (name: string, fallback: unknown) =>
        name === "preview.compileRawBlocks" ? false : fallback,
    }));
    const directory = mkdtempSync(join(tmpdir(), "beamer-preview-problems-"));
    state.temporaryDirectories.push(directory);
    const file = join(directory, "deck.slide.tex");
    const source = String.raw`\begin{document}
\begin{frame}[label=intro]{Intro}
  \includegraphics{figure.png}
  $\TeXOnlyCommand{x}$
\end{frame}
\end{document}`;
    let version = 1;
    const document = {
      uri: Uri.file(file),
      fileName: file,
      isDirty: false,
      get version() {
        return version;
      },
      getText: () => source,
      positionAt: (offset: number) => ({ line: 0, character: offset }),
    } as vscode.TextDocument;
    state.activeEditor = { document } as vscode.TextEditor;
    state.commands.get("beamerEditor.openPreview")?.();
    const { render, onRendered } = state.previewOptions ?? {};
    if (!render || !onRendered) throw new Error("expected editing preview");
    const codes = () => state.setDiagnostics.mock.lastCall?.[1].map((entry) => entry.code);

    const first = render(source, version);
    onRendered(first, document);
    expect(codes()).toEqual(["L004", "P001"]);
    expect(state.setDiagnostics.mock.lastCall?.[1][0]?.message).toContain("フレーム 1 [intro]");

    version++;
    state.setDiagnostics.mockClear();
    onRendered(first, document);
    expect(state.setDiagnostics).not.toHaveBeenCalled();
    onRendered(render(source, version), document);
    expect(codes()).toEqual(["L004", "P001"]);

    const image = join(directory, "figure.png");
    writeFileSync(image, "preview checks existence");
    state.fileCreates.at(-1)?.(Uri.file(image));
    expect(state.refreshPreview).toHaveBeenCalled();
    expect(codes()).toEqual([]);
    onRendered(render(source, version), document);
    expect(codes()).toEqual(["P001"]);
  });

  it("Problems は展開後の画像参照を使い、一致する lint の修正候補を残す", () => {
    openPdfTestDocument();
    state.getConfiguration.mockImplementation(() => ({
      get: (name: string, fallback: unknown) =>
        name === "preview.compileRawBlocks" ? false : fallback,
    }));
    const directory = mkdtempSync(join(tmpdir(), "beamer-preview-image-macro-"));
    state.temporaryDirectories.push(directory);
    const file = join(directory, "deck.slide.tex");
    const image = join(directory, "available.png");
    writeFileSync(image, "exists");
    writeFileSync(join(directory, "literal.png"), "exists");
    const source = String.raw`%% macros:begin
\newcommand{\asset}{available.png}
%% macros:end
\begin{document}
\begin{frame}[label=images]{Images}
  \includegraphics{\asset}
  \includegraphics{literal}
  \begin{deckcanvas}\deckimage[x=0,y=0,w=1]{\asset}\end{deckcanvas}
\end{frame}
\end{document}`;
    let currentSource = source;
    let version = 1;
    const document = {
      uri: Uri.file(file),
      fileName: file,
      isDirty: false,
      get version() {
        return version;
      },
      getText: () => currentSource,
      positionAt: (offset: number) => ({ line: 0, character: offset }),
    } as vscode.TextDocument;
    state.activeEditor = { document } as vscode.TextEditor;
    const imageProblems = () =>
      state.setDiagnostics.mock.lastCall?.[1].filter((entry) => entry.code === "L004");
    for (const listener of state.openListeners) listener(document);
    expect(imageProblems()).toHaveLength(2);

    state.commands.get("beamerEditor.openPreview")?.();
    const { render, onRendered } = state.previewOptions ?? {};
    if (!render || !onRendered) throw new Error("expected editing preview");
    const available = render(source, document.version);
    expect(available.deck.frames[0]?.html).toContain('src="available.png"');
    onRendered(available, document);
    expect(imageProblems()).toEqual([
      expect.objectContaining({
        source: "beamer-editor",
        message: expect.stringContaining("literal.png"),
      }),
    ]);
    expect(
      state.setDiagnostics.mock.lastCall?.[1].filter((entry) => entry.code === "L015"),
    ).toEqual([]);

    currentSource = source.replace("available.png", "unsupported.svg");
    version++;
    for (const listener of state.openListeners) listener(document);
    onRendered(render(currentSource, version), document);
    expect(state.setDiagnostics.mock.lastCall?.[1]).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "L015" })]),
    );

    currentSource = source;
    version++;
    for (const listener of state.openListeners) listener(document);
    rmSync(image);
    state.fileDeletes.at(-1)?.(Uri.file(image));
    onRendered(render(currentSource, version), document);
    expect(imageProblems()).toHaveLength(2);
  });

  it.each([
    { name: "declarative theme", themeCode: "", afterLoad: "", beforeManaged: "", keep: false },
    {
      name: "theme saves its background in a box",
      themeCode: String.raw`\newsavebox{\ThemeBackgroundBox}
\sbox{\ThemeBackgroundBox}{\usebeamertemplate{background}}`,
      afterLoad: "",
      beforeManaged: "",
      keep: true,
    },
    {
      name: "preamble uses the background before overriding it",
      themeCode: "",
      afterLoad: String.raw`\usebeamertemplate{background}`,
      beforeManaged: "",
      keep: true,
    },
    {
      name: "preamble installs a package hook before loading the theme",
      themeCode: "",
      afterLoad: "",
      beforeManaged: String.raw`\AddToHook{package/templates/theme/after}{\usebeamertemplate{background}}`,
      keep: true,
    },
  ])("Problems preserves the appropriate template L023 for $name", ({
    themeCode,
    afterLoad,
    beforeManaged,
    keep,
  }) => {
    openPdfTestDocument();
    state.getConfiguration.mockImplementation(() => ({
      get: (name: string, fallback: unknown) =>
        name === "preview.compileRawBlocks" ? false : fallback,
    }));
    const directory = mkdtempSync(join(tmpdir(), "beamer-preview-template-problems-"));
    state.temporaryDirectories.push(directory);
    mkdirSync(join(directory, "templates"));
    writeFileSync(join(directory, "available.png"), "exists");
    writeFileSync(
      join(directory, "templates", "theme.sty"),
      String.raw`\setbeamertemplate{background}{\includegraphics{missing-shared.png}}
\setbeamertemplate{title page}{\includegraphics{missing-shared.png}}
\setbeamertemplate{background canvas}{\includegraphics{missing-canvas.png}}
\AtBeginDocument{\setbeamertemplate{background}{\includegraphics{missing-hook.png}}}
\setbeamertemplate{background}{\includegraphics{missing-superseded.png}}
${themeCode}`,
    );
    const file = join(directory, "deck.slide.tex");
    const source = String.raw`\documentclass[aspectratio=169]{beamer}
${beforeManaged}
${managedPreambleBlock()}
%% preamble-extra:begin
\usepackage{templates/theme}
${afterLoad}
%% preamble-extra:end
%% style:begin
\deckbackground{available.png}
%% style:end
%% macros:begin
\newcommand{\pairimages}{\includegraphics{one.png}\includegraphics{two.png}}
%% macros:end
\begin{document}
\begin{frame}{Cover}\titlepage\end{frame}
\begin{frame}{Body}\pairimages\end{frame}
\end{document}`;
    const document = {
      uri: Uri.file(file),
      fileName: file,
      isDirty: false,
      version: 1,
      getText: () => source,
      positionAt: (offset: number) => ({ line: 0, character: offset }),
    } as vscode.TextDocument;
    state.activeEditor = { document } as vscode.TextEditor;
    for (const listener of state.openListeners) listener(document);
    const problems = (code: string) =>
      state.setDiagnostics.mock.lastCall?.[1].filter((entry) => entry.code === code);
    expect(problems("L023")).toHaveLength(4);
    state.commands.get("beamerEditor.openPreview")?.();
    const { render, onRendered } = state.previewOptions ?? {};
    if (!render || !onRendered) throw new Error("expected editing preview");
    onRendered(render(source, document.version), document);
    expect(problems("L023")).toEqual([
      expect.objectContaining({ message: expect.stringContaining("missing-shared.png") }),
      expect.objectContaining({ message: expect.stringContaining("missing-canvas.png") }),
      expect.objectContaining({ message: expect.stringContaining("missing-hook.png") }),
      ...(keep
        ? [expect.objectContaining({ message: expect.stringContaining("missing-superseded.png") })]
        : []),
    ]);
    expect(problems("L004")).toEqual([
      expect.objectContaining({ message: expect.stringContaining("画像: one.png") }),
      expect.objectContaining({ message: expect.stringContaining("画像: two.png") }),
    ]);
  });

  it.each([
    true,
    false,
  ])("進行中の Export を初回の PDF確認で使い、同じ Webview へ再送しない (先にプレビュー=%s)", async (openFirst) => {
    const document = openPdfTestDocument();
    if (openFirst) state.commands.get("beamerEditor.openPreview")?.();
    const exportReview = state.exportHost?.beginPdfExport?.(
      document as ExportDocument,
      Uri.file("/project/output.pdf"),
    );
    expect(exportReview).toBeDefined();
    if (!openFirst) state.commands.get("beamerEditor.openPreview")?.();
    showPdf();
    expect(state.compilePdf).not.toHaveBeenCalled();
    expect(state.postPdfState).toHaveBeenLastCalledWith(
      "compiling",
      expect.any(Number),
      expect.anything(),
    );

    const pdf = Uint8Array.of(7);
    exportReview?.finish({
      size: pdf.length,
      content: pdfContent(pdf),
      dependencyPaths: [document.uri.fsPath],
    });
    await Promise.resolve();
    expect(state.postPdfState).toHaveBeenLastCalledWith(
      "ready",
      expect.any(Number),
      expect.objectContaining({ pdf, artifactId: 1 }),
    );
    showPdf();
    expect(state.postPdfState.mock.lastCall?.[2]).not.toHaveProperty("pdf");
    state.previewOptions?.onWebviewReady?.();
    showPdf();
    expect(state.postPdfState.mock.lastCall?.[2]).toMatchObject({ pdf, artifactId: 1 });
  });

  it("参照する PDF への Export は採用した時点で要更新にする", async () => {
    const document = openPdfTestDocument();
    state.commands.get("beamerEditor.openPreview")?.();
    const output = Uri.file("/project/figure.pdf");
    const exportReview = state.exportHost?.beginPdfExport?.(document as ExportDocument, output);
    showPdf();
    exportReview?.finish({ size: 1, content: pdfContent(), dependencyPaths: [output.fsPath] });
    await Promise.resolve();
    expect(state.postPdfState).toHaveBeenLastCalledWith(
      "stale",
      expect.any(Number),
      expect.objectContaining({ artifactId: 1 }),
    );
  });

  it("現在の組版ログで非参照と証明できる外部 PDF の変更はプレビュー更新を起こさない", async () => {
    const document = openPdfTestDocument();
    state.compilePdf.mockResolvedValue({
      inputPath: document.uri.fsPath,
      engineVersion: "0.17.0",
      pdf: Uint8Array.of(7),
      dependencyPaths: [document.uri.fsPath, "/project/figure.pdf"],
    });
    state.commands.get("beamerEditor.openPreview")?.();
    showPdf();
    await vi.waitFor(() => expect(state.postPdfState.mock.lastCall?.[0]).toBe("ready"));
    state.refreshPreview.mockClear();
    const watcher = state.fileChanges.at(-1);
    watcher?.(Uri.file("/project/external-unrelated.pdf"));
    expect(state.refreshPreview).not.toHaveBeenCalled();

    watcher?.(Uri.file("/project/figure.pdf"));
    expect(state.refreshPreview).toHaveBeenCalledOnce();
  });

  it("無関係な PDF の作成は現在の組版ログと保存済み本文から除外する", async () => {
    const document = openPdfTestDocument();
    state.compilePdf.mockResolvedValue({
      inputPath: document.uri.fsPath,
      engineVersion: "0.17.0",
      pdf: Uint8Array.of(7),
      dependencyPaths: [document.uri.fsPath, "/project/figure.pdf"],
    });
    state.commands.get("beamerEditor.openPreview")?.();
    showPdf();
    await vi.waitFor(() => expect(state.postPdfState.mock.lastCall?.[0]).toBe("ready"));
    state.refreshPreview.mockClear();
    state.fileCreates.at(-1)?.(Uri.file("/project/external-unrelated.pdf"));
    await vi.waitFor(() => expect(state.refreshPreview).not.toHaveBeenCalled());
  });

  it("マクロで組み立てた存在確認 PDF の作成は PDF だけを要更新にする", async () => {
    const document = openPdfTestDocument() as vscode.TextDocument & { getText(): string };
    document.getText = () =>
      "\\ExplSyntaxOn\\file_if_exist:nTF { \\jobname-flag.pdf } { } { }\\ExplSyntaxOff";
    state.compilePdf.mockResolvedValue({
      inputPath: document.uri.fsPath,
      engineVersion: "0.17.0",
      pdf: Uint8Array.of(7),
      dependencyPaths: [document.uri.fsPath],
    });
    state.commands.get("beamerEditor.openPreview")?.();
    showPdf();
    await vi.waitFor(() => expect(state.postPdfState.mock.lastCall?.[0]).toBe("ready"));
    state.refreshPreview.mockClear();
    state.fileCreates.at(-1)?.(Uri.file("/project/deck.slide-flag.pdf"));
    await vi.waitFor(() => expect(state.postPdfState.mock.lastCall?.[0]).toBe("stale"));
    expect(state.refreshPreview).not.toHaveBeenCalled();
  });

  it("要更新後の未参照 PDF 作成でも編集プレビューを再生成しない", async () => {
    const document = openPdfTestDocument();
    state.compilePdf.mockResolvedValue({
      inputPath: document.uri.fsPath,
      engineVersion: "0.17.0",
      pdf: Uint8Array.of(7),
      dependencyPaths: [document.uri.fsPath, "/project/figure.pdf"],
    });
    state.commands.get("beamerEditor.openPreview")?.();
    showPdf();
    await vi.waitFor(() => expect(state.postPdfState.mock.lastCall?.[0]).toBe("ready"));
    state.refreshPreview.mockClear();
    const created = state.fileCreates.at(-1);
    created?.(Uri.file("/project/external-one.pdf"));
    await vi.waitFor(() => expect(state.postPdfState.mock.lastCall?.[0]).toBe("stale"));
    created?.(Uri.file("/project/external-two.pdf"));
    await Promise.resolve();
    expect(state.refreshPreview).not.toHaveBeenCalled();
  });

  it("更新中の未参照 PDF 変更は結果を要更新にし、編集プレビューは再生成しない", async () => {
    const document = openPdfTestDocument();
    const compiled = {
      inputPath: document.uri.fsPath,
      engineVersion: "0.17.0",
      pdf: Uint8Array.of(7),
      dependencyPaths: [document.uri.fsPath, "/project/figure.pdf"],
    };
    state.compilePdf.mockResolvedValueOnce(compiled);
    state.commands.get("beamerEditor.openPreview")?.();
    showPdf();
    await vi.waitFor(() => expect(state.postPdfState.mock.lastCall?.[0]).toBe("ready"));
    state.fileCreates.at(-1)?.(Uri.file("/project/deck.slide-flag.pdf"));
    await vi.waitFor(() => expect(state.postPdfState.mock.lastCall?.[0]).toBe("stale"));

    let finishCompile: ((value: typeof compiled) => void) | undefined;
    state.compilePdf.mockImplementationOnce(
      () =>
        new Promise<typeof compiled>((resolve) => {
          finishCompile = resolve;
        }),
    );
    state.refreshPreview.mockClear();
    state.previewOptions?.pdfAction?.("refresh");
    await vi.waitFor(() => expect(state.compilePdf).toHaveBeenCalledTimes(2));
    state.fileChanges.at(-1)?.(Uri.file("/project/external-unrelated.pdf"));
    finishCompile?.(compiled);
    await vi.waitFor(() => expect(state.postPdfState.mock.lastCall?.[0]).toBe("stale"));
    expect(state.refreshPreview).not.toHaveBeenCalled();
  });

  it.each([
    ["\\IfFileExists{optional.pdf}{}{ }", "/project/optional.pdf"],
    ["\\includegraphics{figure}", "/project/figure.pdf"],
  ])("作成で参照先になり得る PDF は更新する (%s)", async (source, created) => {
    const document = openPdfTestDocument() as vscode.TextDocument & { getText(): string };
    document.getText = () => source;
    state.compilePdf.mockResolvedValue({
      inputPath: document.uri.fsPath,
      engineVersion: "0.17.0",
      pdf: Uint8Array.of(7),
      dependencyPaths: [document.uri.fsPath],
    });
    state.commands.get("beamerEditor.openPreview")?.();
    showPdf();
    await vi.waitFor(() => expect(state.postPdfState.mock.lastCall?.[0]).toBe("ready"));
    state.refreshPreview.mockClear();
    state.fileCreates.at(-1)?.(Uri.file(created));
    await vi.waitFor(() => expect(state.refreshPreview).toHaveBeenCalledOnce());
    expect(state.postPdfState.mock.lastCall?.[0]).toBe("stale");
  });

  it("追跡済み画像と同じ stem の PDF 作成は、マクロ経由の拡張子省略参照として更新する", async () => {
    const document = openPdfTestDocument();
    state.compilePdf.mockResolvedValue({
      inputPath: document.uri.fsPath,
      engineVersion: "0.17.0",
      pdf: Uint8Array.of(7),
      dependencyPaths: [document.uri.fsPath, "/project/assets/figure.png"],
    });
    state.commands.get("beamerEditor.openPreview")?.();
    showPdf();
    await vi.waitFor(() => expect(state.postPdfState.mock.lastCall?.[0]).toBe("ready"));
    state.refreshPreview.mockClear();
    state.fileCreates.at(-1)?.(Uri.file("/project/other-path/figure.pdf"));
    await vi.waitFor(() => expect(state.refreshPreview).toHaveBeenCalledOnce());
  });

  it("ローカル style の参照先になり得る PDF の作成は更新する", async () => {
    const document = openPdfTestDocument();
    state.watchedFiles.set(
      "/project/theme.sty",
      new TextEncoder().encode("\\IfFileExists{style-optional.pdf}{}{ }"),
    );
    state.compilePdf.mockResolvedValue({
      inputPath: document.uri.fsPath,
      engineVersion: "0.17.0",
      pdf: Uint8Array.of(7),
      dependencyPaths: [document.uri.fsPath, "/project/theme.sty"],
    });
    state.commands.get("beamerEditor.openPreview")?.();
    showPdf();
    await vi.waitFor(() => expect(state.postPdfState.mock.lastCall?.[0]).toBe("ready"));
    state.refreshPreview.mockClear();
    state.fileCreates.at(-1)?.(Uri.file("/project/style-optional.pdf"));
    await vi.waitFor(() => expect(state.refreshPreview).toHaveBeenCalledOnce());
  });

  it("別 symlink 名から依存 PDF を更新しても監視する", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "beamer-editor-watcher-"));
    state.temporaryDirectories.push(temporary);
    const target = join(temporary, "figure.pdf");
    const alias = join(temporary, "alias.pdf");
    writeFileSync(target, "PDF");
    symlinkSync(target, alias);
    const document = openPdfTestDocument();
    state.compilePdf.mockResolvedValue({
      inputPath: document.uri.fsPath,
      engineVersion: "0.17.0",
      pdf: Uint8Array.of(7),
      dependencyPaths: [document.uri.fsPath, realpathSync(target)],
    });
    state.commands.get("beamerEditor.openPreview")?.();
    showPdf();
    await vi.waitFor(() => expect(state.postPdfState.mock.lastCall?.[0]).toBe("ready"));
    state.refreshPreview.mockClear();
    state.fileChanges.at(-1)?.(Uri.file(alias));
    expect(state.refreshPreview).toHaveBeenCalledOnce();
  });

  it("依存一覧が不明な外部 PDF は安全側でプレビュー更新する", async () => {
    const document = openPdfTestDocument();
    state.compilePdf.mockResolvedValue({
      inputPath: document.uri.fsPath,
      engineVersion: "0.17.0",
      pdf: Uint8Array.of(7),
    });
    state.commands.get("beamerEditor.openPreview")?.();
    showPdf();
    await vi.waitFor(() => expect(state.postPdfState.mock.lastCall?.[0]).toBe("ready"));
    state.refreshPreview.mockClear();
    state.fileChanges.at(-1)?.(Uri.file("/project/external-unknown.pdf"));
    expect(state.refreshPreview).toHaveBeenCalledOnce();
  });

  it.each([
    "save",
    "clean reload",
  ])("パネルを開く前の %s で別版になった Export 結果は要更新として表示する", async (change) => {
    const document = openPdfTestDocument() as vscode.TextDocument & { getText(): string };
    let text = "version A";
    document.getText = () => text;
    const exportReview = state.exportHost?.beginPdfExport?.(
      document as ExportDocument,
      Uri.file("/project/output.pdf"),
    );
    text = "version B";
    if (change === "save") {
      for (const saved of state.saveListeners) saved(document);
    } else {
      // The final listener belongs to the pending Export; call it directly
      // so unrelated extension listeners do not affect this focused test.
      const externalReload: vscode.TextDocumentChangeEvent = {
        document,
        contentChanges: [
          {
            range: new Range(0, 0, 0, 0),
            rangeOffset: 0,
            rangeLength: 0,
            text,
          },
        ],
        reason: undefined,
      };
      state.changeListeners.at(-1)?.(externalReload);
    }
    state.commands.get("beamerEditor.openPreview")?.();
    showPdf();
    exportReview?.finish({
      size: 1,
      content: pdfContent(),
      dependencyPaths: [document.uri.fsPath],
    });
    await Promise.resolve();
    expect(state.postPdfState).toHaveBeenLastCalledWith(
      "stale",
      expect.any(Number),
      expect.objectContaining({ artifactId: 1 }),
    );
  });

  it("完了した Export はパネルがなくても保存・再読込監視を破棄する", () => {
    const document = openPdfTestDocument();
    const saves = state.saveListeners.length;
    const changes = state.changeListeners.length;
    const watched = state.fileChanges.length;
    const settings = state.configurationListeners.length;
    const exportReview = state.exportHost?.beginPdfExport?.(
      document as ExportDocument,
      Uri.file("/project/output.pdf"),
    );
    expect(state.saveListeners).toHaveLength(saves + 1);
    expect(state.changeListeners).toHaveLength(changes + 1);
    expect(state.fileChanges).toHaveLength(watched + 1);
    const content = pdfContent();
    exportReview?.finish({ size: 1, content });
    expect(content.read).not.toHaveBeenCalled();
    expect(content.dispose).toHaveBeenCalledOnce();
    expect(state.saveListeners).toHaveLength(saves);
    expect(state.changeListeners).toHaveLength(changes);
    expect(state.fileChanges).toHaveLength(watched);
    expect(state.configurationListeners).toHaveLength(settings);
  });

  it.each([
    ["/project/theme.sty", "stale"],
    ["/project/unrelated.pdf", "ready"],
  ])("パネルを開く前の依存変更を組版結果に引き継ぐ (%s)", async (changed, status) => {
    const document = openPdfTestDocument();
    const exportReview = state.exportHost?.beginPdfExport?.(
      document as ExportDocument,
      Uri.file("/project/output.pdf"),
    );
    state.fileChanges.at(-1)?.(Uri.file(changed));
    state.commands.get("beamerEditor.openPreview")?.();
    showPdf();
    exportReview?.finish({
      size: 1,
      content: pdfContent(),
      dependencyPaths: ["/project/theme.sty", document.uri.fsPath],
    });
    await Promise.resolve();
    expect(state.postPdfState).toHaveBeenLastCalledWith(
      status,
      expect.any(Number),
      expect.objectContaining({ artifactId: 1 }),
    );
  });

  it("パネルを開く前の外部 PDF 作成を Export 結果の要更新へ引き継ぐ", async () => {
    const document = openPdfTestDocument();
    const exportReview = state.exportHost?.beginPdfExport?.(
      document as ExportDocument,
      Uri.file("/project/output.pdf"),
    );
    state.fileCreates.at(-1)?.(Uri.file("/project/deck.slide-flag.pdf"));
    state.commands.get("beamerEditor.openPreview")?.();
    showPdf();
    exportReview?.finish({
      size: 1,
      content: pdfContent(),
      dependencyPaths: [document.uri.fsPath],
    });
    await Promise.resolve();
    expect(state.postPdfState).toHaveBeenLastCalledWith(
      "stale",
      expect.any(Number),
      expect.objectContaining({ artifactId: 1 }),
    );
    state.refreshPreview.mockClear();
    state.fileCreates.at(-1)?.(Uri.file("/project/another-unrelated.pdf"));
    await Promise.resolve();
    expect(state.refreshPreview).not.toHaveBeenCalled();
  });

  it("パネルを開く前の Tectonic 設定変更を Export 結果の要更新へ引き継ぐ", async () => {
    const document = openPdfTestDocument();
    const exportReview = state.exportHost?.beginPdfExport?.(
      document as ExportDocument,
      Uri.file("/project/output.pdf"),
    );
    state.configurationListeners.at(-1)?.({
      affectsConfiguration: (name: string, uri?: vscode.Uri) =>
        uri?.fsPath === document.uri.fsPath && name === "beamerEditor.tectonicPath",
    } as vscode.ConfigurationChangeEvent);
    state.commands.get("beamerEditor.openPreview")?.();
    showPdf();
    exportReview?.finish({
      size: 1,
      content: pdfContent(),
      dependencyPaths: [document.uri.fsPath],
    });
    await Promise.resolve();
    expect(state.postPdfState).toHaveBeenLastCalledWith(
      "stale",
      expect.any(Number),
      expect.objectContaining({ artifactId: 1 }),
    );
  });

  it("編集タブでは Export の PDF を読み込まず、自分の未参照出力で再描画しない", async () => {
    const document = openPdfTestDocument();
    state.commands.get("beamerEditor.openPreview")?.();
    const change = state.fileChanges.at(-1);
    const create = state.fileCreates.at(-1);
    const output = Uri.file("/project/output.pdf");
    state.pdfIdentity.mockResolvedValue("published");
    const exportReview = state.exportHost?.beginPdfExport?.(document as ExportDocument, output);
    const content = pdfContent();
    change?.(output);
    create?.(output);
    exportReview?.finish({
      size: 1,
      content,
      dependencyPaths: [document.uri.fsPath],
      writtenFileIdentity: "published",
    });
    expect(content.read).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(state.pdfIdentity).toHaveBeenCalled());
    expect(state.refreshPreview).not.toHaveBeenCalled();
    showPdf();
    await vi.waitFor(() => expect(state.postPdfState.mock.lastCall?.[0]).toBe("ready"));
    expect(content.read).toHaveBeenCalledOnce();
    expect(content.dispose).toHaveBeenCalledOnce();
    expect(state.compilePdf).not.toHaveBeenCalled();
    state.previewOptions?.previewTabChanged?.("edit", 1);
    showPdf();
    expect(state.postPdfState.mock.lastCall?.[2]).toMatchObject({ artifactId: 1 });
    expect(content.read).toHaveBeenCalledOnce();
  });

  it("deck 配下へ初めて作成した Export の PDF は依存一覧に無くても要更新にする", async () => {
    const document = openPdfTestDocument();
    state.commands.get("beamerEditor.openPreview")?.();
    const output = Uri.file("/project/deck.slide-flag.pdf");
    const exportReview = state.exportHost?.beginPdfExport?.(document as ExportDocument, output);
    showPdf();
    exportReview?.finish(
      { size: 1, content: pdfContent(), dependencyPaths: [document.uri.fsPath] },
      { overwritten: false },
    );
    await Promise.resolve();
    expect(state.postPdfState).toHaveBeenLastCalledWith(
      "stale",
      expect.any(Number),
      expect.objectContaining({ artifactId: 1 }),
    );
    expect(state.refreshPreview).not.toHaveBeenCalled();
  });

  it("deck 外へ初めて作成した未参照 Export の PDF は確認版を要更新にしない", async () => {
    const document = openPdfTestDocument();
    state.commands.get("beamerEditor.openPreview")?.();
    const output = Uri.file("/exports/deck.slide-flag.pdf");
    const exportReview = state.exportHost?.beginPdfExport?.(document as ExportDocument, output);
    showPdf();
    exportReview?.finish(
      { size: 1, content: pdfContent(), dependencyPaths: [document.uri.fsPath] },
      { overwritten: false },
    );
    await Promise.resolve();
    expect(state.postPdfState).toHaveBeenLastCalledWith(
      "ready",
      expect.any(Number),
      expect.objectContaining({ artifactId: 1 }),
    );
  });

  it("deck 配下へ初めて保存した表示中 PDF は依存一覧に無くても要更新にする", async () => {
    const document = openPdfTestDocument();
    const output = Uri.file("/project/deck.slide-flag.pdf");
    state.compilePdf.mockResolvedValue({
      inputPath: document.uri.fsPath,
      engineVersion: "0.17.0",
      pdf: Uint8Array.of(7),
      dependencyPaths: [document.uri.fsPath],
    });
    state.saveDialog.mockResolvedValue(output);
    state.publishPdf.mockResolvedValue({
      outputPath: output.fsPath,
      overwritten: false,
      writtenFileIdentity: "published",
    });
    state.commands.get("beamerEditor.openPreview")?.();
    showPdf();
    await vi.waitFor(() => expect(state.postPdfState.mock.lastCall?.[0]).toBe("ready"));
    state.refreshPreview.mockClear();
    state.previewOptions?.pdfAction?.("save", 1);
    await vi.waitFor(() => expect(state.publishPdf).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(state.postPdfState.mock.lastCall?.[0]).toBe("stale"));
    expect(state.refreshPreview).not.toHaveBeenCalled();
  });

  it("遅れて読み込みが終わった Export は新しい PDF を上書きしない", async () => {
    const document = openPdfTestDocument();
    state.commands.get("beamerEditor.openPreview")?.();
    const output = Uri.file("/project/output.pdf");
    const oldExport = state.exportHost?.beginPdfExport?.(document as ExportDocument, output);
    showPdf();
    let resolveOld = (_bytes: Uint8Array) => {};
    const oldBytes = new Promise<Uint8Array>((resolve) => {
      resolveOld = resolve;
    });
    const oldContent = { read: vi.fn(() => oldBytes), dispose: vi.fn(async () => {}) };
    oldExport?.finish({ size: 1, content: oldContent, dependencyPaths: [document.uri.fsPath] });
    expect(oldContent.read).toHaveBeenCalledOnce();
    const latestExport = state.exportHost?.beginPdfExport?.(document as ExportDocument, output);
    const pdf = Uint8Array.of(9);
    latestExport?.finish({
      size: 1,
      content: pdfContent(pdf),
      dependencyPaths: [document.uri.fsPath],
    });
    await vi.waitFor(() => expect(state.postPdfState.mock.lastCall?.[2]).toMatchObject({ pdf }));
    resolveOld(Uint8Array.of(4));
    await oldBytes;
    expect(state.postPdfState.mock.lastCall?.[2]).toMatchObject({ pdf });
    expect(oldContent.dispose).toHaveBeenCalled();
  });

  it("古い Export が deck 配下へ初めて PDF を作成すると新しい確認版も要更新にする", async () => {
    const document = openPdfTestDocument();
    state.commands.get("beamerEditor.openPreview")?.();
    const oldExport = state.exportHost?.beginPdfExport?.(
      document as ExportDocument,
      Uri.file("/project/deck.slide-flag.pdf"),
    );
    showPdf();
    const newer = state.exportHost?.beginPdfExport?.(
      document as ExportDocument,
      Uri.file("/exports/current.pdf"),
    );
    const current = Uint8Array.of(9);
    newer?.finish(
      { size: 1, content: pdfContent(current), dependencyPaths: [document.uri.fsPath] },
      { overwritten: true },
    );
    await vi.waitFor(() =>
      expect(state.postPdfState.mock.lastCall?.[2]).toMatchObject({ pdf: current }),
    );

    oldExport?.finish(
      { size: 1, content: pdfContent(Uint8Array.of(4)), dependencyPaths: [document.uri.fsPath] },
      { overwritten: false },
    );
    await Promise.resolve();
    expect(state.postPdfState).toHaveBeenLastCalledWith(
      "stale",
      expect.any(Number),
      expect.not.objectContaining({ pdf: Uint8Array.of(4) }),
    );
  });

  it("パネルを開く前の未保存編集だけでは Export 結果を要更新にしない", async () => {
    const document = openPdfTestDocument() as vscode.TextDocument & {
      getText(): string;
      isDirty: boolean;
    };
    let text = "version A";
    document.getText = () => text;
    const exportReview = state.exportHost?.beginPdfExport?.(
      document as ExportDocument,
      Uri.file("/project/output.pdf"),
    );
    text = "unsaved version B";
    document.isDirty = true;
    state.commands.get("beamerEditor.openPreview")?.();
    showPdf();
    exportReview?.finish({
      size: 1,
      content: pdfContent(),
      dependencyPaths: [document.uri.fsPath],
    });
    await Promise.resolve();
    expect(state.postPdfState).toHaveBeenLastCalledWith(
      "ready",
      expect.any(Number),
      expect.objectContaining({ artifactId: 1, message: expect.stringContaining("未保存") }),
    );
  });

  it("依存 symlink の実体への Export も要更新にする", async () => {
    const document = openPdfTestDocument();
    state.commands.get("beamerEditor.openPreview")?.();
    const exportReview = state.exportHost?.beginPdfExport?.(
      document as ExportDocument,
      Uri.file("/project/figure.pdf"),
    );
    showPdf();
    exportReview?.finish({
      size: 1,
      content: pdfContent(),
      dependencyPaths: ["/project/ref.pdf", "/project/figure.pdf"],
    });
    await Promise.resolve();
    expect(state.postPdfState).toHaveBeenLastCalledWith(
      "stale",
      expect.any(Number),
      expect.objectContaining({ artifactId: 1 }),
    );
  });

  it("進行中の Export が失敗した後に更新できる", async () => {
    const document = openPdfTestDocument();
    state.commands.get("beamerEditor.openPreview")?.();
    const exportReview = state.exportHost?.beginPdfExport?.(
      document as ExportDocument,
      Uri.file("/project/output.pdf"),
    );
    showPdf();
    exportReview?.finish();
    expect(state.postPdfState.mock.lastCall?.[0]).toBe("failed");
    state.compilePdf.mockResolvedValue({
      inputPath: document.uri.fsPath,
      engineVersion: "Tectonic 0.17.0",
      pdf: Uint8Array.of(7),
    });
    state.previewOptions?.pdfAction?.("refresh");
    await vi.waitFor(() => expect(state.postPdfState.mock.lastCall?.[0]).toBe("ready"));
  });

  it("古い組版が後から完了しても Export の PDF を保持する", async () => {
    const document = openPdfTestDocument();
    state.commands.get("beamerEditor.openPreview")?.();
    let finishCompile: (
      result: Awaited<ReturnType<typeof import("@beamer-editor/compiler").compilePdf>>,
    ) => void = () => {};
    state.compilePdf.mockReturnValue(
      new Promise((resolve) => {
        finishCompile = resolve;
      }),
    );
    showPdf();
    const exportReview = state.exportHost?.beginPdfExport?.(
      document as ExportDocument,
      Uri.file("/project/output.pdf"),
    );
    const pdf = Uint8Array.of(9);
    exportReview?.finish({
      size: 1,
      content: pdfContent(pdf),
      dependencyPaths: [document.uri.fsPath],
    });
    finishCompile({
      inputPath: document.uri.fsPath,
      engineVersion: "0.17.0",
      pdf: Uint8Array.of(7),
    });
    await Promise.resolve();
    expect(state.postPdfState.mock.lastCall?.[2]).toMatchObject({ pdf, artifactId: 1 });
  });

  function showPdf(): void {
    state.previewOptions?.previewTabChanged?.("pdf");
    state.previewOptions?.pdfAction?.("open");
  }

  function pdfContent(pdf = Uint8Array.of(7)): PdfReviewContent {
    return { read: vi.fn(async () => pdf), dispose: vi.fn(async () => {}) };
  }

  function openPdfTestDocument(): vscode.TextDocument {
    state.getConfiguration.mockImplementation(() => ({
      get: (_name: string, fallback: unknown) => fallback,
    }));
    const document = {
      uri: Uri.file("/project/deck.slide.tex"),
      fileName: "/project/deck.slide.tex",
      isDirty: false,
      getText: () => "",
    } as vscode.TextDocument;
    activate({
      extensionPath: "/extension",
      extensionUri: Uri.file("/extension"),
      globalStorageUri: Uri.file("/storage"),
      subscriptions,
    } as vscode.ExtensionContext);
    state.activeEditor = { document } as vscode.TextEditor;
    return document;
  }
});
