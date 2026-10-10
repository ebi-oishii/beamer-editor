import { readFileSync } from "node:fs";
import { PdfExportError } from "@beamer-editor/compiler";
import { managedPreambleBlock } from "@beamer-editor/core";
import { HtmlExportError } from "@beamer-editor/html-export";
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
const htmlOutput: ExportUri = {
  scheme: "file",
  fsPath: "/deck/talk-html",
  toString: () => "file:///deck/talk-html",
};
const htmlIndex: ExportUri = {
  scheme: "file",
  fsPath: "/deck/talk-html/index.html",
  toString: () => "file:///deck/talk-html/index.html",
};

function createHost(overrides: Partial<ExportHost> = {}): ExportHost {
  return {
    isWorkspaceTrusted: true,
    chooseFormat: vi.fn<() => Promise<"pdf" | "html" | undefined>>(async () => "pdf"),
    chooseOutput: vi.fn(async () => output),
    outputExists: vi.fn(async () => false),
    withProgress: vi.fn(async (task) =>
      task({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
    ),
    showInformation: vi.fn(async () => undefined),
    showError: vi.fn(async () => undefined),
    showWarning: vi.fn(async () => undefined),
    openPdf: vi.fn(async () => undefined),
    openHtml: vi.fn(async () => undefined),
    revealInFileManager: vi.fn(async () => undefined),
    openTectonicSettings: vi.fn(async () => undefined),
    showExportDetails: vi.fn(),
    showProblems: vi.fn(async () => undefined),
    lintOptions: vi.fn(() => ({})),
    uriForFile: vi.fn(() => output),
    tectonicPath: vi.fn(() => "/custom/tectonic"),
    timeoutMs: vi.fn(() => 300_000),
    ...overrides,
  };
}

/** lint の error が無い文書。 */
const CLEAN_SOURCE = `%% deck-source-version: 1
\\documentclass[aspectratio=169]{beamer}
\\begin{document}
\\begin{frame}{A}
\\end{frame}
\\end{document}
`;

function createDocument(
  overrides: Partial<{ isDirty: boolean; save(): Promise<boolean>; getText(): string }> = {},
) {
  return {
    uri: input,
    isDirty: false,
    save: vi.fn(async () => true),
    getText: () => CLEAN_SOURCE,
    ...overrides,
  };
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

  it("exports HTML in an untrusted workspace and opens the generated index", async () => {
    const host = createHost({
      isWorkspaceTrusted: false,
      chooseFormat: vi.fn(async () => "html" as const),
      chooseOutput: vi.fn(async () => htmlOutput),
      showInformation: vi.fn(async () => "HTMLを開く"),
      uriForFile: vi.fn((path) => (path.endsWith("index.html") ? htmlIndex : htmlOutput)),
    });
    const html = vi.fn(async () => ({
      format: "html" as const,
      inputPath: input.fsPath,
      outputPath: htmlOutput.fsPath,
      indexPath: htmlIndex.fsPath,
    }));
    await new ExportController(host, {
      exportHtml: html,
      htmlKatexAssetsPath: "/extension/media/html-export/katex",
    }).export(createDocument());
    expect(html).toHaveBeenCalledWith({
      inputPath: input.fsPath,
      outputPath: htmlOutput.fsPath,
      overwrite: false,
      signal: expect.any(AbortSignal),
      katexAssetsPath: "/extension/media/html-export/katex",
    });
    expect(host.outputExists).toHaveBeenCalledWith(htmlOutput);
    expect(host.openHtml).toHaveBeenCalledWith(htmlIndex);
    expect(host.showWarning).not.toHaveBeenCalled();
  });
  it("asks before replacing an existing HTML folder", async () => {
    const html = vi.fn(async () => ({
      format: "html" as const,
      inputPath: input.fsPath,
      outputPath: htmlOutput.fsPath,
      indexPath: htmlIndex.fsPath,
    }));
    const cancelled = createHost({
      chooseFormat: vi.fn(async () => "html" as const),
      chooseOutput: vi.fn(async () => htmlOutput),
      outputExists: vi.fn(async () => true),
    });
    await new ExportController(cancelled, { exportHtml: html }).export(createDocument());
    expect(html).not.toHaveBeenCalled();
    const approved = createHost({
      chooseFormat: vi.fn(async () => "html" as const),
      chooseOutput: vi.fn(async () => htmlOutput),
      outputExists: vi.fn(async () => true),
      showWarning: vi.fn(async () => "上書き"),
    });
    await new ExportController(approved, { exportHtml: html }).export(createDocument());
    expect(html).toHaveBeenLastCalledWith(expect.objectContaining({ overwrite: true }));
  });

  it("reveals the HTML output folder and reports typed HTML failures", async () => {
    const host = createHost({
      chooseFormat: vi.fn(async () => "html" as const),
      chooseOutput: vi.fn(async () => htmlOutput),
      showInformation: vi.fn(async () => "フォルダーで表示"),
    });
    await new ExportController(host, {
      exportHtml: async () => ({
        format: "html",
        inputPath: input.fsPath,
        outputPath: htmlOutput.fsPath,
        indexPath: htmlIndex.fsPath,
      }),
    }).export(createDocument());
    expect(host.revealInFileManager).toHaveBeenCalledWith(htmlOutput);

    const failed = createHost({
      chooseFormat: vi.fn(async () => "html" as const),
      chooseOutput: vi.fn(async () => htmlOutput),
    });
    await new ExportController(failed, {
      exportHtml: async () => {
        throw new HtmlExportError("E_ASSET", "missing image");
      },
    }).export(createDocument());
    expect(failed.showError).toHaveBeenCalledWith("HTML の書き出しに失敗しました: missing image");
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
      "編集中のファイルを保存できなかったため、書き出しませんでした。",
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
    expect(host.showWarning).toHaveBeenCalledWith("この文書は既に書き出しています。");
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
      "E_RASTERIZE",
      "E_LIMIT",
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
      "書き出しは完了しましたが、表示操作に失敗しました。",
    );
  });

  describe("E_COMPILE に lint の error を添える", () => {
    const read = (path: string) =>
      readFileSync(new URL(`../../../packages/core/${path}`, import.meta.url), "utf8").trimEnd();
    // \deckbackground を足す前の管理プリアンブル + \deckbackground(L025)。
    const outdated = `\\documentclass[aspectratio=169]{beamer}
%% deck-source-version: 1
${managedPreambleBlock().replace(
  read("resources/deck-style-preamble.tex"),
  read("test/resources/deck-style-preamble.before-background.tex"),
)}

%% style:begin
\\deckbackground{assets/bg.png}
%% style:end

\\begin{document}
\\end{document}
`;
    const failing = () => ({
      exportPdf: async () => {
        throw new PdfExportError("E_COMPILE", "Undefined control sequence");
      },
    });
    const line = outdated.split("\n").findIndex((text) => text.startsWith("\\deckbackground")) + 1;

    it("メッセージに件数と先頭の L025 を入れ、「問題を表示」と詳細の全件を出す", async () => {
      const host = createHost({
        showError: vi.fn(async () => "詳細を表示"),
        lintOptions: vi.fn(() => ({ fileExists: () => true })),
      });
      await new ExportController(host, failing()).export(
        createDocument({ getText: () => outdated }),
      );
      const [message, ...actions] = vi.mocked(host.showError).mock.calls[0] ?? [];
      expect(message).toMatch(
        /^PDF のコンパイルに失敗しました。 lint のエラーが 1 件あります\(先頭: L025: ツール管理プリアンブルが/,
      );
      expect(actions).toEqual(["詳細を表示", "問題を表示"]);
      expect(host.lintOptions).toHaveBeenCalledOnce();
      const detail = String(vi.mocked(host.showExportDetails).mock.calls[0]?.[0]);
      expect(detail).toMatch(
        new RegExp(`^lint のエラー\\(コンパイル失敗の原因かもしれません\\):\\n${line}:1 L025 `),
      );
      expect(detail.endsWith("\n\n[E_COMPILE] Undefined control sequence")).toBe(true);

      const problems = createHost({ showError: vi.fn(async () => "問題を表示") });
      await new ExportController(problems, failing()).export(
        createDocument({ getText: () => outdated }),
      );
      expect(problems.showProblems).toHaveBeenCalledOnce();
      expect(problems.showExportDetails).not.toHaveBeenCalled();
    });

    it("lint の error が無い・lint が例外を投げるときは今まで通り", async () => {
      for (const document of [
        createDocument(),
        createDocument({
          getText: () => {
            throw new Error("closed");
          },
        }),
      ]) {
        const host = createHost({ showError: vi.fn(async () => "詳細を表示") });
        await new ExportController(host, failing()).export(document);
        expect(host.showError).toHaveBeenCalledWith(
          "PDF のコンパイルに失敗しました。",
          "詳細を表示",
        );
        expect(host.showExportDetails).toHaveBeenCalledWith(
          "[E_COMPILE] Undefined control sequence",
        );
      }
      const throwing = createHost({
        lintOptions: vi.fn(() => {
          throw new Error("fs");
        }),
      });
      await new ExportController(throwing, failing()).export(
        createDocument({ getText: () => outdated }),
      );
      expect(throwing.showError).toHaveBeenCalledWith(
        "PDF のコンパイルに失敗しました。",
        "詳細を表示",
      );
    });

    it("E_COMPILE 以外では lint しない", async () => {
      const host = createHost();
      await new ExportController(host, {
        exportPdf: async () => {
          throw new PdfExportError("E_IO", "io");
        },
      }).export(createDocument({ getText: () => outdated }));
      expect(host.lintOptions).not.toHaveBeenCalled();
      expect(host.showError).toHaveBeenCalledWith(
        "PDF の書き出し中に入出力エラーが発生しました。",
        "詳細を表示",
      );
    });
  });
});
