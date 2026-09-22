import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

function isCanvasExtent(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function packageResource(directory: string): string {
  const packagePath = fileURLToPath(import.meta.resolve("pdfjs-dist/package.json"));
  return `${join(dirname(packagePath), directory)}/`;
}

/** Node-only adapter; imports occur only when snapshot needs PNG rendering. */
export function createNodePdfRasterizer(
  load: () => Promise<Modules> = loadModules,
): DeckFrameRasterizer {
  return {
    async rasterize(pdfPath, options): Promise<readonly FrameImage[]> {
      let modules: Modules;
      try {
        modules = await load();
      } catch (error) {
        // 注入した loader の失敗も、既定の動的 import と同様に扱う。
        throw error instanceof PdfExportError
          ? error
          : new PdfExportError("E_RASTERIZE", "PDF rasterizer を読み込めません", error);
      }
      const { pdfjs, createCanvas } = modules;
      const loadingTask = pdfjs.getDocument({
        url: pdfPath,
        cMapUrl: packageResource("cmaps"),
        cMapPacked: true,
        standardFontDataUrl: packageResource("standard_fonts"),
        useWorkerFetch: false,
        verbosity: pdfjs.VerbosityLevel?.ERRORS ?? 0,
      });
      try {
        const pdf = await loadingTask.promise;
        const pageNumbers =
          options.pageNumbers ?? Array.from({ length: pdf.numPages }, (_, index) => index + 1);
        if (pageNumbers.length > options.maxPages)
          throw new PdfExportError(
            "E_LIMIT",
            `PDF page 数が上限 ${options.maxPages} を超えています`,
          );
        const images: FrameImage[] = [];
        let total = 0;
        const seen = new Set<number>();
        for (const pageNumber of pageNumbers) {
          if (
            !Number.isSafeInteger(pageNumber) ||
            pageNumber < 1 ||
            pageNumber > pdf.numPages ||
            seen.has(pageNumber)
          )
            throw new PdfExportError("E_RASTERIZE", "rasterize 対象の PDF page が不正です");
          seen.add(pageNumber);
          if (options.signal?.aborted)
            throw new PdfExportError("E_CANCELLED", "rasterize はキャンセルされました");
          const page = await pdf.getPage(pageNumber);
          try {
            if (options.signal?.aborted)
              throw new PdfExportError("E_CANCELLED", "rasterize はキャンセルされました");
            const base = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: 1600 / base.width });
              const width = Math.round(viewport.width);
            const height = Math.round(viewport.height);
            // 不正な viewport を createCanvas に渡さない。0 と NaN は上限比較を通過する。
            if (!isCanvasExtent(width) || !isCanvasExtent(height))
              throw new PdfExportError(
                "E_RASTERIZE",
                `PDF page の画像サイズを解釈できません: ${width}x${height}`,
              );
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
            // renderTask の生成と listener 登録の間に起きた abort も反映する。
            if (options.signal?.aborted) renderTask.cancel();
            try {
              await renderTask.promise;
            } catch (error) {
              if (options.signal?.aborted)
                throw new PdfExportError("E_CANCELLED", "rasterize はキャンセルされました", error);
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
        await loadingTask.destroy();
      }
    },
  };
}

export const nodePdfRasterizer = createNodePdfRasterizer();
