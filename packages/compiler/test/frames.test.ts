import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeCanvasGeometry,
  compileDeckFrames,
  type DeckFrameRasterizer,
  findDeckFrames,
  groupFramePages,
  injectFrameMarkers,
  PdfExportError,
  type ProcessResult,
  type ProcessRunner,
} from "../src/index.ts";

const directories: string[] = [];
const canvasPreamblePath = fileURLToPath(
  new URL("../../../fixtures/deck-canvas-preamble.tex", import.meta.url),
);
const fixturesDirectory = fileURLToPath(new URL("../../../fixtures/", import.meta.url));

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "beamer-editor-frames-test-"));
  directories.push(value);
  return value;
}

async function source(text: string): Promise<string> {
  const dir = await directory();
  const path = join(dir, "talk.slide.tex");
  await writeFile(path, text);
  return path;
}

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { exitCode: 0, stdout: "tectonic 0.16.0", stderr: "", ...overrides };
}

function rasterizer(images: Array<{ page: number; png?: Uint8Array }>): DeckFrameRasterizer {
  return {
    async rasterize() {
      return images.map((image) => ({
        page: image.page,
        png: image.png ?? new Uint8Array([image.page]),
        width: 1600,
        height: 900,
      }));
    },
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("frame measurement helpers", () => {
  const deck = String.raw`\documentclass{beamer}
\begin{document}
% \begin{frame}[label=ignored]
\begin{frame}<2->[allowframebreaks,label=first] One
\end{frame}
\begin{frame}[label = second] Two
\end{frame}
\end{document}
`;

  it("finds normal and raw frame syntax while retaining original spans", () => {
    const frames = findDeckFrames(deck);
    expect(frames.map((frame) => frame.address)).toEqual([
      { number: 1, label: "first" },
      { number: 2, label: "second" },
    ]);
    expect(deck.slice(frames[0]?.span.start, frames[0]?.span.end)).toContain("allowframebreaks");
  });

  it("injects fixed-width same-line markers without changing source line count", () => {
    const measured = injectFrameMarkers(deck);
    expect(measured.match(/BEAMER_EDITOR_FRAME:\d{6}/g)).toHaveLength(2);
    expect(measured.split("\n")).toHaveLength(deck.split("\n").length);
    expect(measured).toContain("BEAMER_EDITOR_FRAME:000001}\\begin{frame}");
  });

  it("groups overlay and allowframebreaks pages under the same logical frame", () => {
    const groups = groupFramePages(
      "BEAMER_EDITOR_FRAME:000001 [1] [2] BEAMER_EDITOR_FRAME:000002 [3]",
      findDeckFrames(deck),
    );
    expect(groups.get(1)).toEqual([1, 2]);
    expect(groups.get(2)).toEqual([3]);
  });

  it("recognizes Tectonic page starts even when shipout chatter precedes the closing bracket", () => {
    const groups = groupFramePages(
      "BEAMER_EDITOR_FRAME:000001 [1\n<shipout resource chatter>\n] [2]\nBEAMER_EDITOR_FRAME:000002 [3\n<more chatter>\n]",
      findDeckFrames(deck),
    );
    expect(groups.get(1)).toEqual([1, 2]);
    expect(groups.get(2)).toEqual([3]);
  });

  it("does not guess when page/marker output is inconsistent", () => {
    expect(() => groupFramePages("[1] BEAMER_EDITOR_FRAME:000001", findDeckFrames(deck))).toThrow(
      PdfExportError,
    );
    expect(() => groupFramePages("BEAMER_EDITOR_FRAME:000002 [1]", findDeckFrames(deck))).toThrow(
      PdfExportError,
    );
  });

  it("stops reading a long log as soon as the physical page limit is exceeded", () => {
    const frames = [{ address: { number: 1, label: null } }];
    const log = `BEAMER_EDITOR_FRAME:000001 [1] [2]${" [3]".repeat(10_000)}`;
    expect.assertions(1);
    try {
      groupFramePages(log, frames, 1);
    } catch (error) {
      expect(error).toMatchObject({ code: "E_LIMIT" });
    }
  });
});

describe("analyzeCanvasGeometry", () => {
  const frames = [
    { address: { number: 1, label: "one" } },
    { address: { number: 2, label: "two" } },
  ] as const;
  const body = "DECKBODY left=10pt top=20pt width=100pt height=50pt";

  it("uses the preceding source marker, accepts wrapped records, and ignores printed frame ownership", () => {
    const diagnostics = analyzeCanvasGeometry(
      `${body}\nBEAMER_EDITOR_FRAME:000001\nDECKGEOM frame=999 page=1 kind=text x=10pt y=20pt w=20pt\n h=10pt\nBEAMER_EDITOR_FRAME:000002\nDECKGEOM frame=1 page=2 kind=image x=105pt y=20pt w=10pt h=10pt`,
      frames,
    );
    expect(diagnostics).toMatchObject([
      {
        kind: "canvas-overflow",
        severity: "warning",
        frame: { number: 2, label: "two" },
        geometry: { kind: "image", x: 105, width: 10 },
      },
    ]);
  });

  it("reports real overlap but not edge contact, with the documented epsilon", () => {
    const diagnostics = analyzeCanvasGeometry(
      `${body}\nBEAMER_EDITOR_FRAME:000001\nDECKGEOM frame=1 page=1 kind=text x=10pt y=20pt w=20pt h=20pt\nDECKGEOM frame=1 page=1 kind=image x=30pt y=20pt w=10pt h=20pt\nDECKGEOM frame=1 page=1 kind=image x=29.98pt y=20pt w=10pt h=20pt`,
      frames,
    );
    const overlaps = diagnostics.filter((diagnostic) => diagnostic.kind === "canvas-overlap");
    expect(overlaps).toHaveLength(2);
    expect(overlaps).toContainEqual(
      expect.objectContaining({
        geometry: expect.objectContaining({ x: 10 }),
        overlappingGeometry: expect.objectContaining({ x: 29.98 }),
      }),
    );
    expect(overlaps).not.toContainEqual(
      expect.objectContaining({
        geometry: expect.objectContaining({ x: 10 }),
        overlappingGeometry: expect.objectContaining({ x: 30 }),
      }),
    );
    expect(overlaps[0]).toMatchObject({
      kind: "canvas-overlap",
      geometry: { x: 10 },
      overlappingGeometry: { x: 29.98 },
    });
    expect(
      analyzeCanvasGeometry(
        `${body}\nBEAMER_EDITOR_FRAME:000001\nDECKGEOM frame=1 page=1 kind=text x=9.995pt y=20pt w=1pt h=1pt`,
        frames,
      ),
    ).toEqual([]);
  });

  it("compares geometry only within the same logical frame and physical page", () => {
    const diagnostics = analyzeCanvasGeometry(
      `${body}\nBEAMER_EDITOR_FRAME:000001\nDECKGEOM frame=1 page=1 kind=text x=10pt y=20pt w=20pt h=20pt\nDECKGEOM frame=1 page=2 kind=text x=10pt y=20pt w=20pt h=20pt\nDECKGEOM frame=1 page=1 kind=image x=15pt y=25pt w=10pt h=10pt`,
      frames,
    );
    expect(diagnostics).toMatchObject([
      {
        kind: "canvas-overlap",
        geometry: { page: 1, kind: "text" },
        overlappingGeometry: { page: 1, kind: "image" },
      },
    ]);
    expect(diagnostics).toHaveLength(1);
  });

  it("accepts Tectonic line folds inside dimensions without accepting spaces", () => {
    const diagnostics = analyzeCanvasGeometry(
      "DECKBODY left=1\n0pt top=2\r\n0pt width=100\npt height=2\n00pt\nBEAMER_EDITOR_FRAME:000001\nDECKGEOM frame=1 page=1 kind=text x=10\r\npt y=2\n0pt w=37.\n2959pt h=1\n19.50685p\r\nt",
      frames,
    );
    expect(diagnostics).toEqual([]);
    for (const invalidX of ["1 0pt", "10 pt", "10\tpt"]) {
      expect(() =>
        analyzeCanvasGeometry(
          `DECKBODY left=10pt top=20pt width=100pt height=50pt\nBEAMER_EDITOR_FRAME:000001\nDECKGEOM frame=1 page=1 kind=text x=${invalidX} y=20pt w=1pt h=1pt`,
          frames,
        ),
      ).toThrow(PdfExportError);
    }
  });

  it("returns no diagnostics for logs without geometry and rejects broken managed records", () => {
    expect(analyzeCanvasGeometry("ordinary Tectonic output", frames)).toEqual([]);
    expect(analyzeCanvasGeometry(body, frames)).toEqual([]);
    for (const log of [
      "DECKGEOM frame=1 page=1 kind=text x=0pt y=0pt w=1pt h=1pt",
      "DECKBODY left=0pt top=0pt width=1pt height=1pt\nDECKBODY left=0pt top=0pt width=1pt height=1pt",
      "DECKBODY left=0pt top=0pt width=0pt height=1pt\nBEAMER_EDITOR_FRAME:000001\nDECKGEOM frame=1 kind=text x=0pt y=0pt w=1pt h=1pt",
      "DECKBODY left=0pt top=0pt width=1pt height=1pt\nBEAMER_EDITOR_FRAME:000001\nDECKGEOM frame=1 page=1 kind=text x=0pt y=0pt w=-1pt h=1pt",
      "DECKBODY left=0pt top=0pt width=1pt height=1pt\nBEAMER_EDITOR_FRAME:000001\nDECKGEOM frame=1 kind=text x=0pt y=0pt w=1pt h=1pt",
      "DECKBODY left=0pt top=0pt width=1pt height=1pt\nBEAMER_EDITOR_FRAME:000001\nDECKGEOMERROR reason=unresolved",
      "DECKBODY left=0pt top=0pt width=1pt height=1ptBAD",
      "DECKBODY left=0pt top=0pt width=1pt height=1pt\nBEAMER_EDITOR_FRAME:000001\nDECKGEOM frame=1 page=1 kind=text x=0pt y=0pt w=1pt h=1pt extra=value",
      "DECKGEOMERROR reason=unresolved extra=value",
    ]) {
      try {
        analyzeCanvasGeometry(log, frames);
        expect.unreachable("broken managed log should throw");
      } catch (error) {
        expect(error).toMatchObject({ code: "E_COMPILE" });
      }
    }
  });

  it("ignores ordinary mentions but rejects a garbage-prefixed managed record", () => {
    expect(
      analyzeCanvasGeometry(
        "ordinary log mentions DECKBODY and DECKGEOM without emitting either record",
        frames,
      ),
    ).toEqual([]);
    expect(() =>
      analyzeCanvasGeometry(
        "DECKBODY left=10pt top=20pt width=100pt height=50pt\nBEAMER_EDITOR_FRAME:000001\nXDECKGEOM frame=1 page=1 kind=text x=10pt y=20pt w=1pt h=1pt",
        frames,
      ),
    ).toThrow(PdfExportError);
  });

  it("bounds overlap reporting instead of performing an unbounded pair scan", () => {
    const records = Array.from(
      { length: 143 },
      () => `DECKGEOM frame=1 page=1 kind=text x=10pt y=20pt w=10pt h=10pt`,
    ).join("\n");
    try {
      analyzeCanvasGeometry(`${body}\nBEAMER_EDITOR_FRAME:000001\n${records}`, frames);
      expect.unreachable("too many overlaps should throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "E_LIMIT" });
    }
  });

  it("also bounds x-overlapping objects that are vertically disjoint", () => {
    const records = Array.from(
      { length: 400 },
      (_, index) => `DECKGEOM frame=1 page=1 kind=text x=10pt y=${index * 20}pt w=10pt h=1pt`,
    ).join("\n");
    try {
      analyzeCanvasGeometry(`${body}\nBEAMER_EDITOR_FRAME:000001\n${records}`, frames);
      expect.unreachable("comparison work must be bounded even when there are no overlaps");
    } catch (error) {
      expect(error).toMatchObject({ code: "E_LIMIT" });
    }
  });
});

describe("compileDeckFrames", () => {
  const deck = String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}[label=one] A
\end{frame}
\begin{frame}[allowframebreaks,label=two] B
\end{frame}
\end{document}
`;

  it("compiles once, preserves the source, and groups rendered pages and warnings", async () => {
    const inputPath = await source(deck);
    const calls: Array<readonly string[]> = [];
    let measuredSource = "";
    const runner: ProcessRunner = {
      async run(_command, args) {
        calls.push(args);
        if (args[0] === "--version") return result();
        const outdir = args[args.indexOf("--outdir") + 1] as string;
        const measuredInput = args.at(-1) as string;
        measuredSource = await readFile(measuredInput, "utf8");
        await writeFile(join(outdir, basename(measuredInput).replace(/\.tex$/, ".pdf")), "%PDF");
        await writeFile(
          join(outdir, basename(measuredInput).replace(/\.tex$/, ".log")),
          "DECKBODY left=0pt top=0pt width=100pt height=100pt\nBEAMER_EDITOR_FRAME:000001 DECKGEOM frame=1 page=1 kind=text x=0pt y=0pt w=1pt h=1pt\n[1] Overfull \\hbox (2.5pt too wide) in paragraph at lines 3--4\nBEAMER_EDITOR_FRAME:000002 DECKGEOM frame=2 page=2 kind=image x=2pt y=2pt w=1pt h=1pt\n[2] [3] Overfull \\vbox (1pt too high) detected at line 99\nOverfull \\vbox (3pt too high) has occurred while \\output is active",
        );
        return result({ stdout: "compiler output is deliberately not parsed" });
      },
    };
    const value = await compileDeckFrames(
      { inputPath },
      { runner, rasterizer: rasterizer([{ page: 1 }, { page: 2 }, { page: 3 }]) },
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("--keep-logs");
    const searchPathIndex = calls[1].indexOf("-Z");
    expect(calls[1].slice(searchPathIndex, searchPathIndex + 2)).toEqual([
      "-Z",
      `search-path=${dirname(inputPath)}`,
    ]);
    expect(await readFile(inputPath, "utf8")).toBe(deck);
    expect(measuredSource).toContain("BEAMER_EDITOR_FRAME:000001");
    expect(value.frames.map((frame) => frame.images.map((image) => image.page))).toEqual([
      [1],
      [2, 3],
    ]);
    expect(value.warnings).toMatchObject([
      {
        kind: "overfull-hbox",
        excessPt: 2.5,
        frame: { number: 1, label: "one" },
        sourceLines: { start: 3, end: 4 },
      },
      { kind: "overfull-vbox", excessPt: 1, frame: null, sourceLines: { start: 99, end: 99 } },
      { kind: "overfull-vbox", excessPt: 3, frame: null, sourceLines: null },
    ]);
    const analysisOnly = await compileDeckFrames({ inputPath, includeImages: false }, { runner });
    expect(analysisOnly.frames.map((frame) => frame.images)).toEqual([[], []]);
    expect(analysisOnly.warnings).toEqual(value.warnings);
    expect(value.layoutDiagnostics).toEqual([]);
    expect(analysisOnly.layoutDiagnostics).toEqual([]);
  });

  it("keeps the marked input in tmp while Tectonic searches the absolute source directory", async () => {
    const inputDirectory = join(await directory(), "deck source");
    await mkdir(inputDirectory);
    const inputPath = join(inputDirectory, "talk.slide.tex");
    await writeFile(inputPath, deck);
    let measuredInput = "";
    let compileArgs: readonly string[] = [];
    const runner: ProcessRunner = {
      async run(_command, args) {
        if (args[0] === "--version") return result();
        compileArgs = args;
        const outdir = args[args.indexOf("--outdir") + 1] as string;
        measuredInput = args.at(-1) as string;
        await writeFile(join(outdir, basename(measuredInput).replace(/\.tex$/, ".pdf")), "%PDF");
        await writeFile(
          join(outdir, basename(measuredInput).replace(/\.tex$/, ".log")),
          "BEAMER_EDITOR_FRAME:000001 [1] BEAMER_EDITOR_FRAME:000002 [2]",
        );
        return result();
      },
    };

    await compileDeckFrames({ inputPath, includeImages: false }, { runner });

    expect(measuredInput).not.toBe(inputPath);
    expect(dirname(measuredInput)).not.toBe(dirname(inputPath));
    const searchPathIndex = compileArgs.indexOf("-Z");
    expect(compileArgs.slice(searchPathIndex, searchPathIndex + 2)).toEqual([
      "-Z",
      `search-path=${dirname(inputPath)}`,
    ]);
  });

  it("rejects page and PNG limits", async () => {
    const inputPath = await source(deck);
    const runner: ProcessRunner = {
      async run(_command, args) {
        if (args[0] === "--version") return result();
        const outdir = args[args.indexOf("--outdir") + 1] as string;
        const measuredInput = args.at(-1) as string;
        await writeFile(join(outdir, basename(measuredInput).replace(/\.tex$/, ".pdf")), "%PDF");
        await writeFile(
          join(outdir, basename(measuredInput).replace(/\.tex$/, ".log")),
          "BEAMER_EDITOR_FRAME:000001 [1] BEAMER_EDITOR_FRAME:000002 [2]",
        );
        return result();
      },
    };
    await expect(
      compileDeckFrames(
        { inputPath, maxPages: 1 },
        { runner, rasterizer: rasterizer([{ page: 1 }, { page: 2 }]) },
      ),
    ).rejects.toMatchObject({ code: "E_LIMIT" });
    await expect(
      compileDeckFrames({ inputPath, maxPages: 1, includeImages: false }, { runner }),
    ).rejects.toMatchObject({ code: "E_LIMIT" });
    await expect(
      compileDeckFrames(
        { inputPath, maxPngBytes: 1 },
        { runner, rasterizer: rasterizer([{ page: 1, png: new Uint8Array([1, 2]) }, { page: 2 }]) },
      ),
    ).rejects.toMatchObject({ code: "E_LIMIT" });
  });

  it("uses a rasterizer by default, but does not require one for analysis-only output", async () => {
    const inputPath = await source(deck);
    await expect(compileDeckFrames({ inputPath })).rejects.toMatchObject({ code: "E_RASTERIZE" });
  });

  it("re-checks cancellation before returning analysis-only output", async () => {
    const inputPath = await source(deck);
    let abortedChecks = 0;
    // The first four checks occur before the PDF/log reads. The fifth is the
    // analysis-only check immediately before its return.
    const signal = {
      get aborted() {
        abortedChecks += 1;
        return abortedChecks === 5;
      },
    } as AbortSignal;
    const runner: ProcessRunner = {
      async run(_command, args) {
        if (args[0] === "--version") return result();
        const outdir = args[args.indexOf("--outdir") + 1] as string;
        const measuredInput = args.at(-1) as string;
        await writeFile(join(outdir, basename(measuredInput).replace(/\.tex$/, ".pdf")), "%PDF");
        await writeFile(
          join(outdir, basename(measuredInput).replace(/\.tex$/, ".log")),
          "BEAMER_EDITOR_FRAME:000001 [1] BEAMER_EDITOR_FRAME:000002 [2]",
        );
        return result();
      },
    };
    await expect(
      compileDeckFrames({ inputPath, includeImages: false, signal }, { runner }),
    ).rejects.toMatchObject({ code: "E_CANCELLED" });
    expect(abortedChecks).toBe(5);
  });

  it("passes decode-safe budgets to the rasterizer before it allocates an image", async () => {
    const inputPath = await source(deck);
    let received:
      | {
          maxPages: number;
          maxPngBytes: number;
          maxPixelsPerPage: number;
          maxImageDimension: number;
        }
      | undefined;
    const runner: ProcessRunner = {
      async run(_command, args) {
        if (args[0] === "--version") return result();
        const outdir = args[args.indexOf("--outdir") + 1] as string;
        const measuredInput = args.at(-1) as string;
        await writeFile(join(outdir, basename(measuredInput).replace(/\.tex$/, ".pdf")), "%PDF");
        await writeFile(
          join(outdir, basename(measuredInput).replace(/\.tex$/, ".log")),
          "BEAMER_EDITOR_FRAME:000001 [1] BEAMER_EDITOR_FRAME:000002 [2]",
        );
        return result();
      },
    };
    const preflightFailure = new PdfExportError("E_LIMIT", "image would exceed decoder budget");
    await expect(
      compileDeckFrames(
        {
          inputPath,
          maxPages: 7,
          maxPngBytes: 1234,
          maxPixelsPerPage: 5678,
          maxImageDimension: 90,
        },
        {
          runner,
          rasterizer: {
            async rasterize(_pdfPath, options) {
              received = options;
              throw preflightFailure;
            },
          },
        },
      ),
    ).rejects.toBe(preflightFailure);
    expect(received).toMatchObject({
      maxPages: 7,
      maxPngBytes: 1234,
      maxPixelsPerPage: 5678,
      maxImageDimension: 90,
    });
  });

  it("fails with typed errors when the final Tectonic log is absent or too large", async () => {
    const inputPath = await source(deck);
    let writeLog = false;
    const runner: ProcessRunner = {
      async run(_command, args) {
        if (args[0] === "--version") return result();
        const outdir = args[args.indexOf("--outdir") + 1] as string;
        const measuredInput = args.at(-1) as string;
        await writeFile(join(outdir, basename(measuredInput).replace(/\.tex$/, ".pdf")), "%PDF");
        if (writeLog)
          await writeFile(
            join(outdir, basename(measuredInput).replace(/\.tex$/, ".log")),
            "BEAMER_EDITOR_FRAME:000001 [1] BEAMER_EDITOR_FRAME:000002 [2]",
          );
        return result();
      },
    };
    await expect(
      compileDeckFrames({ inputPath }, { runner, rasterizer: rasterizer([]) }),
    ).rejects.toMatchObject({ code: "E_COMPILE" });
    writeLog = true;
    await expect(
      compileDeckFrames({ inputPath, maxLogBytes: 1 }, { runner, rasterizer: rasterizer([]) }),
    ).rejects.toMatchObject({ code: "E_LIMIT" });
  });

  it("cleans the marked copy when compilation fails", async () => {
    const inputPath = await source(deck);
    let temporary = "";
    const runner: ProcessRunner = {
      run: async (_command, args) =>
        args[0] === "--version" ? result() : result({ exitCode: 1, stderr: "bad TeX" }),
    };
    await expect(
      compileDeckFrames(
        { inputPath },
        {
          runner,
          rasterizer: rasterizer([]),
          temporaryDirectory: async () => {
            temporary = await directory();
            return temporary;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "E_COMPILE" });
    await expect(readFile(join(temporary, "talk.slide.tex"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("cleans temporary files after rasterizer failure and propagates cancellation", async () => {
    const inputPath = await source(deck);
    let temporary = "";
    const runner: ProcessRunner = {
      async run(_command, args) {
        if (args[0] === "--version") return result();
        const outdir = args[args.indexOf("--outdir") + 1] as string;
        const measuredInput = args.at(-1) as string;
        await writeFile(join(outdir, basename(measuredInput).replace(/\.tex$/, ".pdf")), "%PDF");
        await writeFile(
          join(outdir, basename(measuredInput).replace(/\.tex$/, ".log")),
          "BEAMER_EDITOR_FRAME:000001 [1] BEAMER_EDITOR_FRAME:000002 [2]",
        );
        return result();
      },
    };
    await expect(
      compileDeckFrames(
        { inputPath },
        {
          runner,
          rasterizer: { rasterize: async () => Promise.reject(new Error("renderer failed")) },
          temporaryDirectory: async () => {
            temporary = await directory();
            return temporary;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "E_RASTERIZE" });
    await expect(readFile(join(temporary, "talk.slide.tex"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      compileDeckFrames(
        { inputPath, signal: controller.signal },
        { runner, rasterizer: rasterizer([]) },
      ),
    ).rejects.toMatchObject({ code: "E_CANCELLED" });
  });

  it.runIf(process.env.TECTONIC_INTEGRATION === "1")(
    "uses resolved zref-savepos geometry from the final Tectonic pass for canvas overflow",
    async () => {
      const preamble = await readFile(canvasPreamblePath, "utf8");
      const inputPath = await source(String.raw`\documentclass[aspectratio=169]{beamer}
${preamble}
\begin{document}
\begin{frame}[label=canvas]{Canvas}
\begin{deckcanvas}
\begin{decktext}[x=-.1,y=0,w=.2]Measured text\end{decktext}
\end{deckcanvas}
\end{frame}
\end{document}
`);
      const value = await compileDeckFrames({
        inputPath,
        timeoutMs: 120_000,
        includeImages: false,
      });
      expect(value.frames).toHaveLength(1);
      expect(value.layoutDiagnostics).toMatchObject([
        {
          kind: "canvas-overflow",
          severity: "warning",
          frame: { number: 1, label: "canvas" },
          geometry: { kind: "text", x: expect.any(Number) },
        },
      ]);
    },
    180_000,
  );

  it.runIf(process.env.TECTONIC_INTEGRATION === "1")(
    "resolves relative fixture dependencies from the original input directory",
    async () => {
      for (const file of ["basic.slide.tex", "japanese.slide.tex"]) {
        const inputPath = join(fixturesDirectory, file);
        const expectedFrameCount = findDeckFrames(await readFile(inputPath, "utf8")).length;
        const value = await compileDeckFrames({
          inputPath,
          includeImages: false,
          timeoutMs: 120_000,
        });
        expect(value.frames).toHaveLength(expectedFrameCount);
        expect(value.frames.every((frame) => frame.images.length === 0)).toBe(true);
      }
    },
    300_000,
  );
});
