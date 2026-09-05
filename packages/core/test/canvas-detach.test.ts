import { describe, expect, it } from "vitest";
import type { BlockNode, SourceSpan } from "../src/ast.js";
import { detachBlockToCanvas, detachStatusesOf, isDetachableBlock } from "../src/canvas-detach.js";
import { parseDeck } from "../src/parser.js";

const PREAMBLE = "\\documentclass[aspectratio=169]{beamer}\n\\begin{document}\n";
const deck = (frame: string) => `${PREAMBLE}${frame}\n\\end{document}\n`;

/**
 * 原文(末尾空白を除く)が text と一致するブロックの AST span を、frame 本文の入れ子まで探す。
 * renderer が data 属性に出すのはこの AST span で、段落の span は後続環境の直前まで伸びる。
 */
function spanOf(source: string, text: string): SourceSpan {
  const doc = parseDeck(source);
  const visit = (blocks: BlockNode[]): SourceSpan | null => {
    for (const block of blocks) {
      if (source.slice(block.span.start, block.span.end).trimEnd() === text) return block.span;
      const children: BlockNode[] =
        block.type === "columns"
          ? block.columns.flatMap((column) => column.children)
          : block.type === "blockEnv" || block.type === "center"
            ? block.children
            : block.type === "list"
              ? block.items.flatMap((item) => item.children)
              : [];
      const found = visit(children);
      if (found) return found;
    }
    return null;
  };
  for (const element of doc.body) {
    if (element.type !== "frame") continue;
    const found = visit(element.body);
    if (found) return found;
  }
  throw new Error(`fixture missing: ${text}`);
}

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a replacement");
  return value;
}

function apply(
  source: string,
  replacement: { span: { start: number; end: number }; text: string },
) {
  return `${source.slice(0, replacement.span.start)}${replacement.text}${source.slice(replacement.span.end)}`;
}

describe("detachBlockToCanvas", () => {
  it("段落を取り除き、フレーム末尾に新設した deckcanvas の decktext へ移す", () => {
    const source = deck(`\\begin{frame}{T}
  Intro line one
  continues here.

  \\begin{itemize}
    \\item A
  \\end{itemize}
\\end{frame}`);
    const result = detachBlockToCanvas(
      source,
      spanOf(source, "Intro line one\n  continues here."),
      {
        x: 0.1,
        y: 0.2,
        width: 0.8,
      },
    );
    expect(result).not.toBeNull();
    expect(apply(source, must(result))).toBe(
      deck(`\\begin{frame}{T}

  \\begin{itemize}
    \\item A
  \\end{itemize}
  \\begin{deckcanvas}
    \\begin{decktext}[x=0.100,y=0.200,w=0.800,size=normal]
      Intro line one
      continues here.
    \\end{decktext}
  \\end{deckcanvas}
\\end{frame}`),
    );
    // 置換範囲はフレーム全体(1 操作 = 1 undo)。
    expect(
      source.slice(must(result).span.start, must(result).span.end).startsWith("\\begin{frame}"),
    ).toBe(true);
  });

  it("直後に環境が続く段落(span が次の行の字下げまで伸びる)も行単位で取り除く", () => {
    const source = deck(`\\begin{frame}{T}
  lead text
  \\begin{itemize}
    \\item A
  \\end{itemize}
\\end{frame}`);
    const start = source.indexOf("lead text");
    const end = source.indexOf("\\begin{itemize}");
    const result = detachBlockToCanvas(source, { start, end }, { x: 0, y: 0, width: 1 });
    expect(apply(source, must(result))).toBe(
      deck(`\\begin{frame}{T}
  \\begin{itemize}
    \\item A
  \\end{itemize}
  \\begin{deckcanvas}
    \\begin{decktext}[x=0.000,y=0.000,w=1.000,size=normal]
      lead text
    \\end{decktext}
  \\end{deckcanvas}
\\end{frame}`),
    );
  });

  it("画像は deckimage になり、既存の deckcanvas があればその末尾へ入る", () => {
    const source = deck(`\\begin{frame}[label=mix]{T}
  \\includegraphics[width=0.4\\textwidth]{assets/logo.png}
  \\begin{deckcanvas}
    \\deckimage[x=0.500,y=0.100,w=0.300]{a.png}
  \\end{deckcanvas}
\\end{frame}`);
    const result = detachBlockToCanvas(
      source,
      spanOf(source, "\\includegraphics[width=0.4\\textwidth]{assets/logo.png}"),
      { x: 0.05, y: 0.3, width: 0.4 },
    );
    expect(apply(source, must(result))).toBe(
      deck(`\\begin{frame}[label=mix]{T}
  \\begin{deckcanvas}
    \\deckimage[x=0.500,y=0.100,w=0.300]{a.png}
    \\deckimage[x=0.050,y=0.300,w=0.400]{assets/logo.png}
  \\end{deckcanvas}
\\end{frame}`),
    );
  });

  it("block 環境の中の段落や入れ子のリストも取り出せる(リスト項目直下の段落は不可)", () => {
    const source = deck(`\\begin{frame}{T}
  \\begin{block}{B}
    inside block
  \\end{block}
  \\begin{itemize}
    \\item outer text
    \\begin{itemize}
      \\item inner
    \\end{itemize}
  \\end{itemize}
\\end{frame}`);
    const paragraph = detachBlockToCanvas(source, spanOf(source, "inside block"), {
      x: 0,
      y: 0,
      width: 1,
    });
    expect(paragraph?.text).toContain("\\begin{block}{B}\n  \\end{block}");
    expect(paragraph?.text).toContain("      inside block\n    \\end{decktext}");

    const inner = detachBlockToCanvas(
      source,
      spanOf(source, "\\begin{itemize}\n      \\item inner\n    \\end{itemize}"),
      { x: 0.5, y: 0.5, width: 0.4 },
    );
    expect(inner?.text).toContain("    \\begin{decktext}[x=0.500,y=0.500,w=0.400,size=normal]");
    expect(inner?.text).toContain(
      "      \\begin{itemize}\n        \\item inner\n      \\end{itemize}",
    );

    expect(
      detachBlockToCanvas(source, spanOf(source, "outer text"), { x: 0, y: 0, width: 1 }),
    ).toBeNull();
  });

  it("項目の唯一の内容を取り出すときは空になる \\item も取り除き、他の内容があれば項目は残す", () => {
    const source = deck(`\\begin{frame}{T}
  \\begin{itemize}
    \\item \\includegraphics[width=0.4\\textwidth]{only.png}
    \\item text \\includegraphics[width=0.4\\textwidth]{with-text.png}
  \\end{itemize}
\\end{frame}`);
    const placement = { x: 0.1, y: 0.1, width: 0.3 };
    const only = detachBlockToCanvas(
      source,
      spanOf(source, "\\includegraphics[width=0.4\\textwidth]{only.png}"),
      placement,
    );
    expect(apply(source, must(only))).toBe(
      deck(`\\begin{frame}{T}
  \\begin{itemize}
    \\item text \\includegraphics[width=0.4\\textwidth]{with-text.png}
  \\end{itemize}
  \\begin{deckcanvas}
    \\deckimage[x=0.100,y=0.100,w=0.300]{only.png}
  \\end{deckcanvas}
\\end{frame}`),
    );
    const withText = detachBlockToCanvas(
      source,
      spanOf(source, "\\includegraphics[width=0.4\\textwidth]{with-text.png}"),
      placement,
    );
    expect(withText?.text).toContain("\\item text\n");
    expect(withText?.text).toContain("\\deckimage[x=0.100,y=0.100,w=0.300]{with-text.png}");
  });

  it("入れ子リストだけの項目や、項目が 1 つだけのリストは、それごと取り除く", () => {
    const nestedOnly = deck(`\\begin{frame}{T}
  \\begin{itemize}
    \\item first
    \\item
    \\begin{itemize}
      \\item inner
    \\end{itemize}
  \\end{itemize}
\\end{frame}`);
    const inner = detachBlockToCanvas(
      nestedOnly,
      spanOf(nestedOnly, "\\begin{itemize}\n      \\item inner\n    \\end{itemize}"),
      { x: 0.5, y: 0.5, width: 0.4 },
    );
    expect(apply(nestedOnly, must(inner))).toBe(
      deck(`\\begin{frame}{T}
  \\begin{itemize}
    \\item first
  \\end{itemize}
  \\begin{deckcanvas}
    \\begin{decktext}[x=0.500,y=0.500,w=0.400,size=normal]
      \\begin{itemize}
        \\item inner
      \\end{itemize}
    \\end{decktext}
  \\end{deckcanvas}
\\end{frame}`),
    );

    const soloList = deck(`\\begin{frame}{T}
  intro
  \\begin{itemize}
    \\item \\includegraphics[width=0.4\\textwidth]{solo.png}
  \\end{itemize}
\\end{frame}`);
    const solo = detachBlockToCanvas(
      soloList,
      spanOf(soloList, "\\includegraphics[width=0.4\\textwidth]{solo.png}"),
      { x: 0.1, y: 0.1, width: 0.3 },
    );
    // 空の itemize は LaTeX エラーになるので、リストごと消える。
    expect(apply(soloList, must(solo))).toBe(
      deck(`\\begin{frame}{T}
  intro
  \\begin{deckcanvas}
    \\deckimage[x=0.100,y=0.100,w=0.300]{solo.png}
  \\end{deckcanvas}
\\end{frame}`),
    );
  });

  it("表示条件が変わる候補は対象にしない: overlay 付きの block / \\item の中", () => {
    const source = deck(`\\begin{frame}{T}
  \\begin{block}<2->{B}
    delayed
  \\end{block}
  \\begin{itemize}
    \\item<2-> text \\includegraphics[width=0.4\\textwidth]{late.png}
    \\item text \\includegraphics[width=0.4\\textwidth]{now.png}
  \\end{itemize}
\\end{frame}`);
    const placement = { x: 0.1, y: 0.1, width: 0.3 };
    expect(detachBlockToCanvas(source, spanOf(source, "delayed"), placement)).toBeNull();
    expect(
      detachBlockToCanvas(
        source,
        spanOf(source, "\\includegraphics[width=0.4\\textwidth]{late.png}"),
        placement,
      ),
    ).toBeNull();
    expect(
      detachBlockToCanvas(
        source,
        spanOf(source, "\\includegraphics[width=0.4\\textwidth]{now.png}"),
        placement,
      ),
    ).not.toBeNull();
  });

  it("\\pause との前後関係が移動先と異なる候補は対象にしない", () => {
    const placement = { x: 0.1, y: 0.1, width: 0.3 };
    // canvas を新設する場合、移動先はフレーム末尾(全 pause の後)。pause 前の first は対象外。
    const noCanvas = deck(`\\begin{frame}{T}
  first
  \\pause
  second
\\end{frame}`);
    expect(detachBlockToCanvas(noCanvas, spanOf(noCanvas, "first"), placement)).toBeNull();
    expect(detachBlockToCanvas(noCanvas, spanOf(noCanvas, "second"), placement)).not.toBeNull();
    // 既存 canvas が pause の前にあるなら、pause 後の要素は対象外で、pause 前の要素は対象。
    const withCanvas = deck(`\\begin{frame}[label=c]{T}
  before
  \\begin{deckcanvas}
    \\deckimage[x=0.500,y=0.100,w=0.300]{a.png}
  \\end{deckcanvas}
  \\pause
  after
\\end{frame}`);
    expect(detachBlockToCanvas(withCanvas, spanOf(withCanvas, "after"), placement)).toBeNull();
    expect(detachBlockToCanvas(withCanvas, spanOf(withCanvas, "before"), placement)).not.toBeNull();
  });

  it("center の中は \\centering を保って取り出し、\\pause しか残らない項目の内容は対象にしない", () => {
    const placement = { x: 0.1, y: 0.1, width: 0.3 };
    const centered = deck(`\\begin{frame}{T}
  \\begin{center}
    short text
  \\end{center}
\\end{frame}`);
    expect(
      detachBlockToCanvas(centered, spanOf(centered, "short text"), placement)?.text,
    ).toContain(
      "    \\begin{decktext}[x=0.100,y=0.100,w=0.300,size=normal]\n      \\centering\n      short text\n    \\end{decktext}",
    );

    const paused = deck(`\\begin{frame}{T}
  \\begin{itemize}
    \\item \\pause \\includegraphics[width=0.4\\textwidth]{only.png}
    \\item text \\pause \\includegraphics[width=0.4\\textwidth]{with-text.png}
  \\end{itemize}
\\end{frame}`);
    // 項目ごと消すと \\pause も消えて後続の step が変わるので対象外。
    expect(
      detachBlockToCanvas(
        paused,
        spanOf(paused, "\\includegraphics[width=0.4\\textwidth]{only.png}"),
        placement,
      ),
    ).toBeNull();
    // text が残る項目の画像は、全 pause の後にあるので移動先(フレーム末尾)と表示条件が一致する。
    expect(
      detachBlockToCanvas(
        paused,
        spanOf(paused, "\\includegraphics[width=0.4\\textwidth]{with-text.png}"),
        placement,
      ),
    ).not.toBeNull();
  });

  it("広げた削除範囲にコメントがあるときは \\item を残してコメントを失わない", () => {
    const placement = { x: 0.1, y: 0.1, width: 0.3 };
    const image = "\\includegraphics[width=0.4\\textwidth]{solo.png}";
    const cases: [string, string][] = [
      ["項目の直前", `    % keep me\n    \\item ${image}`],
      ["項目と対象の間", `    \\item % keep me\n    ${image}`],
      ["リスト内の末尾", `    \\item ${image}\n    % keep me`],
    ];
    for (const [label, items] of cases) {
      const source = deck(
        `\\begin{frame}{T}\n  \\begin{itemize}\n${items}\n  \\end{itemize}\n\\end{frame}`,
      );
      const result = apply(
        source,
        must(detachBlockToCanvas(source, spanOf(source, image), placement)),
      );
      expect(result, label).toContain("% keep me");
      expect(result, label).toContain("\\begin{itemize}");
      expect(result, label).toContain("\\item");
      expect(result, label).not.toContain(image);
      expect(result, label).toContain("\\deckimage[x=0.100,y=0.100,w=0.300]{solo.png}");
    }
    const plain = deck(`\\begin{frame}{T}
  \\begin{itemize}
    \\item ${image}
  \\end{itemize}
\\end{frame}`);
    expect(detachBlockToCanvas(plain, spanOf(plain, image), placement)?.text).not.toContain(
      "itemize",
    );
  });

  it("\\pause を含むリストは、既存 deckcanvas の後ろにあっても overlay を理由に候補外にする", () => {
    const source = deck(`\\begin{frame}{T}
  \\begin{deckcanvas}
    \\deckimage[x=0.1,y=0.1,w=0.3]{a.png}
  \\end{deckcanvas}
  \\begin{itemize}
    \\item A
    \\pause
    \\item B
  \\end{itemize}
  \\begin{itemize}
    \\item C
  \\end{itemize}
\\end{frame}`);
    const frame = parseDeck(source).body.find((element) => element.type === "frame");
    if (frame?.type !== "frame") throw new Error("frame missing");
    const statuses = [...detachStatusesOf(frame).entries()].filter(
      ([block]) => block.type === "list",
    );
    expect(statuses.map(([, status]) => status)).toEqual([
      { eligible: false, reason: "overlay" },
      // 後ろのリストは \\pause の後にあるので、移動先(deckcanvas の前 = pause 0 個)と一致しない。
      { eligible: false, reason: "overlay" },
    ]);
    const paused = source.slice(
      source.indexOf("\\begin{itemize}"),
      source.indexOf("\\end{itemize}") + "\\end{itemize}".length,
    );
    expect(
      detachBlockToCanvas(source, spanOf(source, paused), { x: 0, y: 0, width: 1 }),
    ).toBeNull();
  });

  it("decktext と同じく 3 段までのリストは取り出せ、候補外の理由は detachStatusesOf が返す", () => {
    const statusesOf = (source: string) => {
      const frame = parseDeck(source).body.find((element) => element.type === "frame");
      if (frame?.type !== "frame") throw new Error("frame missing");
      const statuses = detachStatusesOf(frame);
      return (text: string) =>
        [...statuses.entries()].find(
          ([block]) => source.slice(block.span.start, block.span.end).trimEnd() === text,
        )?.[1];
    };

    const nested = deck(`\\begin{frame}{T}
  \\begin{itemize}
    \\item a
    \\begin{itemize}
      \\item b
      \\begin{itemize}
        \\item c
      \\end{itemize}
    \\end{itemize}
  \\end{itemize}
  \\begin{block}{B}
    inside
  \\end{block}
\\end{frame}`);
    const outer = nested.slice(
      nested.indexOf("\\begin{itemize}"),
      nested.lastIndexOf("\\end{itemize}") + "\\end{itemize}".length,
    );
    expect(
      detachBlockToCanvas(nested, spanOf(nested, outer), { x: 0, y: 0, width: 1 }),
    ).not.toBeNull();
    const nestedStatus = statusesOf(nested);
    expect(nestedStatus(outer)?.eligible).toBe(true);
    expect(nestedStatus("\\begin{block}{B}\n    inside\n  \\end{block}")).toEqual({
      eligible: false,
      reason: "unsupported-kind",
    });
    expect(nestedStatus("inside")?.eligible).toBe(true);

    const paused = deck(`\\begin{frame}{T}
  before
  \\pause
  after
\\end{frame}`);
    const pausedStatus = statusesOf(paused);
    // before は全 pause の前にあるので、移動先(フレーム末尾)と表示条件が合わない。
    expect(pausedStatus("before")).toEqual({ eligible: false, reason: "overlay" });
    expect(pausedStatus("after")?.eligible).toBe(true);
  });

  it("CRLF 文書では生成部分も CRLF にし、取り除いた行に CR を残さない", () => {
    const source = deck(`\\begin{frame}{T}
  lead text
  \\begin{itemize}
    \\item A
  \\end{itemize}
\\end{frame}`).replaceAll("\n", "\r\n");
    const start = source.indexOf("lead text");
    const end = source.indexOf("\\begin{itemize}");
    const result = detachBlockToCanvas(source, { start, end }, { x: 0, y: 0, width: 1 });
    const applied = apply(source, must(result));
    expect(applied).toBe(
      deck(`\\begin{frame}{T}
  \\begin{itemize}
    \\item A
  \\end{itemize}
  \\begin{deckcanvas}
    \\begin{decktext}[x=0.000,y=0.000,w=1.000,size=normal]
      lead text
    \\end{decktext}
  \\end{deckcanvas}
\\end{frame}`).replaceAll("\n", "\r\n"),
    );
    // LF 単独は一つも残らない。
    expect(applied.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("移せない種類・span 不一致・deckcanvas が 2 つのフレームは null", () => {
    const columns = deck(`\\begin{frame}{T}
  \\begin{columns}
    \\begin{column}{0.5\\textwidth}
      left
    \\end{column}
  \\end{columns}
\\end{frame}`);
    const columnsFrame = parseDeck(columns).body.find((element) => element.type === "frame");
    const columnsBlock =
      columnsFrame?.type === "frame"
        ? columnsFrame.body.find((block) => block.type === "columns")
        : undefined;
    expect(columnsBlock).toBeDefined();
    expect(
      detachBlockToCanvas(columns, must(columnsBlock).span, { x: 0, y: 0, width: 1 }),
    ).toBeNull();
    // 段落の一部だけを指す span は対象にしない。
    const partial = spanOf(columns, "left");
    expect(
      detachBlockToCanvas(
        columns,
        { start: partial.start + 1, end: partial.end },
        { x: 0, y: 0, width: 1 },
      ),
    ).toBeNull();

    const twice = deck(`\\begin{frame}{T}
  para
  \\begin{deckcanvas}\\end{deckcanvas}
  \\begin{deckcanvas}\\end{deckcanvas}
\\end{frame}`);
    expect(detachBlockToCanvas(twice, spanOf(twice, "para"), { x: 0, y: 0, width: 1 })).toBeNull();
  });

  it("座標は本文領域に収め、幅は最小値以上・右端を超えない", () => {
    const source = deck(`\\begin{frame}{T}
  para
\\end{frame}`);
    const result = detachBlockToCanvas(source, spanOf(source, "para"), {
      x: 0.9,
      y: -0.2,
      width: 0.5,
    });
    expect(result?.text).toContain("[x=0.900,y=0.000,w=0.100,size=normal]");
    const tiny = detachBlockToCanvas(source, spanOf(source, "para"), { x: 2, y: 2, width: 0 });
    expect(tiny?.text).toContain("[x=0.950,y=1.000,w=0.050,size=normal]");
  });

  it("isDetachableBlock は decktext に収まる構造だけを許す", () => {
    const doc = parseDeck(
      deck(`\\begin{frame}{T}
  \\begin{itemize}
    \\item<2-> overlay
  \\end{itemize}
  \\begin{itemize}
    \\item a
    \\begin{itemize}
      \\item b
      \\begin{itemize}
        \\item c
      \\end{itemize}
    \\end{itemize}
  \\end{itemize}
  \\begin{center}x\\end{center}
\\end{frame}`),
    );
    const frame = doc.body.find((element) => element.type === "frame");
    if (frame?.type !== "frame") throw new Error("frame missing");
    expect(frame.body.map((block) => [block.type, isDetachableBlock(block)])).toEqual([
      ["list", false],
      ["list", true],
      ["center", false],
    ]);
  });
});
