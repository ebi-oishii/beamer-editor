import { describe, expect, it } from "vitest";
import { fragmentPreambleOf, rawFragmentKey } from "../src/fragment.js";
import { parseDeck } from "../src/parser.js";

describe("fragmentPreambleOf", () => {
  it("preamble-extra とマクロ定義(解釈できない定義も)を原文のまま並べる", () => {
    const doc = parseDeck(`\\documentclass[aspectratio=169]{beamer}
%% macros:begin
\\newcommand{\\code}[1]{\\texttt{#1}}
\\def\\odd{x}
%% macros:end
%% preamble-extra:begin
\\usepackage{tikz}
%% preamble-extra:end
\\begin{document}
\\begin{frame}{T}x\\end{frame}
\\end{document}
`);
    expect(fragmentPreambleOf(doc)).toBe(
      "\\usepackage{tikz}\n\\newcommand{\\code}[1]{\\texttt{#1}}\n\\def\\odd{x}",
    );
  });

  it("どちらも無ければ空文字", () => {
    const doc = parseDeck(
      "\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}{T}x\\end{frame}\n\\end{document}\n",
    );
    expect(fragmentPreambleOf(doc)).toBe("");
  });
});

describe("rawFragmentKey", () => {
  const tikz = "\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}";

  it("同じ本文と前置きなら同じ 16 桁の hex、改行コードの違いは無視する", () => {
    const key = rawFragmentKey(tikz, "\\usepackage{tikz}");
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(rawFragmentKey(tikz.replace(/\n/g, "\r\n"), "\\usepackage{tikz}")).toBe(key);
    expect(rawFragmentKey(`  ${tikz}\n`, "\\usepackage{tikz}")).toBe(key);
  });

  it("本文か前置き(マクロ定義)が変わればキーも変わる", () => {
    const key = rawFragmentKey(tikz, "\\usepackage{tikz}");
    expect(rawFragmentKey(tikz.replace("(1,1)", "(1,2)"), "\\usepackage{tikz}")).not.toBe(key);
    expect(
      rawFragmentKey(tikz, "\\usepackage{tikz}\n\\newcommand{\\code}[1]{\\texttt{#1}}"),
    ).not.toBe(key);
  });
});
