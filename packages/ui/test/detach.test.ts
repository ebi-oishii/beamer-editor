import { describe, expect, it } from "vitest";
import { clampMenuPosition } from "../src/preview/detach.js";

describe("clampMenuPosition", () => {
  const size = { width: 220, height: 80 };
  const viewport = { width: 800, height: 600 };

  it("収まるならクリック位置のまま", () => {
    expect(clampMenuPosition(100, 100, size, viewport)).toEqual({ x: 100, y: 100 });
  });

  it("右端・下端ではクリック位置の左・上へ反転する", () => {
    expect(clampMenuPosition(700, 100, size, viewport)).toEqual({ x: 480, y: 100 });
    expect(clampMenuPosition(100, 580, size, viewport)).toEqual({ x: 100, y: 500 });
  });

  it("反転しても収まらなければ画面内へ clamp する", () => {
    expect(clampMenuPosition(100, 40, { width: 220, height: 700 }, viewport)).toEqual({
      x: 100,
      y: 4,
    });
    expect(clampMenuPosition(2, 2, size, viewport)).toEqual({ x: 4, y: 4 });
  });
});
