import type { InlineNode, RawInlineNode } from "./ast.js";

/** 生インラインを図として扱える、既存の安全なラッパーと描画環境。 */
const FIGURE_WRAPPERS =
  /^\s*\\(resizebox|scalebox|rotatebox|adjustbox|makebox|centerline|fbox|mbox)\b/;
const FIGURE_ENVIRONMENTS = new Set([
  "tikzpicture",
  "pgfpicture",
  "picture",
  "tikzcd",
  "circuitikz",
  "forest",
  "pspicture",
]);

function environmentOf(tex: string): string | null {
  return /\\begin\{([^}\s]+)\}/.exec(tex)?.[1] ?? null;
}

/** 本文を含まず、既存の図ラッパーだけから成る段落ならその生インラインを返す。 */
export function figureLikeRawInline(children: InlineNode[]): RawInlineNode | null {
  const meaningful = children.filter(
    (child) => !(child.type === "text" && child.value.trim() === ""),
  );
  const only = meaningful[0];
  if (meaningful.length !== 1 || only?.type !== "rawInline" || !FIGURE_WRAPPERS.test(only.tex))
    return null;
  const environment = environmentOf(only.tex);
  return environment !== null && FIGURE_ENVIRONMENTS.has(environment) ? only : null;
}
