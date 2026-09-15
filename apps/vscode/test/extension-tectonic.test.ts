import { resolve } from "node:path";
import type { compileFragment } from "@beamer-editor/compiler";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { ExportDocument, ExportHost } from "../src/export-controller";
import type { RawBlockCompilerOptions } from "../src/raw-block-compiler";

const state = vi.hoisted(() => ({
  bundled: undefined as string | undefined,
  configured: undefined as unknown,
  exportHost: undefined as ExportHost | undefined,
  rawHost: undefined as RawBlockCompilerOptions | undefined,
  activeEditor: undefined as vscode.TextEditor | undefined,
  commands: new Map<string, () => void>(),
  compile: vi.fn<typeof compileFragment>(),
  getConfiguration: vi.fn(),
}));

vi.mock("vscode", () => {
  const disposable = () => ({ dispose() {} });
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
    TreeItem: class {},
    RelativePattern: class {},
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    CodeActionKind: { QuickFix: "quickfix" },
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
        onDidChangeViewState: disposable,
        webview: { asWebviewUri: (uri: unknown) => uri },
      }),
    },
    workspace: {
      isTrusted: true,
      textDocuments: [],
      getConfiguration: state.getConfiguration,
      onDidOpenTextDocument: disposable,
      onDidChangeTextDocument: disposable,
      onDidCloseTextDocument: disposable,
      onDidChangeConfiguration: disposable,
      createFileSystemWatcher: () => ({
        ...disposable(),
        onDidChange: disposable,
        onDidCreate: disposable,
        onDidDelete: disposable,
      }),
    },
    languages: {
      createDiagnosticCollection: disposable,
      registerCodeActionsProvider: disposable,
      registerFoldingRangeProvider: disposable,
      registerCodeLensProvider: disposable,
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
    ) {}
  },
}));

import { Uri } from "vscode";
import { activate, deactivate } from "../src/extension";

describe("extension の Tectonic 接続", () => {
  const subscriptions: vscode.Disposable[] = [];
  afterEach(() => {
    deactivate();
    for (const item of subscriptions.splice(0)) item.dispose();
    state.activeEditor = undefined;
    state.commands.clear();
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
});
