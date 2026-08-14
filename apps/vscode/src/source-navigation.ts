/**
 * プレビューのフレームから元ソースのジャンプ先を解決する(移植計画 VS-4)。
 * ここは純粋な計算のみで `vscode` API に依存しない。エディタ操作
 * (showTextDocument / Selection / revealRange / 行フラッシュ)は extension.ts が担う。
 */

import { mapExpandedToSource } from "@beamer-editor/core";
import type { RenderOutcome } from "./document-controller";

/** `vscode.Uri` と同じく文字列表現で同一性を比較できる URI。 */
export interface StringifiableUri {
  toString(): string;
}

/** 表示中エディタからジャンプ先の列を選ぶために必要な最小情報。 */
export interface VisibleSourceEditor<TViewColumn = number> {
  documentUri: StringifiableUri;
  viewColumn: TViewColumn | undefined;
}

/**
 * ソースへ戻る列を解決する。現在表示中の同一 URI のエディタを優先し、
 * 見つからない場合だけプレビューを開いた時点の列へ戻す。
 */
export function resolveSourceViewColumn<TViewColumn>(
  targetUri: StringifiableUri,
  visibleEditors: readonly VisibleSourceEditor<TViewColumn>[],
  fallbackViewColumn: TViewColumn | undefined,
): TViewColumn | undefined {
  const targetUriString = targetUri.toString();
  return (
    visibleEditors.find((editor) => editor.documentUri.toString() === targetUriString)
      ?.viewColumn ?? fallbackViewColumn
  );
}

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
