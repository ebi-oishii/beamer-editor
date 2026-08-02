import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
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
    [
      "--import=./packages/cli/node_modules/tsx/dist/loader.mjs",
      "packages/cli/src/cli.ts",
      ...args,
    ],
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
    expect(usage.status).toBe(2);
    expect(usage.stdout).toBe("");
    expect(JSON.parse(usage.stderr).error.code).toBe("E_USAGE");
    const io = runCli("format", "missing.tex");
    expect(io.status).toBe(1);
    expect(io.stdout).toBe("");
    expect(io.stderr).toContain("読み込みに失敗しました");
  });

  it("treats options without a command as usage errors but retains bare deck behavior", () => {
    const bare = runCli();
    expect(bare.status).toBe(0);
    expect(bare.stdout).toBe("");
    expect(bare.stderr).toContain("使い方: deck");

    const json = runCli("--json");
    expect(json.status).toBe(2);
    expect(json.stdout).toBe("");
    expect(JSON.parse(json.stderr)).toMatchObject({ error: { code: "E_USAGE" } });

    const write = runCli("--write");
    expect(write.status).toBe(2);
    expect(write.stdout).toBe("");
    expect(write.stderr).toContain("コマンドを指定してください");
    expect(write.stderr).toContain("使い方: deck");
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
