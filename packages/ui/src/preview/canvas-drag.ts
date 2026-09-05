/** DOM rect と grab offset から canvas 論理座標を求める。zoom は rect に反映済みなので割らない。 */
export function canvasPointFromPointer(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  clientX: number,
  clientY: number,
  grabX: number,
  grabY: number,
): { x: number; y: number } | null {
  if (
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    return null;
  return {
    x: (clientX - rect.left - grabX) / rect.width,
    y: (clientY - rect.top - grabY) / rect.height,
  };
}

/**
 * ドラッグ中の箱を本文領域内へ収める。core の clampCanvasPosition と同じ規則
 * (lint L012 の条件)だが、ui は core に依存しないためここに置く。書き込み時の
 * 保証は host 側の clamp が行い、こちらは端で止まって見えるようにするためのもの。
 */
export function clampCanvasPoint(
  point: { x: number; y: number },
  width: number,
): { x: number; y: number } {
  const safeWidth = Number.isFinite(width) ? Math.min(Math.max(width, 0), 1) : 0;
  return {
    x: Math.min(Math.max(point.x, 0), 1 - safeWidth),
    y: Math.min(Math.max(point.y, 0), 1),
  };
}

/** source と同じ 3 桁表現へ正規化して no-op 判定に使う。 */
export function normalizeCanvasCoordinate(value: number): number {
  if (!Number.isFinite(value)) return value;
  const normalized = Number((Object.is(value, -0) ? 0 : value).toFixed(3));
  return Object.is(normalized, -0) ? 0 : normalized;
}
