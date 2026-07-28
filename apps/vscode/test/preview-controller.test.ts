import { describe, expect, it, vi } from "vitest";
import { PreviewController } from "../src/preview-controller";

describe("PreviewController", () => {
  it("releases its panel listener and notifies its owner exactly once", () => {
    const listenerDisposable = { dispose: vi.fn() };
    const disposePanel = vi.fn();
    let disposeListener: (() => void) | undefined;
    const onDispose = vi.fn();
    const panel = {
      webview: { html: "" },
      onDidDispose(listener: () => void) {
        disposeListener = listener;
        return listenerDisposable;
      },
      dispose: disposePanel,
    };
    const controller = new PreviewController(panel, "webview.js", onDispose);

    disposeListener?.();
    controller.dispose();

    expect(listenerDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(panel.webview.html).toContain('id="app"');
  });

  it("closes the panel before releasing its resources", () => {
    const panel = {
      webview: { html: "" },
      onDidDispose: () => ({ dispose: vi.fn() }),
      dispose: vi.fn(),
    };
    const controller = new PreviewController(panel, "webview.js", vi.fn());

    controller.close();

    expect(panel.dispose).toHaveBeenCalledOnce();
  });
});
