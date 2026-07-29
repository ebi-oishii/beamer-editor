/**
 * 対象文書の全文を expand → parse → render して Webview へ送れる形に整える
 * (移植計画 VS-3 手順 1)。`vscode` API には依存せず、PreviewController から使う。
 */

import { type ExpandDiagnostic, type ExpansionMap, expandDeck } from "@beamer-editor/core";
import { type RenderedDeck, renderDeck } from "@beamer-editor/renderer";

export interface RenderOutcome {
  deck: RenderedDeck;
  /** レンダリングした時点の TextDocument.version。 */
  version: number;
  /**
   * 展開後ソース → 元ソースの対応。deck 内の sourceSpan は展開後座標なので、
   * 元ソースの位置が要る場面(VS-4 のソースジャンプ)は mapExpandedToSource で戻す。
   */
  expansionMap: ExpansionMap;
  /** マクロ展開の診断(展開不能・引数不足など)。VS-5 で Diagnostics へ流す。 */
  expandDiagnostics: ExpandDiagnostic[];
}

/** 全文をマクロ展開し、展開後 AST を HTML デッキへレンダリングする。 */
export function renderDocument(text: string, version: number): RenderOutcome {
  const expanded = expandDeck(text);
  return {
    deck: renderDeck(expanded.doc),
    version,
    expansionMap: expanded.map,
    expandDiagnostics: expanded.diagnostics,
  };
}
