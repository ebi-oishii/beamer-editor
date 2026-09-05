/**
 * 生ブロックの部分コンパイル(#81)で使う、環境非依存の補助。
 * - 生ブロックを standalone 文書にするときに前置する定義(preamble-extra とマクロ定義)
 * - 画像キャッシュのキー(ブロック本文 + 前置する定義のハッシュ。定義が変わると古い画像が残らない。design.md §4.5)
 */

import type { DeckDocument } from "./ast.js";

/** standalone 文書の前置き: preamble-extra 全文と、マクロ領域の各定義(解釈できなかった定義も原文のまま)。 */
export function fragmentPreambleOf(doc: DeckDocument): string {
  const macros = doc.macros.entries.map((entry) => entry.tex.trim()).filter((tex) => tex !== "");
  return [doc.preambleExtra.tex.trim(), ...macros].filter((tex) => tex !== "").join("\n");
}

/** FNV-1a(32 bit)。暗号用途ではなくキャッシュキー。 */
function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 生ブロックの画像キャッシュのキー(16 桁の hex)。本文の改行コードの違いは同じキーにする。
 * 本文だけのハッシュと、前置き + 本文のハッシュを並べて 64 bit 相当にする。
 */
export function rawFragmentKey(tex: string, preamble: string): string {
  const body = tex.replace(/\r\n/g, "\n").trim();
  const head = preamble.replace(/\r\n/g, "\n").trim();
  return `${fnv1a(body, 0x811c9dc5)}${fnv1a(`${head}\u0000${body}`, 0x01000193)}`;
}
