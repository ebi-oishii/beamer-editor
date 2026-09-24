/**
 * フレーム 1 つの範囲内で行う deckcanvas まわりの編集の共通部(自由配置・貼り付け)。
 * 編集はフレーム範囲内の位置指定の差し込みとして集め、最後にフレーム全体の置換 1 つへ畳む
 * (1 操作 = 1 差分 = 1 undo)。公開 API ではない(index.ts から export しない)。
 */

import {
  type CanvasNode,
  type DeckDocument,
  type FrameNode,
  frameLabel,
  framesOf,
  type SourceSpan,
} from "./ast.js";
import { isBlank, lineStart } from "./source-text.js";

/** 元ソースの span をこのテキストで置き換える、という結果。 */
export interface SourceReplacement {
  span: SourceSpan;
  text: string;
}

export interface Edit {
  start: number;
  end: number;
  text: string;
}

const BEGIN_FRAME = "\\begin{frame}";

/** キャンバスフレームへ自動で付ける label の接頭辞(L011 の「一意な label」)。 */
const CANVAS_LABEL_PREFIX = "canvas";

/**
 * 文書内で未使用の `canvas-N` を返す。ラベルは永続アドレス(ai-protocol §3)なので
 * フレーム位置ではなく空き番号で決め、あとから並べ替えても意味が変わらないようにする。
 */
export function nextCanvasLabel(doc: DeckDocument): string {
  const used = new Set(framesOf(doc).map(frameLabel));
  for (let n = 1; ; n++) {
    const candidate = `${CANVAS_LABEL_PREFIX}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * frame へ `label=` を足す編集。options が無ければ `[label=...]` を新設し、
 * あれば既知 option を既定順に組み直す。空の label は置換し、空 option や末尾カンマも正規化する。
 */
export function addLabelEdit(frame: FrameNode, label: string): Edit {
  const options = frame.options.span;
  if (options === null) {
    const at = frame.span.start + BEGIN_FRAME.length;
    return { start: at, end: at, text: `[label=${label}]` };
  }
  const normalized = [
    frame.options.fragile ? "fragile" : null,
    frame.options.plain ? "plain" : null,
    frame.options.allowframebreaks ? "allowframebreaks" : null,
    `label=${label}`,
  ].filter((option): option is string => option !== null);
  return { start: options.start, end: options.end, text: `[${normalized.join(",")}]` };
}

/**
 * オブジェクトを deckcanvas へ入れる編集。既存があれば `\end{deckcanvas}` の直前、無ければ
 * `\end{frame}` の直前に新設する。build は与えたインデントで整形したオブジェクト原文を返す。
 */
export function insertIntoCanvasEdits(
  source: string,
  frame: FrameNode,
  canvas: CanvasNode | null,
  build: (indent: string) => string,
  eol: string,
): Edit[] {
  if (canvas) {
    const endIndex = source.lastIndexOf("\\end{deckcanvas}", canvas.span.end);
    const endLineStart = lineStart(source, endIndex);
    if (isBlank(source.slice(endLineStart, endIndex))) {
      const canvasIndent = source.slice(endLineStart, endIndex);
      return [
        { start: endLineStart, end: endLineStart, text: `${build(`${canvasIndent}  `)}${eol}` },
      ];
    }
    return [{ start: endIndex, end: endIndex, text: `${eol}${build("    ")}${eol}  ` }];
  }
  const endIndex = source.lastIndexOf("\\end{frame}", frame.span.end);
  const endLineStart = lineStart(source, endIndex);
  const ownsLine = isBlank(source.slice(endLineStart, endIndex));
  const frameIndent = ownsLine ? source.slice(endLineStart, endIndex) : "";
  const bodyIndent = `${frameIndent}  `;
  const text = `${bodyIndent}\\begin{deckcanvas}${eol}${build(`${bodyIndent}  `)}${eol}${bodyIndent}\\end{deckcanvas}${eol}`;
  return ownsLine
    ? [{ start: endLineStart, end: endLineStart, text }]
    : [{ start: endIndex, end: endIndex, text: `${eol}${text}` }];
}

/** フレーム範囲内の編集を後ろから適用し、フレーム全体の置換として返す(1 操作 = 1 undo)。 */
export function applyFrameEdits(
  source: string,
  frame: FrameNode,
  edits: Edit[],
): SourceReplacement {
  const base = frame.span.start;
  let text = source.slice(frame.span.start, frame.span.end);
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    text = `${text.slice(0, edit.start - base)}${edit.text}${text.slice(edit.end - base)}`;
  }
  return { span: frame.span, text };
}
