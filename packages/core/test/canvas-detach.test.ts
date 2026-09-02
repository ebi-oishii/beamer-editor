import { describe, expect, it } from "vitest";
import type { BlockNode, SourceSpan } from "../src/ast.js";
import { detachBlockToCanvas, isDetachableBlock } from "../src/canvas-detach.js";
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
      ["list", false],
      ["center", false],
    ]);
  });
});
