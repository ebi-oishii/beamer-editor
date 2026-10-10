// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  detectOverflow,
  measureFlowExtent,
  OVERFLOW_TOLERANCE_PX,
  overflowMessage,
  sameOverflow,
} from "../src/preview/overflow.js";

/** 455.24pt × 256.07pt を整数 px に丸めた論理サイズ。 */
const SLIDE = { slideWidth: 607, slideHeight: 341 };

describe("detectOverflow", () => {
  it("本文がスライドに収まっていれば null", () => {
    expect(detectOverflow({ ...SLIDE, contentRight: 607, contentBottom: 300 })).toBeNull();
  });

  it("下端を超えた本文は bottom、右端を超えた本文は right", () => {
    expect(detectOverflow({ ...SLIDE, contentRight: 607, contentBottom: 420 })).toEqual({
      bottom: true,
      right: false,
    });
    expect(detectOverflow({ ...SLIDE, contentRight: 700, contentBottom: 200 })).toEqual({
      bottom: false,
      right: true,
    });
    expect(detectOverflow({ ...SLIDE, contentRight: 700, contentBottom: 420 })).toEqual({
      bottom: true,
      right: true,
    });
  });

  it("実測の丸め程度(1pt 以内)の超過は数えない", () => {
    expect(
      detectOverflow({
        ...SLIDE,
        contentRight: 607 + OVERFLOW_TOLERANCE_PX,
        contentBottom: 341 + OVERFLOW_TOLERANCE_PX,
      }),
    ).toBeNull();
    expect(detectOverflow({ ...SLIDE, contentRight: 607, contentBottom: 343 })).toEqual({
      bottom: true,
      right: false,
    });
    expect(detectOverflow({ ...SLIDE, contentRight: 607, contentBottom: 350 }, 10)).toBeNull();
  });

  it("スライドの寸法が取れない・数値でない実測は判定しない", () => {
    expect(detectOverflow({ ...SLIDE, slideHeight: 0, contentRight: 0, contentBottom: 999 })).toBe(
      null,
    );
    expect(detectOverflow({ ...SLIDE, contentRight: Number.NaN, contentBottom: 999 })).toBeNull();
  });
});

describe("sameOverflow", () => {
  it("辺の組が同じなら同一とみなす", () => {
    expect(sameOverflow(null, null)).toBe(true);
    expect(sameOverflow({ bottom: true, right: false }, { bottom: true, right: false })).toBe(true);
    expect(sameOverflow({ bottom: true, right: false }, { bottom: true, right: true })).toBe(false);
    expect(sameOverflow(null, { bottom: true, right: false })).toBe(false);
  });
});

describe("overflowMessage", () => {
  it("はみ出した辺と PDF での現れ方を説明する", () => {
    expect(overflowMessage({ bottom: true, right: false })).toBe(
      "本文がスライドの下端を超えています(PDF では Overfull \\vbox になり、超えた分は表示されません)",
    );
    expect(overflowMessage({ bottom: false, right: true })).toContain("右端");
    expect(overflowMessage({ bottom: false, right: true })).toContain("Overfull \\hbox");
    expect(overflowMessage({ bottom: true, right: true })).toContain("下端と右端");
  });
});

function define(element: Element, metrics: Record<string, number>): void {
  for (const [name, value] of Object.entries(metrics))
    Object.defineProperty(element, name, { configurable: true, value });
}

describe("measureFlowExtent", () => {
  function slideWithBody(): { slide: HTMLElement; body: HTMLElement } {
    const slide = document.createElement("div");
    slide.className = "slide";
    slide.innerHTML =
      '<div class="frametitle">t</div><div class="slide-body"><div class="canvas"></div></div>';
    const body = slide.querySelector<HTMLElement>(".slide-body");
    if (!body) throw new Error("fixture missing");
    return { slide, body };
  }

  it("本文の offset とはみ出し込みの scroll 寸法を論理座標で返す", () => {
    const { slide, body } = slideWithBody();
    define(slide, { clientWidth: 607, clientHeight: 341 });
    define(body, {
      offsetLeft: 0,
      offsetTop: 30,
      offsetWidth: 607,
      offsetHeight: 300,
      scrollWidth: 650,
      scrollHeight: 320,
    });
    expect(measureFlowExtent(slide)).toEqual({
      slideWidth: 607,
      slideHeight: 341,
      contentRight: 650,
      contentBottom: 350,
    });
  });

  it("レイアウトが無い(寸法 0)か本文が無ければ undefined", () => {
    const { slide } = slideWithBody();
    expect(measureFlowExtent(slide)).toBeUndefined();
    const empty = document.createElement("div");
    define(empty, { clientWidth: 607, clientHeight: 341 });
    expect(measureFlowExtent(empty)).toBeUndefined();
  });
});
