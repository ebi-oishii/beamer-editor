/**
 * フロー配置の要素(段落・リスト・画像)を同じフレームの deckcanvas へ移す
 * 「自由配置にする」のソース変換(design.md §4.6、subset-spec §2.8)。
 *
 * formatter と同じく source span ベースの局所置換で行い、触れていない箇所の原文
 * (コメント・空行・インデント)は保つ。対象ブロックの原文を行単位で取り除き、
 * フレーム末尾の deckcanvas(無ければ新設)へ decktext / deckimage として入れる。
 * 取り出した要素の位置は呼び出し側(プレビュー上の表示位置)が決める。
 */

import type { BlockNode, CanvasNode, FrameNode, ListNode, SourceSpan } from "./ast.js";
import { formatCanvasCoordinate } from "./canvas-edit.js";
import { parseDeck } from "./parser.js";

/** 本文領域に対する正規化座標(0〜1)での箱の位置と幅。高さは内容から自動。 */
export interface CanvasPlacement {
  x: number;
  y: number;
  width: number;
}

/** 元ソースの span をこのテキストで置き換える、という結果。 */
export interface SourceReplacement {
  span: SourceSpan;
  text: string;
}

/** 箱の最小幅(正規化値)。極端に細い箱を作らない。 */
const MIN_WIDTH = 0.05;

/** decktext 内のリストは 1 段までネスト可、項目のオーバーレイは不可(L014 と同じ条件)。 */
function listFitsDecktext(list: ListNode, depth: number): boolean {
  return list.items.every(
    (item) =>
      item.overlay === null &&
      item.children.every((child) => {
        if (child.type === "paragraph") return true;
        if (child.type === "list") return depth < 1 && listFitsDecktext(child, depth + 1);
        return false;
      }),
  );
}

/** 自由配置へ移せるブロックか(decktext / deckimage に収まる種類・構造か)。 */
export function isDetachableBlock(block: BlockNode): boolean {
  switch (block.type) {
    case "paragraph":
    case "image":
      return true;
    case "list":
      return listFitsDecktext(block, 0);
    default:
      return false;
  }
}

/**
 * フレーム本文のブロックを深さ優先で列挙する。リスト項目直下の段落は項目の本文そのもの
 * なので対象にしない(取り出すと空の \item が残る)。canvas の中身は対象外。
 */
function* walkBlocks(blocks: BlockNode[]): Generator<BlockNode> {
  for (const block of blocks) {
    yield block;
    switch (block.type) {
      case "columns":
        for (const column of block.columns) yield* walkBlocks(column.children);
        break;
      case "blockEnv":
      case "center":
        yield* walkBlocks(block.children);
        break;
      case "list":
        for (const item of block.items) {
          yield* walkBlocks(item.children.filter((child) => child.type !== "paragraph"));
        }
        break;
      default:
        break;
    }
  }
}

function clampPlacement(placement: CanvasPlacement): CanvasPlacement {
  const x = Math.min(Math.max(placement.x, 0), 1 - MIN_WIDTH);
  const y = Math.min(Math.max(placement.y, 0), 1);
  const width = Math.min(Math.max(placement.width, MIN_WIDTH), 1 - x);
  return { x, y, width };
}

function lineStart(source: string, offset: number): number {
  return source.lastIndexOf("\n", offset - 1) + 1;
}

function lineEnd(source: string, offset: number): number {
  const index = source.indexOf("\n", offset);
  return index === -1 ? source.length : index;
}

function isBlank(text: string): boolean {
  return /^[ \t]*$/.test(text);
}

/** 段落の span は次の環境の直前まで(改行・字下げ込み)伸びることがあるので、末尾の空白を落とす。 */
function trimmedSpan(source: string, span: SourceSpan): SourceSpan {
  let end = span.end;
  while (end > span.start && /\s/.test(source[end - 1] as string)) end--;
  return { start: span.start, end };
}

/** 複数行の原文を、先頭行の位置に合わせて indent で揃え直す。 */
function reindent(text: string, indent: string): string {
  const lines = text.split("\n");
  const rest = lines.slice(1).filter((line) => line.trim() !== "");
  const common =
    rest.length === 0 ? 0 : Math.min(...rest.map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0));
  return lines
    .map((line, index) => {
      if (line.trim() === "") return "";
      const body = index === 0 ? line.trimStart() : line.slice(common);
      return `${indent}${body}`;
    })
    .join("\n");
}

function buildObject(
  source: string,
  block: BlockNode,
  placement: CanvasPlacement,
  indent: string,
): string {
  const f = formatCanvasCoordinate;
  const position = `x=${f(placement.x)},y=${f(placement.y)},w=${f(placement.width)}`;
  if (block.type === "image") return `${indent}\\deckimage[${position}]{${block.path}}`;
  const span = trimmedSpan(source, block.span);
  const content = reindent(source.slice(span.start, span.end), `${indent}  `);
  return `${indent}\\begin{decktext}[${position},size=normal]\n${content}\n${indent}\\end{decktext}`;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function rewriteFrame(
  source: string,
  frame: FrameNode,
  block: BlockNode,
  canvas: CanvasNode | null,
  placement: CanvasPlacement,
): SourceReplacement {
  const edits: Edit[] = [];

  // 1. 対象ブロックの原文を取り除く。行を占有していれば改行ごと消す。
  const span = trimmedSpan(source, block.span);
  const blockLineStart = lineStart(source, span.start);
  const blockLineEnd = lineEnd(source, span.end);
  const ownsLineStart = isBlank(source.slice(blockLineStart, span.start));
  const ownsLineEnd = isBlank(source.slice(span.end, blockLineEnd));
  edits.push({
    start: ownsLineStart ? blockLineStart : span.start,
    end: ownsLineStart && ownsLineEnd ? Math.min(blockLineEnd + 1, source.length) : span.end,
    text: "",
  });

  // 2. deckcanvas へ入れる。既存があれば \end{deckcanvas} の直前、無ければ \end{frame} の直前に新設。
  if (canvas) {
    const endIndex = source.lastIndexOf("\\end{deckcanvas}", canvas.span.end);
    const endLineStart = lineStart(source, endIndex);
    if (isBlank(source.slice(endLineStart, endIndex))) {
      const canvasIndent = source.slice(endLineStart, endIndex);
      const object = buildObject(source, block, placement, `${canvasIndent}  `);
      edits.push({ start: endLineStart, end: endLineStart, text: `${object}\n` });
    } else {
      const object = buildObject(source, block, placement, "    ");
      edits.push({ start: endIndex, end: endIndex, text: `\n${object}\n  ` });
    }
  } else {
    const endIndex = source.lastIndexOf("\\end{frame}", frame.span.end);
    const endLineStart = lineStart(source, endIndex);
    const ownsLine = isBlank(source.slice(endLineStart, endIndex));
    const frameIndent = ownsLine ? source.slice(endLineStart, endIndex) : "";
    const bodyIndent = `${frameIndent}  `;
    const object = buildObject(source, block, placement, `${bodyIndent}  `);
    const text = `${bodyIndent}\\begin{deckcanvas}\n${object}\n${bodyIndent}\\end{deckcanvas}\n`;
    if (ownsLine) edits.push({ start: endLineStart, end: endLineStart, text });
    else edits.push({ start: endIndex, end: endIndex, text: `\n${text}` });
  }

  // 3. フレーム範囲内で後ろから適用し、フレーム全体の置換として返す(1 操作 = 1 undo)。
  const base = frame.span.start;
  let text = source.slice(frame.span.start, frame.span.end);
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    text = `${text.slice(0, edit.start - base)}${edit.text}${text.slice(edit.end - base)}`;
  }
  return { span: frame.span, text };
}

/**
 * blockSpan(元ソース上の範囲)が指すフロー要素を deckcanvas へ移す。
 * 対象が見つからない・移せない種類・deckcanvas が 2 つ以上あるフレームでは null。
 */
export function detachBlockToCanvas(
  source: string,
  blockSpan: SourceSpan,
  placement: CanvasPlacement,
): SourceReplacement | null {
  if (![placement.x, placement.y, placement.width].every((v) => Number.isFinite(v))) return null;
  const doc = parseDeck(source);
  for (const element of doc.body) {
    if (element.type !== "frame") continue;
    if (blockSpan.start < element.span.start || blockSpan.end > element.span.end) continue;
    let target: BlockNode | undefined;
    for (const block of walkBlocks(element.body)) {
      if (block.span.start === blockSpan.start && block.span.end === blockSpan.end) {
        target = block;
        break;
      }
    }
    if (!target || !isDetachableBlock(target)) return null;
    const canvases = element.body.filter((block): block is CanvasNode => block.type === "canvas");
    if (canvases.length > 1) return null;
    return rewriteFrame(source, element, target, canvases[0] ?? null, clampPlacement(placement));
  }
  return null;
}
