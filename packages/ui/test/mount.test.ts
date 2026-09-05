// @vitest-environment jsdom
import type { RenderedDeck } from "@beamer-editor/renderer";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
      html:
        '<div class="slide"><div class="slide-body"><p data-min="2">hi</p>' +
        '<ul data-flow-block="list" data-source-start="30" data-source-end="80"><li><span>outer</span>' +
        '<ul data-flow-block="list" data-source-start="45" data-source-end="70"><li><span>inner</span></li></ul>' +
        "</li></ul>" +
        '<div class="beamer-block" data-flow-block="blockEnv" data-source-start="90" data-source-end="130" data-detach-blocked="unsupported-kind">' +
        '<div class="block-body"><p data-flow-block="paragraph" data-source-start="100" data-source-end="110">inner p</p></div></div>' +
        "</div></div>",
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
  init: PointerEventInit = {},
): void {
  const event = new TestPointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    pointerId,
    ...init,
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
    const saved: unknown[] = [];
    const host = { ...fakeHost(), saveNavState: (state: unknown) => saved.push(state) };

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
    const preview = container.querySelector<HTMLElement>(".beamer-preview");
    if (!preview) throw new Error("preview fixture missing");
    expect(container.querySelectorAll(".slide-card")).toHaveLength(2);

    // すでに消費されたキーは body / preview 配下のどちらからでもナビ状態を変えない。
    const savedBeforePreventedKeys = saved.length;
    document.body.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    const preventedBodyArrow = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    act(() => document.body.dispatchEvent(preventedBodyArrow));
    expect(preventedBodyArrow.defaultPrevented).toBe(true);
    preview.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    const preventedPreviewZoom = new KeyboardEvent("keydown", {
      key: "=",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => preview.dispatchEvent(preventedPreviewZoom));
    expect(preventedPreviewZoom.defaultPrevented).toBe(true);
    expect(saved).toHaveLength(savedBeforePreventedKeys);
    expect(
      container.querySelectorAll<HTMLElement>(".slide-card")[0]?.classList.contains("active"),
    ).toBe(true);
    expect(container.querySelector(".slide-scale")?.getAttribute("style")).not.toContain(
      "scale(1.1)",
    );

    // Webview 本体へ最初からフォーカスがない場合でも、body target のキーで移動できる。
    const bodyArrow = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    act(() => document.body.dispatchEvent(bodyArrow));
    expect(bodyArrow.defaultPrevented).toBe(true);
    expect(saved.at(-1)).toEqual({ current: 1, step: 1, zoom: "fit" });

    // プレビュー外の入力欄は対象外にし、通常の編集キーとして残す。
    const externalTextarea = document.createElement("textarea");
    document.body.append(externalTextarea);
    const textareaArrow = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      bubbles: true,
      cancelable: true,
    });
    act(() => externalTextarea.dispatchEvent(textareaArrow));
    expect(textareaArrow.defaultPrevented).toBe(false);
    expect(saved.at(-1)).toEqual({ current: 1, step: 1, zoom: "fit" });

    expect(() => act(() => unmount())).not.toThrow();
    const callsAfterUnmount = saved.length;
    act(() =>
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
      ),
    );
    expect(saved).toHaveLength(callsAfterUnmount);
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

    // 復元された current=1 のスライドがアクティブになる。
    const cards = [...container.querySelectorAll(".slide-card")];
    expect(cards[1]?.classList.contains("active")).toBe(true);
    expect(saved.at(-1)).toEqual({ current: 1, step: 1, zoom: "fit" });

    // ← で前へ移動すると新しいナビ状態が保存される。
    const preview = container.querySelector<HTMLElement>(".beamer-preview");
    act(() => {
      preview?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
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

  it("Ctrl/Cmd キー操作でズームを反映・保存し、fit に戻せる", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const saved: unknown[] = [];
    const host = {
      ...fakeHost(),
      loadNavState: () => ({ current: 0, step: 1, zoom: 1 as const }),
      saveNavState: (state: unknown) => saved.push(state),
    };

    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });

    const preview = container.querySelector<HTMLElement>(".beamer-preview");
    expect(container.querySelector(".slide-scale")?.getAttribute("style")).toContain("scale(1)");
    expect(container.querySelector<HTMLElement>(".slide-layout")?.style.width).toBe("607px");
    expect(container.querySelector<HTMLElement>(".slide-layout")?.style.height).toBe("341px");
    expect(container.querySelector<HTMLElement>(".slide-scale")?.style.width).toBe("607px");
    expect(container.querySelector<HTMLElement>(".slide-scale")?.style.height).toBe("341px");
    expect(saved.at(-1)).toEqual({ current: 0, step: 1, zoom: 1 });

    act(() => {
      preview?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "=", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(container.querySelector(".slide-scale")?.getAttribute("style")).toContain("scale(1.1)");
    expect(container.querySelector<HTMLElement>(".slide-layout")?.style.width).toBe("667.7px");
    expect(container.querySelector<HTMLElement>(".slide-layout")?.style.height).toBe("375.1px");
    // 手動ズームは外側だけを変え、transform 対象は論理サイズのまま(#58 の幾何契約)。
    expect(container.querySelector<HTMLElement>(".slide-scale")?.style.width).toBe("607px");
    expect(container.querySelector<HTMLElement>(".slide-scale")?.style.height).toBe("341px");
    expect(saved.at(-1)).toEqual({ current: 0, step: 1, zoom: 1.1 });

    act(() => {
      preview?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "0", metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(saved.at(-1)).toEqual({ current: 0, step: 1, zoom: "fit" });
  });

  it("step range 上でも Ctrl/Cmd ズームを扱い、未修飾の左右キーは range に委ねる", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const saved: unknown[] = [];
    const host = {
      ...fakeHost(),
      loadNavState: () => ({ current: 0, step: 1, zoom: 1 as const }),
      saveNavState: (state: unknown) => saved.push(state),
    };
    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });
    const stepRange = container.querySelector<HTMLInputElement>(
      'input[aria-label="オーバーレイ step（2 段階）"]',
    );
    if (!stepRange) throw new Error("step range fixture missing");

    const zoomIn = new KeyboardEvent("keydown", {
      key: "=",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => stepRange.dispatchEvent(zoomIn));
    expect(zoomIn.defaultPrevented).toBe(true);
    expect(saved.at(-1)).toEqual({ current: 0, step: 1, zoom: 1.1 });

    const arrowRight = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    act(() => stepRange.dispatchEvent(arrowRight));
    expect(arrowRight.defaultPrevented).toBe(false);
    expect(
      container.querySelectorAll<HTMLElement>(".slide-card")[0]?.classList.contains("active"),
    ).toBe(true);
  });

  it("Ctrl/Cmd+wheel だけを rAF ごとに一段階ズームし、通常 wheel は妨げない", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const saved: unknown[] = [];
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const host = {
      ...fakeHost(),
      loadNavState: () => ({ current: 0, step: 1, zoom: 1 as const }),
      saveNavState: (state: unknown) => saved.push(state),
    };
    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });
    const preview = container.querySelector<HTMLElement>(".beamer-preview");
    if (!preview) throw new Error("preview fixture missing");

    const normal = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -10 });
    act(() => preview.dispatchEvent(normal));
    expect(normal.defaultPrevented).toBe(false);
    expect(callbacks).toHaveLength(0);

    const zoomIn = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -1,
    });
    const zoomInAgain = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -1,
    });
    act(() => {
      preview.dispatchEvent(zoomIn);
      preview.dispatchEvent(zoomInAgain);
    });
    expect(zoomIn.defaultPrevented).toBe(true);
    expect(zoomInAgain.defaultPrevented).toBe(true);
    expect(callbacks).toHaveLength(1);
    act(() => callbacks[0]?.(0));
    expect(saved.at(-1)).toEqual({ current: 0, step: 1, zoom: 1.1 });

    const zoomOut = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
      deltaY: 1,
    });
    act(() => preview.dispatchEvent(zoomOut));
    expect(zoomOut.defaultPrevented).toBe(true);
    act(() => callbacks[1]?.(16));
    expect(saved.at(-1)).toEqual({ current: 0, step: 1, zoom: 1 });
  });

  it("wheel の倍率変更は現在のスクロール位置を戻さない", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const host = { ...fakeHost(), loadNavState: () => ({ current: 0, step: 1, zoom: 1 as const }) };
    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });
    const preview = container.querySelector<HTMLElement>(".beamer-preview");
    const scroll = container.querySelector<HTMLElement>(".slide-scroll");
    if (!preview || !scroll) throw new Error("preview fixture missing");
    let scrollTop = 187;
    Object.defineProperty(scroll, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    act(() =>
      preview.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -1 }),
      ),
    );
    act(() => callbacks[0]?.(0));
    expect(scrollTop).toBe(187);
  });

  it("fitScale が変わっても pending wheel rAF は unmount まで cancel しない", () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const animationCallbacks: FrameRequestCallback[] = [];
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationCallbacks.push(callback);
      return animationCallbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
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
    const preview = container.querySelector<HTMLElement>(".beamer-preview");
    const scroll = container.querySelector<HTMLElement>(".slide-scroll");
    if (!preview || !scroll) throw new Error("preview fixture missing");
    act(() =>
      preview.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -1 }),
      ),
    );
    Object.defineProperties(scroll, {
      clientWidth: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 400 },
    });
    act(() => resizeCallbacks[0]?.([], {} as ResizeObserver));
    expect(cancelAnimationFrame).not.toHaveBeenCalled();
    act(() => animationCallbacks[0]?.(0));
    // (500 - (12 + 4) * 2) / 607 = 0.771... を基準に一段階上げる。
    expect(saved.at(-1)).toEqual({ current: 0, step: 1, zoom: 0.87 });
  });

  it("resize 後も内側は論理サイズのまま、幅合わせの外側だけを再計算する", () => {
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
    const scroll = container.querySelector<HTMLElement>(".slide-scroll");
    const layout = container.querySelector<HTMLElement>(".slide-layout");
    const scale = container.querySelector<HTMLElement>(".slide-scale");
    if (!scroll || !layout || !scale) throw new Error("stage fixture missing");
    Object.defineProperties(scroll, {
      clientWidth: { configurable: true, value: 1_004 },
      clientHeight: { configurable: true, value: 700 },
    });
    act(() => callbacks[0]?.([], {} as ResizeObserver));
    // (1004 - 32) / 607 は上限 1.6 でクランプされる(32 = scroll padding 24 + card padding 8)。
    expect(layout.style.width).toBe("971.2px");
    expect(layout.style.height).toBe("545.6px");

    Object.defineProperties(scroll, {
      clientWidth: { configurable: true, value: 308 },
      clientHeight: { configurable: true, value: 250 },
    });
    act(() => callbacks[0]?.([], {} as ResizeObserver));
    expect(Number.parseFloat(layout.style.width)).toBeCloseTo(276, 6);
    expect(Number.parseFloat(layout.style.height)).toBeCloseTo(155.05, 2);
    expect(scale.style.width).toBe("607px");
    expect(scale.style.height).toBe("341px");
  });

  it("fit 中の resize は読んでいたカード内の位置を保ち、current を変えない", () => {
    const observed: Array<{ callback: ResizeObserverCallback; element: Element }> = [];
    class ResizeObserverMock {
      private readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(element: Element) {
        observed.push({ callback: this.callback, element });
      }
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("slide-scroll") ? 632 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("slide-scroll") ? 500 : 0;
    });
    const container = document.createElement("div");
    document.body.append(container);
    const notifyActiveFrame = vi.fn();
    const saved: unknown[] = [];
    const host = {
      ...fakeHost(),
      loadNavState: () => ({ current: 1, step: 1, zoom: "fit" as const }),
      notifyActiveFrame,
      saveNavState: (state: unknown) => saved.push(state),
    };

    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });

    const scroll = container.querySelector<HTMLElement>(".slide-scroll");
    const cards = container.querySelectorAll<HTMLElement>(".slide-card");
    if (!scroll || cards.length !== 2) throw new Error("scroll fixture missing");
    const resizeScroll = () => {
      const callback = observed.find(({ element }) => element === scroll)?.callback;
      if (!callback) throw new Error("scroll ResizeObserver fixture missing");
      callback([], {} as ResizeObserver);
    };
    let scrollTop = 0;
    Object.defineProperty(scroll, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    cards.forEach((card, i) => {
      Object.defineProperties(card, {
        offsetTop: { configurable: true, value: 12 + i * 400 },
        offsetHeight: { configurable: true, value: 400 },
      });
    });
    // 初期表示とは別のフレームの途中へ通常スクロールし、step も変更する。
    scrollTop = 200;
    act(() => scroll.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(cards[0]?.classList.contains("active")).toBe(true);
    const stepRange = container.querySelector<HTMLInputElement>(
      'input[aria-label="オーバーレイ step（2 段階）"]',
    );
    if (!stepRange) throw new Error("step range fixture missing");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        stepRange,
        "2",
      );
      stepRange.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(saved.at(-1)).toEqual({ current: 0, step: 2, zoom: "fit" });

    // 一時的な collapse はブラウザが scrollTop を 0 へ clamp して scroll event を
    // 発火しても、通常 scroll で更新されたアンカーと current / step を壊さない。
    Object.defineProperties(scroll, {
      clientWidth: { configurable: true, value: 0 },
      clientHeight: { configurable: true, value: 0 },
    });
    Object.defineProperty(cards[0] as HTMLElement, "offsetHeight", {
      configurable: true,
      value: 0,
    });
    act(resizeScroll);
    scrollTop = 0;
    const savedBeforeCollapse = saved.length;
    const activeBeforeCollapse = notifyActiveFrame.mock.calls.length;
    act(() => scroll.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(cards[0]?.classList.contains("active")).toBe(true);
    expect(saved).toHaveLength(savedBeforeCollapse);
    expect(notifyActiveFrame).toHaveBeenCalledTimes(activeBeforeCollapse);

    Object.defineProperties(scroll, {
      clientWidth: { configurable: true, value: 308 },
      clientHeight: { configurable: true, value: 250 },
    });
    Object.defineProperties(cards[0] as HTMLElement, {
      offsetTop: { configurable: true, value: 700 },
      offsetHeight: { configurable: true, value: 300 },
    });
    Object.defineProperty(cards[1] as HTMLElement, "offsetTop", {
      configurable: true,
      value: 1012,
    });
    act(resizeScroll);
    expect(scrollTop).toBe(838);
    act(() => scroll.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(cards[0]?.classList.contains("active")).toBe(true);
    expect(saved.at(-1)).toEqual({ current: 0, step: 2, zoom: "fit" });

    // 同じ commit の明示 reveal は resize 復元より優先し、古い sentinel を残さない。
    const preview = container.querySelector<HTMLElement>(".beamer-preview");
    Object.defineProperty(scroll, "clientWidth", { configurable: true, value: 307 });
    act(() => {
      resizeScroll();
      preview?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(scrollTop).toBe(1000);
    act(() => scroll.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(cards[1]?.classList.contains("active")).toBe(true);
    expect(saved.at(-1)).toEqual({ current: 1, step: 1, zoom: "fit" });
  });

  it("手動 zoom 中の resize は表示位置とナビ状態を変えない", () => {
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
    const saved: unknown[] = [];
    const host = {
      ...fakeHost(),
      loadNavState: () => ({ current: 1, step: 1, zoom: 1 as const }),
      saveNavState: (state: unknown) => saved.push(state),
    };

    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });

    const scroll = container.querySelector<HTMLElement>(".slide-scroll");
    const cards = container.querySelectorAll<HTMLElement>(".slide-card");
    if (!scroll || cards.length !== 2) throw new Error("scroll fixture missing");
    let scrollTop = 321;
    Object.defineProperty(scroll, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    Object.defineProperties(scroll, {
      clientWidth: { configurable: true, value: 308 },
      clientHeight: { configurable: true, value: 250 },
    });
    Object.defineProperty(cards[1] as HTMLElement, "offsetTop", { configurable: true, value: 700 });

    act(() => callbacks.at(-1)?.([], {} as ResizeObserver));

    expect(scrollTop).toBe(321);
    expect(cards[1]?.classList.contains("active")).toBe(true);
    expect(saved.at(-1)).toEqual({ current: 1, step: 1, zoom: 1 });
  });

  it("computed style の端数論理サイズを整数 offset より優先し、3x では外側だけが 3 倍になる", () => {
    const originalGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const style = originalGetComputedStyle(element);
      if (!(element instanceof HTMLElement) || !element.classList.contains("slide")) return style;
      return { ...style, width: "606.9867px", height: "341.4267px" } as CSSStyleDeclaration;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(606);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(341);
    const container = document.createElement("div");
    document.body.append(container);
    const host = {
      ...fakeHost(),
      loadNavState: () => ({ current: 0, step: 1, zoom: 3 as const }),
    };

    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });

    const layout = container.querySelector<HTMLElement>(".slide-layout");
    const scale = container.querySelector<HTMLElement>(".slide-scale");
    if (!layout || !scale) throw new Error("stage fixture missing");
    expect(Number.parseFloat(scale.style.width)).toBeCloseTo(606.9867, 4);
    expect(Number.parseFloat(scale.style.height)).toBeCloseTo(341.4267, 4);
    expect(Number.parseFloat(layout.style.width)).toBeCloseTo(606.9867 * 3, 4);
    expect(Number.parseFloat(layout.style.height)).toBeCloseTo(341.4267 * 3, 4);
  });

  it("外側の .slide-layout が transform のはみ出しを閉じ、影を持つ", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const host = fakeHost();

    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });

    const stylesheet = document.getElementById("beamer-preview-styles") as HTMLStyleElement | null;
    const layout = container.querySelector<HTMLElement>(".slide-layout");
    if (!stylesheet || !layout) throw new Error("stage fixture missing");
    const cssRule = (selector: string) =>
      [...(stylesheet.sheet?.cssRules ?? [])].find(
        (rule): rule is CSSStyleRule =>
          rule instanceof CSSStyleRule && rule.selectorText === selector,
      );
    expect(getComputedStyle(layout).overflow).toBe("hidden");
    expect(cssRule(".slide-layout")?.style.getPropertyValue("box-shadow")).not.toBe("");
    expect(cssRule(".slide-layout .slide")?.style.getPropertyValue("box-shadow")).toBe("none");
    expect(cssRule(".slide")?.style.getPropertyValue("box-shadow")).not.toBe("");
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

  it("Ctrl+Enter でキーボードからソースへジャンプできる", () => {
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

    // スライド上の Ctrl+Enter はダブルクリックと等価にジャンプする。
    const card = container.querySelectorAll<HTMLElement>(".slide-card")[1];
    act(() => {
      card?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      );
    });
    expect(jumpToSource).toHaveBeenLastCalledWith(1, 1);
  });

  it("全フレームを縦一列に描画し、現在フレームだけに step を適用する", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const host = fakeHost();

    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });

    // サムネイル一覧は無く、スライド本体が全フレーム分並ぶ。
    expect(container.querySelector(".slide-list")).toBeNull();
    const scales = container.querySelectorAll<HTMLElement>(".slide-scale");
    expect(scales).toHaveLength(2);
    // 現在フレーム(0)は step=1 なので data-min="2" の要素は covered、他フレームは全ステップ表示。
    expect(scales[0]?.querySelector("[data-min]")?.classList.contains("covered")).toBe(true);
    // 旧ツールバーはなく、step のある現在フレームだけにコンパクトな操作を表示する。
    expect(container.querySelector(".controls")).toBeNull();
    expect(container.querySelector('button[aria-label="前のフレーム"]')).toBeNull();
    const stepRange = container.querySelector<HTMLInputElement>(
      'input[aria-label="オーバーレイ step（2 段階）"]',
    );
    expect(stepRange?.value).toBe("1");
    expect(container.querySelector(".step-indicator")?.textContent).toBe("1/2");
    const cards = container.querySelectorAll<HTMLElement>(".slide-card");
    expect(cards[0]?.getAttribute("aria-current")).toBe("true");
    expect(cards[1]?.hasAttribute("aria-current")).toBe(false);
    const status = container.querySelector<HTMLElement>(".preview-status");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.getAttribute("aria-atomic")).toBe("true");
    expect(status?.textContent).toBe("フレーム 1 / 2");
    act(() => {
      if (stepRange) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          stepRange,
          "2",
        );
        stepRange.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    expect(scales[0]?.querySelector("[data-min]")?.classList.contains("covered")).toBe(false);
    expect(container.querySelector(".step-indicator")?.textContent).toBe("2/2");
    const captions = [...container.querySelectorAll(".slide-caption")].map((c) => c.textContent);
    expect(captions).toEqual(["1. one", "2. two（label=f2）"]);

    // クリックで選択すると active が移る。
    act(() => {
      cards[1]?.click();
    });
    expect(cards[1]?.classList.contains("active")).toBe(true);
    expect(cards[0]?.hasAttribute("aria-current")).toBe(false);
    expect(cards[1]?.getAttribute("aria-current")).toBe("true");
    expect(status?.textContent).toBe("フレーム 2 / 2");
    // step のないフレームでは操作も余白も描画しない。
    expect(container.querySelector(".step-control")).toBeNull();
  });

  it("スクロールで上端に来たフレームが現在フレームになる", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const notifyActiveFrame = vi.fn();
    const host = { ...fakeHost(), notifyActiveFrame };

    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });

    const scroll = container.querySelector<HTMLElement>(".slide-scroll");
    const cards = container.querySelectorAll<HTMLElement>(".slide-card");
    if (!scroll || cards.length !== 2) throw new Error("scroll fixture missing");
    Object.defineProperties(scroll, {
      clientWidth: { configurable: true, value: 632 },
      clientHeight: { configurable: true, value: 500 },
    });
    // jsdom はレイアウトを持たないので offsetTop / offsetHeight / scrollTop を与える。
    cards.forEach((card, i) => {
      Object.defineProperties(card, {
        offsetTop: { configurable: true, value: 12 + i * 416 },
        offsetHeight: { configurable: true, value: 400 },
      });
    });
    let scrollTop = 0;
    Object.defineProperty(scroll, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    scrollTop = 300;
    act(() => {
      scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(cards[1]?.classList.contains("active")).toBe(true);
    expect(notifyActiveFrame).toHaveBeenLastCalledWith(1);

    // ← で戻ると移動先のカードが上端へ揃うようにスクロールされる。
    const preview = container.querySelector<HTMLElement>(".beamer-preview");
    act(() => {
      preview?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(cards[0]?.classList.contains("active")).toBe(true);
    expect(scrollTop).toBe(0);
  });

  it("canvas text も editable ならドラッグで move を送る", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const moveCanvasElement = vi.fn();
    const host = { ...fakeHost(), moveCanvasElement };
    const deck: RenderedDeck = {
      title: "canvas-text",
      css: "",
      frames: [
        {
          index: 1,
          label: "text",
          titleText: "text",
          html: `<div class="slide"><div class="slide-body"><div class="canvas">
            <div class="canvas-item canvas-text" data-canvas-element-id="canvas-text-0" data-canvas-element-kind="text" style="left:10%;top:20%;width:40%">hello</div>
          </div></div></div>`,
          stepCount: 1,
          isRaw: false,
          sourceSpan: { start: 0, end: 100 },
          canvasElements: [
            {
              id: "canvas-text-0",
              kind: "text",
              position: { x: 0.1, y: 0.2, width: 0.4 },
              sourceSpan: { start: 10, end: 30 },
              editable: true,
            },
          ],
        },
      ],
    };
    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(deck);
    });
    const scale = container.querySelector<HTMLElement>(".slide-scale");
    const canvas = scale?.querySelector<HTMLElement>(".canvas");
    const text = scale?.querySelector<HTMLElement>('[data-canvas-element-id="canvas-text-0"]');
    if (!scale || !canvas || !text) throw new Error("canvas text fixture missing");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(domRect(100, 50, 400, 200));
    vi.spyOn(text, "getBoundingClientRect").mockReturnValue(domRect(140, 90, 160, 40));
    Object.defineProperties(text, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: () => true },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });

    expect(text.classList.contains("canvas-editable")).toBe(true);
    firePointer(text, "pointerdown", 150, 100);
    firePointer(scale, "pointermove", 250, 150);
    firePointer(scale, "pointerup", 250, 150);
    // grab offset (10, 10) を引いた左上 (240, 140) を canvas rect (100, 50, 400x200) で正規化。
    expect(moveCanvasElement).toHaveBeenCalledExactlyOnceWith(0, "canvas-text-0", 1, 0.35, 0.45);
  });

  it("右クリックで候補メニューを出し、ホバーで強調を移し、選んだ候補の span と rect を送る", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const detachToCanvas = vi.fn();
    const host = { ...fakeHost(), detachToCanvas };
    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });
    const slide = container.querySelector<HTMLElement>(".slide-scale .slide");
    const lists = container.querySelectorAll<HTMLElement>(".slide-scale ul");
    const innerText = lists[1]?.querySelector<HTMLElement>("span");
    if (!slide || lists.length !== 2 || !innerText) throw new Error("flow fixture missing");
    vi.spyOn(slide, "getBoundingClientRect").mockReturnValue(domRect(0, 0, 600, 300));
    vi.spyOn(lists[0] as HTMLElement, "getBoundingClientRect").mockReturnValue(
      domRect(30, 90, 540, 90),
    );
    vi.spyOn(lists[1] as HTMLElement, "getBoundingClientRect").mockReturnValue(
      domRect(60, 120, 300, 30),
    );

    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 130,
    });
    act(() => {
      innerText.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    const items = [...container.querySelectorAll<HTMLButtonElement>(".context-menu button")];
    // 内側の候補が先。ラベルは単位と抜粋。
    expect(items.map((item) => item.textContent)).toEqual([
      "箸条書き「inner」を自由配置にする",
      "箸条書き「outer inner」を自由配置にする",
    ]);
    expect(lists[1]?.classList.contains("flow-target")).toBe(true);

    act(() => {
      items[1]?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(lists[0]?.classList.contains("flow-target")).toBe(true);
    expect(lists[1]?.classList.contains("flow-target")).toBe(false);

    act(() => {
      items[1]?.click();
    });
    // 1 枚目のカード(frameIndex 0)から、表示中 version 1 で送る。
    expect(detachToCanvas).toHaveBeenCalledExactlyOnceWith(
      0,
      1,
      { start: 30, end: 80 },
      { x: 0.05, y: 0.3, width: 0.9 },
    );
    expect(container.querySelector(".context-menu")).toBeNull();
    expect(container.querySelector(".flow-target")).toBeNull();
  });

  it("候補にできない要素は理由付きの無効項目として並び、押しても送らない", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const detachToCanvas = vi.fn();
    const host = { ...fakeHost(), detachToCanvas };
    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });
    const innerP = container.querySelector<HTMLElement>(".slide-scale .beamer-block p");
    if (!innerP) throw new Error("fixture missing");
    act(() => {
      innerP.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    const items = [...container.querySelectorAll<HTMLButtonElement>(".context-menu button")];
    expect(items.map((item) => [item.textContent, item.disabled])).toEqual([
      ["段落「inner p」を自由配置にする", false],
      ["ブロック「inner p」は自由配置にできません(この種類は canvas に置けません)", true],
    ]);
    act(() => {
      items[1]?.click();
    });
    expect(detachToCanvas).not.toHaveBeenCalled();
  });

  it("ホストが detachToCanvas を持たなければ右クリックメニューを出さない", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const host = fakeHost();
    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK);
    });
    const inner = container.querySelector<HTMLElement>(".slide-scale ul ul span");
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => {
      inner?.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(container.querySelector(".context-menu")).toBeNull();
  });

  it("ホストからの表示要求は表示中 version のときだけ現在フレームを動かす(#66)", () => {
    const container = document.createElement("div");
    document.body.append(container);
    let reveal: ((frameIndex: number, version: number) => void) | undefined;
    const host = {
      ...fakeHost(),
      onRevealFrame(listener: (frameIndex: number, version: number) => void) {
        reveal = listener;
        return () => {};
      },
    };
    act(() => {
      mountPreview(container, host);
    });
    act(() => {
      host.push(DECK, 4);
    });
    const cards = container.querySelectorAll<HTMLElement>(".slide-card");
    act(() => {
      reveal?.(1, 4);
    });
    expect(cards[1]?.classList.contains("active")).toBe(true);
    // 古い version の要求は無視する。
    act(() => {
      reveal?.(0, 3);
    });
    expect(cards[1]?.classList.contains("active")).toBe(true);
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

  it("右クリックはドラッグを始めず、その後のマウス移動で箱が追従しない(#108)", () => {
    const { editable, moveCanvasElement, scale, setPointerCapture } = mountCanvasPreview();
    const left = editable.style.left;
    const top = editable.style.top;

    firePointer(editable, "pointerdown", 150, 100, 7, { button: 2 });
    expect(editable.classList.contains("canvas-dragging")).toBe(false);
    expect(setPointerCapture).not.toHaveBeenCalled();
    act(() => {
      editable.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    // メニュー操作の後にマウスを動かしても、箱は動かず move も送らない。
    firePointer(scale, "pointermove", 300, 250);
    firePointer(scale, "pointermove", 320, 260);
    expect(editable.style.left).toBe(left);
    expect(editable.style.top).toBe(top);
    firePointer(scale, "pointerup", 320, 260);
    expect(moveCanvasElement).not.toHaveBeenCalled();
  });

  it("ドラッグ中に右クリックされたらドラッグを取り消して元の位置に戻す(#108)", () => {
    const { editable, moveCanvasElement, releasePointerCapture, scale } = mountCanvasPreview();
    const left = editable.style.left;
    const top = editable.style.top;
    firePointer(editable, "pointerdown", 150, 100);
    firePointer(scale, "pointermove", 200, 150);
    expect(editable.style.left).not.toBe(left);
    act(() => {
      editable.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    expect(editable.classList.contains("canvas-dragging")).toBe(false);
    expect(editable.style.left).toBe(left);
    expect(editable.style.top).toBe(top);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    firePointer(scale, "pointermove", 260, 200);
    expect(editable.style.left).toBe(left);
    firePointer(scale, "pointerup", 260, 200);
    expect(moveCanvasElement).not.toHaveBeenCalled();
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
