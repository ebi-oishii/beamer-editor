import { describe, expect, it } from "vitest";
import { emptyPreviewHtml } from "../src/preview-controller";
import {
  parsePreviewRestoreState,
  previewTitle,
  withPreviewRestoreState,
} from "../src/preview-restore";

describe("プレビューの復元に使う Webview state(#199)", () => {
  it("state から元ソースを取り出し、無い・壊れているなら null", () => {
    expect(
      parsePreviewRestoreState({
        current: 2,
        step: 1,
        restore: { uri: "file:///a/deck.tex", automatic: true },
      }),
    ).toEqual({ uri: "file:///a/deck.tex", automatic: true });
    expect(parsePreviewRestoreState(undefined)).toBeNull();
    expect(parsePreviewRestoreState({ current: 0, step: 1 })).toBeNull();
    expect(parsePreviewRestoreState({ restore: { uri: "", automatic: false } })).toBeNull();
    expect(parsePreviewRestoreState({ restore: { uri: "file:///a.tex" } })).toBeNull();
  });

  it("作った時点で元ソースを保存し、ナビ状態で丸ごと置き換えられても元ソースを残す", () => {
    let saved: unknown;
    const store = withPreviewRestoreState(
      { getState: () => saved, setState: (state) => (saved = state) },
      { uri: "file:///a/deck.tex", automatic: false },
    );
    expect(saved).toEqual({ restore: { uri: "file:///a/deck.tex", automatic: false } });
    store.setState({ current: 3, step: 2, zoom: "fit" });
    expect(saved).toEqual({
      current: 3,
      step: 2,
      zoom: "fit",
      restore: { uri: "file:///a/deck.tex", automatic: false },
    });
    expect(store.getState()).toBe(saved);
  });

  it("前回の state(ナビ状態)は残したまま元ソースを足す", () => {
    let saved: unknown = { current: 4, step: 1 };
    withPreviewRestoreState(
      { getState: () => saved, setState: (state) => (saved = state) },
      { uri: "file:///b.tex", automatic: true },
    );
    expect(saved).toEqual({
      current: 4,
      step: 1,
      restore: { uri: "file:///b.tex", automatic: true },
    });
  });

  it("パネルの HTML に元ソースを入れる(属性値はエスケープする)", () => {
    const html = emptyPreviewHtml({ scriptUri: "s.js", styleUri: "s.css" }, "csp", "nonce", {
      uri: 'file:///a/"x".tex',
      automatic: true,
    });
    expect(html).toContain('data-source-uri="file:///a/&quot;x&quot;.tex" data-automatic="true"');
    expect(
      emptyPreviewHtml({ scriptUri: "s.js", styleUri: "s.css" }, "csp", "nonce"),
    ).not.toContain("data-source-uri");
  });

  it("タブ名はファイル名だけを使う", () => {
    expect(previewTitle("/a/b/deck.slide.tex")).toBe("Beamer Preview: deck.slide.tex");
    expect(previewTitle("C:\\a\\deck.tex")).toBe("Beamer Preview: deck.tex");
  });
});
