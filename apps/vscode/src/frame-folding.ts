import { framesOf, parseDeck } from "@beamer-editor/core";

/** VS Code に依存しない折りたたみ範囲。行番号は 0 始まりで両端を含む。 */
export interface FrameFoldRange {
  start: number;
  end: number;
}

export interface FrameFoldPosition {
  line: number;
}

export interface FrameFoldDocument {
  version: number;
  getText(): string;
  positionAt(offset: number): FrameFoldPosition;
}

export interface FrameFoldCancellation {
  isCancellationRequested: boolean;
}

const FRAME_BEGIN = "\\begin{frame}";
const FRAME_END = "\\end{frame}";

/** 直前にある連続バックスラッシュ数が奇数なら、その位置の文字は TeX でエスケープされる。 */
function isEscaped(source: string, position: number): boolean {
  let slashes = 0;
  for (let cursor = position - 1; cursor >= 0 && source[cursor] === "\\"; cursor--) slashes++;
  return slashes % 2 === 1;
}

/** 候補位置までの同一行に、エスケープされていない `%` コメント開始があるか。 */
function isInTeXComment(source: string, candidate: number): boolean {
  const lineStart =
    Math.max(source.lastIndexOf("\n", candidate - 1), source.lastIndexOf("\r", candidate - 1)) + 1;
  for (let cursor = lineStart; cursor < candidate; cursor++) {
    if (source[cursor] === "%" && !isEscaped(source, cursor)) return true;
  }
  return false;
}

/** 終端以降が空白または非エスケープ `%` コメントだけかを検査する。 */
function hasOnlyTrailingTrivia(source: string, start: number, end: number): boolean {
  for (let cursor = start; cursor < end; ) {
    if (/\s/.test(source[cursor] as string)) {
      cursor++;
      continue;
    }
    if (source[cursor] !== "%" || isEscaped(source, cursor)) return false;
    while (cursor < end && source[cursor] !== "\n" && source[cursor] !== "\r") cursor++;
  }
  return true;
}

/**
 * parser の frame span 内で、コメント・エスケープを考慮して frame delimiter の深さを追う。
 * 外側を閉じる end だけを受け入れ、その後には trailing trivia だけを許可する。
 */
function hasCompleteOuterFrame(source: string, start: number, end: number): boolean {
  let depth = 0;
  let cursor = start;
  while (cursor < end) {
    const begin = source.indexOf(FRAME_BEGIN, cursor);
    const frameEnd = source.indexOf(FRAME_END, cursor);
    const candidate = begin === -1 || (frameEnd !== -1 && frameEnd < begin) ? frameEnd : begin;
    if (candidate === -1 || candidate >= end) return false;
    const delimiter = candidate === begin ? FRAME_BEGIN : FRAME_END;
    cursor = candidate + delimiter.length;
    if (
      candidate + delimiter.length > end ||
      isEscaped(source, candidate) ||
      isInTeXComment(source, candidate)
    )
      continue;
    if (delimiter === FRAME_BEGIN) {
      depth++;
      continue;
    }
    if (depth === 0) return false;
    depth--;
    if (depth === 0) return hasOnlyTrailingTrivia(source, cursor, end);
  }
  return false;
}

/**
 * core の AST span を VS Code の行範囲へ変換する。
 *
 * パーサーは未完フレームも RawFrame として保持する。span 内の uncommented literal
 * delimiter を深さ付きで走査し、外側を閉じる終端とその後の trivia を確認するため、
 * 入力途中の終端 RawFrame・コメント/エスケープ中の delimiter・不整合な入れ子を
 * 折りたたみ対象にしない。
 */
export function frameFoldRanges(
  source: string,
  positionAt: (offset: number) => FrameFoldPosition,
): FrameFoldRange[] {
  return framesOf(parseDeck(source)).flatMap((frame) => {
    const { start, end } = frame.span;
    if (!hasCompleteOuterFrame(source, start, end)) return [];
    const startLine = positionAt(start).line;
    const endLine = positionAt(end - 1).line;
    return endLine > startLine ? [{ start: startLine, end: endLine }] : [];
  });
}

/** TextDocument/version ごとの解析結果を保持する小さなキャッシュ。 */
export class FrameFoldCache {
  private readonly entries = new WeakMap<object, { version: number; ranges: FrameFoldRange[] }>();

  get(document: FrameFoldDocument): FrameFoldRange[] {
    const cached = this.entries.get(document);
    if (cached?.version === document.version) return cached.ranges;
    const ranges = frameFoldRanges(document.getText(), (offset) => document.positionAt(offset));
    this.entries.set(document, { version: document.version, ranges });
    return ranges;
  }
}

/** provider の VS Code 非依存部分。キャンセル時は `undefined`、非対象文書は空配列。 */
export function provideFrameFoldRanges<Document extends FrameFoldDocument>(
  document: Document,
  isManaged: (document: Document) => boolean,
  cancellation: FrameFoldCancellation,
  cache: FrameFoldCache,
): FrameFoldRange[] | undefined {
  if (cancellation.isCancellationRequested) return undefined;
  if (!isManaged(document)) return [];
  const ranges = cache.get(document);
  return cancellation.isCancellationRequested ? undefined : ranges;
}
