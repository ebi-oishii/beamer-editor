import { describe, expect, it } from "vitest";
import { deckCompletionsAt } from "../src/deck-completion";

/** マーカー `|` の位置で補完を求め、候補のラベルと置き換える文字列を返す。 */
function complete(text: string) {
  const offset = text.indexOf("|");
  if (offset < 0) throw new Error("cursor marker missing");
  const source = text.slice(0, offset) + text.slice(offset + 1);
  const completions = deckCompletionsAt(source, offset);
  return {
    labels: completions.map((completion) => completion.label),
    replaced: completions.map((completion) =>
      source.slice(completion.range.start, completion.range.end),
    ),
    completions,
  };
}

describe("deckCompletionsAt", () => {
  it("`\\begin{` の後で deck の環境を出し、自動で閉じた `}` も置き換える", () => {
    const result = complete("  \\begin{deck|}");
    expect(result.labels).toEqual(["deckcanvas", "decktext"]);
    expect(result.replaced).toEqual(["deck}", "deck}"]);
    const decktext = result.completions.find((completion) => completion.label === "decktext");
    expect(decktext?.snippet).toContain(
      `[x=\${1:0.100},y=\${2:0.100},w=\${3:0.400},size=\${4|normal,`,
    );
    expect(decktext?.snippet).toContain("\\end{decktext}");
  });

  it("`\\` から始まる命令名で deck の命令を出し、置き換えは `\\` から", () => {
    for (const typed of ["\\", "\\d", "\\deck", "\\deckim"]) {
      const result = complete(`text ${typed}|`);
      expect(result.labels).toContain("\\deckimage");
      expect(result.labels).toContain("\\deckcolor");
      expect(result.replaced[0]).toBe(typed);
    }
    expect(complete("\\section|").labels).toEqual([]);
  });

  it("decktext のオプションでは書いていないキーだけを出す", () => {
    expect(complete("\\begin{decktext}[|").labels).toEqual(["x", "y", "w", "size"]);
    const result = complete("\\begin{decktext}[x=0.100, w|");
    expect(result.labels).toEqual(["y", "w", "size"]);
    expect(result.replaced[0]).toBe("w");
    expect(complete("\\deckimage[|").labels).toEqual(["x", "y", "w"]);
    expect(complete("\\decklogo[x=0.9,|").labels).toEqual(["y", "w"]);
    expect(complete("\\deckbackground[|").labels).toEqual(["title"]);
  });

  it("`size=` の後で文字サイズを出し、キーの選択後は続けて候補を出す", () => {
    const result = complete("\\begin{decktext}[x=0.1,size=sm|]");
    expect(result.labels).toEqual([
      "tiny",
      "scriptsize",
      "footnotesize",
      "small",
      "normal",
      "large",
      "Large",
    ]);
    expect(result.replaced[0]).toBe("sm");
    const size = complete("\\begin{decktext}[|").completions.find((c) => c.label === "size");
    expect(size?.retrigger).toBe(true);
    // 数値のキーには値の候補を出さない。
    expect(complete("\\begin{decktext}[x=|").labels).toEqual([]);
  });

  it("`\\deckcolor{` と `\\deckfont{` の 1 つ目の引数の候補を出す", () => {
    expect(complete("\\deckcolor{al|").labels).toEqual([
      "structure",
      "alert",
      "example",
      "text",
      "background",
    ]);
    expect(complete("\\deckcolor{al|").replaced[0]).toBe("al");
    expect(complete("\\deckfont{|").labels).toEqual(["main", "mono"]);
  });

  it("コメントの中と、オプションを閉じた後では出さない", () => {
    expect(complete("% \\begin{deck|").labels).toEqual([]);
    expect(complete("text % note \\deck|").labels).toEqual([]);
    expect(complete("100\\% \\deck|").labels).toContain("\\deckimage");
    expect(complete("\\begin{decktext}[x=0.1] |").labels).toEqual([]);
  });
});
