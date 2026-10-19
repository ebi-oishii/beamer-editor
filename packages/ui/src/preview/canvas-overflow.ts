/**
 * 本文領域の下端からはみ出したキャンバス要素を、描いた高さで探す(#178)。
 *
 * 静的な L012 は書かれた x, y, w だけを見るので、箱の高さ(テキストの行数や画像の縦横比で
 * 決まる)による下へのはみ出しは分からない。プレビューが実際に描いた箱で判定し、ホストへ伝える。
 */

/** 下端からはみ出した要素。frameIndex は deck.frames の添字、elementId は描画中の版の ID。 */
export interface CanvasOverflow {
  frameIndex: number;
  elementId: string;
}

/** はみ出しとみなす最小量(論理 px)。小数の丸めで警告しない。 */
const OVERFLOW_TOLERANCE_PX = 1;

/**
 * root 配下のスライド(`.slide-card[data-index]`)ごとに、`.canvas`(本文領域)の下端を
 * 越えた要素を返す。表示倍率は rect に掛かっているので、`.canvas` のレイアウト高さとの比で
 * 論理 px へ戻して比べる。オーバーレイで隠れた要素も場所は取っているので数える。
 */
export function findCanvasOverflows(root: ParentNode): CanvasOverflow[] {
  const overflows: CanvasOverflow[] = [];
  for (const card of root.querySelectorAll<HTMLElement>(".slide-card[data-index]")) {
    const frameIndex = Number(card.dataset.index);
    if (!Number.isInteger(frameIndex)) continue;
    for (const canvas of card.querySelectorAll<HTMLElement>(".canvas")) {
      const bounds = canvas.getBoundingClientRect();
      if (bounds.height <= 0 || canvas.offsetHeight <= 0) continue;
      const toLogical = canvas.offsetHeight / bounds.height;
      for (const element of canvas.querySelectorAll<HTMLElement>(
        ":scope > [data-canvas-element-id]",
      )) {
        const elementId = element.dataset.canvasElementId;
        if (!elementId) continue;
        const overflow = (element.getBoundingClientRect().bottom - bounds.bottom) * toLogical;
        if (overflow > OVERFLOW_TOLERANCE_PX) overflows.push({ frameIndex, elementId });
      }
    }
  }
  return overflows;
}
