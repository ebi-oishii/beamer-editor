import { describe, expect, it } from "vitest";
import { stepZoom, wheelDeltaPixels, wheelZoom } from "../src/preview/zoom.js";

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

describe("wheelZoom", () => {
  it("マウスの 1 ノッチ(100px)でおよそ 10% 変わり、逆向きで元に戻る", () => {
    expect(wheelZoom(1, 1, -100)).toBe(1.105);
    expect(wheelZoom(1.105, 1, 100)).toBe(1);
  });

  it("ピンチの小さな delta は小さく効き、丸めで消えない", () => {
    expect(wheelZoom(1, 1, -5)).toBe(1.005);
    expect(wheelZoom(1, 1, 5)).toBe(0.995);
  });

  it("1 フレームの delta は上限で頭打ちになり、倍率は範囲内に収まる", () => {
    expect(wheelZoom(1, 1, -5000)).toBe(wheelZoom(1, 1, -250));
    expect(wheelZoom(0.25, 1, 100)).toBe(0.25);
    expect(wheelZoom(3, 1, -100)).toBe(3);
  });

  it("fit からは現在の fit 倍率を基準にする", () => {
    expect(wheelZoom("fit", 0.5, -100)).toBe(0.553);
  });

  it("行・ページ単位の delta は px に換算する", () => {
    expect(wheelDeltaPixels(3, 1)).toBe(48);
    expect(wheelDeltaPixels(1, 2)).toBe(400);
    expect(wheelDeltaPixels(-7, 0)).toBe(-7);
  });
});
