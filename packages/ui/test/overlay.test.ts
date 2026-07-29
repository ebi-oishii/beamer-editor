import { describe, expect, it } from "vitest";
import { isVisibleAtStep } from "../src/preview/overlay.js";

describe("isVisibleAtStep", () => {
  it("属性が無ければ常に可視", () => {
    expect(isVisibleAtStep({}, 1)).toBe(true);
    expect(isVisibleAtStep({ min: null, overlay: null }, 5)).toBe(true);
  });

  it("min: step >= min で可視", () => {
    expect(isVisibleAtStep({ min: "3" }, 2)).toBe(false);
    expect(isVisibleAtStep({ min: "3" }, 3)).toBe(true);
    expect(isVisibleAtStep({ min: "3" }, 4)).toBe(true);
  });

  it("overlay: 範囲内なら可視", () => {
    expect(isVisibleAtStep({ overlay: "2-4" }, 1)).toBe(false);
    expect(isVisibleAtStep({ overlay: "2-4" }, 2)).toBe(true);
    expect(isVisibleAtStep({ overlay: "2-4" }, 4)).toBe(true);
    expect(isVisibleAtStep({ overlay: "2-4" }, 5)).toBe(false);
  });

  it("overlay: 複数範囲のいずれかに入れば可視", () => {
    expect(isVisibleAtStep({ overlay: "1-1,3-4" }, 2)).toBe(false);
    expect(isVisibleAtStep({ overlay: "1-1,3-4" }, 3)).toBe(true);
  });

  it("overlay: to 空は +∞（from 以降ずっと可視）", () => {
    expect(isVisibleAtStep({ overlay: "3-" }, 2)).toBe(false);
    expect(isVisibleAtStep({ overlay: "3-" }, 3)).toBe(true);
    expect(isVisibleAtStep({ overlay: "3-" }, 99)).toBe(true);
  });
});
