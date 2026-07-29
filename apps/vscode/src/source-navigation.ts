/**
 * プレビューのフレームから元ソースのジャンプ先を解決する(移植計画 VS-4)。
 * ここは純粋な計算のみで `vscode` API に依存しない。エディタ操作
 * (showTextDocument / Selection / revealRange / 行フラッシュ)は extension.ts が担う。
 */

import { mapExpandedToSource } from "@beamer-editor/core";
import type { RenderOutcome } from "./document-controller";

/**
 * frameIndex から元ソースの UTF-16 オフセットを解決する。フレームが無ければ null。
 * deck 内の sourceSpan は展開後座標なので ExpansionMap で元ソースへ戻す
 * (マクロ本体由来の位置は呼び出しサイト先頭へ丸められる)。
 */
export function resolveJumpOffset(outcome: RenderOutcome, frameIndex: number): number | null {
  const frame = outcome.deck.frames[frameIndex];
  if (!frame) return null;
  return mapExpandedToSource(outcome.expansionMap, frame.sourceSpan.start);
}
