/**
 * Webview エントリ。packages/ui のプレビューを #app へマウントする。
 * ここは apps/vscode（Webview コンテキスト）なので acquireVsCodeApi を使ってよい。
 * webview グローバルは MessageTransport / WebviewStateStore に閉じ込め、ui へは持ち込まない。
 * acquireVsCodeApi の戻り値はモジュールスコープに留め、global へ公開しない(移植計画 VS-8)。
 */

import {
  createMessageShellHost,
  type ExtensionToWebview,
  type MessageTransport,
  mountPreview,
  parseExtensionToWebview,
  type RasterImage,
  type WebviewToExtension,
} from "@beamer-editor/ui";
import * as pdfjs from "pdfjs-dist";
import { rasterScaleFor } from "./raster-scale";
// KaTeX の数式 CSS とフォント。esbuild が media/webview.css + フォントへ抽出する。
import "katex/dist/katex.min.css";

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

document.documentElement.dataset.beamerEditor = "preview";

const api = acquireVsCodeApi();

const transport: MessageTransport = {
  post: (msg: WebviewToExtension) => api.postMessage(msg),
  subscribe: (cb: (msg: ExtensionToWebview) => void) => {
    const handler = (event: MessageEvent) => {
      const msg = parseExtensionToWebview(event.data);
      if (msg) cb(msg);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  },
};

// ナビ状態(現在フレーム・step・zoom)だけを getState / setState で保存する(移植計画 VS-7)。
const host = createMessageShellHost(transport, {
  getState: () => api.getState(),
  setState: (state) => api.setState(state),
});
const container = document.getElementById("app");

const pdfWorker = container?.dataset.pdfWorker;
let pdfWorkerBlob: Promise<string> | undefined;

function localPdfWorker(): Promise<string> {
  // A blob worker importing the cross-origin Webview resource can stall in
  // Electron. Load the bundled module from the Webview and start it directly.
  pdfWorkerBlob ??= (async () => {
    if (!pdfWorker) throw new Error("PDF ワーカーの URI を取得できません。");
    const response = await fetch(pdfWorker);
    if (!response.ok) throw new Error(`PDF ワーカーを読み込めません (${response.status})。`);
    const module = new Blob([await response.blob()], { type: "text/javascript" });
    return URL.createObjectURL(module);
  })().catch((error) => {
    pdfWorkerBlob = undefined;
    throw error;
  });
  return pdfWorkerBlob;
}

async function readPdf<T>(
  bytes: Uint8Array,
  read: (pdf: pdfjs.PDFDocumentProxy) => Promise<T>,
): Promise<T> {
  const port = new Worker(await localPdfWorker(), { type: "module" });
  const worker = pdfjs.PDFWorker.create({ port });
  const listener = new AbortController();
  let failed = false;
  const workerError = new Promise<never>((_resolve, reject) => {
    port.addEventListener(
      "error",
      (event) => {
        failed = true;
        reject(new Error(event.message || "PDF ワーカーを起動できません。"));
      },
      { once: true, signal: listener.signal },
    );
  });
  let task: pdfjs.PDFDocumentLoadingTask | undefined;
  try {
    task = pdfjs.getDocument({ data: bytes, worker });
    return await Promise.race([task.promise.then(read), workerError]);
  } finally {
    listener.abort();
    try {
      if (!failed) await task?.destroy();
    } finally {
      worker.destroy();
      port.terminate();
    }
  }
}

function installPdfConfirmation(app: HTMLElement): void {
  const toolbar = document.createElement("header");
  toolbar.className = "deck-preview-tabs";
  toolbar.setAttribute("role", "group");
  toolbar.setAttribute("aria-label", "プレビュー表示");
  toolbar.innerHTML = `
    <button type="button" data-tab="edit" aria-controls="app">編集</button>
    <button type="button" data-tab="pdf" aria-controls="deck-pdf-confirmation">PDF確認</button>`;
  app.before(toolbar);

  const pane = document.createElement("section");
  pane.id = "deck-pdf-confirmation";
  pane.setAttribute("aria-label", "PDF確認");
  pane.innerHTML = `
    <div class="deck-pdf-toolbar">
      <span class="deck-pdf-status" role="status"></span>
      <div class="deck-pdf-controls">
        <button type="button" data-action="previous-page">前のページ</button>
        <span class="deck-pdf-page" aria-live="polite"></span>
        <button type="button" data-action="next-page">次のページ</button>
        <button type="button" data-action="refresh">更新</button>
        <button type="button" data-action="save">表示中の PDF を保存</button>
      </div>
      <p class="deck-pdf-render-error" role="status" hidden></p>
    </div>
    <div class="deck-pdf-pages"></div>`;
  app.after(pane);

  const [edit, pdfTab] = toolbar.querySelectorAll("button");
  const status = pane.querySelector<HTMLElement>(".deck-pdf-status");
  const renderError = pane.querySelector<HTMLElement>(".deck-pdf-render-error");
  const pages = pane.querySelector<HTMLElement>(".deck-pdf-pages");
  const refresh = pane.querySelector<HTMLButtonElement>('[data-action="refresh"]');
  const save = pane.querySelector<HTMLButtonElement>('[data-action="save"]');
  const previous = pane.querySelector<HTMLButtonElement>('[data-action="previous-page"]');
  const next = pane.querySelector<HTMLButtonElement>('[data-action="next-page"]');
  const pageLabel = pane.querySelector<HTMLElement>(".deck-pdf-page");
  if (
    !edit ||
    !pdfTab ||
    !status ||
    !renderError ||
    !pages ||
    !refresh ||
    !save ||
    !previous ||
    !next ||
    !pageLabel
  )
    return;

  let pdfDocument: pdfjs.PDFDocumentProxy | undefined;
  let pdfWorkerSession:
    | {
        run: <T>(operation: Promise<T>) => Promise<T>;
        close: () => Promise<void>;
      }
    | undefined;
  let closingSession = Promise.resolve();
  let pageRender: pdfjs.RenderTask | undefined;
  let pdfLoadRevision = 0;
  let currentArtifactId: number | undefined;
  let requestedArtifactId: number | undefined;
  let revision = -1;
  let rendering = 0;
  let pageNumber = 1;
  let pageCount = 0;
  let busy = false;
  let restricted = false;

  const updateControls = () => {
    const canNavigate = !busy && !!pdfDocument && currentArtifactId === requestedArtifactId;
    previous.disabled = !canNavigate || pageNumber <= 1;
    next.disabled = !canNavigate || pageNumber >= pageCount;
    save.disabled =
      restricted ||
      currentArtifactId === undefined ||
      currentArtifactId !== requestedArtifactId ||
      !pages.firstElementChild;
    pageLabel.textContent = pageCount > 0 ? `${pageNumber} / ${pageCount}` : "";
  };
  const disposePdf = () => {
    rendering += 1;
    pageRender?.cancel();
    pageRender = undefined;
    const session = pdfWorkerSession;
    pdfDocument = undefined;
    pdfWorkerSession = undefined;
    if (session) closingSession = session.close();
    return closingSession;
  };
  const loadPdf = async (bytes: ArrayBuffer, artifactId: number) => {
    const loadRevision = ++pdfLoadRevision;
    requestedArtifactId = artifactId;
    busy = true;
    renderError.hidden = true;
    updateControls();
    try {
      await disposePdf();
      if (loadRevision !== pdfLoadRevision) return;
      const workerUrl = await localPdfWorker();
      if (loadRevision !== pdfLoadRevision) return;
      const port = new Worker(workerUrl, { type: "module" });
      const startupFailure = new AbortController();
      port.addEventListener(
        "error",
        (event) =>
          startupFailure.abort(new Error(event.message || "PDF ワーカーを起動できません。")),
        { once: true },
      );
      let worker: pdfjs.PDFWorker | undefined;
      let loading: pdfjs.PDFDocumentLoadingTask;
      try {
        worker = pdfjs.PDFWorker.create({ port });
        loading = pdfjs.getDocument({ data: new Uint8Array(bytes), worker });
      } catch (error) {
        worker?.destroy();
        port.terminate();
        throw error;
      }
      const run = async <T>(operation: Promise<T>): Promise<T> => {
        const signal = startupFailure.signal;
        const listener = new AbortController();
        try {
          return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
              if (signal.aborted) reject(signal.reason);
              else
                signal.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                  signal: listener.signal,
                });
            }),
          ]);
        } finally {
          listener.abort();
        }
      };
      pdfWorkerSession = {
        run,
        close: async () => {
          try {
            // A broken worker cannot acknowledge destruction.
            await run(loading.destroy()).catch(() => undefined);
          } finally {
            worker.destroy();
            port.terminate();
          }
        },
      };
      const loaded = await run(loading.promise);
      if (loadRevision !== pdfLoadRevision) return;
      pdfDocument = loaded;
      await renderPage(1, artifactId);
    } catch (error) {
      if (loadRevision !== pdfLoadRevision) return;
      void disposePdf();
      renderError.textContent = `PDF を表示できません。 ${String(error)}`;
      renderError.hidden = false;
      busy = false;
      updateControls();
    }
  };
  const showTab = (tab: "edit" | "pdf") => {
    app.hidden = tab === "pdf";
    pane.hidden = tab === "edit";
    edit.setAttribute("aria-pressed", String(tab === "edit"));
    pdfTab.setAttribute("aria-pressed", String(tab === "pdf"));
    if (tab === "pdf") api.postMessage({ type: "openPdfConfirmation" });
  };
  const renderPage = async (requested: number, artifactId = currentArtifactId) => {
    const pdf = pdfDocument;
    const session = pdfWorkerSession;
    if (!pdf || !session || artifactId === undefined) return;
    const request = ++rendering;
    busy = true;
    renderError.hidden = true;
    updateControls();
    let page: pdfjs.PDFPageProxy | undefined;
    try {
      pageRender?.cancel();
      const number = Math.max(1, Math.min(requested, pdf.numPages));
      page = await session.run(pdf.getPage(number));
      if (request !== rendering) return;
      const base = page.getViewport({ scale: 1 });
      const scale = rasterScaleFor(base.width, base.height, 2);
      if (scale === null) throw new Error("PDF のページが大きすぎます。");
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const task = page.render({ canvas, viewport });
      pageRender = task;
      await session.run(task.promise);
      const result = { canvas, number, count: pdf.numPages };
      if (request !== rendering) return;
      pageNumber = result.number;
      pageCount = result.count;
      currentArtifactId = artifactId;
      result.canvas.setAttribute("aria-label", `PDF ページ ${pageNumber} / ${pageCount}`);
      pages.replaceChildren(result.canvas);
    } catch (error) {
      if (request !== rendering) return;
      renderError.textContent = `PDF を表示できません。 ${String(error)}`;
      renderError.hidden = false;
    } finally {
      page?.cleanup();
      if (request === rendering) {
        pageRender = undefined;
        busy = false;
        updateControls();
      }
    }
  };

  edit.addEventListener("click", () => showTab("edit"));
  pdfTab.addEventListener("click", () => showTab("pdf"));
  refresh.addEventListener("click", () => api.postMessage({ type: "refreshPdfConfirmation" }));
  save.addEventListener("click", () => {
    if (currentArtifactId !== undefined)
      api.postMessage({ type: "saveDisplayedPdf", artifactId: currentArtifactId });
  });
  previous.addEventListener("click", () => void renderPage(pageNumber - 1));
  next.addEventListener("click", () => void renderPage(pageNumber + 1));

  transport.subscribe((message) => {
    if (message.type !== "pdfUpdated" || message.revision < revision) return;
    revision = message.revision;
    restricted = message.status === "restricted";
    status.textContent =
      message.message ??
      {
        idle: "PDF確認を開くと、保存済みのデッキを組版します。",
        compiling: "Tectonic で組版中です。",
        ready: "保存済みの版を表示しています。",
        stale: "要更新。表示中は前回成功した保存済みの版です。",
        failed: "組版に失敗しました。",
        restricted: "Restricted Mode では PDF確認を利用できません。",
      }[message.status];
    refresh.disabled = restricted || message.status === "compiling";
    if (
      message.pdf &&
      message.artifactId !== undefined &&
      message.artifactId !== requestedArtifactId
    ) {
      void loadPdf(message.pdf, message.artifactId);
    }
    updateControls();
  });
  showTab("edit");
  updateControls();
  window.addEventListener(
    "unload",
    () => {
      pdfLoadRevision += 1;
      void disposePdf();
    },
    { once: true },
  );
}

async function rasterizePdf(pdf: Uint8Array): Promise<RasterImage> {
  return readPdf(pdf, async (loaded) => {
    const page = await loaded.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = rasterScaleFor(base.width, base.height);
    if (scale === null)
      throw new Error(
        `PDF のページが大きすぎます(${Math.round(base.width)} × ${Math.round(base.height)} pt)`,
      );
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas 2D context を取得できません");
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    return {
      dataUrl: canvas.toDataURL("image/png"),
      width: canvas.width,
      height: canvas.height,
      widthPt: base.width,
      heightPt: base.height,
    };
  });
}

if (container) {
  mountPreview(container, { ...host, rasterizePdf });
  installPdfConfirmation(container);
  host.ready();
}
