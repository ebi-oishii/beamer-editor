/**
 * オーバーレイ可視判定（apps/web の applyOverlay を純粋述語として抽出）。
 *
 * renderer は data-min / data-overlay 属性でステップ表示を表現する。
 * - data-min: `step >= Number(min)` で可視（\pause 由来）。
 * - data-overlay: "from-to,from-" 形式。step がいずれかの範囲内なら可視（to 空は +∞）。
 */

/** 属性値と現在 step から、その要素が可視かを返す。 */
export function isVisibleAtStep(
  attrs: { min?: string | null | undefined; overlay?: string | null | undefined },
  step: number,
): boolean {
  const { min, overlay } = attrs;
  if (min != null && min !== "" && step < Number(min)) {
    return false;
  }
  if (overlay != null && overlay !== "") {
    return overlay.split(",").some((part) => {
      const [from, to] = part.split("-");
      const f = Number(from);
      const t = to === "" || to === undefined ? Number.POSITIVE_INFINITY : Number(to);
      return step >= f && step <= t;
    });
  }
  return true;
}

/**
 * DOM へ covered クラスを適用する。data-min と data-overlay を独立の 2 パスで処理し、
 * apps/web の applyOverlay と同じ挙動（両方持つ要素では overlay パスが後勝ち）にする。
 */
export function applyOverlay(root: HTMLElement, step: number): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-min]")) {
    el.classList.toggle("covered", !isVisibleAtStep({ min: el.dataset.min }, step));
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-overlay]")) {
    el.classList.toggle("covered", !isVisibleAtStep({ overlay: el.dataset.overlay }, step));
  }
}
