import { describe, expect, it } from "vitest";
import { canvasPointFromPointer, normalizeCanvasCoordinate } from "../src/preview/canvas-drag.js";

describe("canvasPointFromPointer", () => {
  it("拡大率を別途割らず rect と grab offset から論理位置を出す", () => {
    expect(
      canvasPointFromPointer({ left: 100, top: 50, width: 400, height: 200 }, 80, 310, 20, 10),
    ).toEqual({ x: -0.1, y: 1.25 });
    // fit/manual zoom 後の rect でも同じ割合なら結果は同じ。
    expect(
      canvasPointFromPointer({ left: 200, top: 100, width: 800, height: 400 }, 160, 620, 40, 20),
    ).toEqual({ x: -0.1, y: 1.25 });
  });
  it("ゼロ寸法は拒否する", () => {
    expect(canvasPointFromPointer({ left: 0, top: 0, width: 0, height: 1 }, 0, 0, 0, 0)).toBeNull();
  });
  it("3桁丸めは -0 と範囲外値を保持する", () => {
    expect(normalizeCanvasCoordinate(-0.0004)).toBe(0);
    expect(normalizeCanvasCoordinate(-0.5004)).toBe(-0.5);
    expect(normalizeCanvasCoordinate(1.2346)).toBe(1.235);
  });
});

describe("canvasPointFromPointer: width を渡すと本文領域に収める(#111)", () => {
  const rect = { left: 0, top: 0, width: 400, height: 200 };
  it("左上・右下にはみ出した位置は端で止まる", () => {
    expect(canvasPointFromPointer(rect, -20, -10, 0, 0, 0.3)).toEqual({ x: 0, y: 0 });
    expect(canvasPointFromPointer(rect, 380, 250, 0, 0, 0.3)).toEqual({ x: 0.7, y: 1 });
    // 範囲内はそのまま。
    expect(canvasPointFromPointer(rect, 100, 100, 0, 0, 0.3)).toEqual({ x: 0.25, y: 0.5 });
  });
  it("width を渡さなければ従来どおり生の座標", () => {
    expect(canvasPointFromPointer(rect, -20, 250, 0, 0)).toEqual({ x: -0.05, y: 1.25 });
  });
});
