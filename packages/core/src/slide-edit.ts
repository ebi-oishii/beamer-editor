import { type AnyFrameNode, framesOf, type SourceSpan } from "./ast.js";
import { expandDeck, mapExpandedRangeToSourceExact } from "./expander.js";
import { parseDeck } from "./parser.js";

export type SlideEditAction = "moveUp" | "moveDown" | "duplicate" | "delete" | "insert";
export interface SlideSourceEdit {
  span: SourceSpan;
  text: string;
}
export type SlideEditResult =
  | { ok: true; edits: SlideSourceEdit[] }
  | { ok: false; reason: string };

/** Comments are masked for structural parsing; edits always use the original UTF-16 source. */
function maskComments(source: string): string {
  return source.replace(/(?<!\\)(?:\\\\)*%[^\r\n]*/g, (match) => {
    const percent = match.indexOf("%");
    return match.slice(0, percent) + " ".repeat(match.length - percent);
  });
}

/** Whole-line comments immediately before a frame and its end-of-line comment travel with it. */
function attachedSpan(source: string, frame: AnyFrameNode, floor: number): SourceSpan {
  let start = frame.span.start;
  const line = source.lastIndexOf("\n", start - 1) + 1;
  if (line >= floor && /^[ \t]*$/.test(source.slice(line, start))) {
    start = line;
    while (start > floor) {
      const previous = source.lastIndexOf("\n", start - 2) + 1;
      if (previous < floor || !/^[ \t]*%[^\r\n]*\r?\n$/.test(source.slice(previous, start))) break;
      start = previous;
    }
  }
  let end = frame.span.end;
  const tail = /^[ \t]*(?:%[^\r\n]*)?(?:\r?\n|$)/.exec(source.slice(end));
  if (tail) end += tail[0].length;
  return { start, end };
}

function unusedLabel(source: string): string {
  let index = 1;
  // Also avoid names in opaque/macro-generated frames and reference commands.
  while (source.includes(`slide-${index}`)) index++;
  return `slide-${index}`;
}

const VERBATIM_ENVS = new Set(["verbatim", "verbatim*", "semiverbatim", "lstlisting", "minted"]);

/** Reject frame nesting and unmatched frame tags before an edit can remove a swallowed frame. */
function hasWellFormedFrames(masked: string): boolean {
  const token = /\\(begin|end)\{([^}\\\r\n]+)\}/g;
  let depth = 0;
  for (let match = token.exec(masked); match; match = token.exec(masked)) {
    let precedingSlashes = 0;
    for (let i = (match.index ?? 0) - 1; i >= 0 && masked[i] === "\\"; i--) precedingSlashes++;
    // Match parser.ts: a tag after `\\` is live (the two slashes are a line break),
    // while a tag after one escaped slash is literal text.
    if (precedingSlashes % 2 !== 0) continue;
    const kind = match[1];
    const environment = match[2];
    if (!kind || !environment) return false;
    if (kind === "begin" && VERBATIM_ENVS.has(environment)) {
      const end = `\\end{${environment}}`;
      const endAt = masked.indexOf(end, token.lastIndex);
      if (endAt === -1) return false;
      token.lastIndex = endAt + end.length;
      continue;
    }
    if (environment !== "frame") continue;
    if (kind === "begin") {
      if (depth !== 0) return false;
      depth = 1;
    } else {
      if (depth !== 1) return false;
      depth = 0;
    }
  }
  return depth === 0;
}

function skipHeaderTrivia(source: string, cursor: number): number {
  while (cursor < source.length) {
    const whitespace = /^[ \t\r\n]+/.exec(source.slice(cursor));
    if (whitespace) {
      cursor += whitespace[0].length;
      continue;
    }
    if (source[cursor] === "%") {
      const eol = source.indexOf("\n", cursor);
      cursor = eol === -1 ? source.length : eol + 1;
      continue;
    }
    break;
  }
  return cursor;
}

interface FrameHeader {
  options: SourceSpan | null;
  insertAt: number;
}

/**
 * Locate the simple public part of a frame header. We retain all bytes, but only
 * rewrite an ordinary option list after optional whitespace, comments, and one overlay spec.
 */
function parseFrameHeader(source: string, begin: number): FrameHeader | null {
  let cursor = begin + "\\begin{frame}".length;
  cursor = skipHeaderTrivia(source, cursor);
  if (source[cursor] === "<") {
    const close = source.indexOf(">", cursor + 1);
    if (close === -1 || /[\r\n%{}\\<>]/.test(source.slice(cursor + 1, close))) return null;
    cursor = skipHeaderTrivia(source, close + 1);
  }
  const insertAt = cursor;
  if (source[cursor] !== "[") return { options: null, insertAt };
  const close = source.indexOf("]", cursor + 1);
  if (close === -1 || /[\r\n%{}\\[\]]/.test(source.slice(cursor + 1, close))) return null;
  return { options: { start: insertAt, end: close + 1 }, insertAt };
}

/** Replace only the frame's public address, retaining its other options and opaque body. */
function duplicateFrame(source: string, label: string, begin: number): string | null {
  if (begin < 0) return null;
  const header = parseFrameHeader(source, begin);
  if (!header) return null;
  if (!header.options)
    return `${source.slice(0, header.insertAt)}[label=${label}]${source.slice(header.insertAt)}`;
  const options = source.slice(header.options.start, header.options.end);
  const matches = [...options.matchAll(/([[,])([ \t]*label[ \t]*=[ \t]*)([^,\]]*)/g)];
  if (matches.length > 1 || matches.some((match) => !match[3]?.trim())) return null;
  const match = matches[0];
  const changed = match
    ? options.slice(0, (match.index ?? 0) + (match[1]?.length ?? 0)) +
      `${match[2]}${label}` +
      options.slice((match.index ?? 0) + match[0].length)
    : `${options.slice(0, -1)}${options.length > 2 ? "," : ""}label=${label}]`;
  return source.slice(0, header.options.start) + changed + source.slice(header.options.end);
}

function hasInternalLabel(source: string, masked: string, span: SourceSpan): boolean {
  if (/\\label\s*\{/.test(masked.slice(span.start, span.end))) return true;
  const expanded = expandDeck(source);
  const expandedMasked = maskComments(expanded.source);
  for (const match of expandedMasked.matchAll(/\\label\s*\{/g)) {
    const start = match.index;
    if (start === undefined) continue;
    const range = { start, end: start + match[0].length };
    const exact = mapExpandedRangeToSourceExact(expanded.map, range);
    if (exact && exact.start >= span.start && exact.end <= span.end) return true;
    if (exact) continue;
    // A synthetic label cannot be rewritten safely. Refuse only when its call site
    // belongs to this frame, so macro labels in other frames remain editable.
    if (
      expanded.map.some(
        (segment) =>
          segment.expandedStart < range.end &&
          segment.expandedEnd > range.start &&
          !segment.exact &&
          segment.sourceStart < span.end &&
          segment.sourceEnd > span.start,
      )
    )
      return true;
  }
  return false;
}

/** Pure source edits. No reformatting or macro expansion of source being moved/copied. */
export function editSlide(
  source: string,
  action: SlideEditAction,
  frameStart?: number,
): SlideEditResult {
  const fail = (reason: string): SlideEditResult => ({ ok: false, reason });
  const masked = maskComments(source);
  const begins = [...masked.matchAll(/\\begin\{document\}/g)];
  const ends = [...masked.matchAll(/\\end\{document\}/g)];
  const begin = begins[0]?.index;
  const end = ends[0]?.index;
  if (
    begins.length !== 1 ||
    ends.length !== 1 ||
    begin === undefined ||
    end === undefined ||
    begin >= end
  ) {
    return fail("document環境の境界を特定できません。ソースを確認してください。");
  }
  const bodyStart = begin + "\\begin{document}".length;
  if (!hasWellFormedFrames(masked.slice(bodyStart, end)))
    return fail("閉じていない、または入れ子になったフレームがあります。ソースを確認してください。");
  // The parser's document delimiter lookup is literal. Mask comments for it as well,
  // while retaining original source bytes for every replacement.
  const frames = framesOf(parseDeck(masked));
  if (
    frames.some(
      (frame) =>
        frame.span.start < bodyStart ||
        frame.span.end > end ||
        !source.slice(frame.span.start, frame.span.end).endsWith("\\end{frame}"),
    )
  ) {
    return fail("閉じていないフレームがあります。ソースを確認してください。");
  }
  const index = frames.findIndex((frame) => frame.span.start === frameStart);
  if (frameStart !== undefined && index < 0)
    return fail("対象スライドが更新されています。一覧から選び直してください。");
  if (action !== "insert" && index < 0) return fail("一覧でスライドを選択してください。");
  const spans = frames.map((frame, i) =>
    attachedSpan(source, frame, frames[i - 1]?.span.end ?? bodyStart),
  );
  const span = spans[index];
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  let edits: SlideSourceEdit[];
  if (action === "insert") {
    const at = span?.end ?? end;
    const text = `\\begin{frame}[label=${unusedLabel(source)}]{New slide}${newline}${newline}\\end{frame}${newline}`;
    edits = [{ span: { start: at, end: at }, text: `${newline}${text}` }];
  } else if (!span) {
    return fail("対象スライドが見つかりません。");
  } else if (action === "delete") {
    edits = [{ span, text: "" }];
  } else if (action === "duplicate") {
    // An internal TeX label can be referenced anywhere, including opaque commands.
    // Do not silently duplicate those targets or rewrite unknown TeX references.
    if (hasInternalLabel(source, masked, span)) {
      return fail("本文に\\labelがあるスライドは、参照先を確認してソース上で複製してください。");
    }
    const frame = frames[index];
    if (!frame) return fail("対象スライドが見つかりません。");
    const copy = duplicateFrame(
      source.slice(span.start, span.end),
      unusedLabel(source),
      frame.span.start - span.start,
    );
    if (copy === null)
      return fail("フレームのlabelを安全に変更できません。ソースを確認してください。");
    edits = [
      {
        span: { start: span.end, end: span.end },
        text: `${newline}${copy}${copy.endsWith("\n") ? "" : newline}`,
      },
    ];
  } else {
    const adjacent = spans[index + (action === "moveUp" ? -1 : 1)];
    if (!adjacent) return { ok: true, edits: [] };
    if (Math.max(span.start, adjacent.start) < Math.min(span.end, adjacent.end))
      return fail("フレームの境界が重なっています。");
    edits = [
      { span, text: source.slice(adjacent.start, adjacent.end) },
      { span: adjacent, text: source.slice(span.start, span.end) },
    ];
  }
  // Verify the source operation did not swallow adjacent frames or document boundaries.
  let next = source;
  for (const edit of [...edits].sort((a, b) => b.span.start - a.span.start))
    next = next.slice(0, edit.span.start) + edit.text + next.slice(edit.span.end);
  const expected =
    frames.length +
    (action === "insert" || action === "duplicate" ? 1 : action === "delete" ? -1 : 0);
  if (framesOf(parseDeck(maskComments(next))).length !== expected)
    return fail("変更後のフレーム境界を確認できないため、操作を中止しました。");
  return { ok: true, edits };
}
