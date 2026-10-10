/**
 * source tab を閉じて開き直したときのプレビューの配置復元(#155)。
 * ここは列番号の計算だけで `vscode` API に依存しない。tab group の読み取りと
 * パネルの移動・空グループの片付けは extension.ts が担う。
 */

/** プレビューから見た source の側。同じグループ・左右混在・列不明は undefined。 */
export type SourceSide = "left" | "right";

/** source tab の列がすべてプレビューの左(右)にあれば "left"("right")。それ以外は判定しない。 */
export function sourceSideOfPreview(
  previewColumn: number | undefined,
  sourceColumns: readonly number[],
): SourceSide | undefined {
  if (previewColumn === undefined || sourceColumns.length === 0) return undefined;
  if (sourceColumns.every((column) => column < previewColumn)) return "left";
  if (sourceColumns.every((column) => column > previewColumn)) return "right";
  return undefined;
}

/**
 * 開き直した source に対して、プレビューを移す列を返す(移さないなら undefined)。
 * 復元するのは既定の「source が左・プレビューが右」(プレビューは ViewColumn.Beside で開く)だけ。
 * source が同じグループか右側に開いたら、source の最も右の列の 1 つ右へプレビューを移す。
 * "right" は VS Code が入れ替わった配置に開くとそのまま一致し、左側にグループを作ってまでは戻さない。
 */
export function planPreviewLayoutRestore(input: {
  previewColumn: number | undefined;
  sourceColumns: readonly number[];
  sourceSide: SourceSide;
}): number | undefined {
  const { previewColumn, sourceColumns, sourceSide } = input;
  if (sourceSide !== "left" || previewColumn === undefined || sourceColumns.length === 0)
    return undefined;
  if (sourceColumns.some((column) => column < previewColumn)) return undefined;
  return Math.max(...sourceColumns) + 1;
}
