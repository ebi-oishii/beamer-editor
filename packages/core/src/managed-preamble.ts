import type { SourceSpan } from "./ast.js";
import { MANAGED_PREAMBLE_RESOURCES } from "./generated-managed-preamble.js";
import type { LintFix } from "./linter.js";
import { documentTags } from "./tex-scan.js";
import { USER_REGION_NAMES } from "./user-regions.js";

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

/** ツール管理プリアンブルの位置、または範囲を特定できない理由(そのまま利用者に見せる文)。 */
export type ManagedPreambleLocation = { span: SourceSpan } | { problem: string };

/**
 * ソース上のツール管理プリアンブル(開始行の先頭から終了行の末尾まで。改行は含まない)を探す。
 * 終了印は、開始印より後ろで、最初のユーザー領域の印と `\begin{document}` より前だけで探す
 * (終了印が消えたデッキで、後ろへ貼り付けた終了印の行まで差し替えてユーザー領域を消さない)。
 * ユーザー領域の開始印は、開始印より後ろで最初に出てくる文字列で判定する(行頭か・コメントの中か・
 * 終了印があるかは問わない)。parser の region() はファイル全体で最初の、終了印もそろった印だけを
 * 領域と認めるので、それより手前で止まることがあるが、そのときは書き換えずに拒否する側に倒れる。
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
  // 上限は、開始印より後ろで最初に出てくるユーザー領域の開始印の文字列(行頭か・終了印があるかは
  // 問わない)と \begin{document} の手前のほう。parser の region() より手前で止まりうるが、迷ったら
  // 書き換えずに拒否する側に倒す(後ろへ貼り付けた終了印まで差し替えてユーザー領域を消さない)。
  const limit = Math.min(
    preamble.length,
    ...USER_REGION_NAMES.map((name) => preamble.indexOf(`%% ${name}:begin`, contentStart)).filter(
      (index) => index !== -1,
    ),
  );
  const endLine = END_LINE.exec(source.slice(contentStart, limit));
  if (endLine === null)
    return {
      problem: END_LINE.test(source.slice(contentStart))
        ? "終了印が最初のユーザー領域(%% macros / %% style / %% preamble-extra)か \\begin{document} より後ろにあります"
        : END_LINE.test(source.slice(0, begin.index))
          ? "終了印が開始印より前にあります"
          : `終了印(「${MANAGED_PREAMBLE_END}」)がありません`,
    };
  return { span: { start: begin.index, end: contentStart + endLine.index + endLine[0].length } };
}

/**
 * `span`(locateManagedPreamble の結果)のツール管理プリアンブルを、`deck init` が書く現行の内容へ
 * 差し替える修正(`--update-preamble` と L025 の fix)。`%% deck-source-version` 行とユーザー領域
 * (印の外)には触らない。すでに現行と一致していれば、置換しても変わらない修正を返す。
 */
export function managedPreambleReplacement(source: string, span: SourceSpan): LintFix {
  const block = managedPreambleBlock();
  // CRLF のファイルは改行コードを揃える(管理領域だけ LF になるのを避ける)。
  const crlf = source.slice(span.start, span.end).includes("\r\n");
  return { span, replacement: crlf ? block.replaceAll("\n", "\r\n") : block };
}
