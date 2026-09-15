import { describe, expect, it } from "vitest";
import {
  MAX_RASTER_PIXELS,
  MAX_RASTER_SIDE,
  RASTER_SCALE,
  rasterScaleFor,
} from "../src/raster-scale";

describe("rasterScaleFor", () => {
  it("普通の大きさの図は既定の倍率で描く", () => {
    expect(rasterScaleFor(300, 200)).toBe(RASTER_SCALE);
  });

  it("1 辺が上限を超えるなら、辺が上限に収まる倍率まで下げる", () => {
    const scale = rasterScaleFor(3000, 100);
    expect(scale).not.toBeNull();
    expect((scale as number) * 3000).toBeLessThanOrEqual(MAX_RASTER_SIDE);
    expect(scale).toBeLessThan(RASTER_SCALE);
  });

  it("総画素数が上限を超えるなら、画素数が上限に収まる倍率まで下げる", () => {
    const scale = rasterScaleFor(2000, 2000);
    expect(scale).not.toBeNull();
    expect((scale as number) ** 2 * 2000 * 2000).toBeLessThanOrEqual(MAX_RASTER_PIXELS + 1);
  });

  it("上限に収めると 0.1 倍を切る巨大なページや、不正な寸法は描かない", () => {
    expect(rasterScaleFor(100_000, 100_000)).toBeNull();
    expect(rasterScaleFor(0, 100)).toBeNull();
    expect(rasterScaleFor(Number.NaN, 100)).toBeNull();
  });
});
