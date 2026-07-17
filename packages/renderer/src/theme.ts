/**
 * プレビュー側のテーマ契約(docs/theme-design.md)。
 *
 * テーマは「語彙を変えない提示層」であり、renderer が必要とするのは
 * 幾何(スライド実寸・本文領域)と文字サイズ実寸のみ。
 * 値はテーマパックの metrics.json(TeX 側実測)と一致させる。
 * 見た目(色・フォント・タイトルページ様式)はテーマ CSS が担う。
 */

export type CanvasFontSizeName =
  | "tiny"
  | "scriptsize"
  | "footnotesize"
  | "small"
  | "normal"
  | "large"
  | "Large";

export interface ThemeMetrics {
  /** スライドの論理サイズ(pt)。16:9 = 160mm × 90mm。 */
  slideWidthPt: number;
  slideHeightPt: number;
  /** キャンバスの本文領域(pt)。テーマごとに計測デッキで実測する(C-1)。 */
  bodyAreaPt: { left: number; top: number; width: number; height: number };
}

export interface Theme {
  name: string;
  version: number;
  metrics: ThemeMetrics;
  /** 文字サイズ enum の実寸(pt)。LaTeX の基準フォントサイズに依存。 */
  fontSizesPt: Record<CanvasFontSizeName, number>;
}

/**
 * beamer default テーマ(11pt・16:9)。
 * metrics は fixtures/measure-body-area.tex の実測(2026-07-10)。
 * fixtures/deck-canvas-preamble.tex の定数と一致させること。
 */
export const DEFAULT_THEME: Theme = {
  name: "default",
  version: 1,
  metrics: {
    slideWidthPt: 455.24,
    slideHeightPt: 256.07,
    bodyAreaPt: { left: 28.45, top: 19.06, width: 398.34, height: 236.97 },
  },
  fontSizesPt: {
    tiny: 6,
    scriptsize: 8,
    footnotesize: 9,
    small: 10,
    normal: 11,
    large: 12,
    Large: 14.4,
  },
};
