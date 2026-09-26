/**
 * プレビュー上のキャンバス要素(decktext / deckimage)の削除・コピー・貼り付け(#148)。
 * ソースを正とした PowerPoint 風の操作で、クリップボードには要素のソース原文をそのまま置く。
 * 貼り付けはその原文を解釈し、対象フレームの deckcanvas(無ければ新設)へ入れる。
 * formatter・自由配置と同じく span ベースの局所置換で、触れていない原文は保つ。
 */

import {
  type CanvasImageNode,
  type CanvasNode,
  type CanvasTextNode,
  type FrameNode,
  frameLabel,
  framesOf,
  type SourceSpan,
} from "./ast.js";
import {
  canvasPositionReplacement,
  formatCanvasCoordinate,
  roundCanvasCoordinate,
} from "./canvas-edit.js";
import {
  addLabelEdit,
  applyFrameEdits,
  type Edit,
  insertIntoCanvasEdits,
  nextCanvasLabel,
  type SourceReplacement,
} from "./canvas-frame.js";
import { parseDeck } from "./parser.js";
import { detectEol, isBlank, lineEnd, lineStart, reindent, trimmedSpan } from "./source-text.js";

type CanvasObject = CanvasTextNode | CanvasImageNode;

/** 同じフレームへ貼り付けたとき、元の箱と重ならないようにずらす量(正規化座標)。 */
export const CANVAS_PASTE_OFFSET = 0.02;

interface LocatedCanvasObject {
  frame: FrameNode;
  canvas: CanvasNode;
  item: CanvasObject;
}

/** renderer が要素に付ける options(`[x=..,y=..,w=..]`)の span から、その要素を探す。 */
function locateCanvasObject(source: string, optionsSpan: SourceSpan): LocatedCanvasObject | null {
  for (const frame of framesOf(parseDeck(source))) {
    if (frame.type !== "frame") continue;
    for (const canvas of frame.body) {
      if (canvas.type !== "canvas") continue;
      for (const item of canvas.items) {
        if (
          item.type !== "rawBlock" &&
          item.position.span.start === optionsSpan.start &&
          item.position.span.end === optionsSpan.end
        )
          return { frame, canvas, item };
      }
    }
  }
  return null;
}

/**
 * 要素のソース原文(クリップボードへ置く形)。先頭行の字下げを外し、改行は LF に揃える。
 * 見つからなければ null。
 */
export function canvasObjectSource(source: string, optionsSpan: SourceSpan): string | null {
  const located = locateCanvasObject(source, optionsSpan);
  if (!located) return null;
  const span = trimmedSpan(source, located.item.span);
  return reindent(source.slice(span.start, span.end), "", "\n");
}

/**
 * 要素を取り除く編集。行を占有していれば改行ごと消し、同じ行に別の内容があれば要素の範囲だけ
 * (直前の空白を含めて)消す。deckcanvas が空になっても環境は残す。見つからなければ null。
 */
export function removeCanvasObject(
  source: string,
  optionsSpan: SourceSpan,
): SourceReplacement | null {
  const located = locateCanvasObject(source, optionsSpan);
  if (!located) return null;
  const span = trimmedSpan(source, located.item.span);
  const start = lineStart(source, span.start);
  const end = lineEnd(source, span.end);
  if (isBlank(source.slice(start, span.start)) && isBlank(source.slice(span.end, end))) {
    return { span: { start, end: Math.min(end + 1, source.length) }, text: "" };
  }
  let removeStart = span.start;
  while (removeStart > start && /[ \t]/.test(source[removeStart - 1] as string)) removeStart--;
  return { span: { start: removeStart, end: span.end }, text: "" };
}

/** クリップボードから読めた要素 1 つ。text は原文、options はその中の `[...]` の範囲。 */
export interface CanvasClipboardObject {
  text: string;
  options: SourceSpan;
  position: { x: number; y: number; width: number };
}

const CLIPBOARD_PREFIX =
  "\\documentclass[aspectratio=169]{beamer}\n\\begin{document}\n\\begin{frame}\n\\begin{deckcanvas}\n";
const CLIPBOARD_SUFFIX = "\n\\end{deckcanvas}\n\\end{frame}\n\\end{document}\n";

/**
 * クリップボードの文字列を deckcanvas 直下の要素の列として読む。decktext / deckimage 以外
 * (素の文章・生ブロック)を含むか、要素が無ければ null。
 */
export function parseCanvasClipboard(text: string): CanvasClipboardObject[] | null {
  if (text.trim() === "") return null;
  const synthetic = `${CLIPBOARD_PREFIX}${text}${CLIPBOARD_SUFFIX}`;
  const frame = parseDeck(synthetic).body.find((element) => element.type === "frame");
  const canvas = frame?.body.find((block): block is CanvasNode => block.type === "canvas");
  if (!canvas || canvas.items.length === 0) return null;
  const objects: CanvasClipboardObject[] = [];
  for (const item of canvas.items) {
    if (item.type === "rawBlock") return null;
    const span = trimmedSpan(synthetic, item.span);
    objects.push({
      text: synthetic.slice(span.start, span.end),
      options: {
        start: item.position.span.start - span.start,
        end: item.position.span.end - span.start,
      },
      position: { x: item.position.x, y: item.position.y, width: item.position.width },
    });
  }
  return objects;
}

function positionKey(x: number, y: number): string {
  return `${roundCanvasCoordinate(x)},${roundCanvasCoordinate(y)}`;
}

/**
 * 衝突を避けるため x/y を書き換える。通常は既存の局所置換を使い、片方または両方が
 * 省略されている場合だけ、安全に読める key/value 列へ補う。重複・未知の形式は原文を
 * 曖昧に書き換えず拒否する。
 */
function pastedPositionReplacement(options: string, x: number, y: number): string | null {
  const direct = canvasPositionReplacement(options, x, y);
  if (direct !== null) return direct;
  if (!options.startsWith("[") || !options.endsWith("]")) return null;
  const values = new Set<string>();
  const parts = options.slice(1, -1).split(",");
  const rewritten: string[] = [];
  for (const part of parts) {
    if (part.trim() === "") continue;
    const match = /^(\s*)(x|y|w|size)(\s*=\s*)(\S+)(\s*)$/.exec(part);
    if (!match) return null;
    const [, prefix, key, separator, value, suffix] = match;
    if (
      prefix === undefined ||
      key === undefined ||
      separator === undefined ||
      value === undefined ||
      suffix === undefined ||
      values.has(key)
    )
      return null;
    values.add(key);
    if (key === "x" || key === "y") {
      if (!Number.isFinite(Number(value))) return null;
      rewritten.push(
        `${prefix}${key}${separator}${formatCanvasCoordinate(key === "x" ? x : y)}${suffix}`,
      );
    } else {
      rewritten.push(part);
    }
  }
  if (!values.has("x")) rewritten.push(`x=${formatCanvasCoordinate(x)}`);
  if (!values.has("y")) rewritten.push(`y=${formatCanvasCoordinate(y)}`);
  return `[${rewritten.join(",")}]`;
}

/**
 * クリップボードの要素を、frameOffset(元ソース上の位置)を含むフレームの deckcanvas へ貼り付ける。
 * 位置は元のまま。同じ位置に既に要素があれば、重ならない位置まで右下へ少しずつずらす
 * (PowerPoint の同じスライドへの貼り付けと同じ)。deckcanvas が無ければ新設し、フレームに label が
 * 無ければ付ける(L011)。クリップボードが要素でない・フレームが無い・deckcanvas が 2 つ以上なら null。
 */
export function pasteCanvasObjects(
  source: string,
  frameOffset: number,
  clipboard: string,
): SourceReplacement | null {
  const objects = parseCanvasClipboard(clipboard);
  if (!objects) return null;
  const doc = parseDeck(source);
  const frame = framesOf(doc).find(
    (candidate): candidate is FrameNode =>
      candidate.type === "frame" &&
      frameOffset >= candidate.span.start &&
      frameOffset < candidate.span.end,
  );
  if (!frame) return null;
  const canvases = frame.body.filter((block): block is CanvasNode => block.type === "canvas");
  if (canvases.length > 1) return null;
  const canvas = canvases[0] ?? null;
  const eol = detectEol(source);
  const occupied = new Set<string>();
  for (const item of canvas?.items ?? []) {
    if (item.type !== "rawBlock") occupied.add(positionKey(item.position.x, item.position.y));
  }
  const texts: string[] = [];
  for (const object of objects) {
    let { x, y } = object.position;
    for (let attempt = 0; occupied.has(positionKey(x, y)); attempt++) {
      // occupied が n 個なら、異なる n + 1 個の候補のいずれかは空く。固定回数ではなく
      // 現在の占有数を上限にすることで、51 個以上の同じ貼り付け位置にも対応する。
      if (attempt >= occupied.size) return null;
      // GUI は位置を本文領域へ clamp しない。範囲外の配置は L012 / deck check が通知する。
      const nextX = roundCanvasCoordinate(x + CANVAS_PASTE_OFFSET);
      const nextY = roundCanvasCoordinate(y + CANVAS_PASTE_OFFSET);
      if (positionKey(nextX, nextY) === positionKey(x, y)) return null;
      x = nextX;
      y = nextY;
    }
    occupied.add(positionKey(x, y));
    if (x === object.position.x && y === object.position.y) {
      texts.push(object.text);
      continue;
    }
    const options = object.text.slice(object.options.start, object.options.end);
    const replaced = pastedPositionReplacement(options, x, y);
    if (replaced === null) return null;
    texts.push(
      `${object.text.slice(0, object.options.start)}${replaced}${object.text.slice(object.options.end)}`,
    );
  }
  const edits: Edit[] = [];
  if (frameLabel(frame) === null) edits.push(addLabelEdit(source, frame, nextCanvasLabel(doc)));
  edits.push(
    ...insertIntoCanvasEdits(
      source,
      frame,
      canvas,
      (indent) => texts.map((text) => reindent(text, indent, eol)).join(eol),
      eol,
    ),
  );
  return applyFrameEdits(source, frame, edits);
}
