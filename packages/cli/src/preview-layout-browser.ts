import type { RenderedDeck } from "@beamer-editor/renderer";
import { mountPreview } from "@beamer-editor/ui";
import "katex/dist/katex.min.css";

const deck = JSON.parse(
  document.getElementById("deck-input")?.textContent ?? "null",
) as RenderedDeck;
const root = document.getElementById("app");
if (!root || !deck) throw new Error("Preview input missing");

const dispose = mountPreview(
  root,
  {
    subscribe(listener) {
      listener(deck, 0);
      return () => {};
    },
    jumpToSource() {},
    notifyActiveFrame() {},
    moveCanvasElement() {},
    layoutChecked(_version, _assets, findings) {
      const result = document.createElement("pre");
      result.id = "layout-result";
      result.textContent = JSON.stringify(findings);
      dispose();
      document.body.replaceChildren(result);
    },
  },
  { layoutOverlayStep: 1 },
);
