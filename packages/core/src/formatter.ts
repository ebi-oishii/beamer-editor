/**
 * Beamer サブセットの正規形フォーマッタ。
 *
 * Phase 2 の第一段として、仕様上の正規形が確定しているキャンバス位置指定を
 * source span ベースで局所置換する。未対応の領域は原文をそのまま保持するため、
 * コメント・生 LaTeX・プリアンブルを失わない。
 */

import type {
  BlockNode,
  CanvasImageNode,
  CanvasTextNode,
  DeckDocument,
  SourceSpan,
} from "./ast.js";
import { parseDeck } from "./parser.js";

interface Replacement {
  span: SourceSpan;
  text: string;
}

function fixed(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`キャンバス座標は有限数である必要があります: ${String(value)}`);
  }
  const formatted = value.toFixed(3);
  return formatted === "-0.000" ? "0.000" : formatted;
}

function canvasTextOptions(item: CanvasTextNode): string {
  const { x, y, width } = item.position;
  return `[x=${fixed(x)},y=${fixed(y)},w=${fixed(width)},size=${item.size}]`;
}

function canvasImageOptions(item: CanvasImageNode): string {
  const { x, y, width } = item.position;
  return `[x=${fixed(x)},y=${fixed(y)},w=${fixed(width)}]`;
}

function collectBlockReplacements(block: BlockNode, replacements: Replacement[]): void {
  switch (block.type) {
    case "canvas":
      for (const item of block.items) {
        if (item.type === "canvasText") {
          replacements.push({ span: item.position.span, text: canvasTextOptions(item) });
        } else if (item.type === "canvasImage") {
          replacements.push({ span: item.position.span, text: canvasImageOptions(item) });
        }
      }
      break;
    case "list":
      for (const item of block.items) {
        for (const child of item.children) collectBlockReplacements(child, replacements);
      }
      break;
    case "columns":
      for (const column of block.columns) {
        for (const child of column.children) collectBlockReplacements(child, replacements);
      }
      break;
    case "blockEnv":
    case "center":
      for (const child of block.children) collectBlockReplacements(child, replacements);
      break;
    default:
      break;
  }
}

function canvasReplacements(document: DeckDocument): Replacement[] {
  const replacements: Replacement[] = [];
  for (const element of document.body) {
    if (element.type !== "frame") continue;
    for (const block of element.body) collectBlockReplacements(block, replacements);
  }
  return replacements;
}

function applyReplacements(source: string, replacements: Replacement[]): string {
  const ordered = [...replacements].sort((a, b) => b.span.start - a.span.start);
  let previousStart = source.length;
  let result = source;

  for (const replacement of ordered) {
    const { start, end } = replacement.span;
    if (start < 0 || end < start || end > source.length || end > previousStart) {
      throw new RangeError(`ソース範囲が不正または重複しています: [${start}, ${end})`);
    }
    if (source[start] !== "[" || source[end - 1] !== "]") {
      throw new Error(
        `キャンバス位置のソース範囲がオプション指定を指していません: [${start}, ${end})`,
      );
    }
    result = `${result.slice(0, start)}${replacement.text}${result.slice(end)}`;
    previousStart = start;
  }

  return result;
}

/**
 * ソースを正規形へ整える。
 *
 * document を省略した場合は source をパースする。GUI 等で AST を変更した場合は、
 * 同じ source から得た document を変更して渡すことで、その値を source span の位置へ書き戻せる。
 */
export function formatDeck(source: string, document: DeckDocument = parseDeck(source)): string {
  return applyReplacements(source, canvasReplacements(document));
}
