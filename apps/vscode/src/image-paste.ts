import { framesOf, parseDeck } from "@beamer-editor/core";

/**
 * エディタへの画像の貼り付け(#153)。クリップボードの画像を文書と同じ場所の `assets/` に
 * 保存し、カーソル位置に参照を挿入する。ここは VS Code に依存しない判断だけを持つ。
 */

/** 受け付ける画像の MIME と、保存するときの拡張子。 */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
};

export const IMAGE_PASTE_MIME_TYPES: readonly string[] = Object.keys(IMAGE_EXTENSIONS);

/** 保存先のディレクトリ(文書からの相対)。fixture と同じ `assets/`。 */
export const IMAGE_PASTE_DIRECTORY = "assets";

/** 通常フローに置くときの幅(`\textwidth` の係数)。 */
const FLOW_IMAGE_WIDTH = "0.8";
/** deckcanvas に置くときの位置と幅(正規形の小数 3 桁)。 */
const CANVAS_IMAGE_POSITION = "x=0.100,y=0.100,w=0.400";

/** MIME に対応する拡張子。対象外なら null。 */
export function imagePasteExtension(mimeType: string): string | null {
  return IMAGE_EXTENSIONS[mimeType] ?? null;
}

/** `image.<ext>`, `image-1.<ext>`, ... のうち、まだ無い最初の名前。 */
export function nextImagePasteFileName(
  extension: string,
  exists: (name: string) => boolean,
): string {
  for (let n = 0; ; n++) {
    const name = n === 0 ? `image.${extension}` : `image-${n}.${extension}`;
    if (!exists(name)) return name;
  }
}

/**
 * offset の位置に挿入する参照。deckcanvas の中なら `\deckimage`、それ以外(通常フロー・
 * 解釈できないフレーム・フレーム外)は `\includegraphics`。
 */
export function imagePasteInsertText(source: string, offset: number, relativePath: string): string {
  return isInsideCanvas(source, offset)
    ? `\\deckimage[${CANVAS_IMAGE_POSITION}]{${relativePath}}`
    : `\\includegraphics[width=${FLOW_IMAGE_WIDTH}\\textwidth]{${relativePath}}`;
}

function isInsideCanvas(source: string, offset: number): boolean {
  for (const frame of framesOf(parseDeck(source))) {
    if (frame.type !== "frame" || offset < frame.span.start || offset > frame.span.end) continue;
    return frame.body.some(
      (block) => block.type === "canvas" && offset > block.span.start && offset < block.span.end,
    );
  }
  return false;
}
