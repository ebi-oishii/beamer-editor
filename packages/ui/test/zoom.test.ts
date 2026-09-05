import { describe, expect, it } from "vitest";
import { stepZoom } from "../src/preview/zoom.js";

describe("stepZoom", () => {
  it("下限で縮小しても 0.25 を下回らない", () => {
    expect(stepZoom(0.25, 1, -1)).toBe(0.25);
  });

  it("fit の現在倍率から 0.1 刻みで増減する", () => {
    expect(stepZoom("fit", 0.65, -1)).toBe(0.55);
    expect(stepZoom("fit", 0.65, 1)).toBe(0.75);
  });

  it("上限で拡大しても 3 を超えない", () => {
    expect(stepZoom(3, 1, 1)).toBe(3);
  });
});
