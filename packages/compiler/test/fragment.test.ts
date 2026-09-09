import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildFragmentDocument,
  fragmentDependencies,
  fragmentGraphicsPaths,
} from "../src/fragment.js";
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

  it("テンプレートのテーマ .sty の usepackage は落とす(fixtures/templated.slide.tex の preamble-extra)", () => {
    const tex = readFileSync(
      fileURLToPath(new URL("../../../fixtures/templated.slide.tex", import.meta.url)),
      "utf8",
    );
    const extra = /%% preamble-extra:begin\r?\n([\s\S]*?)\r?\n%% preamble-extra:end/.exec(tex)?.[1];
    expect(extra).toContain("beamerthemecorporate");
    const doc = buildFragmentDocument(
      "\\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture}",
      extra ?? "",
    );
    expect(doc).not.toContain("beamertheme");
    expect(doc).not.toContain("usepackage{templates");
    expect(doc).toContain("\\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture}");
  });

  it("同じ usepackage 行にテーマと他のパッケージが混ざっていればテーマだけ落とす", () => {
    const doc = buildFragmentDocument(
      "x",
      "\\usepackage{tikz,templates/corporate/beamerthemecorporate,xcolor}",
    );
    expect(doc).toContain("\\usepackage{tikz,xcolor}");
    expect(doc).not.toContain("beamertheme");
  });
});

describe("fragmentDependencies", () => {
  it("画像・入力ファイル・データ表・ローカル .sty の参照を出現順に拾い、拡張子は補完しない", () => {
    expect(
      fragmentDependencies(
        [
          "\\usepackage[final]{mystyle,tikz}",
          "\\begin{tikzpicture}",
          "\\node {\\includegraphics[width=2cm]{figs/plot}};",
          "\\addplot[blue] table[x=t,y=v] {data/run1.dat};",
          "\\pgfplotstableread{data/run2.csv}\\tbl",
          "\\input{parts/inner.tex}",
          "\\end{tikzpicture}",
        ].join("\n"),
      ),
    ).toEqual([
      "mystyle.sty",
      "tikz.sty",
      "figs/plot",
      "data/run1.dat",
      "data/run2.csv",
      "parts/inner.tex",
    ]);
  });

  it("コメントの中・インラインデータ・同じ参照の重複は拾わない", () => {
    expect(
      fragmentDependencies(
        [
          "% \\includegraphics{commented.png}",
          "\\includegraphics{a.png} % \\input{also-commented}",
          "\\includegraphics{a.png}",
          "\\addplot table {",
          "1 2",
          "3 4",
          "};",
          "100\\% \\includegraphics{after-escaped-percent.png}",
        ].join("\n"),
      ),
    ).toEqual(["a.png", "after-escaped-percent.png"]);
    expect(fragmentDependencies("\\draw (0,0) -- (1,1);")).toEqual([]);
  });
});

describe("fragmentGraphicsPaths", () => {
  it("\\graphicspath の探索ディレクトリを出現順に拾い、コメントの中は見ない", () => {
    expect(
      fragmentGraphicsPaths(
        "% \\graphicspath{{old/}}\n\\graphicspath{ {images/} {figs/} }\n\\graphicspath{{images/}{../shared/}}",
      ),
    ).toEqual(["images/", "figs/", "../shared/"]);
    expect(fragmentGraphicsPaths("\\includegraphics{a.png}")).toEqual([]);
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

  it("生成 PDF が上限を超えたら読み込まずに E_COMPILE にする", async () => {
    const calls: { command: string; args: string[]; cwd: string }[] = [];
    await expect(
      compileFragment(
        { document: "x", maxOutputBytes: FAKE_PDF.length - 1 },
        { runner: runner(calls) },
      ),
    ).rejects.toMatchObject({
      code: "E_COMPILE",
      message: expect.stringContaining("大きすぎます"),
    });
    const ok = await compileFragment(
      { document: "x", maxOutputBytes: FAKE_PDF.length },
      { runner: runner(calls) },
    );
    expect(Array.from(ok.pdf)).toEqual(Array.from(FAKE_PDF));
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
