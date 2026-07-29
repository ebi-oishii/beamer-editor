import { describe, expect, it, vi } from "vitest";
import { PreviewController, type PreviewPanel } from "../src/preview-controller";

/** テスト用のフェイク Webview パネル。postMessage / onDidReceiveMessage を捕捉する。 */
function makePanel() {
  const posted: unknown[] = [];
  let receive: ((msg: unknown) => void) | undefined;
  let disposeListener: (() => void) | undefined;
  const listenerDisposable = { dispose: vi.fn() };
  const receiveDisposable = { dispose: vi.fn() };
  const panel: PreviewPanel & { webview: { html: string } } = {
    webview: {
      html: "",
      postMessage: (msg: unknown) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
      onDidReceiveMessage(listener: (msg: unknown) => void) {
        receive = listener;
        return receiveDisposable;
      },
    },
    onDidDispose(listener: () => void) {
      disposeListener = listener;
      return listenerDisposable;
    },
    dispose: vi.fn(),
  };
  return {
    panel,
    posted,
    fire: (msg: unknown) => receive?.(msg),
    fireDispose: () => disposeListener?.(),
    listenerDisposable,
    receiveDisposable,
  };
}

const doc = { getText: () => "\\begin{frame}Hi\\end{frame}", version: 7 };

describe("PreviewController", () => {
  it("releases its listeners and notifies its owner exactly once", () => {
    const { panel, fireDispose, listenerDisposable, receiveDisposable } = makePanel();
    const onDispose = vi.fn();
    const controller = new PreviewController(panel, "webview.js", doc, onDispose);

    fireDispose();
    controller.dispose();

    expect(listenerDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(receiveDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(panel.webview.html).toContain('id="app"');
  });

  it("closes the panel before releasing its resources", () => {
    const { panel } = makePanel();
    const controller = new PreviewController(panel, "webview.js", doc, vi.fn());

    controller.close();

    expect(panel.dispose).toHaveBeenCalledOnce();
  });

  it("renders and posts a deckUpdated with the document version on ready", () => {
    const { panel, posted, fire } = makePanel();
    new PreviewController(panel, "webview.js", doc, vi.fn());

    fire({ type: "ready" });

    expect(posted).toHaveLength(1);
    const message = posted[0] as { type: string; version: number; activeFrame: number };
    expect(message.type).toBe("deckUpdated");
    expect(message.version).toBe(7);
    expect(message.activeFrame).toBe(0);
  });

  it("ignores invalid webview messages", () => {
    const { panel, posted, fire } = makePanel();
    new PreviewController(panel, "webview.js", doc, vi.fn());

    fire({ type: "bogus" });
    fire(null);

    expect(posted).toHaveLength(0);
  });
});
