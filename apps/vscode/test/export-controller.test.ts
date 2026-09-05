import { PdfExportError } from "@beamer-editor/compiler";
import { describe, expect, it, vi } from "vitest";
import {
  ExportController,
  type ExportHost,
  type ExportUri,
  resolveExportDocument,
} from "../src/export-controller";

const input: ExportUri = {
  fsPath: "/deck/talk.slide.tex",
  toString: () => "file:///deck/talk.slide.tex",
};
const output: ExportUri = { fsPath: "/deck/talk.pdf", toString: () => "file:///deck/talk.pdf" };

function createHost(overrides: Partial<ExportHost> = {}): ExportHost {
  return {
    isWorkspaceTrusted: true,
    chooseFormat: vi.fn<() => Promise<"pdf" | undefined>>(async () => "pdf"),
    chooseOutput: vi.fn(async () => output),
    outputExists: vi.fn(async () => false),
    confirmOverwrite: vi.fn(async () => true),
    withProgress: vi.fn(async (task) =>
      task({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
    ),
    showInformation: vi.fn(async () => undefined),
    showError: vi.fn(async () => undefined),
    showWarning: vi.fn(async () => undefined),
    openPdf: vi.fn(async () => undefined),
    revealInFileManager: vi.fn(async () => undefined),
    openTectonicSettings: vi.fn(async () => undefined),
    uriForFile: vi.fn(() => output),
    tectonicPath: vi.fn(() => "/custom/tectonic"),
    ...overrides,
  };
}

function createDocument(overrides: Partial<{ isDirty: boolean; save(): Promise<boolean> }> = {}) {
  return { uri: input, isDirty: false, save: vi.fn(async () => true), ...overrides };
}

describe("ExportController", () => {
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
        signal: expect.any(AbortSignal),
      }),
    );
    expect(host.openPdf).toHaveBeenCalledWith(output);
  });

  it("does not compile after picker/save cancellation or failed dirty save", async () => {
    for (const [host, document] of [
      [
        createHost({
          chooseFormat: vi.fn<() => Promise<"pdf" | undefined>>(async () => undefined),
        }),
        createDocument(),
      ],
      [createHost({ chooseOutput: vi.fn(async () => undefined) }), createDocument()],
      [createHost(), createDocument({ isDirty: true, save: async () => false })],
    ] as const) {
      const compile = vi.fn();
      await new ExportController(host, { exportPdf: compile }).export(document);
      expect(compile).not.toHaveBeenCalled();
    }
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

  it("confirms overwrite and serializes the same source URI", async () => {
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

  it("maps every typed compiler error and offers settings for missing Tectonic", async () => {
    for (const code of [
      "E_INPUT",
      "E_OUTPUT_EXISTS",
      "E_TECTONIC_VERSION",
      "E_COMPILE",
      "E_IO",
    ] as const) {
      const host = createHost();
      await new ExportController(host, {
        exportPdf: async () => {
          throw new PdfExportError(code, code);
        },
      }).export(createDocument());
      expect(host.showError).toHaveBeenCalledTimes(1);
    }
    const host = createHost({ showError: vi.fn(async () => "設定を開く") });
    await new ExportController(host, {
      exportPdf: async () => {
        throw new PdfExportError("E_TECTONIC_NOT_FOUND", "missing");
      },
    }).export(createDocument());
    expect(host.openTectonicSettings).toHaveBeenCalledOnce();
  });

  it("does not run compilers in untrusted workspaces", async () => {
    const host = createHost({ isWorkspaceTrusted: false });
    const compile = vi.fn();
    await new ExportController(host, { exportPdf: compile }).export(createDocument());
    expect(compile).not.toHaveBeenCalled();
    expect(host.showWarning).toHaveBeenCalledOnce();
  });
});
