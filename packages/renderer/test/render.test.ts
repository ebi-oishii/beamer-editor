import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDeck } from "@beamer-editor/core";
import { describe, expect, it } from "vitest";
import { renderDeck } from "../src/render.js";

const fixture = (name: string) => readFileSync(join(__dirname, "../../../fixtures", name), "utf8");

describe("renderDeck: basic.tex", () => {
  const source = fixture("basic.tex");
  const deck = renderDeck(parseDeck(source));

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

  it("元ソース上のフレーム範囲を引き継ぐ", () => {
    const first = deck.frames[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(source.slice(first.sourceSpan.start, first.sourceSpan.end)).toBe(
      "\\begin{frame}\n  \\titlepage\n\\end{frame}",
    );
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

  it("許可外サイズは normal の安全なフォールバックで描画される", () => {
    const source = fixture("canvas.tex").replace("size=normal", "size=huge");
    const rendered = renderDeck(parseDeck(source));

    expect(rendered.frames[1]?.html).toContain("font-size:11pt");
    expect(rendered.frames[1]?.html).not.toContain("font-size:undefinedpt");
  });

  it("PDF 画像はプレースホルダになる", () => {
    expect(deck.frames[1]?.html).toContain("image-placeholder");
  });

  it("decktext と deckimage が frame 内で一意の drag descriptor と data 属性を持つ", () => {
    const frame = deck.frames[1];
    const elements = frame?.canvasElements ?? [];
    expect(elements.map((element) => [element.id, element.kind])).toEqual([
      ["canvas-text-0", "text"],
      ["canvas-image-0", "image"],
    ]);
    expect(frame?.html).toContain(
      'data-canvas-element-id="canvas-text-0" data-canvas-element-kind="text"',
    );
    expect(frame?.html).toContain('data-canvas-element-id="canvas-image-0"');
    // sourceSpan は options の `[...]` 範囲(x/y 置換の対象)。
    const text = elements[0];
    expect(text?.position).toEqual({ x: 0.05, y: 0.1, width: 0.42 });
    expect(text?.sourceSpan.end).toBeGreaterThan(text?.sourceSpan.start ?? 0);
  });
});

describe("renderDeck: 自由配置候補の識別属性", () => {
  const source = `\\documentclass[aspectratio=169]{beamer}
\\begin{document}
\\begin{frame}{T}
  top paragraph
  \\begin{block}{B}
    inside block
  \\end{block}
  \\begin{itemize}
    \\item item text
  \\end{itemize}
  \\includegraphics[width=0.4\\textwidth]{a.png}
  \\begin{deckcanvas}
    \\begin{decktext}[x=0,y=0,w=1]canvas paragraph\\end{decktext}
  \\end{deckcanvas}
\\end{frame}
\\end{document}
`;
  const html = renderDeck(parseDeck(source)).frames[0]?.html ?? "";

  it("段落・リスト・画像に span 付きの data-flow-block を付け、入れ子でも付く", () => {
    expect(html).toContain(
      `<p data-flow-block="paragraph" data-source-start="${source.indexOf("top paragraph")}"`,
    );
    expect(html).toContain(
      `<p data-flow-block="paragraph" data-source-start="${source.indexOf("inside block")}"`,
    );
    expect(html).toContain(
      `<ul data-flow-block="list" data-source-start="${source.indexOf("\\begin{itemize}")}"`,
    );
    expect(html).toContain(
      `<img data-flow-block="image" data-source-start="${source.indexOf("\\includegraphics")}"`,
    );
  });

  it("リスト項目直下の段落と deckcanvas の中身には付けない", () => {
    expect(html).toContain("<span>item text");
    expect(html).not.toContain(`data-source-start="${source.indexOf("item text")}"`);
    expect(html).not.toContain(`data-source-start="${source.indexOf("canvas paragraph")}"`);
    expect(html.match(/data-flow-block=/g)).toHaveLength(4);
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
      '--deck-font-main: "Noto Sans CJK JP", "Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif;',
    );
  });

  it("main フォントは和文ローカルフォントへフォールバックする(CJK 近似・Linux 名も含む)", () => {
    const deck2 = renderDeck(parseDeck(fixture("japanese.tex")));
    // \deckfont{main}{Noto Sans CJK JP} → 指定名 → 和文ローカル → サンス総称。
    // Linux でインストール名として現れうる Noto 名(Noto Sans CJK JP / Noto Sans JP)を含める。
    expect(deck2.css).toContain(
      '--deck-font-main: "Noto Sans CJK JP", "Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif;',
    );
    expect(deck2.css).toContain('"Noto Sans JP"');
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
