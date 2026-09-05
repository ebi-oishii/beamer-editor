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

/** ホイール 1px あたりの倍率変化(指数)。マウスの 1 ノッチ(約 100px)でおよそ 10% 変わる。 */
export const WHEEL_ZOOM_RATE = 0.001;
/** 1 描画フレームで反映する delta の上限(px)。まとめて届いた大きな delta で一気に飛ばない。 */
export const WHEEL_DELTA_CAP = 250;

/**
 * Ctrl/Cmd+ホイール(トラックパッドのピンチ含む)で、1 描画フレーム分にまとめた deltaY(px)から
 * 次の倍率を作る。以前は delta の大きさを見ずに 1 フレーム 1 段階(10%)動かしていたため、
 * 毎フレーム小さな delta を送るピンチでは 1 秒で数倍になっていた(#102)。
 * 倍率は delta に比例(指数的)にし、ピンチの細かい動きが保存で消えないよう 3 桁で丸める。
 */
export function wheelZoom(zoom: ZoomState, fitScale: number, deltaY: number): number {
  const base = zoom === "fit" ? fitScale : zoom;
  const delta = Math.max(-WHEEL_DELTA_CAP, Math.min(WHEEL_DELTA_CAP, deltaY));
  const next = base * Math.exp(-delta * WHEEL_ZOOM_RATE);
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)) * 1000) / 1000;
}

/** WheelEvent の delta を px に揃える(deltaMode が行・ページ単位のときの換算)。 */
export function wheelDeltaPixels(deltaY: number, deltaMode: number): number {
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * 400;
  return deltaY;
}
