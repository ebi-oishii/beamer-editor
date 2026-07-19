import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDeck } from "@beamer-editor/core";
import { describe, expect, it } from "vitest";
import { renderDeck } from "../src/render.js";

const fixture = (name: string) => readFileSync(join(__dirname, "../../../fixtures", name), "utf8");

describe("renderDeck: basic.tex", () => {
  const deck = renderDeck(parseDeck(fixture("basic.tex")));

  it("15 フレームが描画される", () => {
    expect(deck.frames).toHaveLength(15);
    expect(deck.title).toBe("A Tiny Study of Deck Editing");
  });

  it("タイトルページにメタデータが出る", () => {
    expect(deck.frames[0]?.html).toContain("tp-title");
    expect(deck.frames[0]?.html).toContain("Beamer Editor Team");
  });

  it("数式が KaTeX で HTML になる", () => {
    const mathFrame = deck.frames[9];
    expect(mathFrame?.html).toContain("katex");
  });

  it("オーバーレイのステップ数が計算される", () => {
    const stepsFrame = deck.frames[3]; // <2,4> があるので 4 ステップ
    expect(stepsFrame?.stepCount).toBe(4);
    const pauseFrame = deck.frames[4]; // \pause 1 回 → 2 ステップ
    expect(pauseFrame?.stepCount).toBe(2);
  });

  it("画像が img タグになる", () => {
    expect(deck.frames[7]?.html).toContain('src="assets/logo.png"');
  });
});

describe("renderDeck: canvas.tex", () => {
  const deck = renderDeck(parseDeck(fixture("canvas.tex")));

  it("キャンバスが絶対配置で描画される", () => {
    const results = deck.frames[1];
    expect(results?.html).toContain('class="canvas"');
    expect(results?.html).toContain("left:5.00%");
    expect(results?.html).toContain("top:10.00%");
    expect(results?.html).toContain("width:42.00%");
  });

  it("文字サイズ enum が pt に変換される", () => {
    const sizes = deck.frames[2];
    expect(sizes?.html).toContain("font-size:14.4pt"); // Large
    expect(sizes?.html).toContain("font-size:9pt"); // footnotesize
  });

  it("PDF 画像はプレースホルダになる", () => {
    expect(deck.frames[1]?.html).toContain("image-placeholder");
  });
});

describe("renderDeck: kitchen-sink.tex", () => {
  const deck = renderDeck(parseDeck(fixture("kitchen-sink.tex")));

  it("生ブロックはプレースホルダで描画される", () => {
    const tikz = deck.frames[2];
    expect(tikz?.html).toContain("raw-block");
    expect(tikz?.html).toContain("tikzpicture");
  });

  it("生フレームも一覧に出る", () => {
    const raw = deck.frames.find((f) => f.isRaw);
    expect(raw).toBeDefined();
    expect(raw?.html).toContain("解釈不能フレーム");
  });
});

describe("renderDeck: styled.tex(スタイル語彙)", () => {
  const deck = renderDeck(parseDeck(fixture("styled.tex")));

  it("CSS 変数が生成される", () => {
    expect(deck.css).toContain("--deck-structure: #0F62FE;");
    expect(deck.css).toContain("--deck-alert: #DA1E28;");
    expect(deck.css).toContain(
      '--deck-font-main: "Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic", sans-serif;',
    );
  });

  it("main フォントは和文ローカルフォントへフォールバックする(CJK 近似)", () => {
    const deck2 = renderDeck(parseDeck(fixture("japanese.tex")));
    // \deckfont{main}{Noto Sans CJK JP} → 指定名 → 和文ローカル → サンス総称。
    expect(deck2.css).toContain(
      '--deck-font-main: "Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic", sans-serif;',
    );
    // mono は指定されていないので main のみが出る。
    expect(deck2.css).not.toContain("--deck-font-mono");
  });

  it("ロゴとフッターが全フレームに入る(ページ番号付き)", () => {
    for (const frame of deck.frames) {
      expect(frame.html).toContain('class="deck-logo"');
      expect(frame.html).toContain('class="deck-footer"');
    }
    expect(deck.frames[0]?.html).toContain("1 / 3");
    expect(deck.frames[2]?.html).toContain("3 / 3");
    expect(deck.frames[0]?.html).toContain("ACME Corp.");
  });

  it("style 領域が無いデッキでは CSS も装飾も出ない", () => {
    const plain = renderDeck(parseDeck(fixture("basic.tex")));
    expect(plain.css).toBe("");
    expect(plain.frames[0]?.html).not.toContain("deck-footer");
  });
});
