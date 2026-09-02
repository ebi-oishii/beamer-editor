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
    expect(container.querySelectorAll(".slide-card")).toHaveLength(2);

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

    // 復元された current=1 のスライドがアクティブになる。
    const cards = [...container.querySelectorAll(".slide-card")];
    expect(cards[1]?.classList.contains("active")).toBe(true);
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
    // 手動ズームは外側だけを変え、transform 対象は論理サイズのまま(#58 の幾何契約)。
    expect(container.querySelector<HTMLElement>(".slide-scale")?.style.width).toBe("607px");
    expect(container.querySelector<HTMLElement>(".slide-scale")?.style.height).toBe("341px");
    expect(saved.at(-1)).toEqual({ current: 0, step: 1, zoom: 1.1 });

    const fit = container.querySelector<HTMLButtonElement>('button[aria-label="画面に合わせる"]');
    act(() => fit?.click());
    expect(container.querySelector(".zoom-indicator")?.textContent).toMatch(/^フィット /);
    expect(saved.at(-1)).toEqual({ current: 0, step: 1, zoom: "fit" });
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
    act(() => callbacks.at(-1)?.([], {} as ResizeObserver));
    // (1004 - 32) / 607 は上限 1.6 でクランプされる(32 = scroll padding 24 + card padding 8)。
    expect(layout.style.width).toBe("971.2px");
    expect(layout.style.height).toBe("545.6px");

    Object.defineProperties(scroll, {
      clientWidth: { configurable: true, value: 308 },
      clientHeight: { configurable: true, value: 250 },
    });
    act(() => callbacks.at(-1)?.([], {} as ResizeObserver));
    expect(Number.parseFloat(layout.style.width)).toBeCloseTo(276, 6);
    expect(Number.parseFloat(layout.style.height)).toBeCloseTo(155.05, 2);
    expect(scale.style.width).toBe("607px");
    expect(scale.style.height).toBe("341px");
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
    const captions = [...container.querySelectorAll(".slide-caption")].map((c) => c.textContent);
    expect(captions).toEqual(["1. one", "2. two（label=f2）"]);

    // クリックで選択すると active が移り、frame indicator も追従する。
    const cards = container.querySelectorAll<HTMLElement>(".slide-card");
    act(() => {
      cards[1]?.click();
    });
    expect(cards[1]?.classList.contains("active")).toBe(true);
    expect(container.querySelector(".frame-indicator")?.textContent).toBe("2 / 2");
    // 総数の桁から幅を固定し、フレームが変わっても右側のボタンが動かない。
    expect(container.querySelector<HTMLElement>(".frame-indicator")?.style.minWidth).toBe("5ch");
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

    // ◀ で戻ると移動先のカードが上端へ揃うようにスクロールされる。
    const prev = container.querySelector<HTMLButtonElement>('button[aria-label="前のフレーム"]');
    act(() => {
      prev?.click();
    });
    expect(cards[0]?.classList.contains("active")).toBe(true);
    expect(scrollTop).toBe(0);
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
