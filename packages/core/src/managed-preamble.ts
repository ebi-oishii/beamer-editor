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
const USER_REGION_BEGINS = ["%% macros:begin", "%% style:begin", "%% preamble-extra:begin"];

/**
 * ソース上のツール管理プリアンブル(開始行の先頭から終了行の末尾まで。改行は含まない)。
 * 終了印は、開始印より後ろで、最初のユーザー領域の印と `\begin{document}` より前だけで探す
 * (終了印が消えたデッキで、後ろへ貼り付けた終了印の行まで差し替えてユーザー領域を消さない)。
 * 印が欠けている・範囲内に終了印が無い・プリアンブルに開始印が 2 つ以上あるなら null。
 */
export function managedPreambleSpan(source: string): SourceSpan | null {
  const documentBegin = documentTags(source).begin;
  const preamble = documentBegin === -1 ? source : source.slice(0, documentBegin);
  const begins = [...preamble.matchAll(BEGIN_LINE)];
  const begin = begins[0];
  if (begin === undefined || begins.length > 1) return null;
  const contentStart = begin.index + begin[0].length;
  const limit = Math.min(
    preamble.length,
    ...USER_REGION_BEGINS.map((marker) => preamble.indexOf(marker, contentStart)).filter(
      (index) => index !== -1,
    ),
  );
  const end = END_LINE.exec(source.slice(contentStart, limit));
  if (end === null) return null;
  return { start: begin.index, end: contentStart + end.index + end[0].length };
}

/**
 * ツール管理プリアンブルを `deck init` が書く現行の内容へ差し替える修正。
 * `%% deck-source-version` 行とユーザー領域(印の外)には触らない。印が無ければ null。
 * すでに現行と一致していれば、置換しても変わらない修正を返す。
 */
export function managedPreambleUpdate(source: string): LintFix | null {
  const span = managedPreambleSpan(source);
  if (span === null) return null;
  const block = managedPreambleBlock();
  // CRLF のファイルは改行コードを揃える(管理領域だけ LF になるのを避ける)。
  const crlf = source.slice(span.start, span.end).includes("\r\n");
  return { span, replacement: crlf ? block.replaceAll("\n", "\r\n") : block };
}
