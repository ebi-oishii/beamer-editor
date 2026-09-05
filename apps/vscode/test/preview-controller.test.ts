import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderOutcome } from "../src/document-controller";
import {
  type DocumentEvents,
  PreviewController,
  type PreviewDocument,
  type PreviewDocumentChangeEvent,
  type PreviewPanel,
  RENDER_DEBOUNCE_MS,
  rewriteImageSources,
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
    reveal: vi.fn(),
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
const canvasRender = (_text: string, version: number): RenderOutcome => ({
  deck: {
    title: "t",
    css: "",
    frames: [
      {
        index: 1,
        label: null,
        titleText: "one",
        html: "",
        stepCount: 1,
        isRaw: false,
        sourceSpan: { start: 0, end: 1 },
        canvasElements: [
          {
            id: "canvas-image-0",
            kind: "image",
            position: { x: 0, y: 0, width: 1 },
            sourceSpan: { start: 10, end: 25 },
            editable: true,
          },
          {
            id: "canvas-text-0",
            kind: "text",
            position: { x: 0.5, y: 0.5, width: 0.4 },
            sourceSpan: { start: 30, end: 45 },
            editable: true,
          },
        ],
      },
    ],
  },
  version,
  expansionMap: [],
  expandDiagnostics: [],
});

describe("rewriteImageSources", () => {
  it("エスケープ済みパスを復元して resolve し、結果を再エスケープする", () => {
    const html = '<img class="x" src="figs/a&amp;b.png">';
    const seen: string[] = [];
    const result = rewriteImageSources(html, (path) => {
      seen.push(path);
      return `resolved://${path}?q="v"`;
    });

    expect(seen).toEqual(["figs/a&b.png"]);
    expect(result).toBe('<img class="x" src="resolved://figs/a&amp;b.png?q=&quot;v&quot;">');
  });

  it("http(s) / data / vscode-webview 系の src は書き換えない", () => {
    const html = '<img src="https://a/b.png"><img src="data:x"><img src="vscode-webview://x/y">';
    expect(rewriteImageSources(html, () => "BOOM")).toBe(html);
  });
});

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

  it("reveals the existing panel without disposing it", () => {
    const { panel } = makePanel();
    const { events } = makeEvents();
    const controller = new PreviewController(panel, ASSETS, makeDoc(), events, vi.fn());

    controller.reveal();

    expect(panel.reveal).toHaveBeenCalledOnce();
    expect(panel.dispose).not.toHaveBeenCalled();
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

  it("moveCanvasElement: 最新・editable な画像だけを一度 callback へ渡す", async () => {
    const { panel, fire } = makePanel();
    const { events } = makeEvents();
    const doc = makeDoc();
    const moveCanvasElement = vi.fn(async () => "applied" as const);
    const render = (_text: string, version: number): RenderOutcome => ({
      deck: {
        title: "t",
        css: "",
        frames: [
          {
            index: 1,
            label: null,
            titleText: "one",
            html: "",
            stepCount: 1,
            isRaw: false,
            sourceSpan: { start: 0, end: 1 },
            canvasElements: [
              {
                id: "canvas-image-0",
                kind: "image",
                position: { x: 0, y: 0, width: 1 },
                sourceSpan: { start: 10, end: 25 },
                editable: true,
              },
            ],
          },
        ],
      },
      version,
      expansionMap: [],
      expandDiagnostics: [],
    });
    new PreviewController(panel, ASSETS, doc, events, vi.fn(), { render, moveCanvasElement });
    fire({ type: "ready" });
    fire({
      type: "moveCanvasElement",
      frameIndex: 0,
      elementId: "canvas-image-0",
      version: 7,
      x: -0.25,
      y: 1.5,
    });
    await Promise.resolve();
    expect(moveCanvasElement).toHaveBeenCalledExactlyOnceWith({
      frameIndex: 0,
      elementId: "canvas-image-0",
      version: 7,
      x: -0.25,
      y: 1.5,
      sourceSpan: { start: 10, end: 25 },
      document: doc,
      expectedOptions: doc.getText().slice(10, 25),
    });
  });

  describe("detachToCanvas", () => {
    const detachRender = (text: string, version: number): RenderOutcome => ({
      ...canvasRender(text, version),
      // 展開後 = 元ソース(逐語)の対応。
      expansionMap: [
        { expandedStart: 0, expandedEnd: 500, sourceStart: 0, sourceEnd: 500, exact: true },
      ],
    });

    it("最新 version の要求だけを、元ソース span と本文領域座標に変換して callback へ渡す", async () => {
      const { panel, fire } = makePanel();
      const { events } = makeEvents();
      const doc = makeDoc();
      const detachToCanvas = vi.fn(async (_request: unknown) => "applied" as const);
      new PreviewController(panel, ASSETS, doc, events, vi.fn(), {
        render: detachRender,
        detachToCanvas,
      });
      fire({ type: "ready" });
      fire({
        type: "detachToCanvas",
        frameIndex: 0,
        version: 7,
        sourceSpan: { start: 12, end: 30 },
        rect: { x: 0.5, y: 0.5, width: 0.25 },
      });
      await Promise.resolve();
      expect(detachToCanvas).toHaveBeenCalledOnce();
      const request = detachToCanvas.mock.calls[0]?.[0] as {
        frameIndex: number;
        version: number;
        sourceSpan: { start: number; end: number };
        placement: { x: number; y: number; width: number };
        document: unknown;
      };
      expect(request.frameIndex).toBe(0);
      expect(request.version).toBe(7);
      expect(request.sourceSpan).toEqual({ start: 12, end: 30 });
      expect(request.document).toBe(doc);
      // 本文領域: left 28.45 / top 19.06 / width 398.34 / height 236.97 (slide 455.24 × 256.07)
      expect(request.placement.x).toBeCloseTo(0.5, 6);
      expect(request.placement.y).toBeCloseTo((0.5 * 256.07 - 19.06) / 236.97, 6);
      expect(request.placement.width).toBeCloseTo((0.25 * 455.24) / 398.34, 6);
    });

    it("古い version の要求は適用せず再描画し、展開由来の span は警告だけ出す", async () => {
      const { panel, posted, fire } = makePanel();
      const { events } = makeEvents();
      const detachToCanvas = vi.fn(async () => "applied" as const);
      const warning = vi.fn();
      new PreviewController(panel, ASSETS, makeDoc(), events, vi.fn(), {
        render: detachRender,
        detachToCanvas,
        onWarning: warning,
      });
      fire({ type: "ready" });
      const before = posted.length;
      fire({
        type: "detachToCanvas",
        frameIndex: 0,
        version: 6,
        sourceSpan: { start: 12, end: 30 },
        rect: { x: 0.5, y: 0.5, width: 0.25 },
      });
      await Promise.resolve();
      expect(detachToCanvas).not.toHaveBeenCalled();
      expect(posted.length).toBe(before + 1);

      fire({
        type: "detachToCanvas",
        frameIndex: 0,
        version: 7,
        sourceSpan: { start: 600, end: 650 },
        rect: { x: 0.5, y: 0.5, width: 0.25 },
      });
      await Promise.resolve();
      expect(detachToCanvas).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith("マクロ展開由来の要素は自由配置にできません。");
    });
  });

  it("moveCanvasElement: decktext も画像と同じ経路で callback へ渡す", async () => {
    const { panel, fire } = makePanel();
    const { events } = makeEvents();
    const doc = makeDoc();
    const moveCanvasElement = vi.fn(async () => "applied" as const);
    new PreviewController(panel, ASSETS, doc, events, vi.fn(), {
      render: canvasRender,
      moveCanvasElement,
    });
    fire({ type: "ready" });
    fire({
      type: "moveCanvasElement",
      frameIndex: 0,
      elementId: "canvas-text-0",
      version: 7,
      x: 0.3,
      y: 0.25,
    });
    await Promise.resolve();
    expect(moveCanvasElement).toHaveBeenCalledExactlyOnceWith({
      frameIndex: 0,
      elementId: "canvas-text-0",
      version: 7,
      x: 0.3,
      y: 0.25,
      sourceSpan: { start: 30, end: 45 },
      document: doc,
      expectedOptions: doc.getText().slice(30, 45),
    });
  });

  describe("revealSourceOffset(ソース → プレビュー)", () => {
    const twoFrames = (_text: string, version: number): RenderOutcome => ({
      deck: {
        title: "t",
        css: "",
        frames: [
          {
            index: 1,
            label: null,
            titleText: "a",
            html: "",
            stepCount: 1,
            isRaw: false,
            sourceSpan: { start: 0, end: 20 },
          },
          {
            index: 2,
            label: null,
            titleText: "b",
            html: "",
            stepCount: 1,
            isRaw: false,
            sourceSpan: { start: 20, end: 40 },
          },
        ],
      },
      version,
      expansionMap: [
        { expandedStart: 0, expandedEnd: 100, sourceStart: 0, sourceEnd: 100, exact: true },
      ],
      expandDiagnostics: [],
    });

    it("offset を含むフレームを表示中の version 付きで Webview へ送り、フレーム外は送らない", () => {
      const { panel, posted, fire } = makePanel();
      const { events } = makeEvents();
      const controller = new PreviewController(panel, ASSETS, makeDoc(), events, vi.fn(), {
        render: twoFrames,
      });
      fire({ type: "ready" });
      const before = posted.length;
      controller.revealSourceOffset(25);
      expect(posted.slice(before)).toEqual([
        { type: "activeFrameChanged", frameIndex: 1, version: 7 },
      ]);
      controller.revealSourceOffset(90);
      expect(posted.length).toBe(before + 1);
    });

    it("描画前の要求は初回描画の後に適用し、onlyIfChanged は同じフレームを繰り返さない", () => {
      const { panel, posted, fire } = makePanel();
      const { events } = makeEvents();
      const controller = new PreviewController(panel, ASSETS, makeDoc(), events, vi.fn(), {
        render: twoFrames,
      });
      controller.revealSourceOffset(5);
      expect(posted).toHaveLength(0);
      fire({ type: "ready" });
      expect(posted.map((m) => (m as { type: string }).type)).toEqual([
        "deckUpdated",
        "activeFrameChanged",
      ]);
      const before = posted.length;
      controller.revealSourceOffset(10, { onlyIfChanged: true });
      expect(posted.length).toBe(before);
      controller.revealSourceOffset(30, { onlyIfChanged: true });
      expect(posted.length).toBe(before + 1);
      expect(posted.at(-1)).toEqual({ type: "activeFrameChanged", frameIndex: 1, version: 7 });
    });
  });

  it.each([
    "failed" as const,
    new Error("reject"),
  ])("move callback failure (%s) re-renders and reports once", async (result) => {
    const { panel, posted, fire } = makePanel();
    const { events } = makeEvents();
    const error = vi.fn();
    const warning = vi.fn();
    const callback = vi.fn(() =>
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
    );
    new PreviewController(panel, ASSETS, makeDoc(), events, vi.fn(), {
      render: canvasRender,
      onError: error,
      onWarning: warning,
      moveCanvasElement: callback,
    });
    fire({ type: "ready" });
    fire({
      type: "moveCanvasElement",
      frameIndex: 0,
      elementId: "canvas-image-0",
      version: 7,
      x: 1,
      y: 1,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(error).toHaveBeenCalledTimes(1);
    expect(warning).not.toHaveBeenCalled();
    expect(posted).toHaveLength(2);
  });

  it("unchanged move silently redraws and permits another move at the same version", async () => {
    const { panel, posted, fire } = makePanel();
    const { events } = makeEvents();
    const callback = vi.fn(async () => "unchanged" as const);
    const warning = vi.fn();
    const error = vi.fn();
    new PreviewController(panel, ASSETS, makeDoc(), events, vi.fn(), {
      render: canvasRender,
      onWarning: warning,
      onError: error,
      moveCanvasElement: callback,
    });
    fire({ type: "ready" });
    const move = {
      type: "moveCanvasElement",
      frameIndex: 0,
      elementId: "canvas-image-0",
      version: 7,
      x: 0.25,
      y: 0.5,
    } as const;

    fire(move);
    await Promise.resolve();
    fire({ ...move, x: 0.75 });
    await Promise.resolve();

    expect(callback).toHaveBeenCalledTimes(2);
    expect(posted).toHaveLength(3);
    expect(warning).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("cancelled move warns, redraws, and permits a retry", async () => {
    const { panel, posted, fire } = makePanel();
    const { events } = makeEvents();
    const callback = vi.fn(async () => "cancelled" as const);
    const warning = vi.fn();
    const error = vi.fn();
    new PreviewController(panel, ASSETS, makeDoc(), events, vi.fn(), {
      render: canvasRender,
      onWarning: warning,
      onError: error,
      moveCanvasElement: callback,
    });
    fire({ type: "ready" });
    const move = {
      type: "moveCanvasElement",
      frameIndex: 0,
      elementId: "canvas-image-0",
      version: 7,
      x: 0.25,
      y: 0.5,
    } as const;

    fire(move);
    await Promise.resolve();
    fire({ ...move, x: 0.75 });
    await Promise.resolve();

    expect(callback).toHaveBeenCalledTimes(2);
    expect(posted).toHaveLength(3);
    expect(warning).toHaveBeenCalledWith(
      "Canvas element position was not updated. Try dragging it again.",
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("applyEdit 中は同じ旧 version の追加 move を無視し、再描画後に解除する", async () => {
    const { panel, posted, fire } = makePanel();
    const { events } = makeEvents();
    let settle: ((value: "failed") => void) | undefined;
    const pending = new Promise<"failed">((resolve) => {
      settle = resolve;
    });
    const callback = vi.fn(() => pending);
    new PreviewController(panel, ASSETS, makeDoc(), events, vi.fn(), {
      render: canvasRender,
      moveCanvasElement: callback,
    });
    fire({ type: "ready" });
    const first = {
      type: "moveCanvasElement",
      frameIndex: 0,
      elementId: "canvas-image-0",
      version: 7,
      x: 0.25,
      y: 0.5,
    } as const;
    fire(first);
    fire({ ...first, x: 0.75 });
    expect(callback).toHaveBeenCalledTimes(1);

    settle?.("failed");
    await Promise.resolve();
    await Promise.resolve();
    expect(posted).toHaveLength(2);

    fire({ ...first, x: 0.75 });
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("成功した move は更新後 version の再描画まで次の move を待たせる", async () => {
    const { panel, fire } = makePanel();
    const { events, change } = makeEvents();
    const doc = makeDoc();
    const callback = vi.fn(async () => "applied" as const);
    new PreviewController(panel, ASSETS, doc, events, vi.fn(), {
      render: canvasRender,
      moveCanvasElement: callback,
    });
    fire({ type: "ready" });
    const move = {
      type: "moveCanvasElement",
      frameIndex: 0,
      elementId: "canvas-image-0",
      version: 7,
      x: 0.25,
      y: 0.5,
    } as const;
    fire(move);
    await Promise.resolve();
    fire({ ...move, x: 0.75 });
    expect(callback).toHaveBeenCalledTimes(1);

    doc.edit(`${doc.getText()} `);
    change(doc);
    vi.advanceTimersByTime(RENDER_DEBOUNCE_MS);
    fire({ ...move, version: 8, x: 0.75 });
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it.each([
    "failed" as const,
    new Error("reject"),
  ])("disposed pending callback (%s) is silent", async (result) => {
    const { panel, posted, fire } = makePanel();
    const { events } = makeEvents();
    const error = vi.fn();
    let settle: ((value: "failed") => void) | undefined;
    let reject: ((reason: unknown) => void) | undefined;
    const pending = new Promise<"failed">((resolve, rejectPromise) => {
      settle = resolve;
      reject = rejectPromise;
    });
    const controller = new PreviewController(panel, ASSETS, makeDoc(), events, vi.fn(), {
      render: canvasRender,
      onError: error,
      moveCanvasElement: () => pending,
    });
    fire({ type: "ready" });
    fire({
      type: "moveCanvasElement",
      frameIndex: 0,
      elementId: "canvas-image-0",
      version: 7,
      x: 1,
      y: 1,
    });
    controller.dispose();
    if (result instanceof Error) reject?.(result);
    else settle?.(result);
    await Promise.resolve();
    await Promise.resolve();
    expect(error).not.toHaveBeenCalled();
    expect(posted).toHaveLength(1);
  });

  it("same URI/version replacement document cannot use old latest descriptors", () => {
    const { panel, posted, fire } = makePanel();
    const { events, change } = makeEvents();
    const doc = makeDoc();
    const callback = vi.fn();
    new PreviewController(panel, ASSETS, doc, events, vi.fn(), {
      render: canvasRender,
      moveCanvasElement: callback,
    });
    fire({ type: "ready" });
    const replacement = { ...makeDoc(), getText: () => "different same-version text" };
    change(replacement);
    fire({
      type: "moveCanvasElement",
      frameIndex: 0,
      elementId: "canvas-image-0",
      version: 7,
      x: 1,
      y: 1,
    });
    expect(callback).not.toHaveBeenCalled();
    expect(posted).toHaveLength(2);
  });

  it("resolveResource 指定時は送信する deck の <img src> だけを書き換える", () => {
    const { panel, posted, fire } = makePanel();
    const { events } = makeEvents();
    const html =
      '<div><img src="figs/a.png"><img src="https://cdn/x.png"><img src="data:image/png;base64,AA"></div>';
    const render = (_text: string, version: number): RenderOutcome => ({
      deck: {
        title: "t",
        css: "",
        frames: [
          {
            index: 1,
            label: null,
            titleText: "one",
            html,
            stepCount: 1,
            isRaw: false,
            sourceSpan: { start: 0, end: 1 },
          },
        ],
      },
      version,
      expansionMap: [],
      expandDiagnostics: [],
    });
    const controller = new PreviewController(panel, ASSETS, makeDoc(), events, vi.fn(), {
      render,
      resolveResource: (path) => `vscode-webview://authority/${path}`,
    });

    fire({ type: "ready" });

    const sent = (posted[0] as { deck: { frames: { html: string }[] } }).deck.frames[0]
      ?.html as string;
    expect(sent).toContain('src="vscode-webview://authority/figs/a.png"');
    expect(sent).toContain('src="https://cdn/x.png"');
    expect(sent).toContain('src="data:image/png;base64,AA"');
    // latestOutcome(ジャンプ・診断の参照元)は書き換え前の deck を保持する。
    expect(controller.latestOutcome?.deck.frames[0]?.html).toBe(html);
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
