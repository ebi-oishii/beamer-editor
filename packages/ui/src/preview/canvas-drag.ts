import { clampCanvasPosition } from "@beamer-editor/core";

/**
 * DOM rect と grab offset から canvas 論理座標を求める。zoom は rect に反映済みなので割らない。
 * width(対象の幅、正規化値)を渡すと本文領域に収める(端で止まる。L012 と同じ条件。#111)。
 */
export function canvasPointFromPointer(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  clientX: number,
  clientY: number,
  grabX: number,
  grabY: number,
  width?: number,
): { x: number; y: number } | null {
  if (
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    return null;
  const x = (clientX - rect.left - grabX) / rect.width;
  const y = (clientY - rect.top - grabY) / rect.height;
  return width === undefined ? { x, y } : clampCanvasPosition(x, y, width);
}

/** source と同じ 3 桁表現へ正規化して no-op 判定に使う。 */
export function normalizeCanvasCoordinate(value: number): number {
  if (!Number.isFinite(value)) return value;
  const normalized = Number((Object.is(value, -0) ? 0 : value).toFixed(3));
  return Object.is(normalized, -0) ? 0 : normalized;
}
