import type { SourceSpan } from "./ast.js";
import { MANAGED_PREAMBLE_RESOURCES } from "./generated-managed-preamble.js";
import type { LintFix } from "./linter.js";
import { documentTags } from "./tex-scan.js";

/** `deck init` が書くツール管理プリアンブルの開始行。 */
export const MANAGED_PREAMBLE_BEGIN =
  "% ---- ツール管理プリアンブル: 編集は macros / style / preamble-extra 領域へ ----";
/** ツール管理プリアンブルの終了行。 */
export const MANAGED_PREAMBLE_END = "% ---- ツール管理ここまで ----";

/**
 * `deck init` が書く現行のツール管理プリアンブル(開始行から終了行まで。末尾改行なし)。
 * 中身は packages/core/resources の 3 ファイルをこの順に展開したもの。
 */
export function managedPreambleBlock(): string {
  return [
    MANAGED_PREAMBLE_BEGIN,
    Object.values(MANAGED_PREAMBLE_RESOURCES).join("\n").trimEnd(),
    MANAGED_PREAMBLE_END,
  ].join("\n");
}

// 開始行は文言を問わない(fixture は `% ---- ツール管理プリアンブル ----`)。
const BEGIN_LINE = /^% ---- ツール管理プリアンブル[^\n]*$/gm;
const END_LINE = /^% ---- ツール管理ここまで ----[ \t]*(?=\r?$)/m;
// 行頭のものだけ(コメントの中の `%% macros:begin` では止まらない)。
const USER_REGION_BEGIN = /^%% (?:macros|style|preamble-extra):begin/gm;

/** ツール管理プリアンブルの位置、または範囲を特定できない理由(そのまま利用者に見せる文)。 */
export type ManagedPreambleLocation = { span: SourceSpan } | { problem: string };

/**
 * ソース上のツール管理プリアンブル(開始行の先頭から終了行の末尾まで。改行は含まない)を探す。
 * 終了印は、開始印より後ろで、最初のユーザー領域の印と `\begin{document}` より前だけで探す
 * (終了印が消えたデッキで、後ろへ貼り付けた終了印の行まで差し替えてユーザー領域を消さない)。
 * `preambleEnd` はプリアンブルの終わり(parse 済みなら渡すと全文の走査を省ける)。
 */
export function locateManagedPreamble(
  source: string,
  preambleEnd?: number,
): ManagedPreambleLocation {
  const end = preambleEnd ?? documentTags(source).begin;
  const preamble = end === -1 ? source : source.slice(0, end);
  const begins = [...preamble.matchAll(BEGIN_LINE)];
  const begin = begins[0];
  if (begin === undefined)
    return { problem: "開始印(「% ---- ツール管理プリアンブル」で始まる行)がありません" };
  if (begins.length > 1) return { problem: "開始印がプリアンブルに複数あります" };
  const contentStart = begin.index + begin[0].length;
  USER_REGION_BEGIN.lastIndex = contentStart;
  const limit = USER_REGION_BEGIN.exec(preamble)?.index ?? preamble.length;
  const endLine = END_LINE.exec(source.slice(contentStart, limit));
  if (endLine === null)
    return {
      problem: END_LINE.test(source.slice(contentStart))
        ? "終了印が最初のユーザー領域(%% macros / %% style / %% preamble-extra)か \\begin{document} より後ろにあります"
        : `終了印(「${MANAGED_PREAMBLE_END}」)がありません`,
    };
  return { span: { start: begin.index, end: contentStart + endLine.index + endLine[0].length } };
}

/** 範囲を特定できたときのツール管理プリアンブルの位置。できなければ null(理由は locateManagedPreamble)。 */
export function managedPreambleSpan(source: string, preambleEnd?: number): SourceSpan | null {
  const located = locateManagedPreamble(source, preambleEnd);
  return "span" in located ? located.span : null;
}

/** `span` のツール管理プリアンブルを `deck init` が書く現行の内容へ差し替える修正。 */
export function managedPreambleReplacement(source: string, span: SourceSpan): LintFix {
  const block = managedPreambleBlock();
  // CRLF のファイルは改行コードを揃える(管理領域だけ LF になるのを避ける)。
  const crlf = source.slice(span.start, span.end).includes("\r\n");
  return { span, replacement: crlf ? block.replaceAll("\n", "\r\n") : block };
}

/**
 * ツール管理プリアンブルを `deck init` が書く現行の内容へ差し替える修正。
 * `%% deck-source-version` 行とユーザー領域(印の外)には触らない。範囲を特定できない
 * (開始印・終了印が無い、終了印が最初のユーザー領域より後ろにある、開始印が複数ある)なら null。
 * すでに現行と一致していれば、置換しても変わらない修正を返す。
 */
export function managedPreambleUpdate(source: string, preambleEnd?: number): LintFix | null {
  const span = managedPreambleSpan(source, preambleEnd);
  return span === null ? null : managedPreambleReplacement(source, span);
}
