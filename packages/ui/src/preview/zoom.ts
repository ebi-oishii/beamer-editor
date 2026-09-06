/** プレビューの拡大率に関する、UI 非依存の小さな補助関数。 */

export type ZoomState = "fit" | number;

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 3;
export const ZOOM_STEP = 0.1;

/**
 * 表示・保存に使う倍率(小数 3 桁)。内部の倍率は丸めずに持つ。丸めた値を次の基準にすると、
 * 1px 未満の delta が毎フレーム捨てられ、小さく動かし続けても倍率が変わらなくなる。
 */
export function roundZoom(value: number): number {
  return Math.round(value * 1000) / 1000;
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

/**
 * 手動倍率の範囲。基準になる倍率(fit の現在値、または今の手動倍率)が [MIN_ZOOM, MAX_ZOOM] の外なら、
 * その値まで範囲を広げる。fit が 0.1 のときに縮小しようとして下限の 0.25 へ「拡大」する、のような
 * 操作と逆向きの飛びを起こさないための規則。範囲の外にいる間は、範囲へ戻る向きにだけ動ける。
 */
function zoomRange(base: number): { min: number; max: number } {
  return { min: Math.min(MIN_ZOOM, base), max: Math.max(MAX_ZOOM, base) };
}

/** fit から動かなかった操作は fit のままにする(ウィンドウの大きさに追従し続ける)。 */
function settle(zoom: ZoomState, base: number, next: number): ZoomState {
  return zoom === "fit" && next === base ? "fit" : next;
}

/** fit 値を基準にした +/- 操作を含め、次の倍率を作る(0.1 刻み、2 桁に丸める)。 */
export function stepZoom(zoom: ZoomState, fitScale: number, direction: 1 | -1): ZoomState {
  const base = zoom === "fit" ? fitScale : zoom;
  const { min, max } = zoomRange(base);
  const stepped = Math.round((base + direction * ZOOM_STEP) * 100) / 100;
  return settle(zoom, base, Math.min(max, Math.max(min, stepped)));
}

/** ホイール 1px あたりの倍率変化(指数)。マウスの 1 ノッチ(約 100px)でおよそ 10% 変わる。 */
export const WHEEL_ZOOM_RATE = 0.001;
/** 1 描画フレームで反映する delta の上限(px)。まとめて届いた大きな delta で一気に飛ばない。 */
export const WHEEL_DELTA_CAP = 250;

/**
 * Ctrl/Cmd+ホイール(トラックパッドのピンチ含む)で、1 描画フレーム分にまとめた deltaY(px)から
 * 次の倍率を作る。以前は delta の大きさを見ずに 1 フレーム 1 段階(10%)動かしていたため、
 * 毎フレーム小さな delta を送るピンチでは 1 秒で数倍になっていた(#102)。
 * 倍率は delta に比例(指数的)にし、丸めない(丸めは表示・保存の roundZoom で行う)。
 */
export function wheelZoom(zoom: ZoomState, fitScale: number, deltaY: number): ZoomState {
  const base = zoom === "fit" ? fitScale : zoom;
  const { min, max } = zoomRange(base);
  const delta = Math.max(-WHEEL_DELTA_CAP, Math.min(WHEEL_DELTA_CAP, deltaY));
  const next = base * Math.exp(-delta * WHEEL_ZOOM_RATE);
  return settle(zoom, base, Math.min(max, Math.max(min, next)));
}

/** WheelEvent の delta を px に揃える(deltaMode が行・ページ単位のときの換算)。 */
export function wheelDeltaPixels(deltaY: number, deltaMode: number): number {
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * 400;
  return deltaY;
}
