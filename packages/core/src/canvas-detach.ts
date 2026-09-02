/**
 * フロー配置の要素(段落・リスト・画像)を同じフレームの deckcanvas へ移す
 * 「自由配置にする」のソース変換(design.md §4.6、subset-spec §2.8)。
 *
 * formatter と同じく source span ベースの局所置換で行い、触れていない箇所の原文
 * (コメント・空行・インデント)は保つ。対象ブロックの原文を行単位で取り除き、
 * フレーム末尾の deckcanvas(無ければ新設)へ decktext / deckimage として入れる。
 * 取り出した要素の位置は呼び出し側(プレビュー上の表示位置)が決める。
 */

import type {
  BlockNode,
  CanvasNode,
  FrameNode,
  ListItemNode,
  ListNode,
  SourceSpan,
} from "./ast.js";
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
 * リスト項目の子のうち、取り出してよいもの。項目直下の段落は項目の本文そのものなので不可。
 * 画像や入れ子リストも、それが項目の唯一の内容なら不可(取り出すと空の \item と記号が残る)。
 * renderer の候補属性も同じ規則で付ける。
 */
export function isDetachableListItemChild(item: ListItemNode, child: BlockNode): boolean {
  return child.type !== "paragraph" && item.children.length > 1;
}

/** ブロックの子孫を深さ優先で列挙する(自身は含まない)。canvas の中身は対象外。 */
function* walkChildren(block: BlockNode): Generator<BlockNode> {
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
        for (const child of item.children) {
          if (isDetachableListItemChild(item, child)) yield child;
          yield* walkChildren(child);
        }
      }
      break;
    default:
      break;
  }
}

/** フレーム本文のブロックを深さ優先で列挙する。 */
function* walkBlocks(blocks: BlockNode[]): Generator<BlockNode> {
  for (const block of blocks) {
    yield block;
    yield* walkChildren(block);
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

/** 行内の空白判定。CRLF 文書では行末の CR も空白として扱う。 */
function isBlank(text: string): boolean {
  return /^[ \t\r]*$/.test(text);
}

/** 文書の改行コード。生成・再インデント・行削除をこれに揃える(混在文書は最初に見つかった方)。 */
function detectEol(source: string): string {
  const index = source.indexOf("\n");
  return index > 0 && source[index - 1] === "\r" ? "\r\n" : "\n";
}

/** 段落の span は次の環境の直前まで(改行・字下げ込み)伸びることがあるので、末尾の空白を落とす。 */
function trimmedSpan(source: string, span: SourceSpan): SourceSpan {
  let end = span.end;
  while (end > span.start && /\s/.test(source[end - 1] as string)) end--;
  return { start: span.start, end };
}

/** 複数行の原文を、先頭行の位置に合わせて indent で揃え直す。改行は eol に統一する。 */
function reindent(text: string, indent: string, eol: string): string {
  const lines = text.split(/\r?\n/);
  const rest = lines.slice(1).filter((line) => line.trim() !== "");
  const common =
    rest.length === 0 ? 0 : Math.min(...rest.map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0));
  return lines
    .map((line, index) => {
      if (line.trim() === "") return "";
      const body = index === 0 ? line.trimStart() : line.slice(common);
      return `${indent}${body}`;
    })
    .join(eol);
}

function buildObject(
  source: string,
  block: BlockNode,
  placement: CanvasPlacement,
  indent: string,
  eol: string,
): string {
  const f = formatCanvasCoordinate;
  const position = `x=${f(placement.x)},y=${f(placement.y)},w=${f(placement.width)}`;
  if (block.type === "image") return `${indent}\\deckimage[${position}]{${block.path}}`;
  const span = trimmedSpan(source, block.span);
  const content = reindent(source.slice(span.start, span.end), `${indent}  `, eol);
  return `${indent}\\begin{decktext}[${position},size=normal]${eol}${content}${eol}${indent}\\end{decktext}`;
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
  const eol = detectEol(source);

  // 1. 対象ブロックの原文を取り除く。行を占有していれば改行ごと消す。
  const span = trimmedSpan(source, block.span);
  const blockLineStart = lineStart(source, span.start);
  const blockLineEnd = lineEnd(source, span.end);
  const ownsLineStart = isBlank(source.slice(blockLineStart, span.start));
  const ownsLineEnd = isBlank(source.slice(span.end, blockLineEnd));
  // 行末に居る場合は直前の空白も消し、`\item text ` のような末尾空白を残さない。
  let removeStart = ownsLineStart ? blockLineStart : span.start;
  if (!ownsLineStart && ownsLineEnd) {
    while (removeStart > blockLineStart && /[ \t]/.test(source[removeStart - 1] as string))
      removeStart--;
  }
  edits.push({
    start: removeStart,
    end: ownsLineStart && ownsLineEnd ? Math.min(blockLineEnd + 1, source.length) : span.end,
    text: "",
  });

  // 2. deckcanvas へ入れる。既存があれば \end{deckcanvas} の直前、無ければ \end{frame} の直前に新設。
  if (canvas) {
    const endIndex = source.lastIndexOf("\\end{deckcanvas}", canvas.span.end);
    const endLineStart = lineStart(source, endIndex);
    if (isBlank(source.slice(endLineStart, endIndex))) {
      const canvasIndent = source.slice(endLineStart, endIndex);
      const object = buildObject(source, block, placement, `${canvasIndent}  `, eol);
      edits.push({ start: endLineStart, end: endLineStart, text: `${object}${eol}` });
    } else {
      const object = buildObject(source, block, placement, "    ", eol);
      edits.push({ start: endIndex, end: endIndex, text: `${eol}${object}${eol}  ` });
    }
  } else {
    const endIndex = source.lastIndexOf("\\end{frame}", frame.span.end);
    const endLineStart = lineStart(source, endIndex);
    const ownsLine = isBlank(source.slice(endLineStart, endIndex));
    const frameIndent = ownsLine ? source.slice(endLineStart, endIndex) : "";
    const bodyIndent = `${frameIndent}  `;
    const object = buildObject(source, block, placement, `${bodyIndent}  `, eol);
    const text = `${bodyIndent}\\begin{deckcanvas}${eol}${object}${eol}${bodyIndent}\\end{deckcanvas}${eol}`;
    if (ownsLine) edits.push({ start: endLineStart, end: endLineStart, text });
    else edits.push({ start: endIndex, end: endIndex, text: `${eol}${text}` });
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
