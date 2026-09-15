import { describe, expect, it } from "vitest";
import { MIN_FIT_SCALE } from "../src/preview/scroll-layout.js";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  parseZoom,
  roundZoom,
  stepZoom,
  wheelDeltaPixels,
  wheelZoom,
  type ZoomState,
} from "../src/preview/zoom.js";

/** 手動倍率になっているはずの結果を数値として取り出す。 */
function manual(zoom: ZoomState): number {
  if (zoom === "fit") throw new Error("expected a manual zoom");
  return zoom;
}

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

  it("fit が下限より小さいときは、縮小しても fit のまま、拡大は fit から連続して動く", () => {
    expect(stepZoom("fit", 0.1, -1)).toBe("fit");
    expect(stepZoom("fit", 0.1, 1)).toBe(0.2);
  });

  it("fit より拡大した後も、縮小で fit の方向へ戻れる", () => {
    expect(stepZoom(0.2, 0.1, -1)).toBe(0.1);
  });
});

describe("wheelZoom", () => {
  it("マウスの 1 ノッチ(100px)でおよそ 10% 変わり、逆向きで元に戻る", () => {
    const zoomedIn = manual(wheelZoom(1, 1, -100));
    expect(zoomedIn).toBeCloseTo(1.105, 3);
    expect(manual(wheelZoom(zoomedIn, 1, 100))).toBeCloseTo(1, 10);
  });

  it("ピンチの小さな delta は小さく効く", () => {
    expect(manual(wheelZoom(1, 1, -5))).toBeCloseTo(1.005, 3);
    expect(manual(wheelZoom(1, 1, 5))).toBeCloseTo(0.995, 3);
  });

  it("1 フレームの delta は上限で頭打ちになり、倍率は範囲内に収まる", () => {
    expect(wheelZoom(1, 1, -5000)).toBe(wheelZoom(1, 1, -250));
    expect(wheelZoom(0.25, 1, 100)).toBe(0.25);
    expect(wheelZoom(3, 1, -100)).toBe(3);
  });

  it("fit からは現在の fit 倍率を基準にする", () => {
    expect(manual(wheelZoom("fit", 0.5, -100))).toBeCloseTo(0.553, 3);
  });

  it("丸めずに積み重ねるので、小さな delta を複数フレームに分けても 1 回でまとめて送ったのと同じ倍率になる", () => {
    let zoom: ZoomState = 1;
    for (let i = 0; i < 10; i++) zoom = wheelZoom(zoom, 1, -0.4);
    expect(manual(zoom)).toBeCloseTo(manual(wheelZoom(1, 1, -4)), 10);
    expect(roundZoom(manual(zoom))).toBe(1.004);
    // 下限に張り付いた状態からの 1px ずつの拡大も積み重なる。
    let low: ZoomState = MIN_ZOOM;
    for (let i = 0; i < 3; i++) low = wheelZoom(low, 1, -1);
    expect(manual(low)).toBeCloseTo(manual(wheelZoom(MIN_ZOOM, 1, -3)), 10);
    expect(manual(low)).toBeGreaterThan(MIN_ZOOM);
  });

  it("fit が下限より小さいときは、縮小しても fit のまま、拡大は fit から連続して動く(0.25 へ飛ばない)", () => {
    expect(wheelZoom("fit", 0.1, 100)).toBe("fit");
    expect(manual(wheelZoom("fit", 0.1, -100))).toBeCloseTo(0.1105, 4);
    // 範囲の外にいる手動倍率は、範囲へ戻る向きにだけ動く。
    expect(wheelZoom(0.1, 0.1, 100)).toBe(0.1);
    expect(manual(wheelZoom(0.1, 0.1, -100))).toBeCloseTo(0.1105, 4);
  });

  it("fit より拡大した後も、縮小で fit の方向へ戻れる", () => {
    // 0.11 から縮小すると 0.1 未満になるが、fit の 0.1 に張り付く。
    expect(wheelZoom(0.11, 0.1, 100)).toBe(0.1);
  });

  it("行・ページ単位の delta は px に換算する", () => {
    expect(wheelDeltaPixels(3, 1)).toBe(48);
    expect(wheelDeltaPixels(1, 2)).toBe(400);
    expect(wheelDeltaPixels(-7, 0)).toBe(-7);
  });
});

describe("parseZoom", () => {
  it("操作で作れる範囲 [MIN_FIT_SCALE, MAX_ZOOM] の数と fit を受け、境界の外は fit に戻す", () => {
    // fit が 0.25 より小さいときに作られる手動倍率(0.111 など)も、保存して読み戻せる。
    for (const value of [MIN_FIT_SCALE, 0.111, 0.24, 1, MAX_ZOOM, "fit"])
      expect(parseZoom(value)).toBe(value);
    // fitWidthScale の下限 0.1 より小さい値、MAX_ZOOM より大きい値は操作では作れないので、壊れた state として扱う。
    for (const value of [
      0.099,
      3.01,
      0.000001,
      Number.MAX_VALUE,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "1",
      undefined,
      null,
    ])
      expect(parseZoom(value)).toBe("fit");
  });
});

describe("roundZoom", () => {
  it("表示・保存用に 3 桁へ丸める", () => {
    expect(roundZoom(1.1051709)).toBe(1.105);
    expect(roundZoom(1.0004)).toBe(1);
  });
});
