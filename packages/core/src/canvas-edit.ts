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

/**
 * 幅を変えずに位置だけを本文領域内へ収める(ドラッグ移動)。
 * 右端と下端は箱の実寸を含めて本文領域内へ収める。返す x/y は小数 3 桁なので、
 * 上限は丸める前の寸法に対して下向きに量子化する。これにより返却後も
 * `x + width <= 1` を保つ。高さは実測できた場合だけ下端も含めて収める。
 */
export function clampCanvasPosition(
  x: number,
  y: number,
  width: number,
  height?: number,
): { x: number; y: number } {
  const size = (value: number | undefined): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  const upperBound = (value: number): number => {
    if (value >= 1) return 0;
    const units = (1 - value) * 1000;
    // `0.666` は二進表現では 333.99999999999994 になり得る。整数に十分近い
    // 場合だけ補正し、3 桁で表現済みの幅を余分に 1/1000 縮めない。
    const nearest = Math.round(units);
    const safeUnits = Math.abs(units - nearest) <= Number.EPSILON * 1000 ? nearest : units;
    const candidate = Math.floor(safeUnits) / 1000;
    // 近傍補正で元の浮動小数値を超えてしまう場合は、返却値そのものに対して
    // 再検証して下げる。width/height のどちらにも同じ保証を適用する。
    return candidate + value <= 1 ? candidate : Math.max(0, candidate - 0.001);
  };
  const coordinate = (value: number, limit: number): number => {
    const safeValue = Number.isFinite(value) ? value : 0;
    const clamped = Math.min(Math.max(roundCanvasCoordinate(safeValue), 0), limit);
    return Object.is(clamped, -0) ? 0 : clamped;
  };
  const safeWidth = size(width);
  // 高さが不明、または本文以上なら UI だけでは収納できない。その場合でも anchor
  // 自体は本文の座標系に保ち、溢れの検出は TeX の実測検証へ委ねる。
  const heightLimit =
    typeof height === "number" && Number.isFinite(height) && height > 0 && height < 1
      ? upperBound(height)
      : 1;
  return {
    x: coordinate(x, upperBound(safeWidth)),
    y: coordinate(y, heightLimit),
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

/** 位置を保ったまま、幅だけを最小幅と右端の間へ収める。 */
export function clampCanvasWidth(x: number, width: number): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(width) || x < 0 || x >= 1) return null;
  let maximum = Math.floor((1 - x) * 1000 + Number.EPSILON * 1000) / 1000;
  if (x + maximum > 1) maximum = Math.max(0, maximum - 0.001);
  if (maximum <= 0) return null;
  return Math.min(
    maximum,
    Math.max(Math.min(CANVAS_MIN_WIDTH, maximum), roundCanvasCoordinate(width)),
  );
}

/** options 内の w だけを置換する。位置・画像パス・他の宣言は原文のまま保つ。 */
export function canvasWidthReplacement(options: string, width: number): string | null {
  if (!Number.isFinite(width) || width <= 0 || !options.startsWith("[") || !options.endsWith("]"))
    return null;
  if (roundCanvasCoordinate(width) <= 0) return null;
  const parts = options.slice(1, -1).split(",");
  const indices = parts.flatMap((part, index) => (/^\s*w\s*=/.test(part) ? [index] : []));
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
  if (index === undefined) return `${options.slice(0, -1)},size=${size}]`;
  const match = /^(\s*size\s*=\s*)([^\s,]+)(\s*)$/.exec(parts[index] ?? "");
  if (!match) return null;
  parts[index] = `${match[1]}${size}${match[3]}`;
  return `[${parts.join(",")}]`;
}
