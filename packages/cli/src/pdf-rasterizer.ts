import { type DeckFrameRasterizer, type FrameImage, PdfExportError } from "@beamer-editor/compiler";

type Modules = {
  pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  createCanvas: typeof import("@napi-rs/canvas").createCanvas;
};

async function loadModules(): Promise<Modules> {
  try {
    const [pdfjs, canvas] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("@napi-rs/canvas"),
    ]);
    return { pdfjs, createCanvas: canvas.createCanvas };
  } catch (error) {
    throw new PdfExportError("E_RASTERIZE", "PDF rasterizer を読み込めません", error);
  }
}

/** Node-only adapter; imports occur only when snapshot needs PNG rendering. */
export function createNodePdfRasterizer(
  load: () => Promise<Modules> = loadModules,
): DeckFrameRasterizer {
  return {
    async rasterize(pdfPath, options): Promise<readonly FrameImage[]> {
      const { pdfjs, createCanvas } = await load();
      const loadingTask = pdfjs.getDocument({ url: pdfPath, useWorkerFetch: false });
      try {
        const pdf = await loadingTask.promise;
        try {
          if (pdf.numPages > options.maxPages)
            throw new PdfExportError(
              "E_LIMIT",
              `PDF page 数が上限 ${options.maxPages} を超えています`,
            );
          const images: FrameImage[] = [];
          let total = 0;
          for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
            if (options.signal?.aborted)
              throw new PdfExportError("E_CANCELLED", "rasterize はキャンセルされました");
            const page = await pdf.getPage(pageNumber);
            try {
              if (options.signal?.aborted)
                throw new PdfExportError("E_CANCELLED", "rasterize はキャンセルされました");
              const base = page.getViewport({ scale: 1 });
              const viewport = page.getViewport({ scale: 1600 / base.width });
              const width = Math.ceil(viewport.width);
              const height = Math.ceil(viewport.height);
              if (
                width > options.maxImageDimension ||
                height > options.maxImageDimension ||
                width * height > options.maxPixelsPerPage
              )
                throw new PdfExportError("E_LIMIT", "PDF page の画像サイズが上限を超えています");
              const canvas = createCanvas(width, height);
              const context = canvas.getContext("2d");
              context.fillStyle = "white";
              context.fillRect(0, 0, width, height);
              const renderTask = page.render({
                canvas: canvas as unknown as HTMLCanvasElement,
                canvasContext: context as never,
                viewport,
              });
              const cancel = () => renderTask.cancel();
              options.signal?.addEventListener("abort", cancel, { once: true });
              try {
                await renderTask.promise;
              } catch (error) {
                if (options.signal?.aborted)
                  throw new PdfExportError(
                    "E_CANCELLED",
                    "rasterize はキャンセルされました",
                    error,
                  );
                throw new PdfExportError(
                  "E_RASTERIZE",
                  "PDF page の rasterize に失敗しました",
                  error,
                );
              } finally {
                options.signal?.removeEventListener("abort", cancel);
              }
              const png = canvas.toBuffer("image/png");
              total += png.byteLength;
              if (total > options.maxPngBytes)
                throw new PdfExportError(
                  "E_LIMIT",
                  `PNG 合計が上限 ${options.maxPngBytes} bytes を超えています`,
                );
              images.push({ page: pageNumber, png, width, height });
            } finally {
              page.cleanup();
            }
          }
          return images;
        } finally {
          await pdf.destroy();
        }
      } finally {
        await loadingTask.destroy();
      }
    },
  };
}

export const nodePdfRasterizer = createNodePdfRasterizer();
