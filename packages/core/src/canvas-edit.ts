import type { SourceSpan } from "./ast.js";

/** キャンバスオブジェクトの幅の下限(正規化値)。極端に細い箱を作らない。自由配置化と移動で共通。 */
export const MIN_CANVAS_WIDTH = 0.05;

/**
 * 位置を本文領域に収める(L012 と同じ条件: 0 <= x, x + w <= 1, 0 <= y <= 1)。幅は変えない。
 * ドラッグ移動で本文領域の端をわずかに越えた座標(x=-0.002 など)を書き込まないために使う(#111)。
 */
export function clampCanvasPosition(x: number, y: number, width: number): { x: number; y: number } {
  const w = Math.min(Math.max(Number.isFinite(width) ? width : MIN_CANVAS_WIDTH, 0), 1);
  const maxX = Math.max(0, 1 - w);
  return {
    x: Math.min(Math.max(x, 0), maxX),
    y: Math.min(Math.max(y, 0), 1),
  };
}

/** 位置と幅を本文領域に収める(自由配置化)。幅は下限以上・右端が 1 を超えない範囲に丸める。 */
export function clampCanvasPlacement(placement: { x: number; y: number; width: number }): {
  x: number;
  y: number;
  width: number;
} {
  const x = Math.min(Math.max(placement.x, 0), 1 - MIN_CANVAS_WIDTH);
  const y = Math.min(Math.max(placement.y, 0), 1);
  const width = Math.min(Math.max(placement.width, MIN_CANVAS_WIDTH), 1 - x);
  return { x, y, width };
}

/** キャンバス座標・幅の正規形(小数 3 桁、-0.000 は 0.000)。 */
export function formatCanvasCoordinate(value: number): string {
  const formatted = value.toFixed(3);
  return formatted === "-0.000" ? "0.000" : formatted;
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
