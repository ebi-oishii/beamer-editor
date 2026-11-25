import { resolve } from "node:path";
import type { compileFragment, PdfReviewContent } from "@beamer-editor/compiler";
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
  postPdfState: vi.fn(),
  getConfiguration: vi.fn(),
  fileChanges: [] as Array<(uri: vscode.Uri) => void>,
  refreshPreview: vi.fn(),
  pdfIdentity: vi.fn<() => Promise<string | undefined>>(),
  saveListeners: [] as Array<(document: vscode.TextDocument) => void>,
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
      registerTreeDataProvider: disposable,
      onDidChangeActiveTextEditor: disposable,
      onDidChangeTextEditorSelection: disposable,
      createWebviewPanel: () => ({
        active: false,
        visible: true,
        onDidChangeViewState: disposable,
        webview: { asWebviewUri: (uri: unknown) => uri },
      }),
    },
    workspace: {
      isTrusted: true,
      textDocuments: [],
      getConfiguration: state.getConfiguration,
      onDidOpenTextDocument: disposable,
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
        onDidCreate: disposable,
        onDidDelete: disposable,
      }),
    },
    languages: {
      createDiagnosticCollection: disposable,
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
    state.fileChanges.splice(0);
    state.changeListeners.splice(0);
    state.configurationListeners.splice(0);
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
    const output = Uri.file("/project/output.pdf");
    state.pdfIdentity.mockResolvedValue("published");
    const exportReview = state.exportHost?.beginPdfExport?.(document as ExportDocument, output);
    const content = pdfContent();
    change?.(output);
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
