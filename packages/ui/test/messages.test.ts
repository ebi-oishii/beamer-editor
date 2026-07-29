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
  });
});
