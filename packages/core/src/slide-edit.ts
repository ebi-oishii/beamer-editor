import { type AnyFrameNode, framesOf, type SourceSpan } from "./ast.js";
import { parseDeck, readFrameHeader } from "./parser.js";
import { macroDefinitions, texTokens } from "./tex-scan.js";

export type SlideEditAction = "moveUp" | "moveDown" | "duplicate" | "delete" | "insert";
export interface SlideSourceEdit {
  span: SourceSpan;
  text: string;
}
export type SlideEditResult =
  | { ok: true; edits: SlideSourceEdit[] }
  | { ok: false; reason: string };

const FRAME_END = "\\end{frame}";
const MALFORMED =
  "閉じていない、または入れ子になったフレームがあります。ソースを確認してください。";

type EditableFrames =
  | { ok: true; frames: AnyFrameNode[]; bodyStart: number; bodyEnd: number }
  | { ok: false; reason: string };

/**
 * 編集対象のフレーム一覧。スライド一覧と同じ `parseDeck(source)` の frame span をそのまま使う。
 * パーサと同じ tex-scan の規則で文書タグ・frame タグを数え、それが AST と食い違う
 * (閉じない・入れ子・文書外へはみ出す)文書は編集しない。
 */
function editableFrames(source: string): EditableFrames {
  const unknownDocument = {
    ok: false,
    reason: "document環境の境界を特定できません。ソースを確認してください。",
  } as const;
  const documentTags = [];
  for (const token of texTokens(source)) {
    if (token.kind === "unterminated") return { ok: false, reason: MALFORMED };
    if ((token.kind === "begin" || token.kind === "end") && token.name === "document")
      documentTags.push(token);
  }
  const [begin, end] = documentTags;
  if (documentTags.length !== 2 || begin?.kind !== "begin" || end?.kind !== "end")
    return unknownDocument;
  const doc = parseDeck(source);
  if (doc.managedPreamble.span.end !== begin.start) return unknownDocument;
  const bodyStart = begin.end;
  const bodyEnd = end.start;
  const frames = framesOf(doc);
  const frameTags = { begin: 0, end: 0 };
  for (const token of texTokens(source, bodyStart, bodyEnd)) {
    if ((token.kind === "begin" || token.kind === "end") && token.name === "frame")
      frameTags[token.kind]++;
  }
  if (
    frameTags.begin !== frames.length ||
    frameTags.end !== frames.length ||
    frames.some(
      (frame) =>
        frame.span.start < bodyStart ||
        frame.span.end > bodyEnd ||
        !source.slice(frame.span.start, frame.span.end).endsWith(FRAME_END),
    )
  ) {
    return { ok: false, reason: MALFORMED };
  }
  return { ok: true, frames, bodyStart, bodyEnd };
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

/**
 * Commands and environments whose replacement text (transitively) reaches `\label`.
 * Definitions anywhere in the source count, including the preamble outside `%% macros`.
 */
function labelProducers(source: string): { commands: Set<string>; environments: Set<string> } {
  const definitions = macroDefinitions(source);
  const producers = { commands: new Set(["label"]), environments: new Set<string>() };
  for (let changed = true; changed; ) {
    changed = false;
    for (const definition of definitions) {
      const known = definition.target === "command" ? producers.commands : producers.environments;
      if (known.has(definition.name)) continue;
      if (definition.bodies.some((body) => emitsLabel(source, body, producers))) {
        known.add(definition.name);
        changed = true;
      }
    }
  }
  return producers;
}

function emitsLabel(
  source: string,
  span: SourceSpan,
  producers: { commands: Set<string>; environments: Set<string> },
): boolean {
  for (const token of texTokens(source, span.start, span.end)) {
    if (token.kind === "command" && producers.commands.has(token.name)) return true;
    if ((token.kind === "begin" || token.kind === "end") && producers.environments.has(token.name))
      return true;
  }
  return false;
}

/** 書き換えてよい素朴な option 列(`key` / `key=value` のカンマ区切り)か。 */
function isPlainOptionList(options: string): boolean {
  const inner = options.slice(1, -1);
  if (/[%{}\\[\]]/.test(inner)) return false;
  return inner
    .split(",")
    .every((part) => part.trim() === "" || /^[A-Za-z][\w@*-]*\s*(?:=[^=]*)?$/.test(part.trim()));
}

/**
 * Give the copy a fresh address, following the frame header exactly as the parser read it.
 * Returns null when the header cannot be rewritten safely.
 */
function duplicateFrame(
  source: string,
  frame: AnyFrameNode,
  span: SourceSpan,
  label: string,
): string | null {
  const header = readFrameHeader(source, frame.span.start, frame.span.end - FRAME_END.length);
  if (header.incomplete) return null;
  const before = (at: number) => source.slice(span.start, at);
  const after = (at: number) => source.slice(at, span.end);
  if (!header.options) return `${before(header.insertAt)}[label=${label}]${after(header.insertAt)}`;
  const options = source.slice(header.options.start, header.options.end);
  if (!isPlainOptionList(options)) return null;
  const matches = [...options.matchAll(/([[,])(\s*label\s*=\s*)([^,\]]*?)(?=\s*[,\]])/g)];
  if (matches.length > 1 || matches.some((match) => !match[3])) return null;
  const match = matches[0];
  const changed = match
    ? options.slice(0, (match.index ?? 0) + (match[1]?.length ?? 0)) +
      `${match[2]}${label}` +
      options.slice((match.index ?? 0) + match[0].length)
    : `${options.slice(0, -1)}${options.slice(1, -1).trim() ? "," : ""}label=${label}]`;
  return before(header.options.start) + changed + after(header.options.end);
}

/** Pure source edits. No reformatting or macro expansion of source being moved/copied. */
export function editSlide(
  source: string,
  action: SlideEditAction,
  frameStart?: number,
): SlideEditResult {
  const fail = (reason: string): SlideEditResult => ({ ok: false, reason });
  const deck = editableFrames(source);
  if (!deck.ok) return deck;
  const { frames, bodyStart, bodyEnd } = deck;
  const index = frames.findIndex((frame) => frame.span.start === frameStart);
  if (frameStart !== undefined && index < 0)
    return fail("対象スライドが更新されています。一覧から選び直してください。");
  if (action !== "insert" && index < 0) return fail("一覧でスライドを選択してください。");
  const spans = frames.map((frame, i) =>
    attachedSpan(source, frame, frames[i - 1]?.span.end ?? bodyStart),
  );
  const span = spans[index];
  const frame = frames[index];
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  let edits: SlideSourceEdit[];
  if (action === "insert") {
    const at = span?.end ?? bodyEnd;
    const text = `\\begin{frame}[label=${unusedLabel(source)}]{New slide}${newline}${newline}\\end{frame}${newline}`;
    edits = [{ span: { start: at, end: at }, text: `${newline}${text}` }];
  } else if (!span || !frame) {
    return fail("対象スライドが見つかりません。");
  } else if (action === "delete") {
    edits = [{ span, text: "" }];
  } else if (action === "duplicate") {
    // An internal TeX label can be referenced anywhere, including opaque commands.
    // Do not silently duplicate those targets or rewrite unknown TeX references.
    if (emitsLabel(source, frame.span, labelProducers(source)))
      return fail("本文に\\labelがあるスライドは、参照先を確認してソース上で複製してください。");
    const copy = duplicateFrame(source, frame, span, unusedLabel(source));
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
  const after = editableFrames(next);
  if (!after.ok || after.frames.length !== expected)
    return fail("変更後のフレーム境界を確認できないため、操作を中止しました。");
  return { ok: true, edits };
}
