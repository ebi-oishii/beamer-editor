/**
 * 本文がスライドからはみ出したかの判定(#193)。
 *
 * プレビューは本文を上詰めで描き、.slide の overflow: hidden で下端・右端を黙って切る。
 * PDF では同じフレームが Overfull \vbox / \hbox になるので、プレビューでも示せるよう
 * 本文(.slide-body 以下の流し込み要素)の広がりをスライドの論理サイズと比べる。
 * 絶対配置のキャンバス要素(.canvas)は .slide を包含ブロックにするため .slide-body の
 * はみ出し量に入らず、ここでは数えない(キャンバスのはみ出しは L012 が扱う)。
 */

/** はみ出した辺。どちらも false の結果は作らず、はみ出しなしは null で表す。 */
export interface SlideOverflow {
  bottom: boolean;
  right: boolean;
}

/** スライドの論理座標(px、transform の倍率を掛ける前)での実測値。 */
export interface FlowMeasurement {
  slideWidth: number;
  slideHeight: number;
  /** 本文の右端(スライド左端から)。 */
  contentRight: number;
  /** 本文の下端(スライド上端から)。 */
  contentBottom: number;
}

/** 実測の丸め(scrollHeight 等は整数 px)で誤検知しないための許容量。1pt = 4/3 px。 */
export const OVERFLOW_TOLERANCE_PX = 4 / 3;

/** 実測値からはみ出した辺を返す。はみ出しが無い、または実測できていないときは null。 */
export function detectOverflow(
  measurement: FlowMeasurement,
  tolerance: number = OVERFLOW_TOLERANCE_PX,
): SlideOverflow | null {
  const { slideWidth, slideHeight, contentRight, contentBottom } = measurement;
  if (
    ![slideWidth, slideHeight, contentRight, contentBottom].every(Number.isFinite) ||
    slideWidth <= 0 ||
    slideHeight <= 0
  )
    return null;
  const bottom = contentBottom > slideHeight + tolerance;
  const right = contentRight > slideWidth + tolerance;
  return bottom || right ? { bottom, right } : null;
}

export function sameOverflow(a: SlideOverflow | null, b: SlideOverflow | null): boolean {
  return a === b || (a !== null && b !== null && a.bottom === b.bottom && a.right === b.right);
}

/**
 * .slide の直下の .slide-body を論理座標で測る。offset / scroll 系の値は transform の影響を
 * 受けないので倍率で割り戻す必要がない。.slide は position: relative なので .slide-body の
 * offsetTop / offsetLeft はスライド左上からの距離になる。
 * レイアウトが無い(非表示の Webview など)ときは undefined を返し、直前の判定を保たせる。
 */
export function measureFlowExtent(slide: HTMLElement): FlowMeasurement | undefined {
  const body = [...slide.children].find(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains("slide-body"),
  );
  const slideWidth = slide.clientWidth;
  const slideHeight = slide.clientHeight;
  if (!body || slideWidth <= 0 || slideHeight <= 0) return undefined;
  return {
    slideWidth,
    slideHeight,
    // 可視 overflow の要素でも scrollWidth / scrollHeight は子孫のはみ出しを含む。
    contentRight: body.offsetLeft + Math.max(body.offsetWidth, body.scrollWidth),
    contentBottom: body.offsetTop + Math.max(body.offsetHeight, body.scrollHeight),
  };
}

/** はみ出しの説明(title とスクリーンリーダー向け)。 */
export function overflowMessage(overflow: SlideOverflow): string {
  if (overflow.bottom && overflow.right)
    return "本文がスライドの下端と右端を超えています(PDF では Overfull \\vbox / \\hbox になり、超えた分は表示されません)";
  if (overflow.bottom)
    return "本文がスライドの下端を超えています(PDF では Overfull \\vbox になり、超えた分は表示されません)";
  return "本文がスライドの右端を超えています(PDF では Overfull \\hbox になり、超えた分は表示されません)";
}
