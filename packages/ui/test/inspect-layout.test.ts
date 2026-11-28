// @vitest-environment jsdom
import { renderEditingPreview, withEditableCanvasElements } from "@beamer-editor/renderer";
import { expect, it, vi } from "vitest";
import { inspectPreviewLayout } from "../src/preview/inspect-layout.js";

const source = String.raw`
\begin{document}
\begin{frame}[label=clean]\begin{deckcanvas}
\deckimage[x=.1,y=.2,w=.3]{normal.png}
\end{deckcanvas}\end{frame}
\begin{frame}[label=damaged]\includegraphics{damaged.png}\end{frame}
\begin{frame}[label=overflow]\begin{deckcanvas}
\deckimage[x=1.2,y=.2,w=.3]{normal.png}
\end{deckcanvas}\end{frame}
\begin{frame}[label=missing]\begin{deckcanvas}
\deckimage[x=.1,y=.2,w=.3]{normal.png}
\end{deckcanvas}\end{frame}
\begin{frame}[allowframebreaks]Paragraph\end{frame}
\end{document}`;

it("distinguishes image decode, overflow, missing editables and successful frames", async () => {
  const rendered = renderEditingPreview(source);
  const deck = withEditableCanvasElements(rendered.deck, rendered.expansionMap);
  const root = document.createElement("div");
  root.innerHTML = deck.frames
    .map(
      (frame, index) =>
        `<div class="slide-card" data-index="${index}"><div class="slide-scale">${frame.html}</div></div>`,
    )
    .join("");
  const box = (selector: string, left: number, top: number, width: number, height: number) => {
    for (const element of root.querySelectorAll(selector)) {
      const rect = new DOMRect(left, top, width, height);
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
      vi.spyOn(element, "getClientRects").mockReturnValue([rect] as unknown as DOMRectList);
    }
  };
  box(".slide, .canvas", 0, 0, 300, 200);
  box('[data-index="2"] .canvas-item', 360, 0, 100, 80);
  box('[data-index="4"] .slide-body > p', 0, 0, 300, 300);
  root.querySelector('[data-index="3"] .canvas-item')?.remove();
  for (const img of root.querySelectorAll("img")) {
    const bad = img.getAttribute("src") === "damaged.png";
    img.decode = bad
      ? vi.fn().mockRejectedValue(new Error("decode failed"))
      : vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(img, "naturalWidth", { value: bad ? 0 : 20 });
  }
  const findings = await inspectPreviewLayout(root, deck);
  expect(findings).toEqual([
    {
      frame: 2,
      code: "B001",
      expandedSpan: expect.objectContaining({ start: expect.any(Number) }),
    },
    { frame: 3, code: "B002", elementId: "canvas-image-0" },
    { frame: 4, code: "B003", elementId: "canvas-image-0" },
  ]);
});
