import { describe, expect, it } from "vitest";
import {
  CANVAS_MIN_WIDTH,
  canvasPositionReplacement,
  clampCanvasPlacement,
  clampCanvasPosition,
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

describe("clampCanvasPosition", () => {
  it("左上へはみ出した位置を本文領域の端で止める", () => {
    expect(clampCanvasPosition(-0.002, -0.5, 1)).toEqual({ x: 0, y: 0 });
  });
  it("右端は x + width が 1 を超えない位置で止める", () => {
    expect(clampCanvasPosition(0.9, 0.2, 0.4)).toEqual({ x: 0.6, y: 0.2 });
    expect(clampCanvasPosition(0.3, 0.2, 1)).toEqual({ x: 0, y: 0.2 });
  });
  it("下端は y=1 で止める", () => {
    expect(clampCanvasPosition(0.1, 1.25, 0.4)).toEqual({ x: 0.1, y: 1 });
  });
  it("範囲内の位置は変えない", () => {
    expect(clampCanvasPosition(0.05, 0.15, 0.5)).toEqual({ x: 0.05, y: 0.15 });
  });
  it("幅が不正なら x を [0, 1] に収めるだけにする", () => {
    expect(clampCanvasPosition(1.5, 0.2, Number.NaN)).toEqual({ x: 1, y: 0.2 });
  });
});

describe("clampCanvasPlacement", () => {
  it("位置と幅の両方を本文領域内へ収める", () => {
    expect(clampCanvasPlacement({ x: -0.2, y: -0.1, width: 1.5 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
    });
    expect(clampCanvasPlacement({ x: 0.8, y: 0.2, width: 0.5 })).toEqual({
      x: 0.8,
      y: 0.2,
      width: 0.2,
    });
  });
  it("極端に細い箱は最小幅まで広げる", () => {
    expect(clampCanvasPlacement({ x: 0.1, y: 0.1, width: 0 }).width).toBe(CANVAS_MIN_WIDTH);
  });
  it("clamp の結果は 3 桁表現のまま x + width <= 1 を保つ", () => {
    // 丸めずに clamp すると 1 - 0.8 が 0.19999999999999996 になり、
    // 3 桁化で 0.800 + 0.200 へ振れて L012 の x + width <= 1 を割る。
    for (const x of [0.8, 0.3335, 0.6667, 0.9499]) {
      const placement = clampCanvasPlacement({ x, y: 0.5, width: 1 });
      expect(placement.width).toBe(Number(placement.width.toFixed(3)));
      expect(placement.x + placement.width).toBeLessThanOrEqual(1);
    }
  });
});

describe("clamp の結果はそのまま lint L012 を通る", () => {
  const cases = [
    { x: -0.002, y: 0.121, width: 1 },
    { x: 1.4, y: -0.3, width: 0.333 },
    { x: 0.9995, y: 1.9, width: 0.667 },
  ];
  it("移動でも自由配置化でも x >= 0 / y in [0,1] / x + width <= 1 を満たす", () => {
    for (const { x, y, width } of cases) {
      const moved = clampCanvasPosition(x, y, width);
      expect(moved.x).toBeGreaterThanOrEqual(0);
      expect(moved.y).toBeGreaterThanOrEqual(0);
      expect(moved.y).toBeLessThanOrEqual(1);
      expect(moved.x + width).toBeLessThanOrEqual(1);

      const placed = clampCanvasPlacement({ x, y, width });
      expect(placed.x).toBeGreaterThanOrEqual(0);
      expect(placed.y).toBeGreaterThanOrEqual(0);
      expect(placed.y).toBeLessThanOrEqual(1);
      expect(placed.width).toBeGreaterThan(0);
      expect(placed.x + placed.width).toBeLessThanOrEqual(1);
    }
  });
});
