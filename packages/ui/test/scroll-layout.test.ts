import { describe, expect, it } from "vitest";
import {
  fitWidthScale,
  frameAtScrollTop,
  MAX_FIT_SCALE,
  MIN_FIT_SCALE,
  trailingSpace,
} from "../src/preview/scroll-layout.js";

describe("fitWidthScale", () => {
  it("padding を除いた横幅にスライドを収める", () => {
    expect(fitWidthScale(631, 607, 24)).toBeCloseTo(1);
    expect(fitWidthScale(327.5, 607, 24)).toBeCloseTo(0.5);
  });

  it("上限・下限へクランプし、幅が取れないときは下限を返す", () => {
    expect(fitWidthScale(10_000, 607, 24)).toBe(MAX_FIT_SCALE);
    expect(fitWidthScale(0, 607, 24)).toBe(MIN_FIT_SCALE);
    expect(fitWidthScale(800, 0, 24)).toBe(MIN_FIT_SCALE);
  });
});

describe("frameAtScrollTop", () => {
  // 高さ 400 のカードが 12px の余白から 16px 間隔で並ぶ(offsetTop 相当)。
  const cards = [12, 428, 844, 1260].map((top) => ({ top, height: 400 }));

  it("先頭では 0、上端に揃えたカードがそのまま現在フレームになる", () => {
    expect(frameAtScrollTop(0, cards)).toBe(0);
    expect(frameAtScrollTop(428 - 12, cards)).toBe(1);
    expect(frameAtScrollTop(1260 - 12, cards)).toBe(3);
  });

  it("カードの中央が上端を越えた時点で次のフレームへ切り替わる", () => {
    expect(frameAtScrollTop(428 - 200 - 1, cards)).toBe(0);
    expect(frameAtScrollTop(428 - 200, cards)).toBe(1);
  });

  it("カードが無ければ 0", () => {
    expect(frameAtScrollTop(500, [])).toBe(0);
  });
});

describe("trailingSpace", () => {
  it("末尾カードを上端へ送るのに足りない分だけ余白を返す", () => {
    expect(trailingSpace(800, 400, 12)).toBe(388);
  });

  it("表示領域より高いカードには余白を足さない", () => {
    expect(trailingSpace(300, 400, 12)).toBe(0);
  });
});
