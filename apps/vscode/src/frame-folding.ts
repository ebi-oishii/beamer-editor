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
const VERBATIM_ENVS = new Set(["verbatim", "verbatim*", "semiverbatim", "lstlisting", "minted"]);

/** 直前にある連続バックスラッシュ数が奇数なら、その位置の文字は TeX でエスケープされる。 */
function isEscaped(source: string, position: number): boolean {
  let slashes = 0;
  for (let cursor = position - 1; cursor >= 0 && source[cursor] === "\\"; cursor--) slashes++;
  return slashes % 2 === 1;
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
function completeOuterFrameEnd(source: string, start: number, end: number): number | undefined {
  let depth = 0;
  let cursor = start;
  let slashes = 0;
  while (cursor < end) {
    const char = source[cursor] as string;
    if (char === "%" && slashes % 2 === 0) {
      while (cursor < end && source[cursor] !== "\n" && source[cursor] !== "\r") cursor++;
      slashes = 0;
      continue;
    }
    if (slashes % 2 === 0 && source.startsWith("\\begin{", cursor)) {
      let close = cursor + 7;
      while (
        close < end &&
        source[close] !== "}" &&
        source[close] !== "\\" &&
        source[close] !== "\n" &&
        source[close] !== "\r"
      )
        close++;
      if (source[close] !== "}") {
        cursor += "\\begin{".length;
        slashes = 0;
        continue;
      }
      const environment = source.slice(cursor + 7, close);
      if (VERBATIM_ENVS.has(environment)) {
        const verbatimEnd = `\\end{${environment}}`;
        const endPos = source.indexOf(verbatimEnd, close + 1);
        if (endPos === -1 || endPos >= end) return undefined;
        cursor = endPos + verbatimEnd.length;
        slashes = 0;
        continue;
      }
    }
    if (slashes % 2 === 0 && source.startsWith(FRAME_BEGIN, cursor)) {
      depth++;
      cursor += FRAME_BEGIN.length;
      slashes = 0;
      continue;
    }
    if (slashes % 2 === 0 && source.startsWith(FRAME_END, cursor)) {
      if (depth === 0) return undefined;
      depth--;
      const outerEnd = cursor + FRAME_END.length;
      if (depth === 0) return hasOnlyTrailingTrivia(source, outerEnd, end) ? outerEnd : undefined;
      cursor = outerEnd;
      slashes = 0;
      continue;
    }
    slashes = char === "\\" ? slashes + 1 : 0;
    cursor++;
  }
  return undefined;
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
    const outerEnd = completeOuterFrameEnd(source, start, end);
    if (outerEnd === undefined) return [];
    const startLine = positionAt(start).line;
    const endLine = positionAt(outerEnd - 1).line;
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

/** provider の VS Code 非依存部分。キャンセル時・非対象文書は `undefined`。 */
export function provideFrameFoldRanges<Document extends FrameFoldDocument>(
  document: Document,
  isManaged: (document: Document) => boolean,
  cancellation: FrameFoldCancellation,
  cache: FrameFoldCache,
): FrameFoldRange[] | undefined {
  if (cancellation.isCancellationRequested) return undefined;
  if (!isManaged(document)) return undefined;
  const ranges = cache.get(document);
  return cancellation.isCancellationRequested ? undefined : ranges;
}
