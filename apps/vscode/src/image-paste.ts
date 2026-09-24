import {
  type CanvasNode,
  type FrameNode,
  framesOf,
  parseDeck,
  type RawFrameNode,
} from "@beamer-editor/core";

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

const BEGIN_FRAME = "\\begin{frame}";
const END_FRAME = "\\end{frame}";

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

/** 貼り付けで入れる参照と、その挿入位置。 */
export interface ImagePasteInsertion {
  text: string;
  /** 挿入位置。canvas のアイテムの中にはアイテムを入れられないので、その直後へ寄せる。 */
  offset: number;
}

/**
 * offset の位置に入れる参照。deckcanvas の中なら `\deckimage`、フレーム内のそれ以外
 * (通常フロー・解釈できないフレーム)は `\includegraphics`。フレームの外は入れない。
 */
export function imagePasteInsertion(
  source: string,
  offset: number,
  relativePath: string,
): ImagePasteInsertion | null {
  const target = insertTarget(source, offset);
  if (!target) return null;
  const reference = target.canvas
    ? `\\deckimage[${CANVAS_IMAGE_POSITION}]{${relativePath}}`
    : `\\includegraphics[width=${FLOW_IMAGE_WIDTH}\\textwidth]{${relativePath}}`;
  // 寄せた先は直前のアイテムの終わりなので、改行とそのアイテムのインデントを付ける。
  if (target.offset === offset) return { text: reference, offset };
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return { text: `${newline}${target.indent}${reference}`, offset: target.offset };
}

interface InsertTarget {
  canvas: boolean;
  offset: number;
  /** 挿入先を寄せたときの、寄せ先の行のインデント。 */
  indent: string;
}

/**
 * フレーム本文の中だけを挿入先にする。プリアンブルへ入るとビルドが落ち、フレームの間・
 * 見出し(オプション・タイトル)へ入ると壊れるため、どれも貼り付けない。
 */
function insertTarget(source: string, offset: number): InsertTarget | null {
  for (const frame of framesOf(parseDeck(source))) {
    if (offset < frame.span.start || offset > frame.span.end) continue;
    const body =
      frame.type === "frame" ? frameBodyRange(source, frame) : rawFrameBodyRange(source, frame);
    if (offset < body.start || offset > body.end) return null;
    if (frame.type !== "frame") return { canvas: false, offset, indent: "" };
    const canvas = frame.body.find(
      (block): block is CanvasNode =>
        block.type === "canvas" && offset > block.span.start && offset < block.span.end,
    );
    if (!canvas) return { canvas: false, offset, indent: "" };
    // decktext の中に画像は置けない(L014)ので、そのアイテムの直後を挿入先にする。
    const item = canvas.items.find((i) => offset > i.span.start && offset < i.span.end);
    if (!item) return { canvas: true, offset, indent: "" };
    return { canvas: true, offset: item.span.end, indent: indentOf(source, item.span.start) };
  }
  return null;
}

/** `\begin{frame}` の見出しの終わりから `\end{frame}` の直前まで。 */
function frameBodyRange(source: string, frame: FrameNode): { start: number; end: number } {
  let start = frame.span.start + BEGIN_FRAME.length;
  if (frame.options.span) start = Math.max(start, frame.options.span.end);
  if (frame.title) {
    // タイトルのノードは `{...}` の中身。空のタイトルもあるので閉じ括弧は原文から探す。
    const close = source.indexOf("}", frame.title.at(-1)?.span.end ?? start);
    if (close >= 0) start = Math.max(start, close + 1);
  }
  return { start, end: frameBodyEnd(frame) };
}

/**
 * raw frame は中身を解釈できないので、見出しの行を丸ごと避ける。1 行で書かれた raw frame は
 * 本文の始まりを決められないため、どこにも挿入しない。
 */
function rawFrameBodyRange(source: string, frame: RawFrameNode): { start: number; end: number } {
  const lineEnd = source.indexOf("\n", frame.span.start);
  return { start: lineEnd < 0 ? frame.span.end : lineEnd + 1, end: frameBodyEnd(frame) };
}

function frameBodyEnd(frame: FrameNode | RawFrameNode): number {
  return frame.span.end - END_FRAME.length;
}

function indentOf(source: string, offset: number): string {
  const line = source.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(source.slice(line, offset))?.[0] ?? "";
}
