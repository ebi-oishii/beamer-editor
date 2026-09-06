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
