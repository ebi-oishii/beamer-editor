import type { SourceSpan } from "./ast.js";

/** options 原文内の x/y だけを小数 3 桁で置換する。 */
export function canvasImagePositionReplacement(
  options: string,
  x: number,
  y: number,
): string | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!options.startsWith("[") || !options.endsWith("]")) return null;
  const value = (n: number) => {
    const formatted = n.toFixed(3);
    return formatted === "-0.000" ? "0.000" : formatted;
  };
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
export function updateCanvasImagePosition(
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
  const replacement = canvasImagePositionReplacement(
    source.slice(optionsSpan.start, optionsSpan.end),
    x,
    y,
  );
  return replacement === null
    ? null
    : `${source.slice(0, optionsSpan.start)}${replacement}${source.slice(optionsSpan.end)}`;
}
