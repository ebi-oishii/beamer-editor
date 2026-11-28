import type {
  LayoutCode,
  LayoutFinding,
  RenderedDeck,
  RenderedFrame,
} from "@beamer-editor/renderer";

const FONT_TIMEOUT_MS = 3000;
const IMAGE_TIMEOUT_MS = 5000;
const OVERFLOW_TOLERANCE = 2;

async function within<T>(promise: Promise<T>, milliseconds: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function location(element: Element): Pick<LayoutFinding, "elementId" | "expandedSpan"> {
  const canvas = element.closest<HTMLElement>("[data-canvas-element-id]");
  const elementId = canvas?.dataset.canvasElementId;
  if (elementId !== undefined) return { elementId };
  const flow = element.closest<HTMLElement>("[data-source-start][data-source-end]");
  if (!flow) return {};
  return {
    expandedSpan: { start: Number(flow.dataset.sourceStart), end: Number(flow.dataset.sourceEnd) },
  };
}

function firstOverflow(slide: HTMLElement, frame: RenderedFrame): HTMLElement | undefined {
  if (frame.isRaw) return undefined;
  const slideBounds = slide.getBoundingClientRect();
  const candidates = slide.querySelectorAll<HTMLElement>(
    ".frametitle, .slide-body > :not(.canvas), [data-flow-block], .canvas-item",
  );
  return [...candidates].find((element) => {
    if (element.getClientRects().length === 0) return false;
    const canvas = element.closest<HTMLElement>(".canvas");
    const bounds = canvas?.getBoundingClientRect() ?? slideBounds;
    const rect = element.getBoundingClientRect();
    const dx = OVERFLOW_TOLERANCE;
    const horizontalScroll =
      element.clientWidth > 0 && element.scrollWidth > element.clientWidth + dx;
    if (rect.left < bounds.left - dx || rect.right > bounds.right + dx || horizontalScroll)
      return true;
    if (frame.allowFrameBreaks && !canvas) return false;
    const verticalScroll =
      element.clientHeight > 0 && element.scrollHeight > element.clientHeight + dx;
    return rect.top < bounds.top - dx || rect.bottom > bounds.bottom + dx || verticalScroll;
  });
}

async function failedImage(image: HTMLImageElement): Promise<boolean> {
  const decode = image.decode();
  return within(
    decode.then(
      () => image.naturalWidth === 0,
      () => true,
    ),
    IMAGE_TIMEOUT_MS,
    true,
  );
}

/** Inspect the mounted editing UI after font layout and image decoding. */
export async function inspectPreviewLayout(
  root: HTMLElement,
  deck: RenderedDeck,
): Promise<LayoutFinding[]> {
  const fonts = root.ownerDocument.fonts;
  if (fonts)
    await within(
      fonts.ready.then(() => undefined),
      FONT_TIMEOUT_MS,
      undefined,
    );
  const cards = [...root.querySelectorAll<HTMLElement>(".slide-card")];
  const results = await Promise.all(
    deck.frames.map(async (frame, index) => {
      const slide = cards[index]?.querySelector<HTMLElement>(".slide-scale > .slide");
      const finding = (
        code: LayoutCode,
        loc: Pick<LayoutFinding, "elementId" | "expandedSpan"> = {},
      ): LayoutFinding => ({ code, frame: frame.index, ...loc });
      if (!slide) return [finding("B003")];
      const images = [...slide.querySelectorAll("img")];
      const failed = await Promise.all(images.map(failedImage));
      const items = new Set(
        [...slide.querySelectorAll<HTMLElement>("[data-canvas-element-id]")].map(
          (element) => element.dataset.canvasElementId,
        ),
      );
      const overflow = firstOverflow(slide, frame);
      return [
        ...images.flatMap((image, i) => (failed[i] ? [finding("B001", location(image))] : [])),
        ...(overflow ? [finding("B002", location(overflow))] : []),
        ...(frame.canvasElements ?? []).flatMap((element) =>
          element.editable && !items.has(element.id)
            ? [finding("B003", { elementId: element.id })]
            : [],
        ),
      ];
    }),
  );
  return results.flat();
}
