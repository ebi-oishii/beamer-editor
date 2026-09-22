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

const VERBATIM_ENVS = new Set(["verbatim", "verbatim*", "semiverbatim", "lstlisting", "minted"]);

/**
 * Mask TeX regions whose contents cannot safely participate in structural checks.
 * The resulting string has the same UTF-16 length and line breaks as `source`, so
 * parser spans can still be applied to the original source unchanged.
 */
function maskComments(source: string): string {
  const masked = source.split("");
  const mask = (start: number, end: number) => {
    for (let i = start; i < end; i++) {
      if (source[i] !== "\r" && source[i] !== "\n") masked[i] = " ";
    }
  };
  const balancedArgument = (at: number, open = "{", close = "}"): SourceSpan | null => {
    let cursor = skipTrivia(at);
    if (source[cursor] !== open) return null;
    const start = cursor;
    let depth = 1;
    let slashRun = 0;
    for (cursor++; cursor < source.length; cursor++) {
      const char = source[cursor] as string;
      if (char === "%" && slashRun % 2 === 0) {
        while (cursor < source.length && source[cursor] !== "\r" && source[cursor] !== "\n")
          cursor++;
        slashRun = 0;
        continue;
      }
      if (char === open && slashRun % 2 === 0) depth++;
      else if (char === close && slashRun % 2 === 0 && --depth === 0)
        return { start, end: cursor + 1 };
      slashRun = char === "\\" ? slashRun + 1 : 0;
    }
    return null;
  };
  const skipCommand = (at: number): number | null => {
    if (source[at] !== "\\") return null;
    let end = at + 1;
    if (/[a-zA-Z@]/.test(source[end] ?? ""))
      while (end < source.length && /[a-zA-Z@]/.test(source[end] as string)) end++;
    else end++;
    return end;
  };
  const skipTrivia = (at: number): number => {
    while (at < source.length && /\s/.test(source[at] as string)) at++;
    if (source[at] !== "%") return at;
    let slashes = 0;
    for (let previous = at - 1; previous >= 0 && source[previous] === "\\"; previous--) slashes++;
    if (slashes % 2 !== 0) return at;
    while (at < source.length && source[at] !== "\r" && source[at] !== "\n") at++;
    return skipTrivia(at);
  };
  const latexDefinitionBody = (at: number): SourceSpan | null => {
    let cursor = skipTrivia(at);
    if (source[cursor] === "*") cursor = skipTrivia(cursor + 1);
    const name =
      balancedArgument(cursor) ??
      (() => {
        const end = skipCommand(cursor);
        return end === null ? null : { start: cursor, end };
      })();
    if (!name) return null;
    cursor = skipTrivia(name.end);
    for (let count = 0; count < 2; count++) {
      const optional = balancedArgument(cursor, "[", "]");
      if (!optional) break;
      cursor = skipTrivia(optional.end);
    }
    return balancedArgument(cursor);
  };
  const primitiveDefinitionBody = (at: number): SourceSpan | null => {
    let cursor = skipTrivia(at);
    const nameEnd = skipCommand(cursor);
    if (nameEnd === null) return null;
    cursor = nameEnd;
    while (cursor < source.length) {
      if (source[cursor] === "{") return balancedArgument(cursor);
      if (source[cursor] === "\\") {
        const end = skipCommand(cursor);
        if (end === null) return null;
        cursor = end;
        continue;
      }
      if (source[cursor] === "}" || source[cursor] === "%") return null;
      cursor++;
    }
    return null;
  };
  const environmentDefinitionBodies = (at: number): [SourceSpan, SourceSpan] | null => {
    let cursor = skipTrivia(at);
    if (source[cursor] === "*") cursor = skipTrivia(cursor + 1);
    const name = balancedArgument(cursor);
    if (!name) return null;
    cursor = skipTrivia(name.end);
    for (let count = 0; count < 2; count++) {
      const optional = balancedArgument(cursor, "[", "]");
      if (!optional) break;
      cursor = skipTrivia(optional.end);
    }
    const begin = balancedArgument(cursor);
    if (!begin) return null;
    const end = balancedArgument(begin.end);
    return end ? [begin, end] : null;
  };

  let slashRun = 0;
  let stringifyNextToken = false;
  for (let cursor = 0; cursor < source.length; cursor++) {
    const slashesBefore = slashRun;
    if (stringifyNextToken) {
      if (source[cursor] === "%" && slashesBefore % 2 === 0) {
        let end = cursor;
        while (end < source.length && source[end] !== "\r" && source[end] !== "\n") end++;
        mask(cursor, end);
        cursor = end - 1;
        slashRun = 0;
        continue;
      }
      if (/\s/.test(source[cursor] as string)) {
        slashRun = source[cursor] === "\\" ? slashRun + 1 : 0;
        continue;
      }
      stringifyNextToken = false;
      if (source[cursor] !== "\\") {
        slashRun = 0;
        continue;
      }
      let end = cursor + 1;
      if (/[a-zA-Z@]/.test(source[end] ?? ""))
        while (end < source.length && /[a-zA-Z@]/.test(source[end] as string)) end++;
      else end = Math.min(end + 1, source.length);
      cursor = end - 1;
      slashRun = 0;
      continue;
    }
    if (source[cursor] === "%" && slashesBefore % 2 === 0) {
      let end = cursor;
      while (end < source.length && source[end] !== "\r" && source[end] !== "\n") end++;
      mask(cursor, end);
      cursor = end - 1;
      slashRun = 0;
      continue;
    }
    if (source[cursor] !== "\\" || slashesBefore % 2 !== 0) {
      slashRun = source[cursor] === "\\" ? slashRun + 1 : 0;
      continue;
    }

    if (source.startsWith("\\detokenize", cursor) && !/[a-zA-Z@]/.test(source[cursor + 11] ?? "")) {
      const argument = balancedArgument(cursor + 11);
      if (argument) {
        mask(cursor + 11, argument.end);
        cursor = argument.end - 1;
        slashRun = 0;
        continue;
      }
    }
    if (
      (source.startsWith("\\string", cursor) && !/[a-zA-Z@]/.test(source[cursor + 7] ?? "")) ||
      (source.startsWith("\\meaning", cursor) && !/[a-zA-Z@]/.test(source[cursor + 8] ?? ""))
    ) {
      stringifyNextToken = true;
      cursor += source[cursor + 1] === "s" ? 6 : 7;
      slashRun = 0;
      continue;
    }

    const latexDefinition = [
      "newcommand",
      "renewcommand",
      "providecommand",
      "DeclareRobustCommand",
    ].find(
      (command) =>
        source.startsWith(`\\${command}`, cursor) &&
        !/[a-zA-Z@]/.test(source[cursor + command.length + 1] ?? ""),
    );
    const primitiveDefinition = ["def", "gdef", "edef", "xdef"].find(
      (command) =>
        source.startsWith(`\\${command}`, cursor) &&
        !/[a-zA-Z@]/.test(source[cursor + command.length + 1] ?? ""),
    );
    const environmentDefinition = ["newenvironment", "renewenvironment", "provideenvironment"].find(
      (command) =>
        source.startsWith(`\\${command}`, cursor) &&
        !/[a-zA-Z@]/.test(source[cursor + command.length + 1] ?? ""),
    );
    const definition = latexDefinition
      ? latexDefinitionBody(cursor + latexDefinition.length + 1)
      : primitiveDefinition
        ? primitiveDefinitionBody(cursor + primitiveDefinition.length + 1)
        : null;
    if (definition) {
      const commandEnd = cursor + (latexDefinition ?? primitiveDefinition ?? "").length + 1;
      mask(commandEnd, definition.end);
      cursor = definition.end - 1;
      slashRun = 0;
      continue;
    }
    const environmentBodies = environmentDefinition
      ? environmentDefinitionBodies(cursor + environmentDefinition.length + 1)
      : null;
    if (environmentBodies) {
      mask(cursor + environmentDefinition!.length + 1, environmentBodies[1].end);
      cursor = environmentBodies[1].end - 1;
      slashRun = 0;
      continue;
    }

    const environment = /^\\begin\{(verbatim|verbatim\*|semiverbatim|lstlisting|minted)\}/.exec(
      source.slice(cursor),
    )?.[1];
    if (environment && VERBATIM_ENVS.has(environment)) {
      const beginEnd = cursor + `\\begin{${environment}}`.length;
      const endToken = `\\end{${environment}}`;
      const end = source.indexOf(endToken, beginEnd);
      if (end === -1) {
        mask(beginEnd, source.length);
        return masked.join("");
      }
      mask(beginEnd, end);
      cursor = end + endToken.length - 1;
      slashRun = 0;
      continue;
    }

    if (!source.startsWith("\\verb", cursor)) {
      slashRun++;
      continue;
    }
    const star = source[cursor + 5] === "*";
    const delimiterAt = cursor + (star ? 6 : 5);
    const delimiter = source[delimiterAt];
    if (!delimiter || /[A-Za-z@\r\n]/.test(delimiter)) {
      slashRun++;
      continue;
    }
    const end = source.indexOf(delimiter, delimiterAt + 1);
    let lineEnd = delimiterAt;
    while (lineEnd < source.length && source[lineEnd] !== "\r" && source[lineEnd] !== "\n")
      lineEnd++;
    if (end === -1 || end >= lineEnd) {
      mask(delimiterAt, lineEnd);
      cursor = lineEnd - 1;
      slashRun = 0;
      continue;
    }
    mask(delimiterAt, end + 1);
    cursor = end;
    slashRun = delimiter === "\\" ? 1 : 0;
  }
  return masked.join("");
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
