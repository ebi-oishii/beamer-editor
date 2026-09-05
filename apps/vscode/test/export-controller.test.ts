import { PdfExportError } from "@beamer-editor/compiler";
import { describe, expect, it, vi } from "vitest";
import {
  ExportController,
  type ExportHost,
  type ExportUri,
  exportErrorDetail,
  normalizeTectonicPath,
  resolveExportDocument,
} from "../src/export-controller";

const input: ExportUri = {
  scheme: "file",
  fsPath: "/deck/talk.slide.tex",
  toString: () => "file:///deck/talk.slide.tex",
};
const output: ExportUri = {
  scheme: "file",
  fsPath: "/deck/talk.pdf",
  toString: () => "file:///deck/talk.pdf",
};

function createHost(overrides: Partial<ExportHost> = {}): ExportHost {
  return {
    isWorkspaceTrusted: true,
    chooseFormat: vi.fn<() => Promise<"pdf" | undefined>>(async () => "pdf"),
    chooseOutput: vi.fn(async () => output),
    outputExists: vi.fn(async () => false),
    withProgress: vi.fn(async (task) =>
      task({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
    ),
    showInformation: vi.fn(async () => undefined),
    showError: vi.fn(async () => undefined),
    showWarning: vi.fn(async () => undefined),
    openPdf: vi.fn(async () => undefined),
    revealInFileManager: vi.fn(async () => undefined),
    openTectonicSettings: vi.fn(async () => undefined),
    showExportDetails: vi.fn(),
    uriForFile: vi.fn(() => output),
    tectonicPath: vi.fn(() => "/custom/tectonic"),
    timeoutMs: vi.fn(() => 300_000),
    ...overrides,
  };
}

function createDocument(overrides: Partial<{ isDirty: boolean; save(): Promise<boolean> }> = {}) {
  return { uri: input, isDirty: false, save: vi.fn(async () => true), ...overrides };
}

describe("ExportController", () => {
  it("normalizes only non-empty string compiler settings", () => {
    expect(normalizeTectonicPath(" /custom/tectonic ")).toBe("/custom/tectonic");
    for (const value of [undefined, null, 42, {}, "   "]) {
      expect(normalizeTectonicPath(value)).toBeUndefined();
    }
  });
  it("resolves an explicit source before the active preview and editor", () => {
    expect(
      resolveExportDocument(
        "explicit",
        [
          { active: false, document: "first-preview" },
          { active: true, document: "pressed-preview" },
        ],
        "editor",
      ),
    ).toBe("explicit");
    expect(
      resolveExportDocument(
        undefined,
        [
          { active: false, document: "first-preview" },
          { active: true, document: "pressed-preview" },
        ],
        "editor",
      ),
    ).toBe("pressed-preview");
    expect(resolveExportDocument(undefined, [], "editor")).toBe("editor");
  });

  it("uses the PDF-only picker, slide default name, resource compiler setting, and success actions", async () => {
    const host = createHost({ showInformation: vi.fn(async () => "PDFを開く") });
    const compile = vi.fn(async () => ({
      format: "pdf" as const,
      inputPath: input.fsPath,
      outputPath: output.fsPath,
      overwritten: false,
      engineVersion: "0.15.0",
    }));
    await new ExportController(host, { exportPdf: compile }).export(createDocument());
    expect(host.uriForFile).toHaveBeenCalledWith("/deck/talk.pdf");
    expect(compile).toHaveBeenCalledWith(
      expect.objectContaining({
        inputPath: input.fsPath,
        outputPath: output.fsPath,
        overwrite: false,
        tectonicPath: "/custom/tectonic",
        timeoutMs: 300_000,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(host.openPdf).toHaveBeenCalledWith(output);
  });

  it("does not compile after picker or output cancellation", async () => {
    for (const [host, document] of [
      [
        createHost({
          chooseFormat: vi.fn<() => Promise<"pdf" | undefined>>(async () => undefined),
        }),
        createDocument(),
      ],
      [createHost({ chooseOutput: vi.fn(async () => undefined) }), createDocument()],
    ] as const) {
      const compile = vi.fn();
      await new ExportController(host, { exportPdf: compile }).export(document);
      expect(compile).not.toHaveBeenCalled();
      expect(host.showWarning).not.toHaveBeenCalled();
    }
  });

  it("reports a failed dirty save and does not compile", async () => {
    const host = createHost();
    const compile = vi.fn();
    await new ExportController(host, { exportPdf: compile }).export(
      createDocument({ isDirty: true, save: async () => false }),
    );
    expect(compile).not.toHaveBeenCalled();
    expect(host.showWarning).toHaveBeenCalledWith(
      "編集中のファイルを保存できなかったため、PDFを書き出しませんでした。",
    );
  });

  it("does not compile virtual documents selected from the active editor fallback", async () => {
    const host = createHost();
    const compile = vi.fn();
    await new ExportController(host, { exportPdf: compile }).export({
      ...createDocument(),
      uri: { scheme: "git", fsPath: "/deck/talk.tex", toString: () => "git:/deck/talk.tex" },
    });
    expect(compile).not.toHaveBeenCalled();
  });

  it("passes cancellation through AbortSignal and treats cancellation silently", async () => {
    let cancel: (() => void) | undefined;
    const host = createHost({
      withProgress: async (task) =>
        task({
          isCancellationRequested: false,
          onCancellationRequested: (listener) => {
            cancel = listener;
            return { dispose() {} };
          },
        }),
    });
    const compile = vi.fn(async (_request) => {
      cancel?.();
      throw new PdfExportError("E_CANCELLED", "cancelled");
    });
    await new ExportController(host, { exportPdf: compile }).export(createDocument());
    expect(compile.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(host.showError).not.toHaveBeenCalled();
  });

  it("does not start a pre-cancelled progress task and disposes cancellation listeners", async () => {
    const subscription = { dispose: vi.fn() };
    const host = createHost({
      withProgress: async (task) =>
        task({
          isCancellationRequested: true,
          onCancellationRequested: () => subscription,
        }),
    });
    const compile = vi.fn();
    await new ExportController(host, { exportPdf: compile }).export(createDocument());
    expect(compile).not.toHaveBeenCalled();
    expect(subscription.dispose).toHaveBeenCalledOnce();
  });

  it("cleans cancellation state when compiler configuration access throws", async () => {
    const subscription = { dispose: vi.fn() };
    const host = createHost({
      withProgress: async (task) =>
        task({ isCancellationRequested: false, onCancellationRequested: () => subscription }),
      tectonicPath: () => {
        throw new Error("invalid configuration");
      },
    });
    const compile = vi.fn();
    await new ExportController(host, { exportPdf: compile }).export(createDocument());
    expect(compile).not.toHaveBeenCalled();
    expect(subscription.dispose).toHaveBeenCalledOnce();
    expect(host.showError).toHaveBeenCalledOnce();
  });

  it("aborts an in-flight compiler when disposed and never reports a false export failure", async () => {
    let signal: AbortSignal | undefined;
    let resolveCompile: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      resolveCompile = resolve;
    });
    const host = createHost();
    const compile = vi.fn(async (request) => {
      signal = request.signal;
      await pending;
      throw new PdfExportError("E_CANCELLED", "cancelled");
    });
    const controller = new ExportController(host, { exportPdf: compile });
    const running = controller.export(createDocument());
    await vi.waitFor(() => expect(compile).toHaveBeenCalledOnce());
    controller.dispose();
    expect(signal?.aborted).toBe(true);
    resolveCompile?.();
    await running;
    await controller.export(createDocument());
    expect(compile).toHaveBeenCalledOnce();
    expect(host.showError).not.toHaveBeenCalled();
  });

  it("passes the Save Dialog overwrite result through and serializes the same source URI", async () => {
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = createHost({ outputExists: vi.fn(async () => true) });
    const compile = vi.fn(async () => {
      await pending;
      return {
        format: "pdf" as const,
        inputPath: input.fsPath,
        outputPath: output.fsPath,
        overwritten: true,
        engineVersion: "0.15.0",
      };
    });
    const controller = new ExportController(host, { exportPdf: compile });
    const first = controller.export(createDocument());
    await Promise.resolve();
    await controller.export(createDocument());
    expect(host.showWarning).toHaveBeenCalledWith("この文書は既に PDF を書き出しています。");
    release();
    await first;
    expect(compile).toHaveBeenCalledWith(expect.objectContaining({ overwrite: true }));
  });

  it("maps typed compiler errors and makes compiler details available on demand", async () => {
    for (const code of [
      "E_INPUT",
      "E_OUTPUT_EXISTS",
      "E_TECTONIC_VERSION",
      "E_COMPILE",
      "E_IO",
    ] as const) {
      const host = createHost({ showError: vi.fn(async () => "詳細を表示") });
      await new ExportController(host, {
        exportPdf: async () => {
          throw new PdfExportError(code, code);
        },
      }).export(createDocument());
      expect(host.showError).toHaveBeenCalledTimes(1);
      expect(host.showExportDetails).toHaveBeenCalledWith(`[${code}] ${code}`);
    }
    const host = createHost({ showError: vi.fn(async () => "設定を開く") });
    await new ExportController(host, {
      exportPdf: async () => {
        throw new PdfExportError("E_TECTONIC_NOT_FOUND", "missing");
      },
    }).export(createDocument());
    expect(host.showError).toHaveBeenCalledWith(
      "Tectonic が見つかりません。",
      "詳細を表示",
      "設定を開く",
    );
    expect(host.openTectonicSettings).toHaveBeenCalledOnce();
  });

  it("sanitizes and bounds compiler details without exposing the cause", () => {
    const cause = new Error("secret cause");
    const detail = exportErrorDetail(
      new PdfExportError(
        "E_COMPILE",
        `\u001b[31m! Undefined control sequence.\u001b[0m\r\nl.42 \\badmacro\u0000${"x".repeat(70_000)}`,
        cause,
      ),
    );
    expect(detail).toContain("! Undefined control sequence.\nl.42 \\badmacro");
    expect(detail).not.toContain("\u001b");
    expect(detail).not.toContain("secret cause");
    expect(detail).toContain("詳細を切り詰めました");
    expect(detail.length).toBeLessThan(65_700);
  });

  it("does not run compilers in untrusted workspaces", async () => {
    const host = createHost({ isWorkspaceTrusted: false });
    const compile = vi.fn();
    await new ExportController(host, { exportPdf: compile }).export(createDocument());
    expect(compile).not.toHaveBeenCalled();
    expect(host.showWarning).toHaveBeenCalledOnce();
  });

  it("reports display failures separately after a successful export", async () => {
    const host = createHost({
      showInformation: vi.fn(async () => "フォルダーで表示"),
      revealInFileManager: vi.fn(async () => {
        throw new Error("unavailable");
      }),
    });
    await new ExportController(host, {
      exportPdf: async () => ({
        format: "pdf",
        inputPath: input.fsPath,
        outputPath: output.fsPath,
        overwritten: false,
        engineVersion: "0.15.0",
      }),
    }).export(createDocument());
    expect(host.showError).not.toHaveBeenCalled();
    expect(host.showWarning).toHaveBeenCalledWith(
      "PDF は書き出されましたが、表示操作に失敗しました。",
    );
  });
});
