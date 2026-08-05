import { describe, expect, it, vi } from "vitest";
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
  it("マクロ領域の未展開・未対応な定義を L002 で報告する", () => {
    const source = deck(
      "",
      `%% macros:begin
\\newcommand{\\conditional}[1]{\\ifx#1x yes\\fi}
\\def\\legacy{value}
%% macros:end`,
    );

    const diagnostics = lintDeck(parseDeck(source)).filter((entry) => entry.code === "L002");

    expect(diagnostics).toMatchObject([
      { severity: "warning", message: "このマクロ定義は展開に対応していません" },
      { severity: "warning", message: "このマクロ領域の内容は展開に対応していません" },
    ]);
    expect(diagnostics.map((entry) => sourceText(source, entry))).toEqual([
      "\\newcommand{\\conditional}[1]{\\ifx#1x yes\\fi}",
      "\\def\\legacy{value}",
    ]);
    const structured = "\\newcommand{\\conditional}[1]{\\ifx#1x yes\\fi}";
    const raw = "\\def\\legacy{value}";
    expect(diagnostics.map((entry) => entry.span)).toEqual(
      [structured, raw].map((text) => {
        const start = source.indexOf(text);
        return { start, end: start + text.length };
      }),
    );
  });

  it("deck で始まるマクロ名だけを L016 で報告する", () => {
    const source = deck(
      "",
      `%% macros:begin
\\renewcommand{\\deckimage}[1]{#1}
\\newenvironment{deckfoo}{}{}
\\newcommand{\\DeckFoo}[1]{#1}
\\newcommand{\\ordinary}[1]{#1}
%% macros:end`,
    );

    const diagnostics = lintDeck(parseDeck(source)).filter((entry) => entry.code === "L016");

    expect(diagnostics).toMatchObject([{ severity: "error" }, { severity: "error" }]);
    expect(diagnostics.map((entry) => sourceText(source, entry))).toEqual([
      "\\renewcommand{\\deckimage}[1]{#1}",
      "\\newenvironment{deckfoo}{}{}",
    ]);
  });

  it("生の def 系primitiveによる deck* 再定義も L016 で報告する", () => {
    const source = deck(
      "",
      `%% macros:begin
\\def
\\deckdef{}
\\global \\def \\deckglobal{}
\\gdef\\deckgdef{}
\\edef\\deckedef{}
\\xdef\\deckxdef{}
\\long
\\protected
\\def
\\deckmultiline{}
\\def% comment
\\deckcomment{}
%% macros:end`,
    );

    const diagnostics = lintDeck(parseDeck(source)).filter((entry) => entry.code === "L016");

    expect(diagnostics.map((entry) => sourceText(source, entry))).toEqual([
      "\\def\n\\deckdef{}",
      "\\global \\def \\deckglobal{}",
      "\\gdef\\deckgdef{}",
      "\\edef\\deckedef{}",
      "\\xdef\\deckxdef{}",
      "\\long\n\\protected\n\\def\n\\deckmultiline{}",
      "\\def% comment\n\\deckcomment{}",
    ]);
  });

  it("生の \\def は予約済みの対象制御綴だけを L016 で報告する", () => {
    const source = deck(
      "",
      `%% macros:begin
\\def\\deckimage{}
\\def\\ordinary{%
  \\gdef\\deckinside{}
}
\\def\\DeckFoo{}
\\deckfoo{}
%% macros:end`,
    );

    const diagnostics = lintDeck(parseDeck(source)).filter((entry) => entry.code === "L016");

    expect(diagnostics).toHaveLength(1);
    const [diagnostic] = diagnostics;
    if (diagnostic === undefined) throw new Error("expected an L016 diagnostic");
    expect(sourceText(source, diagnostic)).toBe("\\def\\deckimage{}");
  });

  it("同じ RawBlock で定義本文の後ろに続く予約名定義を L016 で報告する", () => {
    const source = deck(
      "",
      `%% macros:begin
\\def\\ordinary{value}\\gdef\\deckafter{}
%% macros:end`,
    );

    const diagnostics = lintDeck(parseDeck(source)).filter((entry) => entry.code === "L016");

    expect(diagnostics).toHaveLength(1);
    expect(sourceText(source, diagnostics[0] as NonNullable<(typeof diagnostics)[number]>)).toBe(
      "\\gdef\\deckafter{}",
    );
  });

  it("同じ RawBlock の複数の直接予約名定義を順に L016 で報告する", () => {
    const source = deck(
      "",
      `%% macros:begin
\\def\\deckfirst{}\\edef\\decksecond{}
%% macros:end`,
    );

    const diagnostics = lintDeck(parseDeck(source)).filter((entry) => entry.code === "L016");

    expect(diagnostics.map((entry) => sourceText(source, entry))).toEqual([
      "\\def\\deckfirst{}",
      "\\edef\\decksecond{}",
    ]);
  });

  it("RawBlock をまたぐ target と本文でも予約名定義を L016 で報告する", () => {
    const source = deck(
      "",
      `%% macros:begin
\\def\\decksplit
{value}
%% macros:end`,
    );

    const diagnostics = lintDeck(parseDeck(source)).filter((entry) => entry.code === "L016");

    expect(diagnostics.map((entry) => sourceText(source, entry))).toEqual([
      "\\def\\decksplit\n{value}",
    ]);
  });

  it("複数 RawBlock にまたがる予約名本文の L016 span は閉じ括弧までを含む", () => {
    const source = deck(
      "",
      `%% macros:begin
\\def\\deckmultiline
{
  value
}
%% macros:end`,
    );

    const diagnostics = lintDeck(parseDeck(source)).filter((entry) => entry.code === "L016");

    expect(diagnostics.map((entry) => sourceText(source, entry))).toEqual([
      "\\def\\deckmultiline\n{\n  value\n}",
    ]);
  });

  it("複数 RawBlock にまたがる本文内の予約名らしい def は L016 として再走査しない", () => {
    const source = deck(
      "",
      `%% macros:begin
\\def\\ordinary
{
  \\gdef\\deckinside{}
}
%% macros:end`,
    );

    expect(lintDeck(parseDeck(source)).filter((entry) => entry.code === "L016")).toEqual([]);
  });

  it("raw の通常マクロ本文で構造化された予約名定義は top-level L016 として報告しない", () => {
    const source = deck(
      "",
      `%% macros:begin
\\def\\ordinary{
\\newcommand{\\deckinside}{value}
}
%% macros:end`,
    );

    expect(lintDeck(parseDeck(source)).filter((entry) => entry.code === "L016")).toEqual([]);
  });

  it("raw の予約名マクロ本文では内側を報告せず、外側だけを L016 で報告する", () => {
    const source = deck(
      "",
      `%% macros:begin
\\def\\deckouter{
\\newcommand{\\deckinside}{value}
}
%% macros:end`,
    );

    const diagnostics = lintDeck(parseDeck(source)).filter((entry) => entry.code === "L016");

    expect(diagnostics.map((entry) => sourceText(source, entry))).toEqual([
      "\\def\\deckouter{\n\\newcommand{\\deckinside}{value}\n}",
    ]);
  });

  it("pending primitive の後の構造化予約名は通常 lint し、後続の直接定義と別々に L016 を報告する", () => {
    const source = deck(
      "",
      `%% macros:begin
\\global
\\newcommand{\\deckinside}{value}
\\def\\deckouter{}
%% macros:end`,
    );

    const diagnostics = lintDeck(parseDeck(source)).filter((entry) => entry.code === "L016");

    expect(diagnostics.map((entry) => sourceText(source, entry))).toEqual([
      "\\newcommand{\\deckinside}{value}",
      "\\def\\deckouter{}",
    ]);
  });

  it("pending primitive は無関係な RawBlock で終了し、後続の直接定義へ持ち越さない", () => {
    const source = deck(
      "",
      `%% macros:begin
\\global
ordinary text
\\def\\deckouter{}
%% macros:end`,
    );

    const diagnostics = lintDeck(parseDeck(source)).filter((entry) => entry.code === "L016");

    expect(diagnostics.map((entry) => sourceText(source, entry))).toEqual(["\\def\\deckouter{}"]);
  });

  it("pending target の構造化予約名は抑制し、その後の top-level 定義は L016 で報告する", () => {
    const source = deck(
      "",
      `%% macros:begin
\\def
\\newcommand{\\deckinside}{value}
\\newcommand{\\decktop}{value}
%% macros:end`,
    );

    const diagnostics = lintDeck(parseDeck(source)).filter((entry) => entry.code === "L016");

    expect(diagnostics.map((entry) => sourceText(source, entry))).toEqual([
      "\\newcommand{\\decktop}{value}",
    ]);
  });

  it("body 未開始の後の構造化予約名は抑制し、その後の top-level 定義は L016 で報告する", () => {
    const source = deck(
      "",
      `%% macros:begin
\\def\\ordinary
\\newcommand{\\deckinside}{value}
\\newcommand{\\decktop}{value}
%% macros:end`,
    );

    const diagnostics = lintDeck(parseDeck(source)).filter((entry) => entry.code === "L016");

    expect(diagnostics.map((entry) => sourceText(source, entry))).toEqual([
      "\\newcommand{\\decktop}{value}",
    ]);
  });

  it("予約名本文の nested/comment/escaped braces を閉じ括弧として早期確定しない", () => {
    const source = deck(
      "",
      `%% macros:begin
\\def\\deckouter{
  {nested \\{ escaped} % } comment
  value
}
%% macros:end`,
    );

    const diagnostics = lintDeck(parseDeck(source)).filter((entry) => entry.code === "L016");

    expect(diagnostics.map((entry) => sourceText(source, entry))).toEqual([
      "\\def\\deckouter{\n  {nested \\{ escaped} % } comment\n  value\n}",
    ]);
  });

  it("本文を閉じた RawBlock の残りにある予約名定義を L016 で報告する", () => {
    const source = deck(
      "",
      `%% macros:begin
\\def\\ordinary
{value}\\xdef\\deckafter{}
%% macros:end`,
    );

    const diagnostics = lintDeck(parseDeck(source)).filter((entry) => entry.code === "L016");

    expect(diagnostics.map((entry) => sourceText(source, entry))).toEqual(["\\xdef\\deckafter{}"]);
  });

  it("定義本文内の予約名らしい def は L016 として再走査しない", () => {
    const source = deck(
      "",
      `%% macros:begin
\\def\\ordinary{\\gdef\\deckinside{}}\\def\\deckoutside{}
%% macros:end`,
    );

    const diagnostics = lintDeck(parseDeck(source)).filter((entry) => entry.code === "L016");

    expect(diagnostics.map((entry) => sourceText(source, entry))).toEqual(["\\def\\deckoutside{}"]);
  });

  it("複数RawBlockの定義はL001/L002を維持しL016を一度だけ報告する", () => {
    const source = deck(
      "",
      `%% macros:begin
\\global
\\def
\\deckfoo{}
%% macros:end`,
    );

    const diagnostics = lintDeck(parseDeck(source));

    expect(diagnostics.map((entry) => entry.code)).toEqual([
      "L001",
      "L002",
      "L016",
      "L001",
      "L002",
      "L001",
      "L002",
    ]);
    const diagnostic = diagnostics[2];
    if (diagnostic === undefined) throw new Error("expected an L016 diagnostic");
    expect(sourceText(source, diagnostic)).toBe("\\global\n\\def\n\\deckfoo{}");
  });

  it("通常の展開可能なマクロは L002/L016 の対象外", () => {
    const source = deck(
      "",
      `%% macros:begin
\\newcommand{\\ordinary}[1]{Hello, #1!}
%% macros:end`,
    );

    expect(
      lintDeck(parseDeck(source)).filter((entry) => entry.code === "L002" || entry.code === "L016"),
    ).toEqual([]);
  });

  it("同じマクロ定義の L002 と L016 を安定した順で報告する", () => {
    const source = deck(
      "",
      `%% macros:begin
\\newcommand{\\deckconditional}[1]{\\ifx#1x yes\\fi}
%% macros:end`,
    );

    const diagnostics = lintDeck(parseDeck(source));

    expect(diagnostics.map((entry) => entry.code)).toEqual(["L002", "L016"]);
    expect(diagnostics.map((entry) => entry.span)).toEqual([
      diagnostics[0]?.span,
      diagnostics[0]?.span,
    ]);
  });

  it("注入された fileExists で通常・ネスト画像とスタイルロゴを L004 として報告する", () => {
    const source = deck(
      `
\\begin{frame}{Images}
\\begin{center}\\includegraphics{missing-nested.png}\\end{center}
\\includegraphics{missing.png}
\\end{frame}`,
      `%% style:begin
\\decklogo[x=0,y=0,w=0.1]{missing-logo.png}
%% style:end`,
    );
    const fileExists = vi.fn(() => false);
    const diagnostics = lintDeck(parseDeck(source), { fileExists }).filter(
      (entry) => entry.code === "L004",
    );

    expect(diagnostics).toHaveLength(3);
    expect(fileExists.mock.calls.map(([path]) => path)).toEqual([
      "missing-logo.png",
      "missing-nested.png",
      "missing.png",
    ]);
    expect(diagnostics.map((entry) => sourceText(source, entry))).toEqual([
      "\\decklogo[x=0,y=0,w=0.1]{missing-logo.png}",
      "\\includegraphics{missing-nested.png}",
      "\\includegraphics{missing.png}",
    ]);
    expect(lintDeck(parseDeck(source)).some((entry) => entry.code === "L004")).toBe(false);
  });

  it("deckimage の形式と注入された寸法プローブを L015 で検査する", () => {
    const source = deck(`
\\begin{frame}[label=canvas]{Canvas}
\\begin{deckcanvas}
\\deckimage[x=0,y=0,w=1]{image.PNG}
\\deckimage[x=0,y=0,w=1]{image.svg}
\\end{deckcanvas}
\\end{frame}`);
    const diagnostics = lintDeck(parseDeck(source), {
      probeImage: () => ({
        ok: true,
        metadata: { format: "jpeg", dimensions: { width: 10, height: 10, unit: "px" } },
      }),
    }).filter((entry) => entry.code === "L015");

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((entry) => sourceText(source, entry))).toEqual([
      "\\deckimage[x=0,y=0,w=1]{image.PNG}",
      "\\deckimage[x=0,y=0,w=1]{image.svg}",
    ]);
  });

  it("deckimage は L004 の対象外で、L015 のプローブ契約を守る", () => {
    const source = deck(`
\\begin{frame}[label=canvas]{Canvas}
\\begin{deckcanvas}
\\deckimage[x=0,y=0,w=1]{image.png}
\\deckimage[x=0,y=0,w=1]{image.svg}
\\end{deckcanvas}
\\end{frame}`);
    const doc = parseDeck(source);
    const probeImage = vi.fn(() => ({
      ok: false as const,
      error: { code: "invalid-data" as const },
    }));

    expect(
      lintDeck(doc, { fileExists: () => false }).filter((entry) => entry.code === "L004"),
    ).toEqual([]);
    expect(lintDeck(doc).filter((entry) => entry.code === "L015")).toHaveLength(1);
    expect(lintDeck(doc, { probeImage }).filter((entry) => entry.code === "L015")).toHaveLength(2);
    expect(probeImage).toHaveBeenCalledTimes(1);
  });

  it("一致するプローブを受け入れ、不正な寸法を L015 で報告する", () => {
    const source = deck(`
\\begin{frame}[label=canvas]{Canvas}
\\begin{deckcanvas}
\\deckimage[x=0,y=0,w=1]{raw path.PNG}
\\end{deckcanvas}
\\end{frame}`);
    const doc = parseDeck(source);
    const matchingProbe = vi.fn(() => ({
      ok: true as const,
      metadata: {
        format: "png" as const,
        dimensions: { width: 10, height: 20, unit: "px" as const },
      },
    }));

    expect(
      lintDeck(doc, { probeImage: matchingProbe }).some((entry) => entry.code === "L015"),
    ).toBe(false);
    expect(matchingProbe).toHaveBeenCalledWith("raw path.PNG");
    for (const dimensions of [
      { width: 0, height: 1, unit: "px" as const },
      { width: Number.NaN, height: 1, unit: "px" as const },
      { width: Number.POSITIVE_INFINITY, height: 1, unit: "px" as const },
    ]) {
      expect(
        lintDeck(doc, {
          probeImage: () => ({ ok: true, metadata: { format: "png", dimensions } }),
        }).some((entry) => entry.code === "L015"),
      ).toBe(true);
    }
  });

  it("ネストされた canvas 内の deckimage も L015 で検査する", () => {
    const source = deck(`
\\begin{frame}{Nested}
\\begin{center}
\\begin{deckcanvas}
\\deckimage[x=0,y=0,w=1]{unsupported.svg}
\\end{deckcanvas}
\\end{center}
\\end{frame}`);

    expect(lintDeck(parseDeck(source)).filter((entry) => entry.code === "L015")).toEqual([
      expect.objectContaining({
        span: expect.objectContaining({ start: source.indexOf("\\deckimage") }),
      }),
    ]);
  });

  it("生ブロック化されたサブセット外構文を L001 で報告する", () => {
    const source = deck(`
\\begin{frame}{Raw}
\\unknowncommand{value}
\\end{frame}`);

    const diagnostic = lintDeck(parseDeck(source)).find((entry) => entry.code === "L001");

    expect(diagnostic).toMatchObject({ severity: "info" });
    expect(source.slice(diagnostic?.span.start, diagnostic?.span.end)).toContain(
      "\\unknowncommand",
    );
  });

  it("到達しないオーバーレイのステップを L005 で報告し、連続範囲は許可する", () => {
    const source = deck(`
\\begin{frame}{Overlay}
\\begin{itemize}
\\item<2> second
\\end{itemize}
\\end{frame}`);

    const diagnostics = lintDeck(parseDeck(source)).filter((entry) => entry.code === "L005");

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: "warning", span: expect.any(Object) });
    expect(
      lintDeck(parseDeck(source.replace("<2>", "<1->"))).some((entry) => entry.code === "L005"),
    ).toBe(false);
  });

  it("verbatim 系を fragile なしで使う frame を L007 で報告する", () => {
    const source = deck(`
\\begin{frame}{Code}
\\begin{verbatim}
code
\\end{verbatim}
\\end{frame}`);

    const diagnostic = lintDeck(parseDeck(source)).find((entry) => entry.code === "L007");

    expect(diagnostic).toMatchObject({ severity: "error" });
    expect(source.slice(diagnostic?.span.start, diagnostic?.span.end)).toContain(
      "\\begin{verbatim}",
    );
    expect(
      lintDeck(parseDeck(source.replace("\\begin{frame}", "\\begin{frame}[fragile]"))).some(
        (entry) => entry.code === "L007",
      ),
    ).toBe(false);
  });

  it("未知環境の生ブロック内にネストした verbatim 系も L007 で報告する", () => {
    const source = deck(`
\\begin{frame}{Code}
\\begin{adjustbox}{width=\\textwidth}
\\begin{verbatim}
code
\\end{verbatim}
\\end{adjustbox}
\\end{frame}`);

    const diagnostic = lintDeck(parseDeck(source)).find((entry) => entry.code === "L007");

    expect(diagnostic).toMatchObject({ severity: "error" });
    expect(source.slice(diagnostic?.span.start, diagnostic?.span.end)).toContain(
      "\\begin{adjustbox}",
    );
    expect(
      lintDeck(parseDeck(source.replace("\\begin{frame}", "\\begin{frame}[fragile]"))).some(
        (entry) => entry.code === "L007",
      ),
    ).toBe(false);
  });

  it("未知環境の生ブロック内で文字列化された verbatim 系は L007 の対象外", () => {
    for (const content of [
      "\\detokenize{before { \\begin{verbatim} } after}",
      "\\meaning\\begin{verbatim}",
    ]) {
      const source = deck(`
\\begin{frame}{Code}
\\begin{adjustbox}{width=\\textwidth}
${content}
\\end{adjustbox}
\\end{frame}`);

      expect(lintDeck(parseDeck(source)).some((entry) => entry.code === "L007")).toBe(false);
    }
  });

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
\\begin{decktext}[x=0.1,y=0.1,w=0.5]text\\end{decktext}
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

    expect(lintDeck(parseDeck(source))).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "L011" })]),
    );
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
\\begin{decktext}[x=0.1,y=0.1,w=0.5]text\\end{decktext}
\\end{deckcanvas}
\\end{frame}`,
    ).replace("aspectratio=169", "aspectratio=43");

    expect(lintDeck(parseDeck(source))).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "L018", severity: "warning" })]),
    );
  });

  it("キャンバス座標の範囲外を L012 で報告し、境界上は許可する", () => {
    const outOfBounds = deck(`
\\begin{frame}[label=canvas]{Canvas}
\\begin{deckcanvas}
\\deckimage[x=0.8,y=1,w=0.3]{image.png}
\\end{deckcanvas}
\\end{frame}`);
    const valid = outOfBounds.replace("x=0.8,y=1,w=0.3", "x=0,y=0,w=1");

    const diagnostic = lintDeck(parseDeck(outOfBounds)).find((entry) => entry.code === "L012");

    expect(diagnostic).toMatchObject({ severity: "warning" });
    expect(sourceText(outOfBounds, diagnostic)).toBe("[x=0.8,y=1,w=0.3]");
    expect(lintDeck(parseDeck(valid)).some((entry) => entry.code === "L012")).toBe(false);
  });

  it("許可外の decktext サイズを L013 で報告し、許可値は報告しない", () => {
    const invalid = deck(`
\\begin{frame}[label=canvas]{Canvas}
\\begin{deckcanvas}
\\begin{decktext}[x=0,y=0,w=1,size=huge]text\\end{decktext}
\\end{deckcanvas}
\\end{frame}`);
    const valid = invalid.replace("size=huge", "size=Large");

    const diagnostic = lintDeck(parseDeck(invalid)).find((entry) => entry.code === "L013");

    expect(diagnostic).toMatchObject({ severity: "error" });
    expect(sourceText(invalid, diagnostic)).toBe("huge");
    expect(lintDeck(parseDeck(valid)).some((entry) => entry.code === "L013")).toBe(false);
  });

  it("L013 は size=size の値側だけを指す", () => {
    const source = deck(`
\\begin{frame}[label=canvas]{Canvas}
\\begin{deckcanvas}
\\begin{decktext}[x=0,y=0,w=1,size=size]text\\end{decktext}
\\end{deckcanvas}
\\end{frame}`);
    const diagnostic = lintDeck(parseDeck(source)).find((entry) => entry.code === "L013");
    const optionStart = source.indexOf("size=size");

    expect(sourceText(source, diagnostic)).toBe("size");
    expect(diagnostic?.span.start).toBe(optionStart + "size=".length);
  });

  it("キャンバス直下・decktext 内の許可外要素を L014 で報告する", () => {
    const source = deck(`
\\begin{frame}[label=canvas]{Canvas}
ordinary flow
\\begin{deckcanvas}
\\pause
\\begin{decktext}[x=0,y=0,w=1]
\\begin{block}{not allowed}text\\end{block}
\\end{decktext}
\\end{deckcanvas}
\\end{frame}`);

    const diagnostics = lintDeck(parseDeck(source)).filter((entry) => entry.code === "L014");

    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.every((entry) => entry.span.end > entry.span.start)).toBe(true);
  });

  it("decktext 内の list item オーバーレイを L014 で指定箇所に報告する", () => {
    const source = deck(`
\\begin{frame}[label=canvas]{Canvas}
\\begin{deckcanvas}
\\begin{decktext}[x=0,y=0,w=1]
\\begin{itemize}\\item<2-> delayed\\end{itemize}
\\end{decktext}
\\end{deckcanvas}
\\end{frame}`);

    const diagnostic = lintDeck(parseDeck(source)).find(
      (entry) => entry.code === "L014" && entry.message.includes("オーバーレイ"),
    );

    expect(sourceText(source, diagnostic)).toBe("<2->");
  });

  it("明示改行を含むキャンバスフレームのタイトルを L019 で報告する", () => {
    const source = deck(`
\\begin{frame}[label=canvas]{First line\\\\Second line}
\\begin{deckcanvas}
\\deckimage[x=0,y=0,w=1]{image.png}
\\end{deckcanvas}
\\end{frame}`);

    const diagnostic = lintDeck(parseDeck(source)).find((entry) => entry.code === "L019");

    expect(diagnostic).toMatchObject({ severity: "warning" });
    expect(sourceText(source, diagnostic)).toBe("First line\\\\Second line");
  });

  it("装飾コマンドの内側の改行もキャンバスタイトルの L019 で報告する", () => {
    const source = deck(`
\\begin{frame}[label=canvas]{\\textbf{First\\\\Second}}
\\begin{deckcanvas}
\\deckimage[x=0,y=0,w=1]{image.png}
\\end{deckcanvas}
\\end{frame}`);

    expect(lintDeck(parseDeck(source)).some((entry) => entry.code === "L019")).toBe(true);
  });

  it("生フレーム内の verbatim 系を fragile なしで使う場合も L007 を報告する", () => {
    const source = deck(`
\\begin{frame}[shrink=5]{Raw}
% \\begin{verbatim} commented out
\\begin{verbatim}
code
\\end{verbatim}
\\end{frame}`);
    const fragile = source.replace("shrink=5", "shrink=5,fragile=singleslide");

    expect(lintDeck(parseDeck(source)).some((entry) => entry.code === "L007")).toBe(true);
    expect(lintDeck(parseDeck(fragile)).some((entry) => entry.code === "L007")).toBe(false);
  });

  it("RawFrame 内の \\string で表した verbatim 環境名は L007 の対象外", () => {
    for (const stringified of ["\\string\\begin{verbatim}", "\\string \\begin{verbatim}"]) {
      const source = deck(`
\\begin{frame}[shrink=5]{Raw}
\\texttt{${stringified}}
\\end{frame}`);

      expect(lintDeck(parseDeck(source)).some((entry) => entry.code === "L007")).toBe(false);
    }
  });

  it("RawFrame 内の二重バックスラッシュ後の begin は L007 の対象外", () => {
    const source = deck(`
\\begin{frame}[shrink=5]{Raw}
\\\\begin{verbatim}
\\end{frame}`);

    expect(lintDeck(parseDeck(source)).some((entry) => entry.code === "L007")).toBe(false);
  });

  it("style領域の未知の記述を L020 で報告する", () => {
    const source = deck(
      "",
      `%% style:begin
\\deckunknown{value}
%% style:end`,
    );

    const diagnostics = lintDeck(parseDeck(source));

    expect(diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "L020", severity: "error" })]),
    );
    const styleDiagnostic = diagnostics.find((entry) => entry.code === "L020");
    expect(source.slice(styleDiagnostic?.span.start, styleDiagnostic?.span.end)).toBe(
      "\\deckunknown{value}",
    );
  });

  it("対応範囲の正常なデッキには診断を返さない", () => {
    const source = deck(`
\\begin{frame}[label=canvas]{Canvas}
\\begin{deckcanvas}
\\begin{decktext}[x=0.1,y=0.1,w=0.5]text\\end{decktext}
\\end{deckcanvas}
\\end{frame}`);

    expect(lintDeck(parseDeck(source))).toEqual([]);
  });

  it("呼び出し側が期待するsource versionを指定できる", () => {
    const source = deck("").replace("deck-source-version: 1", "deck-source-version: 2");

    expect(lintDeck(parseDeck(source), { expectedSourceVersion: 2 })).toEqual([]);
  });

  it("既存 fixture では新規規則の誤検出がない", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const fixtureNames = [
      "basic.tex",
      "macros.tex",
      "kitchen-sink.tex",
      "canvas.tex",
      "styled.tex",
      "japanese.tex",
    ];
    const newCodes = new Set(["L005", "L007", "L012", "L013", "L014", "L019"]);

    const fixturesWithRawSyntax = new Set(["macros.tex", "kitchen-sink.tex"]);
    for (const name of fixtureNames) {
      const source = await readFile(join(__dirname, "../../../fixtures", name), "utf8");
      const expectedCodes = name === "canvas.tex" ? ["L012"] : [];
      expect(
        lintDeck(parseDeck(source))
          .filter((entry) => newCodes.has(entry.code))
          .map((entry) => entry.code),
      ).toEqual(expectedCodes);
      expect(lintDeck(parseDeck(source)).some((entry) => entry.code === "L001")).toBe(
        fixturesWithRawSyntax.has(name),
      );
    }
  });

  it("静的 lint 規則の検出は専用 fixture でも担保する", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const source = await readFile(join(__dirname, "../../../fixtures/lint-static.tex"), "utf8");
    const codes = new Set(lintDeck(parseDeck(source)).map((entry) => entry.code));

    for (const code of ["L001", "L005", "L007", "L012", "L013", "L014", "L019"]) {
      expect(codes).toContain(code);
    }
  });
});

function sourceText(
  source: string,
  diagnostic: { span: { start: number; end: number } } | undefined,
): string {
  if (!diagnostic) throw new Error("expected diagnostic");
  return source.slice(diagnostic.span.start, diagnostic.span.end);
}
