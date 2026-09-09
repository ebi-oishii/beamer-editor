import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT_CODE, exitCodeForError, parseCheckArgs, parseExportArgs, run } from "../src/cli.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
// tsx executes workspace TypeScript and its .js-specifier imports in the subprocess just like Node ESM.
const tsxLoader = require.resolve("tsx");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(`${tmpdir()}/beamer-editor-cli-`);
  temporaryDirectories.push(directory);
  return directory;
}

async function fixture(name: string, source: string): Promise<{ path: string; argvPath: string }> {
  const directory = await temporaryDirectory();
  const path = `${directory}/${name}`;
  await writeFile(path, source, "utf8");
  return { path, argvPath: relative(ROOT, path) };
}

function deck(body: string): string {
  return `%% deck-source-version: 1
\\documentclass[aspectratio=169]{beamer}
\\begin{document}
${body}
\\end{document}
`;
}

function runCli(...args: string[]) {
  return spawnSync(
    process.execPath,
    [`--import=${tsxLoader}`, "packages/cli/src/cli.ts", ...args],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("deck lint", () => {
  it("reports L021 as a warning in text and JSON with UTF-16-aware locations", async () => {
    const source = await fixture("yen.tex", deck("😀日本語 ¥section{Title}"));
    const text = runCli("lint", source.argvPath);
    expect(text.status).toBe(1);
    expect(text.stdout).toContain("warning L021");
    expect(text.stdout).toContain(":4:7:");

    const json = runCli("lint", source.argvPath, "--json");
    expect(json.status).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({
      diagnostics: [
        { code: "L021", severity: "warning", location: { line: 4, column: 7, endColumn: 8 } },
      ],
      summary: { errors: 0, warnings: 1, infos: 0 },
    });
  });

  it("uses the deck directory for relative logo and image probes", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      `${directory}/logo.png`,
      Buffer.from([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
      ]),
    );
    await writeFile(`${directory}/page.pdf`, "%PDF-1.4\n/MediaBox [0 0 100 100]\n", "utf8");
    const file = `${directory}/deck.tex`;
    await writeFile(
      file,
      deck(`%% style:begin
\\decklogo[x=0,y=0,w=0.1]{logo.png}
%% style:end
\\begin{frame}[label=canvas]{Canvas}
\\begin{deckcanvas}
\\deckimage[x=0,y=0,w=1]{page.pdf}
\\end{deckcanvas}
\\end{frame}`),
      "utf8",
    );
    const result = runCli("lint", relative(ROOT, file));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${relative(ROOT, file)}: OK\n`);
    expect(result.stderr).toBe("");
  });

  it("reports warnings, errors, info, and stable JSON locations", async () => {
    const warning = await fixture(
      "warning.tex",
      deck(`\\begin{frame}[label=canvas]{Canvas}
\\begin{deckcanvas}
\\begin{decktext}[x=0.8,y=1,w=0.3,size=normal]text\\end{decktext}
\\end{deckcanvas}
\\end{frame}`),
    );
    const warningResult = runCli("lint", warning.argvPath, "--json");
    expect(warningResult.status).toBe(1);
    expect(warningResult.stderr).toBe("");
    expect(warningResult.stdout.endsWith("\n")).toBe(true);
    const warningJson = JSON.parse(warningResult.stdout) as Record<string, unknown>;
    expect(Object.keys(warningJson)).toEqual(["file", "diagnostics", "summary"]);
    expect(warningJson).toEqual({
      file: warning.argvPath,
      diagnostics: [
        {
          code: "L012",
          severity: "warning",
          message: "キャンバスの x, y, w は本文領域内に収まる必要があります",
          location: { line: 6, column: 17, endLine: 6, endColumn: 46 },
        },
      ],
      summary: { errors: 0, warnings: 1, infos: 0 },
    });
    const diagnostic = warningJson.diagnostics as Array<Record<string, unknown>>;
    expect(Object.keys(diagnostic[0] as Record<string, unknown>)).toEqual([
      "code",
      "severity",
      "message",
      "location",
    ]);
    expect(Object.keys(diagnostic[0]?.location as Record<string, unknown>)).toEqual([
      "line",
      "column",
      "endLine",
      "endColumn",
    ]);
    expect(Object.keys(warningJson.summary as Record<string, unknown>)).toEqual([
      "errors",
      "warnings",
      "infos",
    ]);
    expect(warningResult.stdout).toMatch(
      /^\{\n {2}"file": .+\n {2}"diagnostics": \[\n {4}\{\n {6}"code": "L012",\n {6}"severity": "warning",\n {6}"message": .+\n {6}"location": \{\n {8}"line": 6,\n {8}"column": 17,\n {8}"endLine": 6,\n {8}"endColumn": 46\n {6}\}\n {4}\}\n {2}\],\n {2}"summary": \{\n {4}"errors": 0,\n {4}"warnings": 1,\n {4}"infos": 0\n {2}\}\n\}\n$/,
    );

    const error = await fixture(
      "error.tex",
      deck(`\\begin{frame}[label=canvas]{Canvas}
\\begin{deckcanvas}
\\begin{decktext}[x=0,y=0,w=1,size=huge]日本語\\end{decktext}
\\end{deckcanvas}
\\end{frame}`).replace(/\n/g, "\r\n"),
    );
    const errorResult = runCli("lint", error.argvPath);
    expect(errorResult.status).toBe(2);
    expect(errorResult.stdout).toContain("error L013");

    const info = await fixture(
      "info.tex",
      deck("\\begin{frame}{😀}\\unknowncommand{日本語}\\end{frame}").replace(/\n/g, "\r\n"),
    );
    const infoResult = runCli("lint", info.argvPath, "--json");
    expect(infoResult.status).toBe(0);
    const infoJson = JSON.parse(infoResult.stdout);
    expect(infoJson.diagnostics).toEqual([
      expect.objectContaining({
        code: "L001",
        severity: "info",
        location: { line: 4, column: 18, endLine: 4, endColumn: 38 },
      }),
    ]);
  });

  it("keeps usage and I/O errors on stderr", () => {
    const usage = runCli("lint", "--write", "missing.tex", "--json");
    expect(usage.status).toBe(3);
    expect(usage.stdout).toBe("");
    expect(JSON.parse(usage.stderr)).toEqual({
      error: { code: "E_USAGE", message: "lint は --write をサポートしません" },
    });
    const io = runCli("format", "missing.tex");
    expect(io.status).toBe(3);
    expect(io.stdout).toBe("");
    expect(io.stderr).toContain("読み込みに失敗しました");
    const ioJson = runCli("format", "missing.tex", "--json");
    expect(ioJson.status).toBe(3);
    expect(ioJson.stdout).toBe("");
    const ioError = JSON.parse(ioJson.stderr) as { error: Record<string, unknown> };
    expect(Object.keys(ioError)).toEqual(["error"]);
    expect(Object.keys(ioError.error)).toEqual(["code", "message"]);
    expect(ioError.error.code).toBe("E_IO");
    expect(ioError.error.message).toContain("読み込みに失敗しました: missing.tex:");
  });

  it("maps all E_* operational failures to the stable exit code", () => {
    expect(exitCodeForError("E_USAGE")).toBe(EXIT_CODE.operationalFailure);
    expect(exitCodeForError("E_IO")).toBe(EXIT_CODE.operationalFailure);
    expect(exitCodeForError("E_INTERNAL")).toBe(EXIT_CODE.operationalFailure);
  });

  it("treats an unknown font fetch as an operational failure without changing its JSON result", () => {
    const result = runCli("fonts", "fetch", "Unknown Family", "--json");

    expect(result.status).toBe(3);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      family: "Unknown Family",
      status: "unknown-family",
      fetched: [],
      installed: [],
    });
  });

  it("treats options without a command as usage errors but retains bare deck behavior", () => {
    const bare = runCli();
    expect(bare.status).toBe(0);
    expect(bare.stdout).toBe("");
    expect(bare.stderr).toContain("使い方: deck");

    const json = runCli("--json");
    expect(json.status).toBe(3);
    expect(json.stdout).toBe("");
    expect(JSON.parse(json.stderr)).toEqual({
      error: { code: "E_USAGE", message: "コマンドを指定してください" },
    });

    const write = runCli("--write");
    expect(write.status).toBe(3);
    expect(write.stdout).toBe("");
    expect(write.stderr).toContain("コマンドを指定してください");
    expect(write.stderr).toContain("使い方: deck");
  });

  it("keeps human usage errors on stderr and operational exit code 3", () => {
    const result = runCli("unknown-command");
    expect(result.status).toBe(EXIT_CODE.operationalFailure);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "不明なコマンド: unknown-command\n" +
        "使い方: deck <command> ...\n\n" +
        "  deck init [directory] [--json]       空のディレクトリに新規デッキを生成\n" +
        "  deck lint <file> [--json]           デッキを検査\n" +
        "  deck format <file> [--write] [--json]  デッキを正規化\n" +
        "  deck outline <file> [--json]        フレーム一覧を表示\n" +
        "  deck check <file> [--tectonic <path>] [--json]  実コンパイルで検査\n" +
        "  deck export <file> --format pdf [-o <file>] [--overwrite] [--tectonic <path>] [--json]\n" +
        "  deck fonts status [--json]          フォントカタログ全 family の解決状態\n" +
        '  deck fonts fetch [family] [--json]  family(既定 "Noto Sans CJK JP")を取得・配置\n',
    );
  });
});

describe("deck outline", () => {
  it("展開せずに出現順のフレーム番号、label、タイトルを出力する", async () => {
    const source = await fixture(
      "outline.tex",
      deck(String.raw`\begin{frame}[label=intro]{Intro $x$}\end{frame}
\begin{frame}\end{frame}
\begin{frame}[label=raw,shrink=5]{Raw
  title}\includegraphics[label=figure]{chart.pdf}\end{frame}
\begin{frame}[label=   ,shrink=5]{No label}\end{frame}`),
    );
    const result = runCli("outline", source.argvPath);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      "1. [intro] Intro $x$\n2. [-] frame 2\n3. [raw] Raw title\n4. [-] No label\n",
    );

    const json = runCli("outline", source.argvPath, "--json");
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      file: source.argvPath,
      frames: [
        { number: 1, label: "intro", title: "Intro $x$" },
        { number: 2, label: null, title: "frame 2" },
        { number: 3, label: "raw", title: "Raw title" },
        { number: 4, label: null, title: "No label" },
      ],
    });
  });

  it("空デッキを成功として出力し、使用法と I/O エラーを既存形式で返す", async () => {
    const source = await fixture("empty.tex", deck(""));
    const empty = runCli("outline", source.argvPath, "--json");
    expect(empty.status).toBe(0);
    expect(JSON.parse(empty.stdout)).toEqual({ file: source.argvPath, frames: [] });

    const write = runCli("outline", source.argvPath, "--write", "--json");
    expect(write.status).toBe(3);
    expect(JSON.parse(write.stderr)).toEqual({
      error: { code: "E_USAGE", message: "outline は --write をサポートしません" },
    });
    const extra = runCli("outline", source.argvPath, "other.tex", "--json");
    expect(extra.status).toBe(3);
    expect(JSON.parse(extra.stderr)).toEqual({
      error: { code: "E_USAGE", message: "outline にはファイルを 1 つ指定してください" },
    });
    const absent = runCli("outline", "--json");
    expect(absent.status).toBe(3);
    expect(JSON.parse(absent.stderr)).toEqual({
      error: { code: "E_USAGE", message: "outline にはファイルを 1 つ指定してください" },
    });
    const unknown = runCli("outline", source.argvPath, "--unknown", "--json");
    expect(unknown.status).toBe(3);
    expect(JSON.parse(unknown.stderr).error.code).toBe("E_USAGE");
    const missing = runCli("outline", "missing.tex", "--json");
    expect(missing.status).toBe(3);
    expect(JSON.parse(missing.stderr).error.code).toBe("E_IO");
  });
});

describe("deck check", () => {
  it("accepts options in either position and rejects duplicate, missing, extra, and write options", () => {
    expect(parseCheckArgs(["talk.tex", "--tectonic", "/opt/tectonic", "--json"])).toEqual({
      input: "talk.tex",
      tectonic: "/opt/tectonic",
      json: true,
      write: false,
      error: undefined,
    });
    expect(parseCheckArgs(["--json", "--tectonic", "/opt/tectonic", "talk.tex"])).toMatchObject({
      input: "talk.tex",
      tectonic: "/opt/tectonic",
      json: true,
    });
    for (const argv of [
      ["talk.tex", "--json", "--json"],
      ["talk.tex", "--tectonic"],
      ["talk.tex", "other.tex"],
      ["talk.tex", "--unknown"],
      [],
    ]) {
      expect(parseCheckArgs(argv).error).toBeDefined();
    }
    expect(parseCheckArgs(["talk.tex", "--write"])).toMatchObject({ write: true });
  });

  it("combines lint, compile, and layout diagnostics without writing the input", async () => {
    const source = await fixture(
      "check.tex",
      deck(String.raw`\begin{frame}[label=canvas]{Canvas}
\begin{deckcanvas}
\begin{decktext}[x=0.8,y=1,w=0.3,size=normal]text\end{decktext}
\end{deckcanvas}
\end{frame}`),
    );
    const original = await readFile(source.path, "utf8");
    const frameStart = original.indexOf("\\begin{frame}");
    const frameEnd = original.indexOf("\\end{frame}") + "\\end{frame}".length;
    const compiler = vi.fn(async () => {
      return {
        engineVersion: "0.16.0",
        frames: [
          {
            address: { number: 1, label: "canvas" },
            span: { start: frameStart, end: frameEnd },
            images: [],
          },
        ],
        warnings: [
          {
            kind: "overfull-hbox" as const,
            message: "Overfull \\hbox (2pt too wide)",
            excessPt: 2,
            frame: { number: 1, label: "canvas" },
            sourceLines: { start: 5, end: 6 },
          },
          {
            kind: "overfull-vbox" as const,
            message: "Overfull \\vbox (1pt too high)",
            excessPt: 1,
            frame: null,
            sourceLines: null,
          },
        ],
        layoutDiagnostics: [
          {
            kind: "canvas-overflow" as const,
            severity: "warning" as const,
            frame: { number: 1, label: "canvas" },
            message: "本文領域からはみ出しています",
            geometry: {
              frame: { number: 1, label: "canvas" },
              page: 1,
              kind: "text" as const,
              x: 1,
              y: 2,
              width: 3,
              height: 4,
            },
          },
          {
            kind: "canvas-overlap" as const,
            severity: "info" as const,
            frame: { number: 1, label: "canvas" },
            message: "オブジェクトが重なっています",
            geometry: {
              frame: { number: 1, label: "canvas" },
              page: 1,
              kind: "text" as const,
              x: 1,
              y: 2,
              width: 3,
              height: 4,
            },
            overlappingGeometry: {
              frame: { number: 1, label: "canvas" },
              page: 1,
              kind: "image" as const,
              x: 2,
              y: 3,
              width: 4,
              height: 5,
            },
          },
        ],
      };
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const checkCode = await run(["check", "--json", source.path, "--tectonic", "/opt/tectonic"], {
        compileDeckFrames: compiler,
      });
      expect(checkCode).toBe(EXIT_CODE.lintWarning);
      expect(compiler).toHaveBeenCalledTimes(1);
      expect(compiler).toHaveBeenCalledWith({
        inputPath: source.path,
        tectonicPath: "/opt/tectonic",
        includeImages: false,
      });
      const result = JSON.parse(String(stdout.mock.calls[0]?.[0]));
      expect(Object.keys(result)).toEqual(["file", "engine", "diagnostics", "summary"]);
      expect(Object.keys(result.engine)).toEqual(["name", "version"]);
      expect(Object.keys(result.summary)).toEqual(["errors", "warnings", "infos"]);
      expect(result).toMatchObject({
        file: source.path,
        engine: { name: "tectonic", version: "0.16.0" },
        summary: { errors: 0, warnings: 4, infos: 1 },
      });
      expect(
        result.diagnostics.map((diagnostic: { category: string; code: string }) => [
          diagnostic.category,
          diagnostic.code,
        ]),
      ).toEqual([
        ["lint", "L012"],
        ["compile", "overfull-hbox"],
        ["compile", "overfull-vbox"],
        ["layout", "canvas-overflow"],
        ["layout", "canvas-overlap"],
      ]);
      expect(
        result.diagnostics.map((diagnostic: Record<string, unknown>) => Object.keys(diagnostic)),
      ).toEqual([
        ["category", "code", "severity", "message", "frame", "location"],
        ["category", "code", "severity", "message", "frame", "sourceLines"],
        ["category", "code", "severity", "message", "frame"],
        ["category", "code", "severity", "message", "frame", "geometry"],
        ["category", "code", "severity", "message", "frame", "geometry", "overlappingGeometry"],
      ]);
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "lint",
            code: "L012",
            frame: { number: 1, label: "canvas" },
          }),
          expect.objectContaining({
            category: "compile",
            code: "overfull-hbox",
            sourceLines: { start: 5, end: 6 },
          }),
          expect.objectContaining({ category: "compile", code: "overfull-vbox", frame: null }),
          expect.objectContaining({
            category: "layout",
            code: "canvas-overflow",
            geometry: expect.any(Object),
          }),
          expect.objectContaining({
            category: "layout",
            code: "canvas-overlap",
            overlappingGeometry: expect.any(Object),
          }),
        ]),
      );
      expect(stderr).not.toHaveBeenCalled();
      expect(await readFile(source.path, "utf8")).toBe(original);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("treats an info-only canvas overlap as success", async () => {
    const source = await fixture(
      "check-info.tex",
      deck(String.raw`\begin{frame}[label=canvas]{Canvas}Text\end{frame}`),
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(
        await run(["check", source.path, "--json"], {
          compileDeckFrames: async () => ({
            engineVersion: "0.16.0",
            frames: [],
            warnings: [],
            layoutDiagnostics: [
              {
                kind: "canvas-overlap",
                severity: "info",
                frame: { number: 1, label: "canvas" },
                message: "オブジェクトが重なっています",
                geometry: {
                  frame: { number: 1, label: "canvas" },
                  page: 1,
                  kind: "text",
                  x: 1,
                  y: 2,
                  width: 3,
                  height: 4,
                },
              },
            ],
          }),
        }),
      ).toBe(EXIT_CODE.success);
      expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
        summary: { errors: 0, warnings: 0, infos: 1 },
        diagnostics: [{ category: "layout", code: "canvas-overlap", severity: "info" }],
      });
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("uses source positions in text output and maps every compiler E_* error to stderr exit 3", async () => {
    const source = await fixture("check-clean.tex", deck(""));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const lintError = await fixture("check-error.tex", deck("¥section{bad}"));
      expect(
        await run(["check", lintError.path], {
          compileDeckFrames: async () => ({
            engineVersion: "0.16.0",
            frames: [],
            warnings: [],
            layoutDiagnostics: [],
          }),
        }),
      ).toBe(EXIT_CODE.lintWarning);
      expect(String(stdout.mock.calls[0]?.[0])).toMatch(/check-error\.tex:4:\d+: warning L021:/);
      stdout.mockClear();
      const lintFailure = await fixture(
        "check-lint-error.tex",
        deck(String.raw`\begin{frame}[label=canvas]{Canvas}
\begin{deckcanvas}
\begin{decktext}[x=0,y=0,w=1,size=huge]日本語\end{decktext}
\end{deckcanvas}
\end{frame}`),
      );
      expect(
        await run(["check", lintFailure.path], {
          compileDeckFrames: async () => ({
            engineVersion: "0.16.0",
            frames: [],
            warnings: [],
            layoutDiagnostics: [],
          }),
        }),
      ).toBe(EXIT_CODE.lintError);
      stdout.mockClear();
      expect(
        await run(["check", source.path], {
          compileDeckFrames: async () => ({
            engineVersion: "0.16.0",
            frames: [],
            warnings: [],
            layoutDiagnostics: [],
          }),
        }),
      ).toBe(EXIT_CODE.success);
      expect(String(stdout.mock.calls[0]?.[0])).toBe(`${source.path}: OK\n`);
      stdout.mockClear();
      for (const code of [
        "E_INPUT",
        "E_TECTONIC_NOT_FOUND",
        "E_TECTONIC_VERSION",
        "E_COMPILE",
        "E_RASTERIZE",
        "E_LIMIT",
        "E_IO",
        "E_CANCELLED",
      ]) {
        stderr.mockClear();
        const error = Object.assign(new Error(code), { code });
        expect(
          await run(["check", source.path, "--json"], {
            compileDeckFrames: async () => Promise.reject(error),
          }),
        ).toBe(EXIT_CODE.operationalFailure);
        expect(stdout).not.toHaveBeenCalled();
        expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toEqual({
          error: { code, message: code },
        });
      }
      stderr.mockClear();
      expect(await run(["check", "missing.tex", "--json"])).toBe(EXIT_CODE.operationalFailure);
      expect(JSON.parse(String(stderr.mock.calls[0]?.[0])).error.code).toBe("E_IO");
      stderr.mockClear();
      expect(await run(["check", source.path, "--write", "--json"])).toBe(3);
      expect(JSON.parse(String(stderr.mock.calls.at(-1)?.[0]))).toEqual({
        error: { code: "E_USAGE", message: "check は --write をサポートしません" },
      });
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});

describe("deck format", () => {
  const unformatted = deck(`\\begin{frame}[label=canvas]{Canvas}
\\begin{deckcanvas}
\\deckimage[w=.3,y=-0,x=.8]{image.png}
\\end{deckcanvas}
\\end{frame}`);

  it("writes only changed files and preserves no-write input", async () => {
    const source = await fixture("format.tex", unformatted);
    const expected = runCli("format", source.argvPath);
    expect(expected.status).toBe(0);
    expect(expected.stdout).toBe(
      "%% deck-source-version: 1\n\\documentclass[aspectratio=169]{beamer}\n\\begin{document}\n\\begin{frame}[label=canvas]{Canvas}\n\\begin{deckcanvas}\n\\deckimage[x=0.800,y=0.000,w=0.300]{image.png}\n\\end{deckcanvas}\n\\end{frame}\n\\end{document}\n",
    );
    expect(await readFile(source.path, "utf8")).toBe(unformatted);

    const written = runCli("format", "--write", source.argvPath);
    expect(written.stdout).toBe(`${source.argvPath}: formatted\n`);
    const firstMtime = (await stat(source.path)).mtimeMs;
    const unchanged = runCli("format", source.argvPath, "--write");
    expect(unchanged.stdout).toBe(`${source.argvPath}: unchanged\n`);
    expect((await stat(source.path)).mtimeMs).toBe(firstMtime);
  });

  it("uses the specified JSON shape for write and no-write", async () => {
    const source = await fixture("format-json.tex", unformatted);
    const noWrite = JSON.parse(runCli("format", "--json", source.argvPath).stdout);
    expect(Object.keys(noWrite)).toEqual(["file", "changed", "written", "formatted"]);
    expect(noWrite).toMatchObject({ file: source.argvPath, changed: true, written: false });
    const write = JSON.parse(runCli("format", source.argvPath, "--write", "--json").stdout);
    expect(write).toMatchObject({
      file: source.argvPath,
      changed: true,
      written: true,
      formatted: null,
    });
  });
});

describe("deck export", () => {
  it("parses the required PDF format, output aliases, and usage failures without changing other command parsing", () => {
    expect(
      parseExportArgs(["talk.slide.tex", "--format", "pdf", "-o", "out.pdf", "--overwrite"]),
    ).toMatchObject({
      input: "talk.slide.tex",
      format: "pdf",
      output: "out.pdf",
      overwrite: true,
      error: undefined,
    });
    for (const argv of [
      ["talk.tex"],
      ["--format", "pdf"],
      ["talk.tex", "--format", "html"],
      ["talk.tex", "--format", "pdf", "--format", "pdf"],
      ["talk.tex", "--format", "pdf", "--output"],
      ["talk.tex", "--format", "pdf", "--unknown"],
    ]) {
      expect(parseExportArgs(argv).error).toBeDefined();
    }
    expect(parseExportArgs(["talk.tex", "--format", "--json"])).toMatchObject({
      json: true,
      error: "オプションには値が必要です: --format",
    });
  });

  it("writes the documented human and JSON success shapes", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const compiler = async () => ({
      format: "pdf" as const,
      inputPath: "/tmp/talk.slide.tex",
      outputPath: "/tmp/talk.pdf",
      overwritten: false,
      engineVersion: "0.16.0",
    });
    try {
      expect(
        await run(["export", "talk.slide.tex", "--format", "pdf"], { exportPdf: compiler }),
      ).toBe(0);
      expect(stdout).toHaveBeenLastCalledWith("talk.slide.tex -> talk.pdf\n");
      stdout.mockClear();
      expect(
        await run(["export", "talk.slide.tex", "--format", "pdf", "--json"], {
          exportPdf: compiler,
        }),
      ).toBe(0);
      expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
        format: "pdf",
        input: "talk.slide.tex",
        output: "talk.pdf",
        overwritten: false,
        engine: { name: "tectonic", version: "0.16.0" },
      });
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("keeps export failures on stderr with exit code 3", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const compiler = async () => {
        const error = Object.assign(new Error("already exists"), { code: "E_OUTPUT_EXISTS" });
        throw error;
      };
      expect(
        await run(["export", "talk.tex", "--format", "pdf", "--json"], { exportPdf: compiler }),
      ).toBe(3);
      expect(stdout).not.toHaveBeenCalled();
      expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toEqual({
        error: { code: "E_OUTPUT_EXISTS", message: "already exists" },
      });
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("preserves E_IO rather than reporting an output preflight failure as internal", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const compiler = async () => {
        throw Object.assign(new Error("output cannot be inspected"), { code: "E_IO" });
      };
      expect(
        await run(["export", "talk.tex", "--format", "pdf", "--json"], { exportPdf: compiler }),
      ).toBe(EXIT_CODE.operationalFailure);
      expect(stdout).not.toHaveBeenCalled();
      expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toEqual({
        error: { code: "E_IO", message: "output cannot be inspected" },
      });
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("preserves frame-rendering compiler errors as operational export failures", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      for (const code of ["E_RASTERIZE", "E_LIMIT"] as const) {
        const compiler = async () => {
          throw Object.assign(new Error(`日本語の ${code} エラー`), { code });
        };
        expect(
          await run(["export", "talk.tex", "--format", "pdf", "--json"], { exportPdf: compiler }),
        ).toBe(EXIT_CODE.operationalFailure);
        expect(JSON.parse(String(stderr.mock.calls.at(-1)?.[0]))).toEqual({
          error: { code, message: `日本語の ${code} エラー` },
        });
      }
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
