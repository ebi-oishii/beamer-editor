import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFragmentDocument } from "../src/fragment.js";
import { compileFragment, type ProcessRunner } from "../src/index.js";

describe("buildFragmentDocument", () => {
  it("standalone の前置きの後に preamble-extra とマクロを置き、本文を document に入れる", () => {
    const doc = buildFragmentDocument(
      "\\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture}",
      "\\usepackage{tikz}\n\\newcommand{\\code}[1]{\\texttt{#1}}",
    );
    expect(doc).toBe(`\\documentclass[preview,border=2pt]{standalone}
\\usepackage{amsmath,amssymb,graphicx,xcolor}
\\renewcommand{\\familydefault}{\\sfdefault}
\\usepackage{tikz}
\\newcommand{\\code}[1]{\\texttt{#1}}
\\begin{document}
\\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture}
\\end{document}
`);
  });

  it("beamer 専用の前置き(テーマ・色・ロゴ)は standalone では未定義になるので落とす", () => {
    const doc = buildFragmentDocument(
      "x",
      [
        "\\usetheme{corporate}",
        "\\setbeamercolor{structure}{fg=blue}",
        "\\logo{\\includegraphics{logo.png}}",
        "\\usepackage{tikz}",
        "\\usebackgroundtemplate{\\includegraphics{bg.png}}",
      ].join("\n"),
    );
    expect(doc).toContain("\\usepackage{tikz}\n\\begin{document}");
    expect(doc).not.toContain("usetheme");
    expect(doc).not.toContain("setbeamercolor");
    expect(doc).not.toContain("\\logo");
    expect(doc).not.toContain("usebackgroundtemplate");
  });
});

describe("compileFragment", () => {
  const FAKE_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7

  function runner(calls: { command: string; args: string[]; cwd: string }[]): ProcessRunner {
    return {
      async run(command, args, options) {
        calls.push({ command, args, cwd: options.cwd });
        if (args[0] === "--version")
          return { exitCode: 0, stdout: "tectonic 0.16.9\n", stderr: "" };
        const outdir = args[args.indexOf("--outdir") + 1] as string;
        await writeFile(join(outdir, "fragment.pdf"), FAKE_PDF);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
  }

  it("一時ディレクトリに fragment.tex を書いてコンパイルし、PDF のバイト列を返して片づける", async () => {
    const calls: { command: string; args: string[]; cwd: string }[] = [];
    const temps: string[] = [];
    const makeTemp = async (prefix: string) => {
      const dir = await mkdtemp(join(tmpdir(), prefix));
      temps.push(dir);
      return dir;
    };
    const result = await compileFragment(
      { document: "\\documentclass{standalone}\\begin{document}x\\end{document}", cwd: "/deck" },
      { runner: runner(calls), temporaryDirectory: makeTemp },
    );
    expect(result.engineVersion).toBe("0.16.9");
    expect(Array.from(result.pdf)).toEqual(Array.from(FAKE_PDF));
    expect(calls.map((call) => call.args[0])).toEqual(["--version", "-X"]);
    const compile = calls[1];
    expect(compile?.cwd).toBe("/deck");
    expect(compile?.args.slice(1, 4)).toEqual(["compile", "--outdir", temps[0]]);
    expect(compile?.args[4]).toBe(join(temps[0] as string, "fragment.tex"));
    await expect(readFile(join(temps[0] as string, "fragment.tex"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("コンパイルの失敗は E_COMPILE で、tectonic の出力を message に載せる", async () => {
    const failing: ProcessRunner = {
      run: async (_command, args) =>
        args[0] === "--version"
          ? { exitCode: 0, stdout: "tectonic 0.16.9", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "! Undefined control sequence.\nl.3 \\bad" },
    };
    await expect(compileFragment({ document: "\\bad" }, { runner: failing })).rejects.toMatchObject(
      { code: "E_COMPILE", message: expect.stringContaining("Undefined control sequence") },
    );
  });

  it("tectonic が無ければ E_TECTONIC_NOT_FOUND", async () => {
    const absent: ProcessRunner = {
      run: async () => {
        const error = new Error("spawn tectonic ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
    };
    await expect(compileFragment({ document: "x" }, { runner: absent })).rejects.toMatchObject({
      code: "E_TECTONIC_NOT_FOUND",
    });
  });
});
