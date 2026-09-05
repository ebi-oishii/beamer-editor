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

/** \\pause の数を文書順に数える。stopAt に到達したらそこで止める(canvas の中は見ない)。 */
function countPauses(blocks: BlockNode[], stopAt?: BlockNode): { count: number; stopped: boolean } {
  let count = 0;
  const visit = (list: BlockNode[]): boolean => {
    for (const block of list) {
      if (block === stopAt) return true;
      switch (block.type) {
        case "pause":
          count++;
          break;
        case "columns":
          for (const column of block.columns) if (visit(column.children)) return true;
          break;
        case "blockEnv":
        case "center":
          if (visit(block.children)) return true;
          break;
        case "list":
          for (const item of block.items) if (visit(item.children)) return true;
          break;
        default:
          break;
      }
    }
    return false;
  };
  const stopped = visit(blocks);
  return { count, stopped };
}

interface WalkContext {
  /** overlay 指定を持つ block / \\item の中。 */
  overlay: boolean;
  /** center の中。 */
  center: boolean;
  /** リスト項目の直接の子。 */
  itemChild: boolean;
  /** その項目に、候補以外にも描画される内容(\\pause を除く)があるか。 */
  itemHasOther: boolean;
}

/**
 * フレーム内で「自由配置にする」候補になれるブロックの集合。renderer の候補属性と core の
 * 適用判定はこの同じ集合を使う。次のものは候補にしない:
 * - decktext / deckimage に収まらない種類・構造(isDetachableBlock)
 * - リスト項目直下の段落と、項目の唯一の描画内容(\\pause は数えない)。取り出すと空の \\item が残る
 * - center の中(中央寄せが失われ、表示位置も文字列の左端にならない)
 * - overlay 指定を持つ block / \\item の中(canvas オブジェクトは overlay 非対応で、移すと step 1 から見える)
 * - \\pause との前後関係が移動先(既存の deckcanvas、無ければフレーム末尾)と異なるもの(表示開始 step が変わる)
 * deckcanvas の中身は対象外。deckcanvas が 2 つ以上あるフレームでは空。
 */
export function detachableBlocksOf(frame: FrameNode): Set<BlockNode> {
  const result = new Set<BlockNode>();
  const canvases = frame.body.filter((block): block is CanvasNode => block.type === "canvas");
  if (canvases.length > 1) return result;
  const canvas = canvases[0];
  // 移動先が見え始める step の手前にある \\pause の数。候補も同じ数でなければ表示条件が変わる。
  const targetPauses = countPauses(frame.body, canvas).count;
  let pauses = 0;
  const visit = (blocks: BlockNode[], ctx: WalkContext): void => {
    for (const block of blocks) {
      if (block.type === "pause") {
        pauses++;
        continue;
      }
      const eligible =
        isDetachableBlock(block) &&
        !ctx.overlay &&
        !ctx.center &&
        pauses === targetPauses &&
        (!ctx.itemChild || (block.type !== "paragraph" && ctx.itemHasOther));
      if (eligible) result.add(block);
      switch (block.type) {
        case "columns":
          for (const column of block.columns) visit(column.children, { ...ctx, itemChild: false });
          break;
        case "blockEnv":
          visit(block.children, {
            ...ctx,
            overlay: ctx.overlay || block.overlay !== null,
            itemChild: false,
          });
          break;
        case "center":
          visit(block.children, { ...ctx, center: true, itemChild: false });
          break;
        case "list":
          for (const item of block.items) {
            const rendered = item.children.filter((child) => child.type !== "pause").length;
            visit(item.children, {
              overlay: ctx.overlay || item.overlay !== null,
              center: ctx.center,
              itemChild: true,
              itemHasOther: rendered > 1,
            });
          }
          break;
        default:
          break;
      }
    }
  };
  visit(frame.body, { overlay: false, center: false, itemChild: false, itemHasOther: false });
  return result;
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
 * 候補(detachableBlocksOf)に無い・deckcanvas が 2 つ以上あるフレームでは null。
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
    for (const block of detachableBlocksOf(element)) {
      if (block.span.start === blockSpan.start && block.span.end === blockSpan.end) {
        target = block;
        break;
      }
    }
    if (!target) return null;
    const canvases = element.body.filter((block): block is CanvasNode => block.type === "canvas");
    if (canvases.length > 1) return null;
    return rewriteFrame(source, element, target, canvases[0] ?? null, clampPlacement(placement));
  }
  return null;
}
