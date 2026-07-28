/**
 * ホスト共通のマウント口。react-dom で DeckPreview を描画し、
 * プレビュー用 CSS を container の属するドキュメントへ一度だけ注入する。
 */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ShellHost } from "../shell-host.js";
import { DeckPreview } from "./DeckPreview.js";
import { PREVIEW_CSS } from "./styles.js";

const STYLE_ID = "beamer-preview-styles";

/** container へ DeckPreview をマウントし、unmount 関数を返す。 */
export function mountPreview(container: HTMLElement, host: ShellHost): () => void {
  const doc = container.ownerDocument;
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = PREVIEW_CSS;
    doc.head.append(style);
  }

  const root = createRoot(container);
  root.render(createElement(DeckPreview, { host }));
  return () => root.unmount();
}
