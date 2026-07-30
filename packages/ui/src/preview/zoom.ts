/** プレビューの拡大率に関する、UI 非依存の小さな補助関数。 */

export type ZoomState = "fit" | number;

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 3;
export const ZOOM_STEP = 0.1;

/** 手動倍率を許容範囲へ収め、浮動小数点誤差を表示・保存へ持ち込まない。 */
export function clampZoom(value: number): number {
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  return Math.round(clamped * 100) / 100;
}

/** 保存済みの zoom 値を検証する。不正値は fit に戻す。 */
export function parseZoom(value: unknown): ZoomState {
  if (value === "fit") return value;
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_ZOOM &&
    value <= MAX_ZOOM
  ) {
    return value;
  }
  return "fit";
}

/** fit 値を基準にした +/- 操作を含め、次の手動倍率を作る。 */
export function stepZoom(zoom: ZoomState, fitScale: number, direction: 1 | -1): number {
  return clampZoom((zoom === "fit" ? fitScale : zoom) + direction * ZOOM_STEP);
}

export function formatZoom(zoom: ZoomState, fitScale: number): string {
  const percent = Math.round((zoom === "fit" ? fitScale : zoom) * 100);
  return zoom === "fit" ? `フィット ${percent}%` : `${percent}%`;
}
