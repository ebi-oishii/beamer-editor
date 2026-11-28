/** 部分コンパイル画像のラスタライズ倍率(#81)。上限を設けて巨大な canvas を作らない。 */

/** 通常の倍率。プレビューを拡大しても粗くならない程度。 */
export const RASTER_SCALE = 3;
/** canvas の 1 辺の上限(px)。 */
export const MAX_RASTER_SIDE = 4096;
/** canvas の総画素数の上限。 */
export const MAX_RASTER_PIXELS = 12_000_000;

export function inlineMathBox(subject: unknown, widthBp: number, heightBp: number) {
  if (typeof subject !== "string") return undefined;
  const match = /^DeckEditorInlineMath (\d+) (\d+) (\d+)$/.exec(subject);
  if (!match) return undefined;
  const width = Number(match[1]) / 65536;
  const height = Number(match[2]) / 65536;
  const depth = Number(match[3]) / 65536;
  const bpToPt = 72.27 / 72;
  if (
    width <= 0 ||
    height + depth <= 0 ||
    Math.abs(width - widthBp * bpToPt) > 0.15 ||
    Math.abs(height + depth - heightBp * bpToPt) > 0.15
  )
    return undefined;
  return { width, height, depth };
}

/**
 * ページの基準寸法(倍率 1 のときの幅・高さ)から、上限に収まる倍率を返す。
 * 上限に収めると 0.1 倍を切るような巨大なページは描かない(null)。
 */
export function rasterScaleFor(
  width: number,
  height: number,
  preferred = RASTER_SCALE,
): number | null {
  if (!(width > 0) || !(height > 0)) return null;
  const scale = Math.min(
    preferred,
    MAX_RASTER_SIDE / Math.max(width, height),
    Math.sqrt(MAX_RASTER_PIXELS / (width * height)),
  );
  return scale >= 0.1 ? scale : null;
}
