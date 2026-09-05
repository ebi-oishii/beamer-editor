import { describe, expect, it } from "vitest";
import { parseExtensionToWebview, parseWebviewToExtension } from "../src/messages.js";

const deck = { title: "t", frames: [], css: "" };

describe("parseExtensionToWebview", () => {
  it("正当な deckUpdated を受理する", () => {
    const msg = { type: "deckUpdated", deck, version: 3, activeFrame: 0 };
    expect(parseExtensionToWebview(msg)).toEqual(msg);
  });

  it("正当な activeFrameChanged / error を受理する", () => {
    expect(
      parseExtensionToWebview({ type: "activeFrameChanged", frameIndex: 1, version: 2 }),
    ).toEqual({ type: "activeFrameChanged", frameIndex: 1, version: 2 });
    expect(parseExtensionToWebview({ type: "error", message: "boom" })).toEqual({
      type: "error",
      message: "boom",
    });
  });

  it("不正なものは null にする", () => {
    expect(parseExtensionToWebview(null)).toBeNull();
    expect(parseExtensionToWebview("deckUpdated")).toBeNull();
    expect(parseExtensionToWebview({ type: "unknown" })).toBeNull();
    // type 欠落
    expect(parseExtensionToWebview({ deck, version: 1, activeFrame: 0 })).toBeNull();
    // version 型違い
    expect(
      parseExtensionToWebview({ type: "deckUpdated", deck, version: "1", activeFrame: 0 }),
    ).toBeNull();
    // deck 欠落
    expect(parseExtensionToWebview({ type: "deckUpdated", version: 1, activeFrame: 0 })).toBeNull();
    // message 型違い
    expect(parseExtensionToWebview({ type: "error", message: 5 })).toBeNull();
  });
});

describe("parseWebviewToExtension", () => {
  it("正当なものを受理する", () => {
    expect(parseWebviewToExtension({ type: "ready" })).toEqual({ type: "ready" });
    expect(parseWebviewToExtension({ type: "jumpToSource", frameIndex: 4, version: 2 })).toEqual({
      type: "jumpToSource",
      frameIndex: 4,
      version: 2,
    });
    expect(parseWebviewToExtension({ type: "activeFrameChanged", frameIndex: 0 })).toEqual({
      type: "activeFrameChanged",
      frameIndex: 0,
    });
    expect(
      parseWebviewToExtension({
        type: "moveCanvasElement",
        frameIndex: 0,
        elementId: "canvas-image-0",
        version: 2,
        x: -0.2,
        y: 1.1,
      }),
    ).toEqual({
      type: "moveCanvasElement",
      frameIndex: 0,
      elementId: "canvas-image-0",
      version: 2,
      x: -0.2,
      y: 1.1,
    });
  });

  it("detachToCanvas は span と rect を検証して受理する", () => {
    const valid = {
      type: "detachToCanvas",
      frameIndex: 2,
      version: 5,
      sourceSpan: { start: 10, end: 40 },
      rect: { x: 0.1, y: 0.25, width: 0.5 },
    };
    expect(parseWebviewToExtension(valid)).toEqual(valid);
    expect(parseWebviewToExtension({ ...valid, sourceSpan: { start: 40, end: 40 } })).toBeNull();
    expect(
      parseWebviewToExtension({ ...valid, rect: { x: Number.NaN, y: 0, width: 1 } }),
    ).toBeNull();
    expect(parseWebviewToExtension({ ...valid, version: undefined })).toBeNull();
  });

  it("不正なものは null にする", () => {
    expect(parseWebviewToExtension(undefined)).toBeNull();
    expect(parseWebviewToExtension(42)).toBeNull();
    expect(parseWebviewToExtension({ type: "nope" })).toBeNull();
    // frameIndex 型違い
    expect(
      parseWebviewToExtension({ type: "jumpToSource", frameIndex: "4", version: 2 }),
    ).toBeNull();
    // version 欠落(古い版からのジャンプ検出に必須)
    expect(parseWebviewToExtension({ type: "jumpToSource", frameIndex: 4 })).toBeNull();
    // frameIndex 欠落
    expect(parseWebviewToExtension({ type: "activeFrameChanged" })).toBeNull();
    expect(
      parseWebviewToExtension({
        type: "moveCanvasElement",
        frameIndex: -1,
        elementId: "x",
        version: 1,
        x: 0,
        y: 0,
      }),
    ).toBeNull();
    expect(
      parseWebviewToExtension({
        type: "moveCanvasElement",
        frameIndex: 0,
        elementId: "x",
        version: 1.5,
        x: Number.NaN,
        y: 0,
      }),
    ).toBeNull();
  });
});
