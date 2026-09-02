/**
 * 縦一列プレビューのレイアウト計算(UI 非依存の純粋関数)。
 * DOM の計測値を受け取って倍率・現在フレーム・末尾余白を返すだけで、React に依存しない。
 */

export const MIN_FIT_SCALE = 0.1;
export const MAX_FIT_SCALE = 1.6;

/** スライドを表示領域の横幅いっぱいに収める倍率(Marp のプレビューと同じ幅合わせ)。 */
export function fitWidthScale(
  containerWidth: number,
  slideWidth: number,
  horizontalPadding: number,
): number {
  if (!(slideWidth > 0)) return MIN_FIT_SCALE;
  const available = Math.max(0, containerWidth - horizontalPadding);
  return Math.max(MIN_FIT_SCALE, Math.min(available / slideWidth, MAX_FIT_SCALE));
}

/** スクロール内容座標でのカード位置(offsetTop / offsetHeight 相当)。 */
export interface CardBox {
  top: number;
  height: number;
}

/**
 * スクロール位置から現在フレームを決める。
 * 規則: 上端が「表示領域の上端 + 自身の高さの半分」以下にある最後のカード。
 * カードの中央が上端を越えた時点で次のフレームへ切り替わる(文書の読み位置と同じ)。
 * 該当が無い・カードが無いときは 0。
 */
export function frameAtScrollTop(scrollTop: number, cards: readonly CardBox[]): number {
  let active = 0;
  for (const [i, card] of cards.entries()) {
    if (card.top > scrollTop + card.height / 2) break;
    active = i;
  }
  return active;
}

/**
 * 末尾のカードも表示領域の上端まで送れるようにする追加余白。
 * これが無いと最後のフレームへ移動しても上端に揃わず、スクロール追従の現在フレームと
 * ◀▶ で選んだフレームが食い違う。
 */
export function trailingSpace(
  viewportHeight: number,
  lastCardHeight: number,
  bottomPadding: number,
): number {
  return Math.max(0, viewportHeight - lastCardHeight - bottomPadding);
}
