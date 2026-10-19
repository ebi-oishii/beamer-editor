// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { findCanvasOverflows } from "../src/preview/canvas-overflow.js";

/** jsdom はレイアウトしないので、矩形とレイアウト高さを要素ごとに与える。 */
function place(element: Element, rect: { top: number; bottom: number }, offsetHeight?: number) {
  element.getBoundingClientRect = () =>
    ({ top: rect.top, bottom: rect.bottom, height: rect.bottom - rect.top }) as DOMRect;
  if (offsetHeight !== undefined) {
    Object.defineProperty(element, "offsetHeight", { configurable: true, value: offsetHeight });
  }
}

/** data-index のスライドに、本文領域(.canvas)と要素を並べる。bottoms は各要素の下端。 */
function slide(
  root: HTMLElement,
  index: number,
  canvas: { top: number; bottom: number; offsetHeight: number },
  bottoms: Record<string, number>,
) {
  const card = document.createElement("div");
  card.className = "slide-card";
  card.dataset.index = String(index);
  const area = document.createElement("div");
  area.className = "canvas";
  place(area, canvas, canvas.offsetHeight);
  for (const [id, bottom] of Object.entries(bottoms)) {
    const element = document.createElement("div");
    element.dataset.canvasElementId = id;
    place(element, { top: canvas.top, bottom });
    area.append(element);
  }
  card.append(area);
  root.append(card);
}

describe("findCanvasOverflows", () => {
  it("本文領域の下端を越えた要素だけを、スライドの添字と ID で返す", () => {
    const root = document.createElement("div");
    slide(root, 0, { top: 0, bottom: 200, offsetHeight: 200 }, { inside: 200, below: 230 });
    slide(root, 1, { top: 300, bottom: 500, offsetHeight: 200 }, { tall: 520 });
    expect(findCanvasOverflows(root)).toEqual([
      { frameIndex: 0, elementId: "below" },
      { frameIndex: 1, elementId: "tall" },
    ]);
  });

  it("拡大表示でも論理 px で比べ、1px 以下のずれは数えない", () => {
    const root = document.createElement("div");
    // 2 倍表示: 画面上の 1.8px は論理 0.9px なのではみ出しにしない。3px は論理 1.5px なので数える。
    slide(root, 0, { top: 0, bottom: 400, offsetHeight: 200 }, { edge: 401.8, over: 403 });
    expect(findCanvasOverflows(root)).toEqual([{ frameIndex: 0, elementId: "over" }]);
  });

  it("高さの無い本文領域と、要素 ID の無い子(幅ハンドルなど)は見ない", () => {
    const root = document.createElement("div");
    slide(root, 0, { top: 0, bottom: 0, offsetHeight: 0 }, { hidden: 50 });
    slide(root, 1, { top: 0, bottom: 200, offsetHeight: 200 }, {});
    const handle = document.createElement("div");
    handle.className = "canvas-resize-handle";
    place(handle, { top: 0, bottom: 300 });
    root.querySelectorAll(".canvas")[1]?.append(handle);
    expect(findCanvasOverflows(root)).toEqual([]);
  });
});
