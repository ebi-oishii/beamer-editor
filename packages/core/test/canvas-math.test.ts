import { describe, expect, it } from "vitest";
import { detachBlockToCanvas } from "../src/canvas-detach.js";
import { formatDeck } from "../src/formatter.js";
import { lintSource } from "../src/linter.js";
import { parseDeck } from "../src/parser.js";

const expressions = [
  String.raw`\[a^2+b^2=c^2\]`,
  ...["equation", "equation*", "align", "align*"].map(
    (kind) =>
      `\\begin{${kind}}\na ${kind.startsWith("align") ? "&" : ""}= b % keep math comment\n\\end{${kind}}`,
  ),
];
const deck = (body: string) =>
  `\\documentclass[aspectratio=169]{beamer}\n\\begin{document}\n\\begin{frame}[label=math]\n${body}\n\\end{frame}\n\\end{document}`;
const canvas = (body: string) =>
  `\\begin{deckcanvas}\n\\begin{decktext}[x=.1,y=.2,w=.5]\n${body}\n\\end{decktext}\n\\end{deckcanvas}`;
const semantic = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(semantic)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== "span")
            .map(([key, child]) => [key, semantic(child)]),
        )
      : value;

describe("decktext display math", () => {
  it.each(expressions)("parses, formats and detaches %s without losing content", (expression) => {
    const source = deck(`% before\n${expression}\n% after`);
    const frame = parseDeck(source).body.find((node) => node.type === "frame");
    if (frame?.type !== "frame") throw new Error("frame missing");
    const math = frame.body.find((node) => node.type === "displayMath");
    if (!math) throw new Error("math missing");
    expect(source.slice(math.span.start, math.span.end)).toBe(expression);
    const replacement = detachBlockToCanvas(source, math.span, { x: 0.1, y: 0.2, width: 0.5 });
    if (!replacement) throw new Error("detach rejected");
    const moved =
      source.slice(0, replacement.span.start) +
      replacement.text +
      source.slice(replacement.span.end);
    expect(moved).toContain("% before");
    expect(moved).toContain("% after");
    const parsed = parseDeck(deck(canvas(expression)));
    const targetFrame = parsed.body.find((node) => node.type === "frame");
    const targetCanvas =
      targetFrame?.type === "frame"
        ? targetFrame.body.find((node) => node.type === "canvas")
        : undefined;
    expect(targetCanvas?.items[0]).toMatchObject({
      type: "canvasText",
      children: [semantic(math)],
    });
    expect(lintSource(moved).filter(({ code }) => code === "L014")).toEqual([]);
    const formatted = formatDeck(moved);
    expect(formatDeck(formatted)).toBe(formatted);
    expect(semantic(parseDeck(formatted))).toEqual(semantic(parseDeck(moved)));
    const movedFrame = parseDeck(moved).body.find((node) => node.type === "frame");
    const movedCanvas =
      movedFrame?.type === "frame"
        ? movedFrame.body.find((node) => node.type === "canvas")
        : undefined;
    const text = movedCanvas?.items[0];
    if (text?.type !== "canvasText") throw new Error("text missing");
    expect(semantic(text.children[0])).toEqual(semantic(math));
  });

  it("allows math in lists and retains the existing overlay and unsupported-content restrictions", () => {
    expect(
      lintSource(deck(canvas(String.raw`\begin{itemize}\item \[x=1\]\end{itemize}`))).filter(
        ({ code }) => code === "L014",
      ),
    ).toEqual([]);
    expect(
      lintSource(deck(canvas(String.raw`\begin{block}{B}text\end{block}`))).some(
        ({ code }) => code === "L014",
      ),
    ).toBe(true);
    const source = deck(String.raw`\[x=1\]\pause text`);
    const frame = parseDeck(source).body.find((node) => node.type === "frame");
    if (frame?.type !== "frame") throw new Error("frame missing");
    const first = frame.body[0];
    if (!first) throw new Error("math missing");
    expect(detachBlockToCanvas(source, first.span, { x: 0, y: 0, width: 0.5 })).toBeNull();
  });
});
