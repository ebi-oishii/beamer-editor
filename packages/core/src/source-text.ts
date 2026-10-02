/**
 * ソース原文を行単位で扱う小さな補助。span ベースの局所置換(自由配置・削除・貼り付け)が
 * 触れていない箇所の原文(コメント・空行・インデント・改行コード)を保つために共有する。
 * 公開 API ではない(index.ts から export しない)。
 */

import type { SourceSpan } from "./ast.js";

export function lineStart(source: string, offset: number): number {
  return source.lastIndexOf("\n", offset - 1) + 1;
}

export function lineEnd(source: string, offset: number): number {
  const index = source.indexOf("\n", offset);
  return index === -1 ? source.length : index;
}

/** 行内の空白判定。CRLF 文書では行末の CR も空白として扱う。 */
export function isBlank(text: string): boolean {
  return /^[ \t\r]*$/.test(text);
}

/** 文書の改行コード。生成・再インデント・行削除をこれに揃える(混在文書は最初に見つかった方)。 */
export function detectEol(source: string): string {
  const index = source.indexOf("\n");
  return index > 0 && source[index - 1] === "\r" ? "\r\n" : "\n";
}

/** 段落の span は次の環境の直前まで(改行・字下げ込み)伸びることがあるので、末尾の空白を落とす。 */
export function trimmedSpan(source: string, span: SourceSpan): SourceSpan {
  let end = span.end;
  while (end > span.start && /\s/.test(source[end - 1] as string)) end--;
  return { start: span.start, end };
}

/** 複数行の原文を、先頭行の位置に合わせて indent で揃え直す。改行は eol に統一する。 */
export function reindent(text: string, indent: string, eol: string): string {
  const lines = text.split(/\r?\n/);
  const rest = lines.slice(1).filter((line) => line.trim() !== "");
  const common =
    rest.length === 0 ? 0 : Math.min(...rest.map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0));
  return lines
    .map((line, index) => {
      if (line.trim() === "") return "";
      const body = index === 0 ? line.trimStart() : line.slice(common);
      return `${indent}${body}`;
    })
    .join(eol);
}
