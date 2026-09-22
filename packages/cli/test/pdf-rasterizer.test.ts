import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodePdfRasterizer, nodePdfRasterizer } from "../src/pdf-rasterizer.ts";

type Viewport = { width: number; height: number };

/** 日本語 CID フォントと UniJIS CMap を使う、最小の実 PDF。 */
function japanesePdf(textHex: string | null = "65E5672C8A9E"): Uint8Array {
  const content = textHex === null ? "" : `BT\n/F1 24 Tf\n72 720 Td\n<${textHex}> Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /UniJIS-UTF16-H /DescendantFonts [6 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 7 0 R /DW 1000 >>",
    "<< /Type /FontDescriptor /FontName /HeiseiKakuGo-W5 /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>",
  ];
  let value = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(new TextEncoder().encode(value).byteLength);
    value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = new TextEncoder().encode(value).byteLength;
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) value += `${String(offset).padStart(10, "0")} 00000 n \n`;
  value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(value);
}

async function pngPixels(png: Uint8Array): Promise<Uint8ClampedArray> {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const image = await loadImage(Buffer.from(png));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, image.width, image.height).data;
}

interface FakeConfig {
  numPages?: number;
  /** Viewport for a scale, defaulting to a 100x50 pt page. */
  viewport?: (scale: number) => Viewport;
  pngBytes?: number;
  /** Called synchronously while `page.render` runs, before the abort listener is registered. */
  onRender?: (task: { cancel: () => void }) => void;
  /** "pending" keeps the render promise unsettled until `cancel` rejects it. */
  renderMode?: "resolve" | "pending";
  loadError?: unknown;
}

/** A pdfjs / canvas double recording the lifecycle calls the adapter must make. */
function createFake(config: FakeConfig = {}) {
  const events: string[] = [];
  let documentOptions: Record<string, unknown> | undefined;
  const viewport = (scale: number): Viewport =>
    config.viewport?.(scale) ?? { width: 100 * scale, height: 50 * scale };
  const createCanvas = (width: number, height: number) => {
    events.push(`createCanvas ${width}x${height}`);
    return {
      getContext: () => ({ fillStyle: "", fillRect: () => {} }),
      toBuffer: () => new Uint8Array(config.pngBytes ?? 4),
    };
  };
  const page = (pageNumber: number) => ({
    getViewport: ({ scale }: { scale: number }) => viewport(scale),
    render: () => {
      events.push(`render ${pageNumber}`);
      let rejectRender: (reason: unknown) => void = () => {};
      const promise =
        config.renderMode === "pending"
          ? new Promise<void>((_, reject) => {
              rejectRender = reject;
            })
          : Promise.resolve();
      const task = {
        promise,
        cancel: () => {
          events.push(`cancel ${pageNumber}`);
          rejectRender(new Error("render cancelled"));
        },
      };
      config.onRender?.(task);
      return task;
    },
    cleanup: () => events.push(`cleanup ${pageNumber}`),
  });
  const pdf = {
    numPages: config.numPages ?? 1,
    getPage: async (pageNumber: number) => {
      events.push(`getPage ${pageNumber}`);
      return page(pageNumber);
    },
  };
  const load = async () => {
    if (config.loadError !== undefined) throw config.loadError;
    return {
      pdfjs: {
        getDocument: (options: Record<string, unknown>) => {
          documentOptions = options;
          return {
            promise: Promise.resolve(pdf),
            destroy: async () => {
              events.push("loadingTask.destroy");
            },
          };
        },
      },
      createCanvas,
    };
  };
  return {
    events,
    documentOptions: () => documentOptions,
    rasterizer: createNodePdfRasterizer(load as never),
  };
}

const limits = {
  maxPages: 10,
  maxPngBytes: 1024,
  maxPixelsPerPage: 32_000_000,
  maxImageDimension: 8192,
};

describe("createNodePdfRasterizer", () => {
  it("renders every page and always tears the loading task down", async () => {
    const { events, documentOptions, rasterizer } = createFake({ numPages: 2, pngBytes: 3 });

    await expect(rasterizer.rasterize("deck.pdf", limits)).resolves.toEqual([
      { page: 1, png: new Uint8Array(3), width: 1600, height: 800 },
      { page: 2, png: new Uint8Array(3), width: 1600, height: 800 },
    ]);
    expect(events).toEqual([
      "getPage 1",
      "createCanvas 1600x800",
      "render 1",
      "cleanup 1",
      "getPage 2",
      "createCanvas 1600x800",
      "render 2",
      "cleanup 2",
      "loadingTask.destroy",
    ]);
    expect(documentOptions()).toMatchObject({
      cMapPacked: true,
      useWorkerFetch: false,
      verbosity: 0,
    });
    expect(documentOptions()?.cMapUrl).toMatch(/cmaps\/$/);
    expect(documentOptions()?.standardFontDataUrl).toMatch(/standard_fonts\/$/);
    expect(isAbsolute(documentOptions()?.cMapUrl as string)).toBe(true);
    expect(isAbsolute(documentOptions()?.standardFontDataUrl as string)).toBe(true);
  });

  it("rounds a 16:9 viewport height to avoid a one-pixel floating-point excess", async () => {
    const { rasterizer } = createFake({
      viewport: (scale) =>
        scale === 1
          ? { width: 1600, height: 900.00000000001 }
          : { width: 1600 * scale, height: 900.00000000001 * scale },
    });

    await expect(rasterizer.rasterize("deck.pdf", limits)).resolves.toMatchObject([
      { width: 1600, height: 900 },
    ]);
  });

  it("renders only requested pages and rejects invalid page selections", async () => {
    const { events, rasterizer } = createFake({ numPages: 201 });
    await expect(
      rasterizer.rasterize("deck.pdf", { ...limits, pageNumbers: [201] }),
    ).resolves.toHaveLength(1);
    expect(events).toContain("getPage 201");
    expect(events).not.toContain("getPage 1");
    for (const pageNumbers of [[0], [202], [1, 1]]) {
      await expect(
        rasterizer.rasterize("deck.pdf", { ...limits, pageNumbers }),
      ).rejects.toMatchObject({ code: "E_RASTERIZE" });
    }
  });

  it("reports E_RASTERIZE when the modules cannot be loaded", async () => {
    const { events, rasterizer } = createFake({ loadError: new Error("missing native binding") });

    await expect(rasterizer.rasterize("deck.pdf", limits)).rejects.toMatchObject({
      code: "E_RASTERIZE",
    });
    expect(events).toEqual([]);
  });

  it("reports E_LIMIT when the page count exceeds maxPages and still tears down", async () => {
    const { events, rasterizer } = createFake({ numPages: 3 });

    await expect(
      rasterizer.rasterize("deck.pdf", { ...limits, maxPages: 2 }),
    ).rejects.toMatchObject({ code: "E_LIMIT" });
    expect(events).toEqual(["loadingTask.destroy"]);
  });

  it("reports E_LIMIT for an oversized dimension or pixel count", async () => {
    for (const overrides of [{ maxImageDimension: 1000 }, { maxPixelsPerPage: 1000 }]) {
      const { events, rasterizer } = createFake();

      await expect(
        rasterizer.rasterize("deck.pdf", { ...limits, ...overrides }),
      ).rejects.toMatchObject({ code: "E_LIMIT" });
      // No canvas is allocated for a page rejected by the limits.
      expect(events).toEqual(["getPage 1", "cleanup 1", "loadingTask.destroy"]);
    }
  });

  it("reports E_LIMIT once the combined PNG size exceeds maxPngBytes", async () => {
    const { events, rasterizer } = createFake({ numPages: 3, pngBytes: 10 });

    await expect(
      rasterizer.rasterize("deck.pdf", { ...limits, maxPngBytes: 15 }),
    ).rejects.toMatchObject({ code: "E_LIMIT" });
    expect(events).toEqual([
      "getPage 1",
      "createCanvas 1600x800",
      "render 1",
      "cleanup 1",
      "getPage 2",
      "createCanvas 1600x800",
      "render 2",
      "cleanup 2",
      "loadingTask.destroy",
    ]);
  });

  it("reports E_RASTERIZE without allocating a canvas for a degenerate viewport", async () => {
    for (const degenerate of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { events, rasterizer } = createFake({
        viewport: (scale) =>
          scale === 1 ? { width: 100, height: 50 } : { width: degenerate, height: 50 },
      });

      await expect(rasterizer.rasterize("deck.pdf", limits)).rejects.toMatchObject({
        code: "E_RASTERIZE",
      });
      expect(events).toEqual(["getPage 1", "cleanup 1", "loadingTask.destroy"]);
    }
  });

  it("reports E_CANCELLED for a signal aborted before the call", async () => {
    const { events, rasterizer } = createFake();
    const controller = new AbortController();
    controller.abort();

    await expect(
      rasterizer.rasterize("deck.pdf", { ...limits, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "E_CANCELLED" });
    expect(events).toEqual(["loadingTask.destroy"]);
  });

  it("cancels the render task when the signal aborts during rendering", async () => {
    const controller = new AbortController();
    const { events, rasterizer } = createFake({
      renderMode: "pending",
      onRender: () => setTimeout(() => controller.abort(), 0),
    });

    await expect(
      rasterizer.rasterize("deck.pdf", { ...limits, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "E_CANCELLED" });
    expect(events).toEqual([
      "getPage 1",
      "createCanvas 1600x800",
      "render 1",
      "cancel 1",
      "cleanup 1",
      "loadingTask.destroy",
    ]);
  });

  it("cancels a render task aborted before the abort listener is registered", async () => {
    const controller = new AbortController();
    const { events, rasterizer } = createFake({
      renderMode: "pending",
      // Aborting synchronously inside render() means the listener registration comes too late.
      onRender: () => controller.abort(),
    });

    await expect(
      rasterizer.rasterize("deck.pdf", { ...limits, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "E_CANCELLED" });
    expect(events).toEqual([
      "getPage 1",
      "createCanvas 1600x800",
      "render 1",
      "cancel 1",
      "cleanup 1",
      "loadingTask.destroy",
    ]);
  });
});

describe("nodePdfRasterizer", () => {
  it("renders a real PDF page containing Japanese text to a PNG", async () => {
    const directory = await mkdtemp(join(tmpdir(), "beamer-editor-japanese-pdf-"));
    const path = join(directory, "japanese.pdf");
    const blankPath = join(directory, "blank.pdf");
    const alternatePath = join(directory, "alternate-japanese.pdf");
    try {
      await writeFile(path, japanesePdf());
      await writeFile(blankPath, japanesePdf(null));
      await writeFile(alternatePath, japanesePdf("6F225B574EEE"));
      const images = await nodePdfRasterizer.rasterize(path, {
        ...limits,
        maxPngBytes: 64 * 1024 * 1024,
      });
      const blankImages = await nodePdfRasterizer.rasterize(blankPath, {
        ...limits,
        maxPngBytes: 64 * 1024 * 1024,
      });
      const alternateImages = await nodePdfRasterizer.rasterize(alternatePath, {
        ...limits,
        maxPngBytes: 64 * 1024 * 1024,
      });

      expect(images).toHaveLength(1);
      expect(blankImages).toHaveLength(1);
      expect(alternateImages).toHaveLength(1);
      const image = images[0];
      const blankImage = blankImages[0];
      const alternateImage = alternateImages[0];
      expect(image?.width).toBe(1600);
      expect(image?.height).toBe(2264);
      expect(Array.from((image?.png ?? new Uint8Array()).subarray(0, 4))).toEqual([
        0x89, 0x50, 0x4e, 0x47,
      ]);
      expect(await pngPixels(image?.png ?? new Uint8Array())).not.toEqual(
        await pngPixels(blankImage?.png ?? new Uint8Array()),
      );
      expect(await pngPixels(image?.png ?? new Uint8Array())).not.toEqual(
        await pngPixels(alternateImage?.png ?? new Uint8Array()),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
