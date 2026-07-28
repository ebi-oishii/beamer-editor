export interface SourceJumpTarget {
  selectionStart: number;
  selectionEnd: number;
  scrollTop: number;
}

function lineStartAt(value: string, position: number): number {
  if (position === 0) return 0;
  return value.lastIndexOf("\n", position - 1) + 1;
}

/**
 * ソース位置を含む行の選択範囲と、その行を中央表示するスクロール位置を返す。
 * textarea 固有のDOM操作から分離し、将来のVS Code Selection/Revealにも流用できる値にする。
 */
export function sourceJumpTarget(
  value: string,
  position: number,
  lineHeight: number,
  viewportHeight: number,
): SourceJumpTarget {
  const safePosition = Math.max(0, Math.min(position, value.length));
  const selectionStart = lineStartAt(value, safePosition);
  const lineBreak = value.indexOf("\n", safePosition);
  const selectionEnd = lineBreak === -1 ? value.length : lineBreak;
  const lineIndex = value.slice(0, selectionStart).split("\n").length - 1;
  const centeredTop = lineIndex * lineHeight - (viewportHeight - lineHeight) / 2;

  return {
    selectionStart,
    selectionEnd,
    scrollTop: Math.max(0, centeredTop),
  };
}
