/**
 * ソース → プレビューの対応付け(#66)。ここは `vscode` API に依存しない純粋な計算のみ。
 *
 * - カーソル位置(元ソースの UTF-16 オフセット)を含むフレームの index を、最新のレンダリング結果
 *   から解く。deck 内の span は展開後座標なので ExpansionMap で元ソースへ戻して比較する
 *   (プレビュー → ソースの jump と同じ対応表を逆向きに使う)
 * - CodeLens「プレビューで表示」を置くフレーム先頭の位置を元ソースから列挙する
 */

import { framesOf, mapExpandedToSource, parseDeck } from "@beamer-editor/core";
import type { RenderOutcome } from "./document-controller";

/** offset を含むフレームの index。どのフレームにも属さなければ null。 */
export function frameIndexAtSourceOffset(outcome: RenderOutcome, offset: number): number | null {
  const { frames } = outcome.deck;
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    if (!frame) continue;
    const start = mapExpandedToSource(outcome.expansionMap, frame.sourceSpan.start);
    const end = mapExpandedToSource(outcome.expansionMap, frame.sourceSpan.end);
    if (offset >= start && offset < end) return index;
  }
  return null;
}

export interface FrameLensPosition {
  /** フレーム先頭(`\begin{frame}`)の元ソースオフセット。コマンドの引数にする。 */
  offset: number;
  /** CodeLens を置く行(0 始まり)。 */
  line: number;
}

/** managed 文書の各フレーム先頭。生フレームも含む(一覧・並べ替え可能な単位)。 */
export function frameLensPositions(
  text: string,
  positionAt: (offset: number) => { line: number },
): FrameLensPosition[] {
  return framesOf(parseDeck(text)).map((frame) => ({
    offset: frame.span.start,
    line: positionAt(frame.span.start).line,
  }));
}
