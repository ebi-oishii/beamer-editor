import { describe, expect, it } from "vitest";
import { canvasImagePositionReplacement, updateCanvasImagePosition } from "../src/canvas-edit.js";

describe("updateCanvasImagePosition", () => {
  it("x/y だけを丸め、w と空白を維持する", () => {
    const source = "\\deckimage[ x = -0 , y=1.2, w = .4 ]{same.png}";
    const start = source.indexOf("[");
    const end = source.indexOf("]") + 1;
    expect(updateCanvasImagePosition(source, { start, end }, -0, 1.23456)).toBe(
      "\\deckimage[ x = 0.000 , y=1.235, w = .4 ]{same.png}",
    );
  });
  it("範囲外座標を clamp せず、x/y 欠落・不正 span は拒否する", () => {
    const source = "\\deckimage[x=0,y=0,w=.4]{a.png}";
    const span = { start: source.indexOf("["), end: source.indexOf("]") + 1 };
    expect(updateCanvasImagePosition(source, span, -0.5, 1.25)).toContain("x=-0.500,y=1.250,w=.4");
    const missing = "\\deckimage[x=0,w=.4]{a.png}";
    expect(
      updateCanvasImagePosition(
        missing,
        { start: missing.indexOf("["), end: missing.indexOf("]") + 1 },
        0,
        0,
      ),
    ).toBeNull();
    expect(updateCanvasImagePosition(source, { start: 0, end: source.length }, 0, 0)).toBeNull();
  });
  it("replacement は長短どちらでも options 全体を返し、w/spacing を保つ", () => {
    expect(canvasImagePositionReplacement("[x=.1, y=12.34567, w = .4]", 0.1, 0)).toBe(
      "[x=0.100, y=0.000, w = .4]",
    );
    expect(canvasImagePositionReplacement("[x=0,y=0,w=.4]", -0.0004, 0)).toContain("x=0.000");
    expect(canvasImagePositionReplacement("[x=123.456, y=.2,w=.4]", 0, 0.2)).toBe(
      "[x=0.000, y=0.200,w=.4]",
    );
  });
});
