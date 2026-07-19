import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { framesOf } from "../src/ast.js";
import { expandDeck, mapExpandedToSource } from "../src/expander.js";
import { parseDeck } from "../src/parser.js";

const fixture = (name: string) => readFileSync(join(__dirname, "../../../fixtures", name), "utf8");

/** ノード木から unknown-command の rawInline があるかを深さ優先で探す。 */
// biome-ignore lint/suspicious/noExplicitAny: AST を型に依らず横断走査するため
function hasUnknownCommand(node: any): boolean {
  if (node === null || typeof node !== "object") return false;
  if (node.type === "rawInline" && node.reason === "unknown-command") return true;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      if (value.some((child) => hasUnknownCommand(child))) return true;
    } else if (hasUnknownCommand(value)) {
      return true;
    }
  }
  return false;
}

describe("expandDeck: macros.tex", () => {
  const src = fixture("macros.tex");
  const result = expandDeck(src);

  it("展開結果全文がスナップショットと一致する", () => {
    expect(result.source).toMatchSnapshot();
  });

  it("ゼロ引数マクロと 1 引数マクロを展開する", () => {
    // \R → \mathbb{R}(数式内でも展開)、\code{deck lint} → \texttt{deck lint}
    expect(result.source).toContain("\\mathbb{R}");
    expect(result.source).toContain("\\texttt{deck lint}");
    expect(result.source).not.toContain("\\R$");
  });

  it("ネストした呼び出しを再帰展開する(renewcommand 後勝ちも兼ねる)", () => {
    // \code{\highlight{deck check}} → \texttt{\textbf{deck check}}
    expect(result.source).toContain("\\texttt{\\textbf{deck check}}");
    // \highlight は renewcommand で textbf に上書きされている(alert ではない)
    // ※ macros 領域の定義 \newcommand{\highlight}[1]{\alert{#1}} は残るため、
    //   本文で使われる引数付きの形で比較する。
    expect(result.source).toContain("\\textbf{this}");
    expect(result.source).not.toContain("\\alert{this}");
    expect(result.source).not.toContain("\\alert{deck check}");
  });

  it("省略可能引数を展開する", () => {
    // \greet → Hello, world! / \greet[team] → Hello, team!
    expect(result.source).toContain("Hello, world!");
    expect(result.source).toContain("Hello, team!");
  });

  it("newenvironment を展開する(keypoints → itemize)", () => {
    const before = framesOf(parseDeck(src))[5];
    if (before?.type !== "frame") throw new Error("expected frame");
    expect(before.body.some((b) => b.type === "rawBlock" && b.environment === "keypoints")).toBe(
      true,
    );

    const after = framesOf(result.doc)[5];
    if (after?.type !== "frame") throw new Error("expected frame");
    const list = after.body.find((b) => b.type === "list");
    expect(list?.type).toBe("list");
    if (list?.type !== "list") return;
    expect(list.kind).toBe("itemize");
  });

  it("展開不能な呼び出し(\\swap, \\maybe)は原文のまま残る", () => {
    expect(result.source).toContain("\\swap(alpha,beta)");
    expect(result.source).toContain("\\maybe{1}");
  });

  it("再パース検証: 展開後は unknown-command の rawInline が消える", () => {
    // 「Macros with arguments」フレーム(index 2)
    const before = framesOf(parseDeck(src))[2];
    const after = framesOf(result.doc)[2];
    expect(hasUnknownCommand(before)).toBe(true);
    expect(hasUnknownCommand(after)).toBe(false);
  });

  it("ソースマップ: 引数由来テキストは元位置へ 1:1、本体由来は呼び出しサイトへ丸まる", () => {
    // (a) "deck lint" は引数スプライスなので展開後→元ソースへ 1:1
    const expLint = result.source.indexOf("deck lint");
    const srcLint = src.indexOf("deck lint");
    expect(expLint).toBeGreaterThanOrEqual(0);
    // 先頭・内部の任意オフセットが 1:1 で引ける(末尾は次セグメント境界なので内部で検証)。
    expect(mapExpandedToSource(result.map, expLint)).toBe(srcLint);
    expect(mapExpandedToSource(result.map, expLint + 5)).toBe(srcLint + 5);

    // (b) \texttt(本体由来)の位置は呼び出しサイト \code の先頭へ丸まる
    const expTexttt = result.source.indexOf("\\texttt{deck lint}");
    const srcCode = src.indexOf("\\code{deck lint}");
    expect(mapExpandedToSource(result.map, expTexttt)).toBe(srcCode);
  });

  it("展開が起きたことを changed で示す", () => {
    expect(result.changed).toBe(true);
  });

  it("展開後ソースを再度展開しても変化しない(冪等)", () => {
    const again = expandDeck(result.source);
    expect(again.source).toBe(result.source);
    expect(again.changed).toBe(false);
  });
});

describe("expandDeck: 無限再帰ガード", () => {
  it("自己参照マクロで停止し max-depth を積む", () => {
    const src = [
      "\\documentclass{beamer}",
      "%% macros:begin",
      "\\newcommand{\\looper}{\\looper x}",
      "%% macros:end",
      "\\begin{document}",
      "\\begin{frame}",
      "\\looper",
      "\\end{frame}",
      "\\end{document}",
      "",
    ].join("\n");
    const result = expandDeck(src);
    expect(result.diagnostics.some((d) => d.kind === "max-depth" && d.name === "looper")).toBe(
      true,
    );
    expect(result.changed).toBe(true);
    // 展開しきれなかった \looper が残る(無限ループしていない)
    expect(result.source).toContain("\\looper");
  });
});

describe("expandDeck: マクロなしソース", () => {
  it("何も展開せず入力と同一を返す", () => {
    const src = [
      "\\documentclass{beamer}",
      "\\begin{document}",
      "\\begin{frame}",
      "Plain text, no user macros.",
      "\\end{frame}",
      "\\end{document}",
      "",
    ].join("\n");
    const result = expandDeck(src);
    expect(result.changed).toBe(false);
    expect(result.source).toBe(src);
    expect(result.diagnostics).toHaveLength(0);
  });
});

describe("expandDeck: スキップ領域", () => {
  it("コメント内・verbatim 内の呼び出しは展開しない", () => {
    const src = [
      "\\documentclass{beamer}",
      "%% macros:begin",
      "\\newcommand{\\R}{\\mathbb{R}}",
      "%% macros:end",
      "\\begin{document}",
      "\\begin{frame}[fragile]",
      "% comment keeps \\R raw",
      "\\begin{verbatim}",
      "\\R stays raw",
      "\\end{verbatim}",
      "Inline \\R expands.",
      "\\end{frame}",
      "\\end{document}",
      "",
    ].join("\n");
    const result = expandDeck(src);
    expect(result.source).toContain("% comment keeps \\R raw");
    expect(result.source).toContain("\\R stays raw");
    expect(result.source).toContain("Inline \\mathbb{R} expands.");
  });
});
