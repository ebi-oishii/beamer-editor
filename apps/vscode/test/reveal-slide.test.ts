import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RenderOutcome } from "../src/document-controller";
import {
  frameIndexAtSourceOffset,
  frameLensPositions,
  sourceHasFrameAt,
} from "../src/reveal-slide";

const frame = (index: number, start: number, end: number) => ({
  index,
  label: null,
  titleText: `f${index}`,
  html: "",
  stepCount: 1,
  isRaw: false,
  sourceSpan: { start, end },
});

/** 展開後 = 元ソース(逐語)の対応で、frame が 2 つある結果。 */
const outcome: RenderOutcome = {
  deck: { title: "t", css: "", frames: [frame(1, 10, 30), frame(2, 40, 60)] },
  version: 3,
  expansionMap: [
    { expandedStart: 0, expandedEnd: 100, sourceStart: 0, sourceEnd: 100, exact: true },
  ],
  expandDiagnostics: [],
};

describe("frameIndexAtSourceOffset", () => {
  it("フレーム範囲内(先頭を含み終端を含まない)の offset を index に解く", () => {
    expect(frameIndexAtSourceOffset(outcome, 10)).toBe(0);
    expect(frameIndexAtSourceOffset(outcome, 29)).toBe(0);
    expect(frameIndexAtSourceOffset(outcome, 40)).toBe(1);
    expect(frameIndexAtSourceOffset(outcome, 59)).toBe(1);
  });

  it("どのフレームにも属さない位置(プリアンブル・フレーム間・末尾)は null", () => {
    expect(frameIndexAtSourceOffset(outcome, 0)).toBeNull();
    expect(frameIndexAtSourceOffset(outcome, 35)).toBeNull();
    expect(frameIndexAtSourceOffset(outcome, 60)).toBeNull();
  });
});

describe("frameLensPositions", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../../fixtures/basic.slide.tex", import.meta.url)),
    "utf8",
  );
  const lines = source.split("\n");
  const positionAt = (offset: number) => ({
    line: source.slice(0, offset).split("\n").length - 1,
  });

  it("各 \\begin{frame} の行に 1 つずつ置く", () => {
    const positions = frameLensPositions(source, positionAt);
    expect(positions.length).toBe(lines.filter((line) => line.includes("\\begin{frame}")).length);
    for (const { offset, line } of positions) {
      expect(source.startsWith("\\begin{frame}", offset)).toBe(true);
      expect(lines[line]).toContain("\\begin{frame}");
    }
  });
});

describe("sourceHasFrameAt", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../../fixtures/basic.slide.tex", import.meta.url)),
    "utf8",
  );

  it("フレームの中だけ true で、プリアンブルとフレーム間は false", () => {
    const begin = source.indexOf("\\begin{frame}");
    expect(sourceHasFrameAt(source, begin)).toBe(true);
    expect(sourceHasFrameAt(source, begin + "\\begin{frame}".length)).toBe(true);
    expect(sourceHasFrameAt(source, 0)).toBe(false);
    expect(sourceHasFrameAt(source, begin - 1)).toBe(false);
    const afterFirst = source.indexOf("\\end{frame}") + "\\end{frame}".length;
    expect(sourceHasFrameAt(source, afterFirst)).toBe(false);
  });
});
