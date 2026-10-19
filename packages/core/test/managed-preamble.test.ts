import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MANAGED_PREAMBLE_RESOURCES } from "../src/generated-managed-preamble.js";
import {
  type LintFix,
  lintSource,
  locateManagedPreamble,
  MANAGED_PREAMBLE_BEGIN,
  MANAGED_PREAMBLE_END,
  managedPreambleBlock,
  managedPreambleReplacement,
  parseDeck,
} from "../src/index.js";

const resource = (name: string) =>
  readFileSync(new URL(`../resources/${name}`, import.meta.url), "utf8");
/** `\deckbackground` を足す前(main 時点)の deck-style-preamble.tex。 */
const styleBeforeBackground = readFileSync(
  new URL("./resources/deck-style-preamble.before-background.tex", import.meta.url),
  "utf8",
);

/** `deck init` が書く形のデッキ。管理プリアンブルの中身と style 領域を差し替えられる。 */
function initDeck(managed: string, style: string): string {
  return `\\documentclass[aspectratio=169]{beamer}
%% deck-source-version: 1
${managed}

%% macros:begin
%% macros:end

%% style:begin
${style}
%% style:end

%% preamble-extra:begin
%% preamble-extra:end

\\title{T}

\\begin{document}

\\begin{frame}[label=title]
  \\titlepage
\\end{frame}

\\end{document}
`;
}

/** 古い `deck init` が書いた管理プリアンブル(header / canvas は変わっていない)。 */
const oldManaged = [
  MANAGED_PREAMBLE_BEGIN,
  [resource("deck-managed-header.tex"), resource("deck-canvas-preamble.tex"), styleBeforeBackground]
    .join("\n")
    .trimEnd(),
  MANAGED_PREAMBLE_END,
].join("\n");
const BACKGROUNDS = "\\deckbackground{assets/bg.png}\n\\deckbackground[title]{assets/title.png}";

/** 範囲を特定できたときの位置(できなければ null)。 */
const spanOf = (source: string, preambleEnd?: number) => {
  const located = locateManagedPreamble(source, preambleEnd);
  return "span" in located ? located.span : null;
};
/** --update-preamble / L025 の fix と同じ差し替え(範囲を特定できなければ null)。 */
const updateOf = (source: string) => {
  const span = spanOf(source);
  return span === null ? null : managedPreambleReplacement(source, span);
};
const apply = (source: string, fix: LintFix) =>
  source.slice(0, fix.span.start) + fix.replacement + source.slice(fix.span.end);
const l025 = (source: string) => lintSource(source).filter((entry) => entry.code === "L025");

describe("managedPreambleBlock", () => {
  it("生成済みの定数が resources の 3 ファイルと一致する(pnpm build:skills)", () => {
    expect(MANAGED_PREAMBLE_RESOURCES).toEqual({
      "deck-managed-header.tex": resource("deck-managed-header.tex"),
      "deck-canvas-preamble.tex": resource("deck-canvas-preamble.tex"),
      "deck-style-preamble.tex": resource("deck-style-preamble.tex"),
    });
  });

  it("印で挟んだ 3 リソースの展開で、現行の \\deckbackground を定義している", () => {
    const block = managedPreambleBlock();
    expect(block.startsWith(`${MANAGED_PREAMBLE_BEGIN}\n\\usetheme{default}`)).toBe(true);
    expect(block.endsWith(`\\makeatother\n${MANAGED_PREAMBLE_END}`)).toBe(true);
    expect(block).toContain("\\newcommand\\deckbackground");
  });
});

describe("lintSource: L025(管理プリアンブルが使っているマクロより古い)", () => {
  it("古い管理プリアンブル + \\deckbackground は、エントリごとに error と差し替えの fix を出す", () => {
    const source = initDeck(oldManaged, `\\deckcolor{structure}{0F62FE}\n${BACKGROUNDS}`);
    const found = l025(source);
    expect(found.map((entry) => source.slice(entry.span.start, entry.span.end))).toEqual([
      "\\deckbackground{assets/bg.png}",
      "\\deckbackground[title]{assets/title.png}",
    ]);
    for (const entry of found) {
      expect(entry.severity).toBe("error");
      expect(entry.message).toContain("deck init <file> --update-preamble");
      expect(entry.fix).toEqual(updateOf(source));
    }
  });

  it("fix を当てると管理プリアンブルだけが現行になり、L025 は消える", () => {
    const source = initDeck(oldManaged, BACKGROUNDS);
    const fix = l025(source)[0]?.fix;
    if (fix === undefined) throw new Error("fix expected");
    const fixed = apply(source, fix);
    expect(fixed).toBe(initDeck(managedPreambleBlock(), BACKGROUNDS));
    const span = spanOf(source);
    expect(fixed.slice(0, span?.start)).toBe(source.slice(0, span?.start));
    expect(fixed.slice(fixed.length - (source.length - (span?.end ?? 0)))).toBe(
      source.slice(span?.end),
    );
    expect(lintSource(fixed)).toEqual([]);
    // 2 回目は変化しない。
    const again = updateOf(fixed);
    expect(again && apply(fixed, again)).toBe(fixed);
  });

  it("現行の管理プリアンブルと \\input 形式には出さない", () => {
    expect(l025(initDeck(managedPreambleBlock(), BACKGROUNDS))).toEqual([]);
    // 改行コードと開始行の文言の違いは見ない。
    expect(l025(initDeck(managedPreambleBlock(), BACKGROUNDS).replaceAll("\n", "\r\n"))).toEqual(
      [],
    );
    expect(
      l025(
        initDeck(
          managedPreambleBlock().replace(
            MANAGED_PREAMBLE_BEGIN,
            "% ---- ツール管理プリアンブル ----",
          ),
          BACKGROUNDS,
        ),
      ),
    ).toEqual([]);
    const input = [
      "% ---- ツール管理プリアンブル ----",
      "\\input{../packages/core/resources/deck-managed-header}",
      "\\input{deck-canvas-preamble}",
      "\\input{deck-style-preamble.tex}",
      MANAGED_PREAMBLE_END,
    ].join("\n");
    expect(l025(initDeck(input, BACKGROUNDS))).toEqual([]);
    const fixture = readFileSync(
      new URL("../../../fixtures/styled.slide.tex", import.meta.url),
      "utf8",
    );
    expect(fixture).toContain("\\deckbackground");
    expect(l025(fixture)).toEqual([]);
  });

  it("使う機能が揃っていても、中身が現行と違えば開始行に warning と差し替えの fix を出す", () => {
    const source = initDeck(oldManaged, "\\deckcolor{structure}{0F62FE}");
    const found = l025(source);
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("warning");
    expect(source.slice(found[0]?.span.start, found[0]?.span.end)).toBe(MANAGED_PREAMBLE_BEGIN);
    expect(found[0]?.fix).toEqual(updateOf(source));
    // 既存のマクロの中身だけを手で変えた場合も同じ。
    const edited = initDeck(
      managedPreambleBlock().replace("\\setbeamertemplate{navigation symbols}{}", ""),
      "",
    );
    expect(l025(edited).map((entry) => entry.severity)).toEqual(["warning"]);
  });

  it("管理プリアンブルへ後から足した命令・環境は、対応表なしで使う位置に error を出す", () => {
    // \deckfooter の定義が無い管理プリアンブル(\deckfooter を足す前の版を模す)。
    const withoutFooter = managedPreambleBlock().replace(
      "\\newcommand\\deckfooter",
      "\\newcommand\\deckfooterOld",
    );
    expect(withoutFooter).not.toBe(managedPreambleBlock());
    const footer = initDeck(withoutFooter, "\\deckfooter{left}");
    expect(
      l025(footer).map((entry) => [entry.severity, footer.slice(entry.span.start, entry.span.end)]),
    ).toEqual([["error", "\\deckfooter{left}"]]);
    // canvas の定義が無い管理プリアンブルで deckcanvas を使う。
    const withoutCanvas = [
      MANAGED_PREAMBLE_BEGIN,
      [resource("deck-managed-header.tex"), resource("deck-style-preamble.tex")]
        .join("\n")
        .trimEnd(),
      MANAGED_PREAMBLE_END,
    ].join("\n");
    const canvas = initDeck(withoutCanvas, "").replace(
      "\\end{document}",
      "\\begin{frame}[label=c]\n\\begin{deckcanvas}\n\\deckimage[x=0,y=0,w=0.5]{a.png}\n\\end{deckcanvas}\n\\end{frame}\n\\end{document}",
    );
    expect(
      l025(canvas).map((entry) => [entry.severity, canvas.slice(entry.span.start, entry.span.end)]),
    ).toEqual([
      ["error", "\\begin{deckcanvas}"],
      ["error", "\\deckimage"],
    ]);
  });

  it("使う位置より後ろにある定義は数えない", () => {
    // preamble-extra の後ろ(ユーザー領域の外)に定義を足しても、style の \deckbackground の時点では未定義。
    const source = initDeck(oldManaged, BACKGROUNDS).replace(
      "%% preamble-extra:end\n",
      "%% preamble-extra:end\n\\newcommand\\deckbackground[2][]{}\n",
    );
    expect(l025(source).map((entry) => entry.severity)).toEqual(["error", "error"]);
  });

  it("deck init 直後のデッキと fixture には出さない", () => {
    expect(l025(initDeck(managedPreambleBlock(), ""))).toEqual([]);
    for (const name of [
      "basic",
      "canvas",
      "canvas-math",
      "japanese",
      "kitchen-sink",
      "macros",
      "measure-body-area",
      "styled",
      "templated",
    ]) {
      const fixture = readFileSync(
        new URL(`../../../fixtures/${name}.slide.tex`, import.meta.url),
        "utf8",
      );
      expect(l025(fixture), name).toEqual([]);
    }
    // lint-static は管理プリアンブルを持たずにキャンバスを使うので、PDF は止まる。
    const lintStatic = readFileSync(
      new URL("../../../fixtures/lint-static.slide.tex", import.meta.url),
      "utf8",
    );
    expect(new Set(l025(lintStatic).map((entry) => entry.severity))).toEqual(new Set(["error"]));
  });

  it("ユーザー領域やコメントにある定義は数えない", () => {
    const definition = "\\newcommand\\deckbackground[2][]{}";
    const inMacros = initDeck(oldManaged, BACKGROUNDS).replace(
      "%% macros:begin\n",
      `%% macros:begin\n${definition}\n`,
    );
    expect(l025(inMacros)).toHaveLength(2);
    const commented = initDeck(
      oldManaged.replace(MANAGED_PREAMBLE_END, `% ${definition}\n$&`),
      BACKGROUNDS,
    );
    expect(l025(commented)).toHaveLength(2);
  });

  it("印も定義も無いデッキでも、現行の命令を使っていれば fix なしの error を出す", () => {
    // deck init を通さずに書いたデッキ。PDF は Undefined control sequence で止まる。
    const source = [
      "\\documentclass[aspectratio=169]{beamer}",
      "%% deck-source-version: 1",
      "%% style:begin",
      "\\deckbackground{bg.png}",
      "%% style:end",
      "\\begin{document}",
      "\\begin{frame}{T}x\\end{frame}",
      "\\end{document}",
      "",
    ].join("\n");
    const found = l025(source);
    expect(found.map((entry) => entry.severity)).toEqual(["error"]);
    expect(found[0]?.fix).toBeUndefined();
    expect(found[0]?.message).toContain("範囲を特定できないため自動では直せません(開始印");
    // deck の語彙を使わない普通の Beamer 文書には出さない。
    expect(l025(source.replace("\\deckbackground{bg.png}\n", ""))).toEqual([]);
  });

  it("verbatim・\\verb・\\string の中の \\deckX は使用と数えない", () => {
    const withBody = (body: string) =>
      initDeck(oldManaged, "").replace(
        "\\begin{frame}[label=title]\n  \\titlepage",
        `\\begin{frame}[fragile,label=title]\n${body}`,
      );
    const quoted = withBody(
      [
        "\\begin{verbatim}\\deckbackground{x}\\end{verbatim}",
        "\\verb|\\deckbackground|",
        "\\texttt{\\string\\deckbackground}",
      ].join("\n"),
    );
    // 中身が現行と違う warning だけで、使用の error は出ない。
    expect(l025(quoted).map((entry) => entry.severity)).toEqual(["warning"]);
    expect(l025(withBody("\\deckbackground{x}")).map((entry) => entry.severity)).toEqual(["error"]);
  });

  it("\\DeclareRobustCommand と \\let の定義も数える", () => {
    for (const definition of [
      "\\DeclareRobustCommand\\deckbackground[2][]{}",
      "\\let\\deckbackground\\relax",
    ]) {
      const managed = oldManaged.replace(
        `\n${MANAGED_PREAMBLE_END}`,
        `\n${definition}\n${MANAGED_PREAMBLE_END}`,
      );
      expect(
        l025(initDeck(managed, BACKGROUNDS)).map((entry) => entry.severity),
        definition,
      ).toEqual(["warning"]);
    }
  });

  it("中身の比較では、コメントと空行の違いを見ない(命令の違いは見る)", () => {
    const block = managedPreambleBlock();
    const comment = block
      .split("\n")
      .find(
        (line) =>
          line.startsWith("%") && line !== MANAGED_PREAMBLE_BEGIN && line !== MANAGED_PREAMBLE_END,
      );
    if (comment === undefined) throw new Error("管理プリアンブルにコメント行が無い");
    expect(l025(initDeck(block.replace(comment, "% 別のコメント"), ""))).toEqual([]);
    expect(
      l025(
        initDeck(block.replace(`${MANAGED_PREAMBLE_BEGIN}\n`, `${MANAGED_PREAMBLE_BEGIN}\n\n`), ""),
      ),
    ).toEqual([]);
    expect(
      l025(initDeck(block.replace("\\setbeamertemplate{navigation symbols}{}", "\\relax"), "")).map(
        (entry) => entry.severity,
      ),
    ).toEqual(["warning"]);
  });

  it("CRLF のデッキでは、warning の範囲を開始行の \\r の手前で止める", () => {
    const source = initDeck(oldManaged, "").replaceAll("\n", "\r\n");
    const found = l025(source);
    expect(found.map((entry) => entry.severity)).toEqual(["warning"]);
    const span = found[0]?.span;
    expect(source.slice(span?.start, span?.end)).toBe(MANAGED_PREAMBLE_BEGIN);
    expect(source[span?.end ?? 0]).toBe("\r");
  });

  it("印が無いデッキは fix を付けず、自動では直せないと伝える", () => {
    const source = initDeck(
      oldManaged
        .replace(`${MANAGED_PREAMBLE_BEGIN}\n`, "")
        .replace(`\n${MANAGED_PREAMBLE_END}`, ""),
      BACKGROUNDS,
    );
    const found = l025(source);
    expect(found).toHaveLength(2);
    expect(found[0]?.fix).toBeUndefined();
    expect(found[0]?.message).toContain("自動では直せません");
  });
});

describe("locateManagedPreamble: 終了印を探す範囲", () => {
  const withoutEnd = oldManaged.replace(`\n${MANAGED_PREAMBLE_END}`, "");

  it("終了印が消え、preamble-extra に終了印の行があるデッキは差し替えない(fix も出さない)", () => {
    const source = initDeck(withoutEnd, BACKGROUNDS).replace(
      "%% preamble-extra:begin\n",
      `%% preamble-extra:begin\n${MANAGED_PREAMBLE_END}\n`,
    );
    expect(spanOf(source)).toBeNull();
    expect(updateOf(source)).toBeNull();
    expect(l025(source).map((entry) => entry.fix)).toEqual([undefined, undefined]);
  });

  it("終了印が %% macros:begin より後ろにあるデッキは差し替えない", () => {
    const source = initDeck(withoutEnd, BACKGROUNDS).replace(
      "%% macros:end\n",
      `%% macros:end\n${MANAGED_PREAMBLE_END}\n`,
    );
    expect(spanOf(source)).toBeNull();
  });

  it("終了印が \\begin{document} より後ろにしか無いデッキは差し替えない", () => {
    const source = initDeck(withoutEnd, BACKGROUNDS)
      .replace(/%% (macros|style|preamble-extra):(begin|end)\n/g, "")
      .replace("\\begin{document}\n", `\\begin{document}\n${MANAGED_PREAMBLE_END}\n`);
    expect(spanOf(source)).toBeNull();
  });

  it("プリアンブルに開始印が 2 つあるデッキは差し替えない", () => {
    const source = initDeck(oldManaged, BACKGROUNDS).replace(
      "%% preamble-extra:begin\n",
      `%% preamble-extra:begin\n${MANAGED_PREAMBLE_BEGIN}\n`,
    );
    expect(spanOf(source)).toBeNull();
  });

  it("特定できない理由を場合ごとに返し、L025 のメッセージにも入れる", () => {
    const problem = (source: string) => {
      const located = locateManagedPreamble(source);
      return "problem" in located ? located.problem : null;
    };
    const noBegin = initDeck(oldManaged.replace(`${MANAGED_PREAMBLE_BEGIN}\n`, ""), BACKGROUNDS);
    const noEnd = initDeck(withoutEnd, BACKGROUNDS);
    const late = noEnd.replace("%% macros:end\n", `%% macros:end\n${MANAGED_PREAMBLE_END}\n`);
    const twice = initDeck(oldManaged, BACKGROUNDS).replace(
      "%% preamble-extra:begin\n",
      `%% preamble-extra:begin\n${MANAGED_PREAMBLE_BEGIN}\n`,
    );
    expect(problem(noBegin)).toContain("開始印");
    expect(problem(noEnd)).toBe(`終了印(「${MANAGED_PREAMBLE_END}」)がありません`);
    expect(problem(late)).toContain("より後ろにあります");
    expect(problem(twice)).toBe("開始印がプリアンブルに複数あります");
    // 印の順序が逆(終了印が開始印より前)。
    const reversed = initDeck(`${MANAGED_PREAMBLE_END}\n${withoutEnd}`, BACKGROUNDS);
    expect(problem(reversed)).toBe("終了印が開始印より前にあります");
    expect(problem(initDeck(oldManaged, BACKGROUNDS))).toBeNull();
    expect(l025(late)[0]?.message).toContain(
      `範囲を特定できないため自動では直せません(${problem(late)})`,
    );
  });

  it("(a) %% macros:end の綴りが違い、マクロの後ろに終了印を貼り付けたデッキは差し替えない", () => {
    const source = initDeck(withoutEnd, BACKGROUNDS).replace(
      "%% macros:begin\n%% macros:end\n",
      `%% macros:begin\n\\newcommand{\\R}{\\mathbb{R}}\n%% macro:end\n${MANAGED_PREAMBLE_END}\n`,
    );
    expect(spanOf(source)).toBeNull();
    expect(l025(source).map((entry) => entry.fix)).toEqual([undefined, undefined]);
  });

  it("(b) 管理プリアンブルより前のコメントに %% macros:begin があり、本物のマクロ領域の後ろに終了印があるデッキは差し替えない", () => {
    const source = initDeck(withoutEnd, BACKGROUNDS)
      .replace(
        "%% deck-source-version: 1\n",
        "%% deck-source-version: 1\n% メモ: %% macros:begin の下に書く\n",
      )
      .replace("%% macros:end\n", `%% macros:end\n${MANAGED_PREAMBLE_END}\n`);
    expect(spanOf(source)).toBeNull();
    expect(l025(source).map((entry) => entry.fix)).toEqual([undefined, undefined]);
  });

  it("コメントの中の印でも止まって書き換えない", () => {
    const source = initDeck(
      oldManaged.replace(
        `\n${MANAGED_PREAMBLE_END}`,
        `\n% 利用者のマクロは %% macros:begin の下へ\n${MANAGED_PREAMBLE_END}`,
      ),
      BACKGROUNDS,
    );
    // parser はこのコメントの位置から %% macros 領域を始める。管理プリアンブルの範囲もそこまでに限る。
    expect(parseDeck(source).macros.span.start).toBe(
      source.indexOf("% 利用者のマクロは") + "% 利用者のマクロは %% macros:begin の下へ\n".length,
    );
    expect(updateOf(source)).toBeNull();
  });

  it("parse 済みのプリアンブルの終わりを渡しても同じ結果になる", () => {
    const source = initDeck(oldManaged, BACKGROUNDS);
    expect(spanOf(source, source.indexOf("\\begin{document}"))).toEqual(spanOf(source));
  });
});

describe("managedPreambleReplacement", () => {
  it("開始行の文言を問わず、終了行までを差し替える。印が欠ければ null", () => {
    const source = initDeck(
      oldManaged.replace(MANAGED_PREAMBLE_BEGIN, "% ---- ツール管理プリアンブル ----"),
      "",
    );
    const fix = updateOf(source);
    expect(fix && apply(source, fix)).toBe(initDeck(managedPreambleBlock(), ""));
    expect(updateOf(source.replace(MANAGED_PREAMBLE_END, "% end"))).toBeNull();
    expect(updateOf(source.replace("% ---- ツール管理プリアンブル ----", "% begin"))).toBeNull();
  });

  it("CRLF のデッキは差し替え後も CRLF にそろえる", () => {
    const source = initDeck(oldManaged, BACKGROUNDS).replaceAll("\n", "\r\n");
    const fix = updateOf(source);
    if (fix === null) throw new Error("fix expected");
    const fixed = apply(source, fix);
    expect(fixed).toBe(initDeck(managedPreambleBlock(), BACKGROUNDS).replaceAll("\n", "\r\n"));
    expect(fixed.replaceAll("\r\n", "")).not.toContain("\n");
  });
});
