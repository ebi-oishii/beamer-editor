import type { RenderedDeck } from "@beamer-editor/renderer";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionToWebview } from "../src/messages.js";
import { createMessageShellHost, type MessageTransport } from "../src/shell-host.js";

function makeTransport() {
  const posted: unknown[] = [];
  let cb: ((msg: ExtensionToWebview) => void) | undefined;
  const transport: MessageTransport = {
    post(msg) {
      posted.push(msg);
    },
    subscribe(c) {
      cb = c;
      return () => {
        cb = undefined;
      };
    },
  };
  return { transport, posted, receive: (msg: ExtensionToWebview) => cb?.(msg) };
}

function deck(title: string): RenderedDeck {
  return { title, frames: [], css: "" };
}

describe("createMessageShellHost", () => {
  it("現在値より古い version の deckUpdated を捨てる(移植計画 §6)", () => {
    const { transport, receive } = makeTransport();
    const host = createMessageShellHost(transport);
    const listener = vi.fn();
    host.subscribe(listener);

    receive({ type: "deckUpdated", deck: deck("v2"), version: 2, activeFrame: 0 });
    receive({ type: "deckUpdated", deck: deck("v1"), version: 1, activeFrame: 0 });
    receive({ type: "deckUpdated", deck: deck("v2b"), version: 2, activeFrame: 0 });
    receive({ type: "deckUpdated", deck: deck("v3"), version: 3, activeFrame: 0 });

    expect(listener.mock.calls.map(([d]) => (d as RenderedDeck).title)).toEqual([
      "v2",
      "v2b",
      "v3",
    ]);
  });

  it("ナビ状態を WebviewStateStore へ保存・復元し、旧 state と不正 zoom を fit として扱う", () => {
    const { transport } = makeTransport();
    let stored: unknown;
    const host = createMessageShellHost(transport, {
      getState: () => stored,
      setState: (state) => {
        stored = state;
      },
    });

    expect(host.loadNavState?.()).toBeUndefined();
    host.saveNavState?.({ current: 2, step: 3, zoom: 1.5 });
    expect(host.loadNavState?.()).toEqual({ current: 2, step: 3, zoom: 1.5 });

    stored = { current: 2, step: 3 };
    expect(host.loadNavState?.()).toEqual({ current: 2, step: 3, zoom: "fit" });
    stored = { current: 2, step: 3, zoom: "invalid" };
    expect(host.loadNavState?.()).toEqual({ current: 2, step: 3, zoom: "fit" });
    stored = { current: 2, step: 3, zoom: 0.24 };
    expect(host.loadNavState?.()).toEqual({ current: 2, step: 3, zoom: "fit" });
    stored = { current: 2, step: 3, zoom: 3.01 };
    expect(host.loadNavState?.()).toEqual({ current: 2, step: 3, zoom: "fit" });
    stored = { current: 2, step: 3, zoom: Number.POSITIVE_INFINITY };
    expect(host.loadNavState?.()).toEqual({ current: 2, step: 3, zoom: "fit" });
    stored = { current: 2, step: 3, zoom: 0.25 };
    expect(host.loadNavState?.()).toEqual({ current: 2, step: 3, zoom: 0.25 });
    stored = { current: 2, step: 3, zoom: 3 };
    expect(host.loadNavState?.()).toEqual({ current: 2, step: 3, zoom: 3 });

    stored = { current: "2", step: 3 };
    expect(host.loadNavState?.()).toBeUndefined();
    stored = "junk";
    expect(host.loadNavState?.()).toBeUndefined();
    // 範囲・整数性も検証する(壊れた state で空表示にならないように)。
    stored = { current: -1, step: 1 };
    expect(host.loadNavState?.()).toBeUndefined();
    stored = { current: Number.NaN, step: 1 };
    expect(host.loadNavState?.()).toBeUndefined();
    stored = { current: 1.5, step: 1 };
    expect(host.loadNavState?.()).toBeUndefined();
    stored = { current: 0, step: 0 };
    expect(host.loadNavState?.()).toBeUndefined();
  });

  it("StateStore なしでも loadNavState は undefined を返すだけで壊れない", () => {
    const { transport } = makeTransport();
    const host = createMessageShellHost(transport);

    expect(host.loadNavState?.()).toBeUndefined();
    expect(() => host.saveNavState?.({ current: 0, step: 1, zoom: "fit" })).not.toThrow();
  });

  it("ready / jumpToSource / activeFrameChanged を transport へ post する", () => {
    const { transport, posted } = makeTransport();
    const host = createMessageShellHost(transport);

    host.ready();
    host.jumpToSource(3, 5);
    host.notifyActiveFrame(1);

    expect(posted).toEqual([
      { type: "ready" },
      { type: "jumpToSource", frameIndex: 3, version: 5 },
      { type: "activeFrameChanged", frameIndex: 1 },
    ]);
  });

  it("detachToCanvas を transport へ post する", () => {
    const posted: unknown[] = [];
    const host = createMessageShellHost({
      post: (msg) => posted.push(msg),
      subscribe: () => () => {},
    });
    host.detachToCanvas?.(1, 3, { start: 4, end: 9 }, { x: 0.1, y: 0.2, width: 0.5 });
    expect(posted).toEqual([
      {
        type: "detachToCanvas",
        frameIndex: 1,
        version: 3,
        sourceSpan: { start: 4, end: 9 },
        rect: { x: 0.1, y: 0.2, width: 0.5 },
      },
    ]);
  });
});
