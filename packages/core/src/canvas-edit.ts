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
    // 省略されたキーは追加する(貼り付けた原文に x / y が無くても位置をずらせる)。
    if (matches.length === 0) return appendCanvasOption(text, `${key}=${next}`);
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
  if (withX === null) return null; // 同じキーが複数ある原文は安全に拒否する。
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

/** decktext の中身(`[...]` の直後から `\end{decktext}` の直前まで)と、編集用の文字列。 */
export interface CanvasTextBody {
  /** 元ソース上の中身の範囲。 */
  span: SourceSpan;
  /** 前後の空白と、行頭の字下げを除いた文字列(改行は LF)。 */
  text: string;
}

const DECKTEXT_END = "\\end{decktext}";

/** index が行コメント(エスケープされていない `%` の後ろ)の中にあるか。 */
function inLineComment(source: string, index: number): boolean {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  for (let cursor = lineStart; cursor < index; cursor++) {
    if (source[cursor] === "\\") cursor++;
    else if (source[cursor] === "%") return true;
  }
  return false;
}

/**
 * 中身の書式。先頭と末尾の空白(改行と `\end{decktext}` の前の字下げ)はそのまま残し、
 * 2 行目以降の字下げは中身の最初の行に合わせる。
 */
function bodyLayout(raw: string) {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const body = raw.replaceAll("\r\n", "\n");
  const leading = /^\s*/.exec(body)?.[0] ?? "";
  const rest = body.slice(leading.length);
  const trailing = /\s*$/.exec(rest)?.[0] ?? "";
  const lines = rest.slice(0, rest.length - trailing.length).split("\n");
  const indent = leading.includes("\n")
    ? leading.slice(leading.lastIndexOf("\n") + 1)
    : commonIndent(lines.slice(1));
  return { eol, leading, trailing, lines, indent };
}

/** 空行を除く行に共通する行頭の空白。 */
function commonIndent(lines: string[]): string {
  let common: string | undefined;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (common === undefined) {
      common = indent;
      continue;
    }
    let length = 0;
    while (length < common.length && common[length] === indent[length]) length++;
    common = common.slice(0, length);
  }
  return common ?? "";
}

/**
 * `optionsEnd`(decktext の `[...]` の直後)から始まる中身を返す。対応する `\end{decktext}` が
 * 無ければ null。プレビューでの書き換えは、この text を編集して canvasTextBodyReplacement で戻す。
 */
export function canvasTextBody(source: string, optionsEnd: number): CanvasTextBody | null {
  let end = source.indexOf(DECKTEXT_END, optionsEnd);
  while (end !== -1 && inLineComment(source, end)) end = source.indexOf(DECKTEXT_END, end + 1);
  if (end === -1) return null;
  const { lines, indent } = bodyLayout(source.slice(optionsEnd, end));
  const text = lines
    .map((line, index) =>
      index === 0 ? line : line.startsWith(indent) ? line.slice(indent.length) : line.trimStart(),
    )
    .join("\n");
  return { span: { start: optionsEnd, end }, text };
}

/**
 * decktext の中身を text に置き換える置換。元の中身の前後の改行・字下げ・改行コードに合わせて
 * 2 行目以降を字下げする。中身が見つからなければ null。
 */
export function canvasTextBodyReplacement(
  source: string,
  optionsEnd: number,
  text: string,
): { span: SourceSpan; text: string } | null {
  const body = canvasTextBody(source, optionsEnd);
  if (body === null) return null;
  const { eol, leading, trailing, indent } = bodyLayout(
    source.slice(body.span.start, body.span.end),
  );
  const content = text
    .replaceAll("\r\n", "\n")
    .trim()
    .split("\n")
    .map((line, index) => (index === 0 ? line : line.trim() === "" ? "" : indent + line))
    .join("\n");
  return { span: body.span, text: `${leading}${content}${trailing}`.replaceAll("\n", eol) };
}
