import { describe, expect, it } from "vitest";
import { type PreviewState, previewReducer } from "../src/preview/state.js";

const start: PreviewState = { current: 2, step: 3 };

describe("previewReducer", () => {
  it("goto は current を [0, frameCount-1] にクランプする", () => {
    expect(previewReducer(start, { type: "goto", index: 99 }, 5)).toEqual({ current: 4, step: 1 });
    expect(previewReducer(start, { type: "goto", index: -3 }, 5)).toEqual({ current: 0, step: 1 });
  });

  it("goto でフレームが変わると step が 1 にリセットされる", () => {
    expect(previewReducer(start, { type: "goto", index: 0 }, 5)).toEqual({ current: 0, step: 1 });
  });

  it("goto で current が変わらなければ step を保つ", () => {
    const s = previewReducer(start, { type: "goto", index: 2 }, 5);
    expect(s).toEqual({ current: 2, step: 3 });
  });

  it("prev / next で移動し step をリセットする", () => {
    expect(previewReducer(start, { type: "prev" }, 5)).toEqual({ current: 1, step: 1 });
    expect(previewReducer(start, { type: "next" }, 5)).toEqual({ current: 3, step: 1 });
  });

  it("prev / next は端でクランプされ step も保つ", () => {
    const first: PreviewState = { current: 0, step: 2 };
    expect(previewReducer(first, { type: "prev" }, 5)).toEqual({ current: 0, step: 2 });
    const last: PreviewState = { current: 4, step: 2 };
    expect(previewReducer(last, { type: "next" }, 5)).toEqual({ current: 4, step: 2 });
  });

  it("setStep は step のみ更新し 1 未満を 1 に丸める", () => {
    expect(previewReducer(start, { type: "setStep", step: 4 }, 5)).toEqual({ current: 2, step: 4 });
    expect(previewReducer(start, { type: "setStep", step: 0 }, 5)).toEqual({ current: 2, step: 1 });
  });

  it("deckLoaded keepPosition=false は先頭へ戻り step を 1 にする", () => {
    expect(
      previewReducer(start, { type: "deckLoaded", frameCount: 5, keepPosition: false }, 5),
    ).toEqual({ current: 0, step: 1 });
  });

  it("deckLoaded keepPosition=true は current を維持し範囲外はクランプする", () => {
    expect(
      previewReducer(start, { type: "deckLoaded", frameCount: 5, keepPosition: true }, 5),
    ).toEqual({ current: 2, step: 3 });
    expect(
      previewReducer(start, { type: "deckLoaded", frameCount: 2, keepPosition: true }, 2),
    ).toEqual({ current: 1, step: 3 });
  });
});
