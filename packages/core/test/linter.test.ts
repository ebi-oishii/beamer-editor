import { describe, expect, it } from "vitest";
import { lintDeck, parseDeck } from "../src/index.js";

function deck(body: string, preamble = ""): string {
  return `%% deck-source-version: 1
\\documentclass[aspectratio=169]{beamer}
${preamble}
\\begin{document}
${body}
\\end{document}`;
}

describe("lintDeck", () => {
  it("重複した frame label のすべての出現箇所を L009 で報告する", () => {
    const source = deck(`
\\begin{frame}[label=duplicate]{First}
first
\\end{frame}
\\begin{frame}[label=duplicate]{Second}
second
\\end{frame}`);

    const diagnostics = lintDeck(parseDeck(source));

    expect(diagnostics.filter((diagnostic) => diagnostic.code === "L009")).toHaveLength(2);
    expect(diagnostics.filter((diagnostic) => diagnostic.code === "L009")).toMatchObject([
      { severity: "warning" },
      { severity: "warning" },
    ]);
  });

  it("label のないキャンバスフレームを L011 で報告する", () => {
    const source = deck(`
\\begin{frame}{Canvas}
\\begin{deckcanvas}
\\decktext[x=0.1,y=0.1,w=0.5]{text}
\\end{deckcanvas}
\\end{frame}`);

    expect(lintDeck(parseDeck(source))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "L011",
          severity: "warning",
        }),
      ]),
    );
  });

  it("空の label もキャンバスフレームの label 不足として扱う", () => {
    const source = deck(`
\\begin{frame}[label=]{Canvas}
\\begin{deckcanvas}
\\decktext[x=0.1,y=0.1,w=0.5]{text}
\\end{deckcanvas}
\\end{frame}`);

    expect(lintDeck(parseDeck(source))).toEqual([
      expect.objectContaining({
        code: "L011",
      }),
    ]);
  });

  it("source version の欠落と不一致を L017 で報告する", () => {
    const missing = "\\documentclass[aspectratio=169]{beamer}\\begin{document}\\end{document}";
    const outdated = deck("", "").replace("deck-source-version: 1", "deck-source-version: 2");

    expect(lintDeck(parseDeck(missing))).toEqual([
      expect.objectContaining({
        code: "L017",
        message: expect.stringContaining("ありません"),
        span: { start: 0, end: 0 },
      }),
    ]);
    expect(lintDeck(parseDeck(outdated))).toEqual([
      expect.objectContaining({
        code: "L017",
        message: expect.stringContaining("対応していません"),
      }),
    ]);
  });

  it("4:3デッキのキャンバスフレームを L018 で報告する", () => {
    const source = deck(
      `
\\begin{frame}[label=canvas]{Canvas}
\\begin{deckcanvas}
\\decktext[x=0.1,y=0.1,w=0.5]{text}
\\end{deckcanvas}
\\end{frame}`,
    ).replace("aspectratio=169", "aspectratio=43");

    expect(lintDeck(parseDeck(source))).toEqual([
      expect.objectContaining({
        code: "L018",
        severity: "warning",
      }),
    ]);
  });

  it("style領域の未知の記述を L020 で報告する", () => {
    const source = deck(
      "",
      `%% style:begin
\\deckunknown{value}
%% style:end`,
    );

    const diagnostics = lintDeck(parseDeck(source));

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "L020",
        severity: "error",
      }),
    ]);
    expect(source.slice(diagnostics[0]?.span.start, diagnostics[0]?.span.end)).toBe(
      "\\deckunknown{value}",
    );
  });

  it("対応範囲の正常なデッキには診断を返さない", () => {
    const source = deck(`
\\begin{frame}[label=canvas]{Canvas}
\\begin{deckcanvas}
\\decktext[x=0.1,y=0.1,w=0.5]{text}
\\end{deckcanvas}
\\end{frame}`);

    expect(lintDeck(parseDeck(source))).toEqual([]);
  });

  it("呼び出し側が期待するsource versionを指定できる", () => {
    const source = deck("").replace("deck-source-version: 1", "deck-source-version: 2");

    expect(lintDeck(parseDeck(source), { expectedSourceVersion: 2 })).toEqual([]);
  });
});
