import { describe, expect, it } from "vitest";
import type { SourceSpan } from "../src/ast.js";
import {
  canvasObjectSource,
  parseCanvasClipboard,
  pasteCanvasObjects,
  removeCanvasObject,
} from "../src/canvas-clipboard.js";
import { formatDeck } from "../src/formatter.js";
import { lintSource } from "../src/linter.js";
import { parseDeck } from "../src/parser.js";

const PREAMBLE = "\\documentclass[aspectratio=169]{beamer}\n\\begin{document}\n";
const deck = (...frames: string[]) => `${PREAMBLE}${frames.join("\n")}\n\\end{document}\n`;

const TEXT = `\\begin{decktext}[x=0.100,y=0.200,w=0.400,size=normal]
  Hello \\textbf{world}
\\end{decktext}`;
const IMAGE = "\\deckimage[x=0.500,y=0.100,w=0.300]{assets/a.png}";

const CANVAS_FRAME = `\\begin{frame}[label=canvas-1]{T}
  \\begin{deckcanvas}
    \\begin{decktext}[x=0.100,y=0.200,w=0.400,size=normal]
      Hello \\textbf{world}
    \\end{decktext}
    ${IMAGE}
  \\end{deckcanvas}
\\end{frame}`;

/** frame 内の n 番目(0 起点)のキャンバス要素の options span。 */
function optionsSpanOf(source: string, index: number): SourceSpan {
  for (const element of parseDeck(source).body) {
    if (element.type !== "frame") continue;
    for (const block of element.body) {
      if (block.type !== "canvas") continue;
      const item = block.items[index];
      if (!item || item.type === "rawBlock") throw new Error("fixture missing");
      return item.position.span;
    }
  }
  throw new Error("fixture missing");
}

function must<T>(value: T | null): T {
  if (value === null) throw new Error("expected a result");
  return value;
}

function apply(source: string, replacement: { span: SourceSpan; text: string }): string {
  return `${source.slice(0, replacement.span.start)}${replacement.text}${source.slice(replacement.span.end)}`;
}

function frameOffsetOf(source: string, index: number): number {
  const frames = parseDeck(source).body.filter((element) => element.type === "frame");
  const frame = frames[index];
  if (!frame) throw new Error("fixture missing");
  return frame.span.start;
}

describe("canvasObjectSource", () => {
  it("要素の原文を、先頭行の字下げを外して返す", () => {
    const source = deck(CANVAS_FRAME);
    expect(canvasObjectSource(source, optionsSpanOf(source, 0))).toBe(TEXT);
    expect(canvasObjectSource(source, optionsSpanOf(source, 1))).toBe(IMAGE);
  });

  it("options span に一致する要素が無ければ null", () => {
    const source = deck(CANVAS_FRAME);
    expect(canvasObjectSource(source, { start: 0, end: 5 })).toBeNull();
  });
});

describe("removeCanvasObject", () => {
  it("行を占有する要素は改行ごと消し、他の要素と deckcanvas は残る", () => {
    const source = deck(CANVAS_FRAME);
    const removed = apply(source, must(removeCanvasObject(source, optionsSpanOf(source, 0))));
    expect(removed).toBe(
      deck(`\\begin{frame}[label=canvas-1]{T}
  \\begin{deckcanvas}
    ${IMAGE}
  \\end{deckcanvas}
\\end{frame}`),
    );
    expect(lintSource(removed).map(({ code }) => code)).toEqual(
      lintSource(source).map(({ code }) => code),
    );
  });

  it("最後の要素を消しても空の deckcanvas は残す", () => {
    const source = deck(`\\begin{frame}[label=c]{T}
  \\begin{deckcanvas}
    ${IMAGE}
  \\end{deckcanvas}
\\end{frame}`);
    const removed = apply(source, must(removeCanvasObject(source, optionsSpanOf(source, 0))));
    expect(removed).toContain("  \\begin{deckcanvas}\n  \\end{deckcanvas}\n");
  });

  it("同じ行に別の要素があるときは、その要素と直前の空白だけを消す", () => {
    const source = deck(`\\begin{frame}[label=c]{T}
  \\begin{deckcanvas}
    \\deckimage[x=0.100,y=0.100,w=0.200]{a.png} \\deckimage[x=0.500,y=0.100,w=0.200]{b.png}
  \\end{deckcanvas}
\\end{frame}`);
    const removed = apply(source, must(removeCanvasObject(source, optionsSpanOf(source, 1))));
    expect(removed).toContain(
      "    \\deckimage[x=0.100,y=0.100,w=0.200]{a.png}\n  \\end{deckcanvas}",
    );
  });

  it("CRLF 文書でも行ごと消す", () => {
    const source = deck(CANVAS_FRAME).replace(/\n/g, "\r\n");
    const removed = apply(source, must(removeCanvasObject(source, optionsSpanOf(source, 1))));
    expect(removed).toBe(
      deck(`\\begin{frame}[label=canvas-1]{T}
  \\begin{deckcanvas}
    \\begin{decktext}[x=0.100,y=0.200,w=0.400,size=normal]
      Hello \\textbf{world}
    \\end{decktext}
  \\end{deckcanvas}
\\end{frame}`).replace(/\n/g, "\r\n"),
    );
  });

  it("見つからなければ null", () => {
    expect(removeCanvasObject(deck(CANVAS_FRAME), { start: 0, end: 5 })).toBeNull();
  });
});

describe("parseCanvasClipboard", () => {
  it("decktext / deckimage の列を位置付きで読む", () => {
    const objects = must(parseCanvasClipboard(`${TEXT}\n${IMAGE}`));
    expect(objects.map((object) => object.text)).toEqual([TEXT, IMAGE]);
    expect(objects[0]?.position).toEqual({ x: 0.1, y: 0.2, width: 0.4 });
    expect(objects[1]?.position).toEqual({ x: 0.5, y: 0.1, width: 0.3 });
    const image = objects[1] as { text: string; options: SourceSpan };
    expect(image.text.slice(image.options.start, image.options.end)).toBe(
      "[x=0.500,y=0.100,w=0.300]",
    );
  });

  it("要素でない文字列・空・生の環境は null", () => {
    expect(parseCanvasClipboard("just some text")).toBeNull();
    expect(parseCanvasClipboard("   \n")).toBeNull();
    expect(parseCanvasClipboard(`${IMAGE}\n\\begin{tikzpicture}\\end{tikzpicture}`)).toBeNull();
    expect(parseCanvasClipboard("\\begin{decktext}no options\\end{decktext}")).toBeNull();
  });
});

describe("pasteCanvasObjects", () => {
  const TARGET = `\\begin{frame}[label=target]{U}
  \\begin{deckcanvas}
    \\deckimage[x=0.700,y=0.700,w=0.200]{assets/b.png}
  \\end{deckcanvas}
\\end{frame}`;

  it("別のフレームへは同じ位置に貼り付け、既存の deckcanvas の末尾へ入れる", () => {
    const source = deck(CANVAS_FRAME, TARGET);
    const pasted = apply(source, must(pasteCanvasObjects(source, frameOffsetOf(source, 1), TEXT)));
    expect(pasted).toBe(
      deck(
        CANVAS_FRAME,
        `\\begin{frame}[label=target]{U}
  \\begin{deckcanvas}
    \\deckimage[x=0.700,y=0.700,w=0.200]{assets/b.png}
    \\begin{decktext}[x=0.100,y=0.200,w=0.400,size=normal]
      Hello \\textbf{world}
    \\end{decktext}
  \\end{deckcanvas}
\\end{frame}`,
      ),
    );
    expect(formatDeck(pasted)).toBe(pasted);
  });

  it("同じ位置に要素があれば重ならないように右下へずらし、繰り返すとさらにずれる", () => {
    const source = deck(CANVAS_FRAME);
    const once = apply(source, must(pasteCanvasObjects(source, frameOffsetOf(source, 0), IMAGE)));
    expect(once).toContain(
      "    \\deckimage[x=0.520,y=0.120,w=0.300]{assets/a.png}\n  \\end{deckcanvas}",
    );
    const twice = apply(once, must(pasteCanvasObjects(once, frameOffsetOf(once, 0), IMAGE)));
    expect(twice).toContain(
      "    \\deckimage[x=0.540,y=0.140,w=0.300]{assets/a.png}\n  \\end{deckcanvas}",
    );
    expect(lintSource(twice).filter(({ severity }) => severity === "error")).toEqual([]);
  });

  it("右端で止まり、ずらしても本文領域からはみ出さない", () => {
    const wide = "\\deckimage[x=0.700,y=0.900,w=0.300]{assets/w.png}";
    const source = deck(`\\begin{frame}[label=c]{T}
  \\begin{deckcanvas}
    ${wide}
  \\end{deckcanvas}
\\end{frame}`);
    const pasted = apply(source, must(pasteCanvasObjects(source, frameOffsetOf(source, 0), wide)));
    // x は 1 - w=0.300 が上限(0.700)で動けないので、y だけ下がる。
    expect(pasted).toContain("\\deckimage[x=0.700,y=0.920,w=0.300]{assets/w.png}");
    expect(lintSource(pasted).filter(({ code }) => code === "L012")).toEqual([]);
  });

  it("deckcanvas の無いフレームには新設し、label が無ければ付ける", () => {
    const source = deck(
      CANVAS_FRAME,
      `\\begin{frame}{Plain}
  Some flow text.
\\end{frame}`,
    );
    const pasted = apply(
      source,
      must(pasteCanvasObjects(source, frameOffsetOf(source, 1), `${TEXT}\n${IMAGE}`)),
    );
    expect(pasted).toBe(
      deck(
        CANVAS_FRAME,
        `\\begin{frame}[label=canvas-2]{Plain}
  Some flow text.
  \\begin{deckcanvas}
    \\begin{decktext}[x=0.100,y=0.200,w=0.400,size=normal]
      Hello \\textbf{world}
    \\end{decktext}
    ${IMAGE}
  \\end{deckcanvas}
\\end{frame}`,
      ),
    );
    expect(lintSource(pasted).map(({ code }) => code)).not.toContain("L011");
    expect(formatDeck(pasted)).toBe(pasted);
  });

  it("CRLF 文書では CRLF で入れる", () => {
    const source = deck(CANVAS_FRAME).replace(/\n/g, "\r\n");
    const pasted = apply(source, must(pasteCanvasObjects(source, frameOffsetOf(source, 0), TEXT)));
    expect(pasted).not.toMatch(/[^\r]\n/);
    expect(pasted).toContain("    \\begin{decktext}[x=0.120,y=0.220,w=0.400,size=normal]\r\n");
  });

  it("要素でないクリップボード・フレーム外の位置・deckcanvas が 2 つのフレームは null", () => {
    const source = deck(CANVAS_FRAME);
    expect(pasteCanvasObjects(source, frameOffsetOf(source, 0), "plain text")).toBeNull();
    expect(pasteCanvasObjects(source, 0, IMAGE)).toBeNull();
    const twoCanvases = deck(`\\begin{frame}[label=c]{T}
  \\begin{deckcanvas}
  \\end{deckcanvas}
  \\begin{deckcanvas}
  \\end{deckcanvas}
\\end{frame}`);
    expect(pasteCanvasObjects(twoCanvases, frameOffsetOf(twoCanvases, 0), IMAGE)).toBeNull();
  });
});
