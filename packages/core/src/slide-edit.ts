import { type AnyFrameNode, framesOf, type SourceSpan } from "./ast.js";
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

/** Replace only the frame's public address, retaining its other options and opaque body. */
function duplicateFrame(source: string, label: string, begin: number): string | null {
  if (begin < 0) return null;
  const at = begin + "\\begin{frame}".length;
  if (source[at] !== "[") return `${source.slice(0, at)}[label=${label}]${source.slice(at)}`;
  const options = /^\[[^[\]\r\n]*\]/.exec(source.slice(at))?.[0];
  if (!options || /[%{}\\]/.test(options)) return null;
  const matches = [...options.matchAll(/([[,])([ \t]*label[ \t]*=[ \t]*)([^,\]]*)/g)];
  if (matches.length > 1) return null;
  const match = matches[0];
  const changed = match
    ? options.slice(0, (match.index ?? 0) + (match[1]?.length ?? 0)) +
      `${match[2]}${label}` +
      options.slice((match.index ?? 0) + match[0].length)
    : `${options.slice(0, -1)}${options.length > 2 ? "," : ""}label=${label}]`;
  return source.slice(0, at) + changed + source.slice(at + options.length);
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
    if (/\\label\s*\{/.test(masked.slice(span.start, span.end))) {
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
