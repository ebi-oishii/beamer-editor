/**
 * 対象文書の全文を expand → parse → render して Webview へ送れる形に整える
 * (移植計画 VS-3 手順 1)。`vscode` API には依存せず、PreviewController から使う。
 */

import {
  type DeckDocument,
  type ExpandDiagnostic,
  type ExpansionMap,
  expandDeck,
  mapExpandedRangeToSourceExact,
  type PreviewStyle,
} from "@beamer-editor/core";
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

export interface RenderDocumentOptions {
  /**
   * テンプレート(.sty)や preamble-extra から抽出する土台スタイル(#70)。ファイル解決は
   * ホストの仕事なので関数で受け取る。未指定なら `%% style` 領域だけで描く。
   */
  baseStyle?: (doc: DeckDocument) => PreviewStyle | undefined;
}

/** 全文をマクロ展開し、展開後 AST を HTML デッキへレンダリングする。 */
export function renderDocument(
  text: string,
  version: number,
  options: RenderDocumentOptions = {},
): RenderOutcome {
  const expanded = expandDeck(text);
  const baseStyle = options.baseStyle?.(expanded.doc);
  const rendered = renderDeck(expanded.doc, undefined, baseStyle ? { baseStyle } : {});
  return {
    deck: {
      ...rendered,
      frames: rendered.frames.map((frame) => ({
        ...frame,
        canvasElements: (frame.canvasElements ?? []).map((element) => {
          const sourceSpan = mapExpandedRangeToSourceExact(expanded.map, element.sourceSpan);
          return sourceSpan === null ? element : { ...element, sourceSpan, editable: true };
        }),
      })),
    },
    version,
    expansionMap: expanded.map,
    expandDiagnostics: expanded.diagnostics,
  };
}
