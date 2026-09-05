import { describe, expect, it } from "vitest";
import {
  canvasPositionReplacement,
  clampCanvasPlacement,
  clampCanvasPosition,
  MIN_CANVAS_WIDTH,
  updateCanvasPosition,
} from "../src/canvas-edit.js";

describe("updateCanvasPosition", () => {
  it("x/y だけを丸め、w と空白を維持する", () => {
    const source = "\\deckimage[ x = -0 , y=1.2, w = .4 ]{same.png}";
    const start = source.indexOf("[");
    const end = source.indexOf("]") + 1;
    expect(updateCanvasPosition(source, { start, end }, -0, 1.23456)).toBe(
      "\\deckimage[ x = 0.000 , y=1.235, w = .4 ]{same.png}",
    );
  });
  it("範囲外座標を clamp せず、x/y 欠落・不正 span は拒否する", () => {
    const source = "\\deckimage[x=0,y=0,w=.4]{a.png}";
    const span = { start: source.indexOf("["), end: source.indexOf("]") + 1 };
    expect(updateCanvasPosition(source, span, -0.5, 1.25)).toContain("x=-0.500,y=1.250,w=.4");
    const missing = "\\deckimage[x=0,w=.4]{a.png}";
    expect(
      updateCanvasPosition(
        missing,
        { start: missing.indexOf("["), end: missing.indexOf("]") + 1 },
        0,
        0,
      ),
    ).toBeNull();
    expect(updateCanvasPosition(source, { start: 0, end: source.length }, 0, 0)).toBeNull();
  });
  it("decktext の options(size 付き)でも x/y だけを置換する", () => {
    const source = "\\begin{decktext}[x=0.050,y=0.100,w=0.420,size=normal]";
    const span = { start: source.indexOf("["), end: source.indexOf("]") + 1 };
    expect(updateCanvasPosition(source, span, 0.3, 0.25)).toBe(
      "\\begin{decktext}[x=0.300,y=0.250,w=0.420,size=normal]",
    );
  });
  it("replacement は長短どちらでも options 全体を返し、w/spacing を保つ", () => {
    expect(canvasPositionReplacement("[x=.1, y=12.34567, w = .4]", 0.1, 0)).toBe(
      "[x=0.100, y=0.000, w = .4]",
    );
    expect(canvasPositionReplacement("[x=0,y=0,w=.4]", -0.0004, 0)).toContain("x=0.000");
    expect(canvasPositionReplacement("[x=123.456, y=.2,w=.4]", 0, 0.2)).toBe(
      "[x=0.000, y=0.200,w=.4]",
    );
  });
});

describe("clampCanvasPosition / clampCanvasPlacement", () => {
  it("移動は本文領域の端で止まる(右端は 1 - w、下端は 1)。幅は変えない", () => {
    expect(clampCanvasPosition(-0.002, 0.121, 1)).toEqual({ x: 0, y: 0.121 });
    expect(clampCanvasPosition(0.9, 1.25, 0.3)).toEqual({ x: 0.7, y: 1 });
    expect(clampCanvasPosition(0.2, 0.3, 0.3)).toEqual({ x: 0.2, y: 0.3 });
    // 幅が本文幅いっぱいなら x は 0 に固定される。
    expect(clampCanvasPosition(0.4, 0.5, 1)).toEqual({ x: 0, y: 0.5 });
    // 幅が不正でも例外にせず、下限幅として扱う。
    expect(clampCanvasPosition(0.99, 0, Number.NaN).x).toBe(1 - MIN_CANVAS_WIDTH);
  });

  it("自由配置化は幅も収める(下限あり、右端が 1 を超えない)", () => {
    expect(clampCanvasPlacement({ x: -0.1, y: -0.1, width: 0.01 })).toEqual({
      x: 0,
      y: 0,
      width: MIN_CANVAS_WIDTH,
    });
    const shrunk = clampCanvasPlacement({ x: 0.8, y: 0.5, width: 0.5 });
    expect(shrunk.x).toBe(0.8);
    expect(shrunk.y).toBe(0.5);
    expect(shrunk.width).toBeCloseTo(0.2, 10);
    const far = clampCanvasPlacement({ x: 2, y: 2, width: 2 });
    expect(far.x).toBeCloseTo(1 - MIN_CANVAS_WIDTH, 10);
    expect(far.y).toBe(1);
    expect(far.width).toBeCloseTo(MIN_CANVAS_WIDTH, 10);
  });
});
