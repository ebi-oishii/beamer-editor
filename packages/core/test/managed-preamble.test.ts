import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MANAGED_PREAMBLE_RESOURCES } from "../src/generated-managed-preamble.js";
import {
  type LintFix,
  lintSource,
  MANAGED_PREAMBLE_BEGIN,
  MANAGED_PREAMBLE_END,
  managedPreambleBlock,
  managedPreambleSpan,
  managedPreambleUpdate,
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
      expect(entry.fix).toEqual(managedPreambleUpdate(source));
    }
  });

  it("fix を当てると管理プリアンブルだけが現行になり、L025 は消える", () => {
    const source = initDeck(oldManaged, BACKGROUNDS);
    const fix = l025(source)[0]?.fix;
    if (fix === undefined) throw new Error("fix expected");
    const fixed = apply(source, fix);
    expect(fixed).toBe(initDeck(managedPreambleBlock(), BACKGROUNDS));
    const span = managedPreambleSpan(source);
    expect(fixed.slice(0, span?.start)).toBe(source.slice(0, span?.start));
    expect(fixed.slice(fixed.length - (source.length - (span?.end ?? 0)))).toBe(
      source.slice(span?.end),
    );
    expect(lintSource(fixed)).toEqual([]);
    // 2 回目は変化しない。
    const again = managedPreambleUpdate(fixed);
    expect(again && apply(fixed, again)).toBe(fixed);
  });

  it("現行の管理プリアンブル・\\input 形式・背景を使わない古いデッキには出さない", () => {
    expect(l025(initDeck(managedPreambleBlock(), BACKGROUNDS))).toEqual([]);
    expect(l025(initDeck(oldManaged, "\\deckcolor{structure}{0F62FE}"))).toEqual([]);
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

describe("managedPreambleUpdate", () => {
  it("開始行の文言を問わず、終了行までを差し替える。印が欠ければ null", () => {
    const source = initDeck(
      oldManaged.replace(MANAGED_PREAMBLE_BEGIN, "% ---- ツール管理プリアンブル ----"),
      "",
    );
    const fix = managedPreambleUpdate(source);
    expect(fix && apply(source, fix)).toBe(initDeck(managedPreambleBlock(), ""));
    expect(managedPreambleUpdate(source.replace(MANAGED_PREAMBLE_END, "% end"))).toBeNull();
    expect(
      managedPreambleUpdate(source.replace("% ---- ツール管理プリアンブル ----", "% begin")),
    ).toBeNull();
  });

  it("CRLF のデッキは差し替え後も CRLF にそろえる", () => {
    const source = initDeck(oldManaged, BACKGROUNDS).replaceAll("\n", "\r\n");
    const fix = managedPreambleUpdate(source);
    if (fix === null) throw new Error("fix expected");
    const fixed = apply(source, fix);
    expect(fixed).toBe(initDeck(managedPreambleBlock(), BACKGROUNDS).replaceAll("\n", "\r\n"));
    expect(fixed.replaceAll("\r\n", "")).not.toContain("\n");
  });
});
