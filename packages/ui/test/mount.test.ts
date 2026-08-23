// @vitest-environment jsdom
import type { RenderedDeck } from "@beamer-editor/renderer";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_CSS } from "../src/preview/styles.js";
import type { NavState, ShellHost } from "../src/shell-host.js";

// React の act() を有効化する（createRoot の flush を同期させる）。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;

  constructor(
    type: string,
    init: MouseEventInit & {
      pointerId: number;
    },
  ) {
    super(type, init);
    this.pointerId = init.pointerId;
  }
}

Object.defineProperty(globalThis, "PointerEvent", {
  configurable: true,
  value: TestPointerEvent,
});
Object.defineProperty(window, "PointerEvent", {
  configurable: true,
  value: TestPointerEvent,
});
Object.defineProperty(window, "onpointerdown", {
  configurable: true,
  value: null,
});

// React DOM の Pointer Events 対応判定より先に polyfill を用意してから読み込む。
const { mountPreview } = await import("../src/preview/mount.js");

/** core を介さず（ui → renderer の依存方向を保つ）手組みした最小デッキ。 */
const DECK: RenderedDeck = {
  title: "smoke",
  css: ".slide { color: red; }",
  frames: [
    {
      index: 1,
      label: null,
      titleText: "one",
      html: '<div class="slide"><div class="slide-body"><p data-min="2">hi</p></div></div>',
      stepCount: 2,
      isRaw: false,
      sourceSpan: { start: 0, end: 40 },
    },
    {
      index: 2,
      label: "f2",
      titleText: "two",
      html: '<div class="slide"><div class="slide-body"><p>bye</p></div></div>',
      stepCount: 1,
      isRaw: false,
      sourceSpan: { start: 41, end: 80 },
    },
  ],
};

/** deck を注入できるフェイク ShellHost。 */
function fakeHost(): ShellHost & { push: (deck: RenderedDeck, version?: number) => void } {
  let listener: ((deck: RenderedDeck, version: number) => void) | undefined;
  return {
    subscribe(l) {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
    jumpToSource() {},
    notifyActiveFrame() {},
    moveCanvasElement() {},
    push(deck, version = 1) {
      listener?.(deck, version);
    },
  };
}

const CANVAS_DECK: RenderedDeck = {
  title: "canvas",
  css: "",
  frames: [
    {
      index: 1,
      label: "canvas",
      titleText: "canvas",
      html: `<div class="slide"><div class="slide-body"><div class="canvas">
        <img class="canvas-item" data-canvas-element-id="canvas-image-0" data-canvas-element-kind="image" style="left:10%;top:20%;width:30%">
        <img class="canvas-item" data-canvas-element-id="canvas-image-1" data-canvas-element-kind="image" style="left:50%;top:50%;width:20%">
      </div></div></div>`,
      stepCount: 1,
      isRaw: false,
      sourceSpan: { start: 0, end: 100 },
      canvasElements: [
        {
          id: "canvas-image-0",
          kind: "image",
          position: { x: 0.1, y: 0.2, width: 0.3 },
          sourceSpan: { start: 10, end: 30 },
          editable: true,
        },
        {
          id: "canvas-image-1",
          kind: "image",
          position: { x: 0.5, y: 0.5, width: 0.2 },
          sourceSpan: { start: 40, end: 60 },
        },
      ],
    },
  ],
};

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  };
}

function firePointer(
  target: EventTarget,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  clientX: number,
  clientY: number,
  pointerId = 7,
): void {
  const event = new TestPointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    pointerId,
  });
  act(() => {
    target.dispatchEvent(event);
  });
}

function mountCanvasPreview() {
  const container = document.createElement("div");
  document.body.append(container);
  const moveCanvasElement = vi.fn();
  const host = { ...fakeHost(), moveCanvasElement };
  act(() => {
    mountPreview(container, host);
  });
  act(() => {
    host.push(CANVAS_DECK);
  });

  const scale = container.querySelector<HTMLElement>(".slide-scale");
  const canvas = scale?.querySelector<HTMLElement>(".canvas");
  const editable = scale?.querySelector<HTMLElement>('[data-canvas-element-id="canvas-image-0"]');
  const noneditable = scale?.querySelector<HTMLElement>(
    '[data-canvas-element-id="canvas-image-1"]',
  );
  if (!scale || !canvas || !editable || !noneditable) throw new Error("canvas fixture missing");

  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(domRect(100, 50, 400, 200));
  vi.spyOn(editable, "getBoundingClientRect").mockReturnValue(domRect(140, 90, 120, 60));
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  Object.defineProperties(editable, {
    setPointerCapture: { configurable: true, value: setPointerCapture },
    hasPointerCapture: { configurable: true, value: () => true },
    releasePointerCapture: { configurable: true, value: releasePointerCapture },
  });

  return {
    container,
    editable,
    host,
    moveCanvasElement,
    noneditable,
    releasePointerCapture,
    scale,
    setPointerCapture,
  };
}

describe("mountPreview", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  it("フェイク host と手組みデッキを例外なく描画し unmount できる", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const host = fakeHost();

    let unmount: () => void = () => {};
    act(() => {
      unmount = mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });

    // PREVIEW_CSS が一度だけ注入される。
    expect(document.getElementById("beamer-preview-styles")).not.toBeNull();
    // beamer-preview のルートが描画され、フレームのスライドが入る。
    expect(container.querySelector(".beamer-preview")).not.toBeNull();
    expect(container.querySelectorAll(".thumb")).toHaveLength(2);

    expect(() => act(() => unmount())).not.toThrow();
  });

  it("loadNavState から現在フレームを復元し、ナビ操作で saveNavState が呼ばれる", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const saved: unknown[] = [];
    const host = {
      ...fakeHost(),
      loadNavState: () => ({ current: 1, step: 1, zoom: "fit" as const }),
      saveNavState: (state: unknown) => {
        saved.push(state);
      },
    };

    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });

    // 復元された current=1 のサムネイルがアクティブになる。
    const thumbs = [...container.querySelectorAll(".thumb")];
    expect(thumbs[1]?.classList.contains("active")).toBe(true);
    expect(saved.at(-1)).toEqual({ current: 1, step: 1, zoom: "fit" });

    // 前へ移動すると新しいナビ状態が保存される。
    const prev = container.querySelector<HTMLButtonElement>('button[aria-label="前のフレーム"]');
    act(() => {
      prev?.click();
    });
    expect(saved.at(-1)).toEqual({ current: 0, step: 1, zoom: "fit" });
  });

  it("復元した step は現在フレームの stepCount へクランプされる(P2 指摘)", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const saved: unknown[] = [];
    const host = {
      ...fakeHost(),
      // frames[0] の stepCount は 2。壊れていないが上限超えの state を復元する。
      loadNavState: () => ({ current: 0, step: 999, zoom: "fit" as const }),
      saveNavState: (state: unknown) => {
        saved.push(state);
      },
    };

    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });

    expect(saved.at(-1)).toEqual({ current: 0, step: 2, zoom: "fit" });
  });

  it("ズーム操作を反映・保存し、fit と 100% 表示を切り替える", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const saved: unknown[] = [];
    const host = {
      ...fakeHost(),
      loadNavState: () => ({ current: 0, step: 1, zoom: "fit" as const }),
      saveNavState: (state: unknown) => saved.push(state),
    };

    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });

    expect(container.querySelector(".zoom-indicator")?.textContent).toMatch(/^フィット /);
    const actual = container.querySelector<HTMLButtonElement>('button[aria-label="100%表示"]');
    act(() => actual?.click());
    expect(container.querySelector(".slide-scale")?.getAttribute("style")).toContain("scale(1)");
    expect(container.querySelector<HTMLElement>(".slide-layout")?.style.width).toBe("607px");
    expect(container.querySelector<HTMLElement>(".slide-layout")?.style.height).toBe("341px");
    expect(container.querySelector<HTMLElement>(".slide-scale")?.style.width).toBe("607px");
    expect(container.querySelector<HTMLElement>(".slide-scale")?.style.height).toBe("341px");
    expect(saved.at(-1)).toEqual({ current: 0, step: 1, zoom: 1 });

    const increase = container.querySelector<HTMLButtonElement>('button[aria-label="拡大"]');
    act(() => increase?.click());
    expect(container.querySelector(".slide-scale")?.getAttribute("style")).toContain("scale(1.1)");
    expect(container.querySelector<HTMLElement>(".slide-layout")?.style.width).toBe("667.7px");
    expect(container.querySelector<HTMLElement>(".slide-layout")?.style.height).toBe("375.1px");
    // Manual zoom changes only the outer layout; the transform target remains logical size.
    expect(container.querySelector<HTMLElement>(".slide-scale")?.style.width).toBe("607px");
    expect(container.querySelector<HTMLElement>(".slide-scale")?.style.height).toBe("341px");
    expect(saved.at(-1)).toEqual({ current: 0, step: 1, zoom: 1.1 });

    const fit = container.querySelector<HTMLButtonElement>('button[aria-label="画面に合わせる"]');
    act(() => fit?.click());
    expect(container.querySelector(".zoom-indicator")?.textContent).toMatch(/^フィット /);
    expect(container.querySelector<HTMLElement>(".slide-scale")?.style.width).toBe("607px");
    expect(container.querySelector<HTMLElement>(".slide-scale")?.style.height).toBe("341px");
    expect(saved.at(-1)).toEqual({ current: 0, step: 1, zoom: "fit" });
  });

  it("resize 後も内側は論理サイズのまま、fit layout だけを再計算する", () => {
    const callbacks: ResizeObserverCallback[] = [];
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const container = document.createElement("div");
    document.body.append(container);
    const host = fakeHost();

    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });
    const holder = container.querySelector<HTMLElement>(".slide-holder");
    const layout = container.querySelector<HTMLElement>(".slide-layout");
    const scale = container.querySelector<HTMLElement>(".slide-scale");
    if (!holder || !layout || !scale) throw new Error("stage fixture missing");
    Object.defineProperties(holder, {
      clientWidth: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 700 },
    });
    act(() => callbacks.at(-1)?.([], {} as ResizeObserver));
    expect(layout.style.width).toBe("971.2px");
    expect(layout.style.height).toBe("545.6px");

    Object.defineProperties(holder, {
      clientWidth: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 250 },
    });
    act(() => callbacks.at(-1)?.([], {} as ResizeObserver));
    expect(layout.style.width).toBe("276px");
    expect(Number.parseFloat(layout.style.height)).toBeCloseTo(155.05, 2);
    expect(scale.style.width).toBe("607px");
    expect(scale.style.height).toBe("341px");
  });

  it("scaled layout clips transform overflow while thumbnails keep their own slide shadow", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const host = fakeHost();

    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });

    expect(PREVIEW_CSS).toContain(".slide-layout {\n  margin-left: auto;");
    expect(PREVIEW_CSS).toContain("overflow: hidden;\n  box-shadow: 0 1px 6px");
    expect(PREVIEW_CSS).toContain(".slide-layout .slide {\n  box-shadow: none;");
    expect(PREVIEW_CSS).toContain("line-height: 1.24;\n  box-shadow: 0 1px 6px");
    expect(PREVIEW_CSS).toContain(".thumb-scale .slide {\n  transform: scale(0.264);");
  });

  it("zoom のない旧ナビ状態を fit として保存する", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const saved: unknown[] = [];
    const host = {
      ...fakeHost(),
      // 旧 Webview state は runtime では zoom を持たない。
      loadNavState: () => ({ current: 1, step: 1 }) as unknown as NavState,
      saveNavState: (state: unknown) => saved.push(state),
    };

    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });

    expect(saved.at(-1)).toEqual({ current: 1, step: 1, zoom: "fit" });
  });

  it("「ソースへ」ボタンと Ctrl+Enter でキーボードからジャンプできる", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const jumpToSource = vi.fn();
    const host = { ...fakeHost(), jumpToSource };

    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });

    const jumpButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="このフレームのソース位置へ移動"]',
    );
    act(() => {
      jumpButton?.click();
    });
    expect(jumpToSource).toHaveBeenLastCalledWith(0, 1);

    // サムネイル上の Ctrl+Enter はダブルクリックと等価にジャンプする。
    const thumb = container.querySelectorAll<HTMLElement>(".thumb")[1];
    act(() => {
      thumb?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      );
    });
    expect(jumpToSource).toHaveBeenLastCalledWith(1, 1);
  });

  it("canvas image は pointerup で一度だけ範囲外座標を clamp せず送る", () => {
    const { editable, moveCanvasElement, releasePointerCapture, scale, setPointerCapture } =
      mountCanvasPreview();

    firePointer(editable, "pointerdown", 150, 100);
    expect(editable.classList.contains("canvas-selected")).toBe(true);
    expect(editable.classList.contains("canvas-editable")).toBe(true);
    expect(setPointerCapture).toHaveBeenCalledWith(7);

    firePointer(scale, "pointermove", 70, 310);
    expect(moveCanvasElement).not.toHaveBeenCalled();
    expect(editable.style.left).toBe("-10%");
    expect(editable.style.top).toBe("125%");

    firePointer(scale, "pointerup", 70, 310);
    expect(moveCanvasElement).toHaveBeenCalledExactlyOnceWith(0, "canvas-image-0", 1, -0.1, 1.25);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("canvas image の clickだけではmoveを送らない", () => {
    const { editable, moveCanvasElement, scale } = mountCanvasPreview();

    firePointer(editable, "pointerdown", 150, 100);
    firePointer(scale, "pointerup", 150, 100);

    expect(moveCanvasElement).not.toHaveBeenCalled();
  });

  it("drag中の別pointerdownは現在のdragを上書きしない", () => {
    const { editable, moveCanvasElement, releasePointerCapture, scale, setPointerCapture } =
      mountCanvasPreview();

    firePointer(editable, "pointerdown", 150, 100, 7);
    firePointer(editable, "pointerdown", 180, 120, 8);
    expect(setPointerCapture).toHaveBeenCalledExactlyOnceWith(7);

    firePointer(scale, "pointermove", 70, 310, 8);
    expect(editable.style.left).toBe("10%");
    expect(editable.style.top).toBe("20%");
    firePointer(scale, "pointerup", 70, 310, 8);
    expect(editable.classList.contains("canvas-dragging")).toBe(true);
    expect(releasePointerCapture).not.toHaveBeenCalled();

    firePointer(scale, "pointermove", 70, 310, 7);
    firePointer(scale, "pointerup", 70, 310, 7);
    expect(moveCanvasElement).toHaveBeenCalledExactlyOnceWith(0, "canvas-image-0", 1, -0.1, 1.25);
    expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("pointercancel と Escape は座標を復元してmoveを送らない", () => {
    const { editable, moveCanvasElement, releasePointerCapture, scale } = mountCanvasPreview();

    firePointer(editable, "pointerdown", 150, 100);
    firePointer(scale, "pointermove", 70, 310);
    firePointer(scale, "pointercancel", 70, 310);
    expect(editable.style.left).toBe("10%");
    expect(editable.style.top).toBe("20%");
    expect(moveCanvasElement).not.toHaveBeenCalled();

    firePointer(editable, "pointerdown", 150, 100, 8);
    firePointer(scale, "pointermove", 70, 310, 8);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(editable.style.left).toBe("10%");
    expect(editable.style.top).toBe("20%");
    expect(moveCanvasElement).not.toHaveBeenCalled();
    expect(releasePointerCapture).toHaveBeenCalledTimes(2);
  });

  it("背景・編集不能画像で選択解除し、deck更新中のdragをcancelする", () => {
    const { editable, host, moveCanvasElement, noneditable, releasePointerCapture, scale } =
      mountCanvasPreview();

    firePointer(editable, "pointerdown", 150, 100);
    firePointer(scale, "pointercancel", 150, 100);
    firePointer(scale, "pointerdown", 0, 0);
    expect(editable.classList.contains("canvas-selected")).toBe(false);

    firePointer(editable, "pointerdown", 150, 100);
    firePointer(scale, "pointercancel", 150, 100);
    firePointer(noneditable, "pointerdown", 0, 0);
    expect(editable.classList.contains("canvas-selected")).toBe(false);
    expect(noneditable.classList.contains("canvas-editable")).toBe(false);

    firePointer(editable, "pointerdown", 150, 100, 9);
    firePointer(scale, "pointermove", 70, 310, 9);
    act(() => {
      host.push(
        {
          ...CANVAS_DECK,
          frames: CANVAS_DECK.frames.map((frame) => ({ ...frame })),
        },
        2,
      );
    });
    expect(moveCanvasElement).not.toHaveBeenCalled();
    expect(editable.classList.contains("canvas-dragging")).toBe(false);
    expect(editable.classList.contains("canvas-selected")).toBe(false);
    expect(releasePointerCapture).toHaveBeenCalledWith(9);
  });
});
