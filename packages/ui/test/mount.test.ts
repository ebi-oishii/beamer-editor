// @vitest-environment jsdom
import type { RenderedDeck } from "@beamer-editor/renderer";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { mountPreview } from "../src/preview/mount.js";
import type { ShellHost } from "../src/shell-host.js";

// React の act() を有効化する（createRoot の flush を同期させる）。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
function fakeHost(): ShellHost & { push: (deck: RenderedDeck) => void } {
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
    push(deck) {
      listener?.(deck, 1);
    },
  };
}

describe("mountPreview", () => {
  afterEach(() => {
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
      loadNavState: () => ({ current: 1, step: 1 }),
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
    expect(saved.at(-1)).toEqual({ current: 1, step: 1 });

    // 前へ移動すると新しいナビ状態が保存される。
    const prev = container.querySelector<HTMLButtonElement>('button[aria-label="前のフレーム"]');
    act(() => {
      prev?.click();
    });
    expect(saved.at(-1)).toEqual({ current: 0, step: 1 });
  });
});
