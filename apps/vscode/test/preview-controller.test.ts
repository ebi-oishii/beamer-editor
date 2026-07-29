import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderOutcome } from "../src/document-controller";
import {
  type DocumentEvents,
  PreviewController,
  type PreviewDocument,
  type PreviewDocumentChangeEvent,
  type PreviewPanel,
  RENDER_DEBOUNCE_MS,
} from "../src/preview-controller";

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
      cspSource: "https://csp.test",
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

/** テスト用のフェイク onDidChangeTextDocument。change() でイベントを発火する。 */
function makeEvents() {
  let listener: ((event: PreviewDocumentChangeEvent) => void) | undefined;
  const disposable = { dispose: vi.fn() };
  const events: DocumentEvents = {
    onDidChangeTextDocument(l) {
      listener = l;
      return disposable;
    },
  };
  return {
    events,
    change: (document: PreviewDocument, contentChanges: readonly unknown[] = [{}]) =>
      listener?.({ document, contentChanges }),
    disposable,
  };
}

/** 内容と version を書き換えられるフェイク文書。 */
function makeDoc(uri = "file:///deck.tex") {
  return {
    uri: { toString: () => uri },
    version: 7,
    text: "\\begin{document}\\begin{frame}{Hi}A\\end{frame}\\end{document}",
    getText() {
      return this.text;
    },
    edit(text: string) {
      this.text = text;
      this.version += 1;
    },
  };
}

type DeckMessage = { type: string; version: number; activeFrame: number };

const ASSETS = { scriptUri: "webview.js", styleUri: "webview.css" };

describe("PreviewController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases its listeners and notifies its owner exactly once", () => {
    const { panel, fireDispose, listenerDisposable, receiveDisposable } = makePanel();
    const { events, disposable } = makeEvents();
    const onDispose = vi.fn();
    const controller = new PreviewController(panel, ASSETS, makeDoc(), events, onDispose);

    fireDispose();
    controller.dispose();

    expect(listenerDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(receiveDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(disposable.dispose).toHaveBeenCalledTimes(1);
    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(panel.webview.html).toContain('id="app"');
  });

  it("closes the panel before releasing its resources", () => {
    const { panel } = makePanel();
    const { events } = makeEvents();
    const controller = new PreviewController(panel, ASSETS, makeDoc(), events, vi.fn());

    controller.close();

    expect(panel.dispose).toHaveBeenCalledOnce();
  });

  it("renders and posts a deckUpdated with the document version on ready", () => {
    const { panel, posted, fire } = makePanel();
    const { events } = makeEvents();
    new PreviewController(panel, ASSETS, makeDoc(), events, vi.fn());

    fire({ type: "ready" });

    expect(posted).toHaveLength(1);
    const message = posted[0] as DeckMessage;
    expect(message.type).toBe("deckUpdated");
    expect(message.version).toBe(7);
    expect(message.activeFrame).toBe(0);
  });

  it("Webview HTML に CSP(default-src 'none' + nonce)とアセット参照が入る", () => {
    const { panel } = makePanel();
    const { events } = makeEvents();
    new PreviewController(panel, ASSETS, makeDoc(), events, vi.fn());

    const html = panel.webview.html;
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("style-src https://csp.test 'unsafe-inline'");
    expect(html).toContain("font-src https://csp.test data:");
    expect(html).toContain('<link rel="stylesheet" href="webview.css"');
    const nonce = html.match(/script-src 'nonce-([a-f0-9]+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}" src="webview.js">`);
  });

  it("ignores invalid webview messages", () => {
    const { panel, posted, fire } = makePanel();
    const { events } = makeEvents();
    new PreviewController(panel, ASSETS, makeDoc(), events, vi.fn());

    fire({ type: "bogus" });
    fire(null);

    expect(posted).toHaveLength(0);
  });

  it("保存せずに編集してもプレビューが更新される(debounce 後に最新の内容と version)", () => {
    const { panel, posted, fire } = makePanel();
    const { events, change } = makeEvents();
    const doc = makeDoc();
    new PreviewController(panel, ASSETS, doc, events, vi.fn());
    fire({ type: "ready" });

    doc.edit("\\begin{document}\\begin{frame}{Hi}B\\end{frame}\\end{document}");
    change(doc);
    vi.advanceTimersByTime(RENDER_DEBOUNCE_MS);

    expect(posted).toHaveLength(2);
    const message = posted[1] as DeckMessage;
    expect(message.type).toBe("deckUpdated");
    expect(message.version).toBe(8);
  });

  it("連続入力は 1 回のレンダリングへまとめられ、最後の内容だけが送られる", () => {
    const { panel, posted } = makePanel();
    const { events, change } = makeEvents();
    const doc = makeDoc();
    new PreviewController(panel, ASSETS, doc, events, vi.fn());

    for (const text of ["A", "AB", "ABC"]) {
      doc.edit(`\\begin{document}\\begin{frame}{Hi}${text}\\end{frame}\\end{document}`);
      change(doc);
      vi.advanceTimersByTime(RENDER_DEBOUNCE_MS / 2);
    }
    vi.advanceTimersByTime(RENDER_DEBOUNCE_MS);

    expect(posted).toHaveLength(1);
    expect((posted[0] as DeckMessage).version).toBe(10);
  });

  it("close → 再オープンで別インスタンスになった同一文書にも追従する", () => {
    const { panel, posted, fire } = makePanel();
    const { events, change } = makeEvents();
    const original = makeDoc();
    new PreviewController(panel, ASSETS, original, events, vi.fn());
    fire({ type: "ready" });

    // タブを閉じて開き直すと、同じ uri の新しい TextDocument から変更イベントが届く。
    const reopened = makeDoc();
    reopened.version = 1;
    reopened.edit("\\begin{document}\\begin{frame}{Hi}REOPENED\\end{frame}\\end{document}");
    change(reopened);
    vi.advanceTimersByTime(RENDER_DEBOUNCE_MS);

    expect(posted).toHaveLength(2);
    // 凍結した旧インスタンス(version 7)ではなく、新インスタンスの内容が描画される。
    expect((posted[1] as DeckMessage).version).toBe(2);
  });

  it("別ファイルの変更ではプレビューを再計算しない", () => {
    const { panel, posted } = makePanel();
    const { events, change } = makeEvents();
    new PreviewController(panel, ASSETS, makeDoc(), events, vi.fn());

    change(makeDoc("file:///other.tex"));
    vi.advanceTimersByTime(RENDER_DEBOUNCE_MS * 2);

    expect(posted).toHaveLength(0);
  });

  it("contentChanges が空のイベント(保存など)では再レンダリングしない", () => {
    const { panel, posted } = makePanel();
    const { events, change } = makeEvents();
    const doc = makeDoc();
    new PreviewController(panel, ASSETS, doc, events, vi.fn());

    change(doc, []);
    vi.advanceTimersByTime(RENDER_DEBOUNCE_MS * 2);

    expect(posted).toHaveLength(0);
  });

  it("パネルを閉じた後は保留中の debounce も含めて更新処理が走らない", () => {
    const { panel, posted } = makePanel();
    const { events, change } = makeEvents();
    const doc = makeDoc();
    const controller = new PreviewController(panel, ASSETS, doc, events, vi.fn());

    change(doc);
    controller.dispose();
    vi.advanceTimersByTime(RENDER_DEBOUNCE_MS * 2);
    change(doc);
    vi.advanceTimersByTime(RENDER_DEBOUNCE_MS * 2);

    expect(posted).toHaveLength(0);
  });

  it("jumpToSource: 最新版のプレビューからのジャンプは元ソースのオフセットへ移動する", () => {
    const { panel, posted, fire } = makePanel();
    const { events } = makeEvents();
    const doc = makeDoc();
    const navigate = vi.fn();
    const render = (_text: string, version: number): RenderOutcome => ({
      deck: {
        title: "t",
        css: "",
        frames: [
          {
            index: 1,
            label: null,
            titleText: "one",
            html: "<div />",
            stepCount: 1,
            isRaw: false,
            // 展開後座標。exact セグメントで +10 ずれた元ソースに対応させる。
            sourceSpan: { start: 25, end: 40 },
          },
        ],
      },
      version,
      expansionMap: [
        { expandedStart: 0, expandedEnd: 100, sourceStart: 10, sourceEnd: 110, exact: true },
      ],
      expandDiagnostics: [],
    });
    new PreviewController(panel, ASSETS, doc, events, vi.fn(), { render, navigate });

    fire({ type: "ready" });
    fire({ type: "jumpToSource", frameIndex: 0, version: 7 });

    expect(navigate).toHaveBeenCalledExactlyOnceWith(35);
    // ジャンプで余計な再送はしない(ready の 1 通のみ)。
    expect(posted).toHaveLength(1);
  });

  it("jumpToSource: プレビューが古い版を見ていたら移動せず再描画を送る", () => {
    const { panel, posted, fire } = makePanel();
    const { events, change } = makeEvents();
    const doc = makeDoc();
    const navigate = vi.fn();
    new PreviewController(panel, ASSETS, doc, events, vi.fn(), { navigate });
    fire({ type: "ready" });

    // 編集直後(debounce 保留中)は document.version が先行する。
    doc.edit("\\begin{document}\\begin{frame}{Hi}B\\end{frame}\\end{document}");
    change(doc);
    fire({ type: "jumpToSource", frameIndex: 0, version: 7 });

    expect(navigate).not.toHaveBeenCalled();
    expect(posted).toHaveLength(2);
    expect((posted[1] as DeckMessage).type).toBe("deckUpdated");
    expect((posted[1] as DeckMessage).version).toBe(8);
  });

  it("jumpToSource: 存在しない frameIndex では何もしない", () => {
    const { panel, posted, fire } = makePanel();
    const { events } = makeEvents();
    const navigate = vi.fn();
    new PreviewController(panel, ASSETS, makeDoc(), events, vi.fn(), { navigate });
    fire({ type: "ready" });

    fire({ type: "jumpToSource", frameIndex: 99, version: 7 });

    expect(navigate).not.toHaveBeenCalled();
    expect(posted).toHaveLength(1);
  });

  it("予期しない例外では error を通知し、最後に成功した結果を保持する", () => {
    const { panel, posted, fire } = makePanel();
    const { events, change } = makeEvents();
    const doc = makeDoc();
    const onError = vi.fn();
    const render = (text: string, version: number): RenderOutcome => {
      if (text.includes("BOOM")) throw new Error("boom");
      return {
        deck: { title: "t", frames: [], css: "" },
        version,
        expansionMap: [],
        expandDiagnostics: [],
      };
    };
    const controller = new PreviewController(panel, ASSETS, doc, events, vi.fn(), {
      render,
      onError,
    });

    fire({ type: "ready" });
    const goodOutcome = controller.latestOutcome;

    doc.edit("BOOM");
    change(doc);
    vi.advanceTimersByTime(RENDER_DEBOUNCE_MS);

    expect(posted).toHaveLength(2);
    expect((posted[0] as DeckMessage).type).toBe("deckUpdated");
    expect((posted[1] as { type: string }).type).toBe("error");
    expect(onError).toHaveBeenCalledTimes(1);
    // 最後に成功した結果は失敗で上書きされない(VS-4/VS-5 の参照先)。
    expect(controller.latestOutcome).toBe(goodOutcome);
    expect(controller.latestOutcome?.version).toBe(7);
  });
});
