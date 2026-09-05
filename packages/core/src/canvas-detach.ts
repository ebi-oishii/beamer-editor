/**
 * フロー配置の要素(段落・リスト・画像)を同じフレームの deckcanvas へ移す
 * 「自由配置にする」のソース変換(design.md §4.6、subset-spec §2.8)。
 *
 * formatter と同じく source span ベースの局所置換で行い、触れていない箇所の原文
 * (コメント・空行・インデント)は保つ。対象ブロックの原文を行単位で取り除き、
 * フレーム末尾の deckcanvas(無ければ新設)へ decktext / deckimage として入れる。
 * 取り出した要素の位置は呼び出し側(プレビュー上の表示位置)が決める。
 */

import {
  type BlockNode,
  type CanvasNode,
  type DeckDocument,
  type FrameNode,
  frameLabel,
  framesOf,
  type ListItemNode,
  type ListNode,
  type SourceSpan,
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
const BEGIN_FRAME = "\\begin{frame}";

/** decktext 内のリストは本文と同じ 3 段までネスト可(L014 と同じ条件)。項目のオーバーレイは不可。 */
function listFitsDecktext(list: ListNode, depth: number): boolean {
  return list.items.every(
    (item) =>
      item.overlay === null &&
      item.children.every((child) => {
        if (child.type === "paragraph" || child.type === "pause") return true;
        if (child.type === "list") return depth < 2 && listFitsDecktext(child, depth + 1);
        return false;
      }),
  );
}

/** リスト(入れ子含む)のどこかに \\pause があるか。 */
function listHasPause(list: ListNode): boolean {
  return list.items.some((item) =>
    item.children.some(
      (child) => child.type === "pause" || (child.type === "list" && listHasPause(child)),
    ),
  );
}

/** 自由配置へ移せる種類・構造か(decktext / deckimage に収まるか)。 */
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

/** 候補にできない理由。ui がメニューに表示する。 */
export type DetachBlockedReason = "unsupported-kind" | "overlay";

export type DetachStatus =
  | {
      eligible: true;
      /** ソースから取り除く範囲。唯一の内容なら空になる \\item(項目が 1 つならリスト)まで広げる。 */
      removeSpan: SourceSpan;
      /** center の中にあった要素。decktext 内で \\centering を掛けて見た目を保つ。 */
      center: boolean;
    }
  | { eligible: false; reason: DetachBlockedReason };

type Ancestor = { kind: "item"; item: ListItemNode } | { kind: "list"; list: ListNode };

/**
 * 取り除く範囲を決める。ブロックが項目の唯一の描画内容なら項目ごと、その項目がリストの唯一の
 * 項目ならリストごと取り除く(空の \\item は箱条書き記号が残り、空の itemize は LaTeX エラー)。
 * 項目に \\pause が含まれる場合は項目を消すと後続の step が変わるので広げない。
 */
function removalSpan(block: BlockNode, ancestors: readonly Ancestor[]): SourceSpan {
  let node: BlockNode | ListItemNode | ListNode = block;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i] as Ancestor;
    if (ancestor.kind === "item") {
      const rendered = ancestor.item.children.filter((child) => child.type !== "pause");
      const hasPause = rendered.length !== ancestor.item.children.length;
      if (rendered.length !== 1 || rendered[0] !== node || hasPause) break;
      node = ancestor.item;
    } else {
      if (ancestor.list.items.length !== 1 || ancestor.list.items[0] !== node) break;
      node = ancestor.list;
    }
  }
  return node.span;
}

/**
 * フレーム内のフロー要素それぞれについて「自由配置にする」候補になれるか(なれなければ理由)を
 * 決める。renderer の候補属性と core の適用判定はこの同じ結果を使う。
 * - 種類・構造が decktext / deckimage に収まらない → unsupported-kind
 * - overlay 付きの block / \\item の中、または \\pause との前後関係が移動先(既存の deckcanvas、
 *   無ければフレーム末尾)と異なる → overlay(移すと表示開始 step が変わる)
 * - 項目の唯一の内容で、その項目に \\pause がある → overlay(項目ごと消すと後続の step が変わる)
 * - \\pause を含むリスト → overlay(decktext は \\pause を許さない。L014)
 * リスト項目直下の段落(項目の本文そのもの)と deckcanvas の中身は対象外。deckcanvas が 2 つ以上あるフレームは空。
 */
export function detachStatusesOf(frame: FrameNode): Map<BlockNode, DetachStatus> {
  const result = new Map<BlockNode, DetachStatus>();
  const canvases = frame.body.filter((block): block is CanvasNode => block.type === "canvas");
  if (canvases.length > 1) return result;
  const canvas = canvases[0];
  const targetPauses = countPauses(frame.body, canvas).count;
  let pauses = 0;
  const visit = (
    blocks: BlockNode[],
    ctx: { overlay: boolean; center: boolean; itemChild: boolean },
    ancestors: readonly Ancestor[],
  ): void => {
    for (const block of blocks) {
      if (block.type === "pause") {
        pauses++;
        continue;
      }
      if (
        block.type === "canvas" ||
        block.type === "titlePage" ||
        block.type === "tableOfContents"
      ) {
        continue;
      }
      // 項目直下の段落は項目の本文そのもの(renderer も <span> で描く)。候補にも理由にもしない。
      if (!(ctx.itemChild && block.type === "paragraph")) {
        if (!isDetachableBlock(block)) {
          result.set(block, { eligible: false, reason: "unsupported-kind" });
        } else if (ctx.overlay || pauses !== targetPauses) {
          result.set(block, { eligible: false, reason: "overlay" });
        } else {
          const soleOfPausedItem =
            ancestors.at(-1)?.kind === "item" &&
            (() => {
              const item = (ancestors.at(-1) as { kind: "item"; item: ListItemNode }).item;
              const rendered = item.children.filter((child) => child.type !== "pause");
              return rendered.length === 1 && rendered.length !== item.children.length;
            })();
          // \\pause を含むリストをそのまま decktext に入れると L014 になり step も失われる(#98 で扱う)。
          if (soleOfPausedItem || (block.type === "list" && listHasPause(block)))
            result.set(block, { eligible: false, reason: "overlay" });
          else
            result.set(block, {
              eligible: true,
              removeSpan: removalSpan(block, ancestors),
              center: ctx.center,
            });
        }
      }
      switch (block.type) {
        case "columns":
          for (const column of block.columns)
            visit(column.children, { ...ctx, itemChild: false }, []);
          break;
        case "blockEnv":
          visit(
            block.children,
            { ...ctx, overlay: ctx.overlay || block.overlay !== null, itemChild: false },
            [],
          );
          break;
        case "center":
          visit(block.children, { ...ctx, center: true, itemChild: false }, []);
          break;
        case "list":
          for (const item of block.items) {
            visit(
              item.children,
              {
                overlay: ctx.overlay || item.overlay !== null,
                center: ctx.center,
                itemChild: true,
              },
              [...ancestors, { kind: "list", list: block }, { kind: "item", item }],
            );
          }
          break;
        default:
          break;
      }
    }
  };
  visit(frame.body, { overlay: false, center: false, itemChild: false }, []);
  return result;
}

/** 候補になれるブロックだけの集合(detachStatusesOf の eligible なもの)。 */
export function detachableBlocksOf(frame: FrameNode): Set<BlockNode> {
  const eligible = new Set<BlockNode>();
  for (const [block, status] of detachStatusesOf(frame)) if (status.eligible) eligible.add(block);
  return eligible;
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

/** 行内で `%` コメント(エスケープ `\\%` を除く)が始まる位置。無ければ -1。 */
function commentIndex(line: string): number {
  const match = /(^|[^\\])(\\\\)*(%)/.exec(line);
  return match ? match.index + match[0].length - 1 : -1;
}

/**
 * 広げた削除範囲(\\item やリストごと)のうち、ブロック以外の部分にあるコメントを行ごとに集める。
 * 移動先へ書くのはブロックだけなので、これらは削除位置にそのまま残す(§2.4 のコメント保持)。
 */
function commentsOutsideBlock(
  source: string,
  removeSpan: SourceSpan,
  blockSpan: SourceSpan,
): string[] {
  const kept: string[] = [];
  const segments: [number, number][] = [
    [removeSpan.start, blockSpan.start],
    [blockSpan.end, removeSpan.end],
  ];
  for (const [from, to] of segments) {
    let pos = from;
    while (pos < to) {
      const end = Math.min(lineEnd(source, pos), to);
      const text = source.slice(pos, end);
      const index = commentIndex(text);
      if (index !== -1) kept.push(text.slice(index).trimEnd());
      pos = lineEnd(source, pos) + 1;
    }
  }
  return kept;
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
  center: boolean,
): string {
  const f = formatCanvasCoordinate;
  const position = `x=${f(placement.x)},y=${f(placement.y)},w=${f(placement.width)}`;
  if (block.type === "image") return `${indent}\\deckimage[${position}]{${block.path}}`;
  const span = trimmedSpan(source, block.span);
  const content = reindent(source.slice(span.start, span.end), `${indent}  `, eol);
  // center の中にあった要素は箱の中で中央寄せを保つ。
  const centering = center ? `${indent}  \\centering${eol}` : "";
  return `${indent}\\begin{decktext}[${position},size=normal]${eol}${centering}${content}${eol}${indent}\\end{decktext}`;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** キャンバスフレームへ自動で付ける label の接頭辞(L011 の「一意な label」)。 */
const CANVAS_LABEL_PREFIX = "canvas";

/**
 * 文書内で未使用の `canvas-N` を返す。ラベルは永続アドレス(ai-protocol §3)なので
 * フレーム位置ではなく空き番号で決め、あとから並べ替えても意味が変わらないようにする。
 */
function nextCanvasLabel(doc: DeckDocument): string {
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
function addLabelEdit(frame: FrameNode, label: string): Edit {
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

interface RewriteFrameRequest {
  source: string;
  frame: FrameNode;
  block: BlockNode;
  target: { removeSpan: SourceSpan; center: boolean };
  canvas: CanvasNode | null;
  placement: CanvasPlacement;
  addLabel: string | null;
}

function rewriteFrame({
  source,
  frame,
  block,
  target,
  canvas,
  placement,
  addLabel,
}: RewriteFrameRequest): SourceReplacement {
  const edits: Edit[] = [];
  const eol = detectEol(source);

  // 0. キャンバスフレームには一意な label が要る(L011)。GUI 操作の結果が
  //    そのまま lint を通るよう、label の無いフレームにはここで付ける。
  if (addLabel !== null) edits.push(addLabelEdit(frame, addLabel));

  // 1. 対象の原文(唯一の内容なら \\item やリストごと)を取り除く。行を占有していれば改行ごと消す。
  //    広げた範囲にあったコメントは、行を占有して消せるときは同じ位置に行として残す(§2.4)。
  //    行を占有していない(インラインの)削除でコメントを残せないときは、ブロックだけを取り除く。
  let removeSpan = target.removeSpan;
  let kept = commentsOutsideBlock(source, removeSpan, block.span);
  {
    const wide = trimmedSpan(source, removeSpan);
    const wholeLines =
      isBlank(source.slice(lineStart(source, wide.start), wide.start)) &&
      isBlank(source.slice(wide.end, lineEnd(source, wide.end)));
    if (kept.length > 0 && !wholeLines) {
      removeSpan = block.span;
      kept = [];
    }
  }
  const span = trimmedSpan(source, removeSpan);
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
  const indent = ownsLineStart ? source.slice(blockLineStart, span.start) : "";
  edits.push({
    start: removeStart,
    end: ownsLineStart && ownsLineEnd ? Math.min(blockLineEnd + 1, source.length) : span.end,
    text: kept.length > 0 ? `${kept.map((line) => `${indent}${line}`).join(eol)}${eol}` : "",
  });

  // 2. deckcanvas へ入れる。既存があれば \end{deckcanvas} の直前、無ければ \end{frame} の直前に新設。
  if (canvas) {
    const endIndex = source.lastIndexOf("\\end{deckcanvas}", canvas.span.end);
    const endLineStart = lineStart(source, endIndex);
    if (isBlank(source.slice(endLineStart, endIndex))) {
      const canvasIndent = source.slice(endLineStart, endIndex);
      const object = buildObject(source, block, placement, `${canvasIndent}  `, eol, target.center);
      edits.push({ start: endLineStart, end: endLineStart, text: `${object}${eol}` });
    } else {
      const object = buildObject(source, block, placement, "    ", eol, target.center);
      edits.push({ start: endIndex, end: endIndex, text: `${eol}${object}${eol}  ` });
    }
  } else {
    const endIndex = source.lastIndexOf("\\end{frame}", frame.span.end);
    const endLineStart = lineStart(source, endIndex);
    const ownsLine = isBlank(source.slice(endLineStart, endIndex));
    const frameIndent = ownsLine ? source.slice(endLineStart, endIndex) : "";
    const bodyIndent = `${frameIndent}  `;
    const object = buildObject(source, block, placement, `${bodyIndent}  `, eol, target.center);
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
    let target: { block: BlockNode; removeSpan: SourceSpan; center: boolean } | undefined;
    for (const [block, status] of detachStatusesOf(element)) {
      if (!status.eligible) continue;
      if (block.span.start === blockSpan.start && block.span.end === blockSpan.end) {
        target = { block, removeSpan: status.removeSpan, center: status.center };
        break;
      }
    }
    if (!target) return null;
    const canvases = element.body.filter((block): block is CanvasNode => block.type === "canvas");
    if (canvases.length > 1) return null;
    return rewriteFrame({
      source,
      frame: element,
      block: target.block,
      target,
      canvas: canvases[0] ?? null,
      placement: clampPlacement(placement),
      addLabel: frameLabel(element) === null ? nextCanvasLabel(doc) : null,
    });
  }
  return null;
}
