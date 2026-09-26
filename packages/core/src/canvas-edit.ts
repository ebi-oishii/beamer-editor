import { CANVAS_FONT_SIZES, type CanvasFontSize, type SourceSpan } from "./ast.js";

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

/**
 * 幅を小数 3 桁に丸め、最小幅より細くしない。本文領域での clamp はしない(はみ出しは
 * 許容し、L012 が警告する。#152)。不正な値は null。
 */
export function normalizeCanvasWidth(width: number): number | null {
  if (!Number.isFinite(width)) return null;
  return Math.max(CANVAS_MIN_WIDTH, roundCanvasCoordinate(width));
}

/** options 内の w を置換し、未指定なら追加する。位置・画像パス・他の宣言は原文のまま保つ。 */
export function canvasWidthReplacement(options: string, width: number): string | null {
  if (!Number.isFinite(width) || width <= 0 || !options.startsWith("[") || !options.endsWith("]"))
    return null;
  if (roundCanvasCoordinate(width) <= 0) return null;
  const parts = options.slice(1, -1).split(",");
  const indices = parts.flatMap((part, index) => (/^\s*w\s*=/.test(part) ? [index] : []));
  if (indices.length === 0)
    return appendCanvasOption(options, `w=${formatCanvasCoordinate(width)}`);
  if (indices.length !== 1) return null;
  const index = indices[0];
  if (index === undefined) return null;
  const match = /^(\s*w\s*=\s*)([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(\s*)$/.exec(
    parts[index] ?? "",
  );
  if (!match) return null;
  parts[index] = `${match[1]}${formatCanvasCoordinate(width)}${match[3]}`;
  return `[${parts.join(",")}]`;
}

/**
 * 省略された option を最後の内容を持つパートの直後へ追加する。
 *
 * 末尾の空パートはそのままカンマを増やすと `,,` になるため捨て、最後のパートの
 * 改行・空白は閉じ角括弧の前に残す。空白だけの options は意味を持つ宣言が無いので
 * 通常の空 options と同じ形に正規化する。
 */
function appendCanvasOption(options: string, option: string): string {
  const parts = options.slice(1, -1).split(",");
  let index = parts.length - 1;
  while (index >= 0 && parts[index]?.trim() === "") index -= 1;
  if (index < 0) return `[${option}]`;
  const part = parts[index];
  if (part === undefined) return `[${option}]`;
  const contentEnd = part.search(/\s*$/);
  const suffix = `${part.slice(contentEnd)}${parts.slice(index + 1).join("")}`;
  const before = parts.slice(0, index).join(",");
  const separator = index === 0 ? "" : ",";
  return `[${before}${separator}${part.slice(0, contentEnd)},${option}${suffix}]`;
}

export function isCanvasFontSize(value: unknown): value is CanvasFontSize {
  return typeof value === "string" && CANVAS_FONT_SIZES.some((size) => size === value);
}

/** size だけを変更し、省略されていた場合だけ末尾へ追加する。 */
export function canvasFontSizeReplacement(options: string, size: CanvasFontSize): string | null {
  if (!isCanvasFontSize(size) || !options.startsWith("[") || !options.endsWith("]")) return null;
  const parts = options.slice(1, -1).split(",");
  const indices = parts.flatMap((part, index) => (/^\s*size\s*=/.test(part) ? [index] : []));
  if (indices.length > 1) return null;
  const index = indices[0];
  if (index === undefined) return appendCanvasOption(options, `size=${size}`);
  const match = /^(\s*size\s*=\s*)([^\s,]+)(\s*)$/.exec(parts[index] ?? "");
  if (!match) return null;
  parts[index] = `${match[1]}${size}${match[3]}`;
  return `[${parts.join(",")}]`;
}
