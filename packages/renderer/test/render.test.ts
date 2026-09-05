import { readFileSync } from "node:fs";
import { join } from "node:path";
import { framesOf, parseDeck } from "@beamer-editor/core";
import { describe, expect, it } from "vitest";
import { frameTitleText, renderDeck } from "../src/render.js";

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

describe("frameTitleText", () => {
  it("renderDeck と同じ数式・raw・連番フォールバックを使う", () => {
    const frames = framesOf(
      parseDeck(String.raw`\begin{frame}{Third$x$}\end{frame}
\begin{frame}\end{frame}`),
    );
    const [third, untitled] = frames;
    if (!third || !untitled) throw new Error("expected two frames");
    expect(frameTitleText(third, 3)).toBe("Third$x$");
    expect(frameTitleText(untitled, 4)).toBe("frame 4");
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

  it("候補にできない要素にも属性を付け、理由を data-detach-blocked に載せる", () => {
    expect(html).toMatch(
      new RegExp(
        `data-flow-block="blockEnv" data-source-start="${source.indexOf("\\begin{block}")}" data-source-end="\\d+" data-detach-blocked="unsupported-kind"`,
      ),
    );
    expect(html.match(/data-detach-blocked=/g)).toHaveLength(1);
  });

  it("リスト項目直下の段落と deckcanvas の中身には付けない", () => {
    expect(html).toContain("<span>item text");
    expect(html).not.toContain(`data-source-start="${source.indexOf("item text")}"`);
    expect(html).not.toContain(`data-source-start="${source.indexOf("canvas paragraph")}"`);
    expect(html.match(/data-flow-block=/g)).toHaveLength(5);
  });

  it("表示条件が変わる要素は overlay を理由に候補外にし、center の中は候補にする", () => {
    const src = `\\documentclass[aspectratio=169]{beamer}
\\begin{document}
\\begin{frame}{T}
  first
  \\begin{block}<2->{B}
    delayed
  \\end{block}
  \\begin{center}
    centered
  \\end{center}
  \\begin{itemize}
    \\item \\pause \\includegraphics[width=0.4\\textwidth]{only.png}
  \\end{itemize}
  second
\\end{frame}
\\end{document}
`;
    const rendered = renderDeck(parseDeck(src)).frames[0]?.html ?? "";
    const attrs = (text: string, blocked?: string) =>
      new RegExp(
        `data-flow-block="[a-zA-Z]+" data-source-start="${src.indexOf(text)}" data-source-end="\\d+"${
          blocked ? ` data-detach-blocked="${blocked}"` : ">"
        }`,
      );
    expect(rendered).toMatch(attrs("first", "overlay"));
    expect(rendered).toMatch(attrs("delayed", "overlay"));
    expect(rendered).toMatch(attrs("\\includegraphics[width=0.4\\textwidth]{only.png}", "overlay"));
    // center の中も \pause の前なので overlay を理由に候補外。pause が無ければ候補になる。
    expect(rendered).toMatch(attrs("centered", "overlay"));
    const centerOnly = renderDeck(
      parseDeck(src.replace("\\item \\pause \\includegraphics", "\\item \\includegraphics")),
    ).frames[0]?.html;
    expect(centerOnly).toMatch(
      /<p data-flow-block="paragraph" data-source-start="\d+" data-source-end="\d+">centered /,
    );
    // second は移動先(フレーム末尾 = 全 pause の後)と表示条件が一致する。
    expect(rendered).toMatch(
      new RegExp(
        `<p data-flow-block="paragraph" data-source-start="${src.indexOf("second")}" data-source-end="\\d+" data-min="2">`,
      ),
    );
  });

  it("項目の唯一の内容の画像も候補にし、画像を含むリストは種類として候補外にする", () => {
    const list = `\\documentclass[aspectratio=169]{beamer}
\\begin{document}
\\begin{frame}{T}
  \\begin{itemize}
    \\item \\includegraphics[width=0.4\\textwidth]{only.png}
    \\item text \\includegraphics[width=0.4\\textwidth]{with-text.png}
  \\end{itemize}
\\end{frame}
\\end{document}
`;
    const rendered = renderDeck(parseDeck(list)).frames[0]?.html ?? "";
    expect(rendered.match(/<img data-flow-block="image"/g)).toHaveLength(2);
    expect(rendered).not.toMatch(/<img data-flow-block="image"[^>]*data-detach-blocked/);
    // 画像を含む itemize は decktext に置けないので候補外(理由付き)。
    expect(rendered).toMatch(
      /<ul data-flow-block="list"[^>]*data-detach-blocked="unsupported-kind"/,
    );
  });
});

describe("renderDeck: プレースホルダ(#93)", () => {
  const src = (body: string) => `\\documentclass[aspectratio=169]{beamer}
\\begin{document}
\\begin{frame}{T}
${body}
\\end{frame}
\\end{document}
`;
  const html = (body: string) => renderDeck(parseDeck(src(body))).frames[0]?.html ?? "";

  it("生ブロックは中身を描かず、環境名だけの箱にする(既定は本文幅 6 割・4:3)", () => {
    const out = html("\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}");
    expect(out).toContain('<div class="raw-block placeholder"');
    expect(out).toContain('<span class="placeholder-label">tikzpicture</span>');
    expect(out).toContain("width:60.0%;aspect-ratio:4 / 3");
    expect(out).not.toContain("<pre>");
    // 原文はホバーで見られるよう title に残す。
    expect(out).toContain('title="\\begin{tikzpicture}');
  });

  it("\\resizebox / width= / height= の指定があれば箱の大きさに使う", () => {
    expect(
      html("\\resizebox{0.8\\textwidth}{!}{\\begin{tikzpicture}\\end{tikzpicture}}"),
    ).toContain("width:80.0%");
    expect(html("\\begin{tikzpicture}[width=0.5\\linewidth]\\end{tikzpicture}")).toContain(
      "width:50.0%",
    );
    expect(html("\\begin{tikzpicture}[height=0.5\\textheight]\\end{tikzpicture}")).toMatch(
      /width:60\.0%;height:\d+\.\d+pt/,
    );
  });

  it("環境を命令で包んだ生インラインだけの段落(\\resizebox で包んだ tikz など)も箱にし、原文を本文に出さない", () => {
    const out = html(
      "\\resizebox{0.8\\textwidth}{!}{%\n\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}}",
    );
    expect(out).toContain('<div class="raw-block placeholder"');
    expect(out).toContain('<span class="placeholder-label">tikzpicture</span>');
    expect(out).toContain("width:80.0%");
    expect(out).not.toContain("raw-inline");
    // 短い生インライン(命令だけ)は従来どおり段落内に残す。
    expect(html("before \\textsc{Small} after")).toContain("raw-inline");
  });

  it("PDF 画像はファイル名だけの箱にし、幅指定を使う", () => {
    const out = html("\\includegraphics[width=0.4\\textwidth]{figs/plot.pdf}");
    expect(out).toContain('<div class="image-placeholder placeholder"');
    expect(out).toContain('<span class="placeholder-label">plot.pdf</span>');
    expect(out).toContain("width:40.0%;aspect-ratio:4 / 3");
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

describe("renderDeck: テンプレート由来の土台スタイル", () => {
  const baseStyle = {
    colors: { structure: "123456" as const, background: "FAFAFA" as const },
    fonts: { main: "Corp Sans" },
    logo: {
      path: "templates/corporate/assets/logo.png",
      placement: { kind: "corner" as const, width: { unit: "paperwidth" as const, value: 0.1 } },
    },
    background: { path: "templates/corporate/assets/background.png" },
    footer: "ACME <Confidential>",
  };

  it("土台の色・フォント・背景・右下ロゴ・フッターがデッキに効く", () => {
    const deck = renderDeck(parseDeck(fixture("basic.tex")), undefined, { baseStyle });
    expect(deck.css).toContain("--deck-structure: #123456;");
    expect(deck.css).toContain("--deck-background: #FAFAFA;");
    expect(deck.css).toContain('--deck-font-main: "Corp Sans",');
    const html = deck.frames[1]?.html ?? "";
    expect(html).toContain(
      '<img class="deck-background" src="templates/corporate/assets/background.png">',
    );
    expect(html).toContain(
      '<img class="deck-logo" src="templates/corporate/assets/logo.png" style="right:2%;bottom:3%;width:10.00%">',
    );
    expect(html).toContain("<span>ACME &lt;Confidential&gt;</span>");
  });

  it("デッキの %% style 領域は土台を上書きし、\\decklogo は本文領域座標で置く", () => {
    const deck = renderDeck(parseDeck(fixture("styled.tex")), undefined, { baseStyle });
    expect(deck.css).toContain("--deck-structure: #0F62FE;");
    expect(deck.css).not.toContain("#123456");
    expect(deck.css).toContain("--deck-background: #FAFAFA;");
    const html = deck.frames[1]?.html ?? "";
    expect(html).toMatch(/<img class="deck-logo" src="assets\/logo.png" style="left:/);
    expect(html).not.toContain("right:2%");
    // フッターは %% style の \\deckfooter が勝つ。
    expect(html).toContain("ACME Corp.");
    expect(html).not.toContain("Confidential&gt;");
  });

  it("PDF の背景は <img> にできないので出さず、pt 幅のロゴはスライド幅の % に変える", () => {
    const deck = renderDeck(parseDeck(fixture("basic.tex")), undefined, {
      baseStyle: {
        colors: {},
        fonts: {},
        background: { path: "bg.pdf" },
        logo: {
          path: "logo.png",
          placement: { kind: "corner", width: { unit: "pt", value: 45.524 } },
        },
      },
    });
    const html = deck.frames[0]?.html ?? "";
    expect(html).not.toContain("deck-background");
    expect(html).toContain("width:10.00%");
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
