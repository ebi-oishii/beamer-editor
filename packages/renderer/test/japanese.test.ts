import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDeck } from "@beamer-editor/core";
import { describe, expect, it } from "vitest";
import { renderDeck } from "../src/render.js";

const fixture = (name: string) => readFileSync(join(__dirname, "../../../fixtures", name), "utf8");

// 日本語 fixture を core でパース → renderer で描画するスモークテスト。
// 例外を出さず、和文テキストが HTML に含まれることを確認する(体裁の検証は PDF 側)。
describe("renderDeck: japanese.tex(和文スモーク)", () => {
  const deck = renderDeck(parseDeck(fixture("japanese.tex")));

  it("例外なく描画され、7 フレームになる", () => {
    expect(deck.frames).toHaveLength(7);
    expect(deck.title).toBe("日本語ゴールデンサンプル");
  });

  it("タイトルページに和文メタデータが出る", () => {
    expect(deck.frames[0]?.html).toContain("日本語ゴールデンサンプル");
    expect(deck.frames[0]?.html).toContain("Beamer Editor チーム");
  });

  it("箇条書き・ブロック・表の和文が出力に含まれる", () => {
    const all = deck.frames.map((f) => f.html).join("");
    expect(all).toContain("入れ子の箇条書き");
    expect(all).toContain("例示ブロック");
    expect(all).toContain("提案手法");
  });

  it("数式は KaTeX で描画され、周囲の和文も残る", () => {
    const mathFrame = deck.frames.find((f) => f.html.includes("katex"));
    expect(mathFrame).toBeDefined();
    expect(mathFrame?.html).toContain("に達し");
  });

  it("キャンバス上の和文が絶対配置で出る", () => {
    const canvasFrame = deck.frames.find((f) => f.html.includes('class="canvas"'));
    expect(canvasFrame).toBeDefined();
    expect(canvasFrame?.html).toContain("スタイル非依存");
  });
});
