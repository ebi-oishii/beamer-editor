import { describe, expect, it } from "vitest";
import { frameLabel, framesOf, type SlideEditAction } from "../src/index.js";
import { parseDeck } from "../src/parser.js";
import { editSlide } from "../src/slide-edit.js";

const frame = (title: string, options = "") =>
  `\\begin{frame}${options}{${title}}\n${title} body\n\\end{frame}`;
const deck = (body: string) =>
  `%% deck-source-version: 1\n\\documentclass{beamer}\n\\begin{document}\n${body}\n\\end{document}\n`;
function apply(source: string, action: SlideEditAction, index?: number) {
  const start = index === undefined ? undefined : framesOf(parseDeck(source))[index]?.span.start;
  const result = editSlide(source, action, start);
  if (!result.ok) throw new Error(result.reason);
  for (const { span, text } of [...result.edits].sort((a, b) => b.span.start - a.span.start))
    source = source.slice(0, span.start) + text + source.slice(span.end);
  return source;
}
function labels(source: string) {
  return framesOf(parseDeck(source)).map(frameLabel);
}

describe("slide source edits", () => {
  it("reorders original bytes with attached comments, leaving sections and opaque inter-frame code in place", () => {
    const a = `% A 😀\n${frame("A", "[label=a]")} % tail A\n`;
    const b = `% B\n${frame("B", "[unknown,label=b]")} % tail B\n`;
    const between = "\n\\section{Next}\n\\unknown{keep me}\n\n";
    const source = deck(a + between + b);
    const moved = apply(source, "moveDown", 0);
    expect(moved).toBe(deck(b + between + a));
    expect(labels(moved)).toEqual(["b", "a"]);
    expect(apply(moved, "moveUp", 1)).toBe(source);
  });
  it("duplicates a labeled frame with a fresh address and preserves its body and options", () => {
    const source = deck(
      `${frame("A", "[fragile,label=slide-1,plain]")}\n${frame("B", "[label=slide-2]")}`,
    );
    const next = apply(source, "duplicate", 0);
    expect(labels(next)).toEqual(["slide-1", "slide-3", "slide-2"]);
    expect(next).toContain(frame("A", "[fragile,label=slide-3,plain]"));
  });
  it("copies an opaque frame and ignores a fake frame token inside an attached comment", () => {
    const source = deck(`% example: \\begin{frame} 😀\n${frame("Raw", "[unsupported,label=r]")}`);
    const next = apply(source, "duplicate", 0);
    expect(next.match(/% example: \\begin\{frame\} 😀/g)).toHaveLength(2);
    expect(labels(next)).toEqual(["r", "slide-1"]);
    expect(next).toContain(frame("Raw", "[unsupported,label=slide-1]"));
  });
  it("adds a label to an unlabeled copy and supports adjacent frames without newlines", () => {
    const source = deck(frame("A") + frame("B"));
    expect(labels(apply(source, "duplicate", 0))).toEqual([null, "slide-1", null]);
    expect(apply(source, "delete", 0)).toBe(deck(frame("B")));
  });
  it("inserts after the selected frame and appends when no item is supplied", () => {
    const source = deck(`${frame("A", "[label=a]")}\n${frame("B", "[label=b]")}`);
    expect(labels(apply(source, "insert", 0))).toEqual(["a", "slide-1", "b"]);
    expect(labels(apply(source, "insert"))).toEqual(["a", "b", "slide-1"]);
  });
  it("can delete the final frame and insert into an empty deck, preserving preamble and sections", () => {
    const source = deck(`\\section{Keep}\n% note\n${frame("A")} % tail\n`);
    const empty = apply(source, "delete", 0);
    expect(empty).toBe(deck("\\section{Keep}\n"));
    expect(labels(apply(empty, "insert"))).toEqual(["slide-1"]);
  });
  it("preserves CRLF and Unicode through insertion and duplication", () => {
    const source = deck(`% 😀\n${frame("日本語")}`).replace(/\n/g, "\r\n");
    for (const action of ["insert", "duplicate"] as const) {
      const next = apply(source, action, 0);
      expect(next).not.toMatch(/(?<!\r)\n/);
      expect(next).toContain("日本語");
      expect(framesOf(parseDeck(next))).toHaveLength(2);
    }
  });
  it("refuses stale offsets, missing document boundaries, broken frames, and ambiguous duplicate headers", () => {
    const source = deck(frame("A"));
    expect(editSlide(source, "delete", 1).ok).toBe(false);
    expect(editSlide(frame("A"), "insert").ok).toBe(false);
    expect(editSlide(deck("\\begin{frame}{Broken}"), "insert").ok).toBe(false);
    const bad = deck(frame("A", "[label=a,label=b]"));
    expect(editSlide(bad, "duplicate", framesOf(parseDeck(bad))[0]?.span.start).ok).toBe(false);
  });
  it("does not duplicate internal TeX reference targets", () => {
    const source = deck(frame("A").replace("A body", "\\label{eq:one} $x=1$"));
    expect(editSlide(source, "duplicate", framesOf(parseDeck(source))[0]?.span.start).ok).toBe(
      false,
    );
    expect(labels(apply(source, "moveUp", 0))).toHaveLength(1);
  });
  it("does not create edits when moving past an edge", () => {
    const source = deck(frame("A"));
    for (const action of ["moveUp", "moveDown"] as const)
      expect(editSlide(source, action, framesOf(parseDeck(source))[0]?.span.start)).toEqual({
        ok: true,
        edits: [],
      });
  });
  it("does not expand or mutate macro definitions or opaque content", () => {
    const source = deck(
      frame("A").replace(
        "A body",
        "\\custom{keep}\n\\begin{verbatim}\n  % text 😀\n\\end{verbatim}",
      ),
    );
    const next = apply(source, "duplicate", 0);
    expect(next.match(/\\custom\{keep\}/g)).toHaveLength(2);
    expect(next.match(/ {2}% text 😀/g)).toHaveLength(2);
  });
});
