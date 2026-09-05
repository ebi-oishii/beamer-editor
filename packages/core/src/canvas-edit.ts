import type { SourceSpan } from "./ast.js";

/** 箱の最小幅(正規化値)。極端に細い箱を作らない。 */
export const CANVAS_MIN_WIDTH = 0.05;

/** 本文領域に対する正規化座標(0〜1)での箱の位置と幅。高さは内容から自動。 */
export interface CanvasPlacement {
  x: number;
  y: number;
  width: number;
}

/**
 * キャンバス座標の数値としての正規形(小数 3 桁、-0 は 0)。
 * clamp はソースへ書く値そのものを返すため、境界も含めてここで丸める。
 * 丸めずに clamp すると `1 - 0.8` のような誤差が残り、3 桁化した結果が
 * ふたたび `x + w > 1` へ振れうる。
 */
export function roundCanvasCoordinate(value: number): number {
  if (!Number.isFinite(value)) return value;
  const rounded = Number(value.toFixed(3));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * 箱の位置と幅を本文領域内へ収める(「自由配置にする」のように幅も決めるとき)。
 * 判定は lint L012 の条件と同じで、ここを通した値は必ず L012 を通る。
 */
export function clampCanvasPlacement(placement: CanvasPlacement): CanvasPlacement {
  const r = roundCanvasCoordinate;
  const x = r(Math.min(Math.max(placement.x, 0), 1 - CANVAS_MIN_WIDTH));
  const y = r(Math.min(Math.max(placement.y, 0), 1));
  // 幅の上限は丸めた x に対して取り、x + width <= 1 を 3 桁表現のまま保つ。
  const width = r(Math.min(Math.max(placement.width, CANVAS_MIN_WIDTH), r(1 - x)));
  return { x, y, width };
}

/**
 * 幅を変えずに位置だけを本文領域内へ収める(ドラッグ移動)。
 * 右端は `x + width <= 1` を保つため `1 - width` で止める。幅が読めない
 * (0 や NaN を渡す)場合は x を [0, 1] に収めるだけにする。
 */
export function clampCanvasPosition(x: number, y: number, width: number): { x: number; y: number } {
  const r = roundCanvasCoordinate;
  const safeWidth = Number.isFinite(width) ? Math.min(Math.max(width, 0), 1) : 0;
  return {
    x: r(Math.min(Math.max(x, 0), r(1 - safeWidth))),
    y: r(Math.min(Math.max(y, 0), 1)),
  };
}

/** キャンバス座標・幅の正規形(小数 3 桁、-0.000 は 0.000)。 */
export function formatCanvasCoordinate(value: number): string {
  return roundCanvasCoordinate(value).toFixed(3);
}

/** canvas オブジェクト(deckimage / decktext)の options 原文内の x/y だけを小数 3 桁で置換する。 */
export function canvasPositionReplacement(options: string, x: number, y: number): string | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!options.startsWith("[") || !options.endsWith("]")) return null;
  const value = formatCanvasCoordinate;
  const replace = (key: "x" | "y", next: string, text: string): string | null => {
    const matches = [
      ...text.matchAll(
        new RegExp(
          `(^|[\\[,\\s])(${key})(\\s*=\\s*)([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)`,
          "g",
        ),
      ),
    ];
    if (matches.length !== 1) return null;
    const match = matches[0] as RegExpMatchArray;
    const prefix = match[1];
    const foundKey = match[2];
    const separator = match[3];
    const previous = match[4];
    if (
      prefix === undefined ||
      foundKey === undefined ||
      separator === undefined ||
      previous === undefined
    )
      return null;
    const at = (match.index ?? 0) + prefix.length + foundKey.length + separator.length;
    return `${text.slice(0, at)}${next}${text.slice(at + previous.length)}`;
  };
  const withX = replace("x", value(x), options);
  if (withX === null) return null; // x/y の欠落は安全に拒否する。
  const withY = replace("y", value(y), withX);
  if (withY === null) return null;
  return withY;
}

/** x/y のみを小数 3 桁で置換する。options span は `[...]` 全体でなければならない。 */
export function updateCanvasPosition(
  source: string,
  optionsSpan: SourceSpan,
  x: number,
  y: number,
): string | null {
  if (
    !Number.isInteger(optionsSpan.start) ||
    !Number.isInteger(optionsSpan.end) ||
    optionsSpan.start < 0 ||
    optionsSpan.end > source.length ||
    optionsSpan.start >= optionsSpan.end
  )
    return null;
  const replacement = canvasPositionReplacement(
    source.slice(optionsSpan.start, optionsSpan.end),
    x,
    y,
  );
  return replacement === null
    ? null
    : `${source.slice(0, optionsSpan.start)}${replacement}${source.slice(optionsSpan.end)}`;
}
