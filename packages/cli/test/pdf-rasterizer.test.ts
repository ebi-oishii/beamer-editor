import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createNodePdfRasterizer, nodePdfRasterizer } from "../src/pdf-rasterizer.ts";

const resultChart = fileURLToPath(
  new URL("../../../fixtures/assets/result-chart.pdf", import.meta.url),
);

type Viewport = { width: number; height: number };

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
    destroy: async () => {
      events.push("pdf.destroy");
    },
  };
  const load = async () => {
    if (config.loadError !== undefined) throw config.loadError;
    return {
      pdfjs: {
        getDocument: () => ({
          promise: Promise.resolve(pdf),
          destroy: async () => {
            events.push("loadingTask.destroy");
          },
        }),
      },
      createCanvas,
    };
  };
  return { events, rasterizer: createNodePdfRasterizer(load as never) };
}

const limits = {
  maxPages: 10,
  maxPngBytes: 1024,
  maxPixelsPerPage: 32_000_000,
  maxImageDimension: 8192,
};

describe("createNodePdfRasterizer", () => {
  it("renders every page and always tears the PDF down", async () => {
    const { events, rasterizer } = createFake({ numPages: 2, pngBytes: 3 });

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
      "pdf.destroy",
      "loadingTask.destroy",
    ]);
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
    expect(events).toEqual(["pdf.destroy", "loadingTask.destroy"]);
  });

  it("reports E_LIMIT for an oversized dimension or pixel count", async () => {
    for (const overrides of [{ maxImageDimension: 1000 }, { maxPixelsPerPage: 1000 }]) {
      const { events, rasterizer } = createFake();

      await expect(
        rasterizer.rasterize("deck.pdf", { ...limits, ...overrides }),
      ).rejects.toMatchObject({ code: "E_LIMIT" });
      // No canvas is allocated for a page rejected by the limits.
      expect(events).toEqual(["getPage 1", "cleanup 1", "pdf.destroy", "loadingTask.destroy"]);
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
      "pdf.destroy",
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
      expect(events).toEqual(["getPage 1", "cleanup 1", "pdf.destroy", "loadingTask.destroy"]);
    }
  });

  it("reports E_CANCELLED for a signal aborted before the call", async () => {
    const { events, rasterizer } = createFake();
    const controller = new AbortController();
    controller.abort();

    await expect(
      rasterizer.rasterize("deck.pdf", { ...limits, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "E_CANCELLED" });
    expect(events).toEqual(["pdf.destroy", "loadingTask.destroy"]);
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
      "pdf.destroy",
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
      "pdf.destroy",
      "loadingTask.destroy",
    ]);
  });
});

describe("nodePdfRasterizer", () => {
  it("renders a real PDF page to a PNG", async () => {
    const images = await nodePdfRasterizer.rasterize(resultChart, {
      ...limits,
      maxPngBytes: 64 * 1024 * 1024,
    });

    expect(images).toHaveLength(1);
    const image = images[0];
    expect(image?.width).toBe(1600);
    expect(image?.height).toBeGreaterThan(0);
    expect(Array.from((image?.png ?? new Uint8Array()).subarray(0, 4))).toEqual([
      0x89, 0x50, 0x4e, 0x47,
    ]);
  });
});
