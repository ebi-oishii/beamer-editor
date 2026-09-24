import { type CanvasNode, framesOf, parseDeck } from "@beamer-editor/core";

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
const BEGIN_CANVAS = "\\begin{deckcanvas}";
const END_CANVAS = "\\end{deckcanvas}";

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
 * 見出し(オーバーレイ・オプション・タイトル・サブタイトル)へ入ると壊れるため、どれも貼り付けない。
 */
function insertTarget(source: string, offset: number): InsertTarget | null {
  for (const frame of framesOf(parseDeck(source))) {
    if (offset < frame.span.start || offset > frame.span.end) continue;
    const bodyEnd = frame.span.end - END_FRAME.length;
    const bodyStart = frameHeaderEnd(source, frame.span.start + BEGIN_FRAME.length, bodyEnd);
    if (bodyStart === null || offset < bodyStart || offset > bodyEnd) return null;
    if (frame.type !== "frame") {
      // raw frame は中身を解釈できず、deckcanvas のアイテムの中か外か決められないので入れない。
      if (insideRawCanvas(source, frame.span.start, frame.span.end, offset)) return null;
      return { canvas: false, offset, indent: "" };
    }
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

/** 見出しの引数の開き文字と、対応する閉じ文字。 */
const ARGUMENT_CLOSE: Readonly<Record<string, string>> = { "<": ">", "[": "]", "{": "}" };

/**
 * `\begin{frame}` の直後 start から、beamer の引数読み取りと同じく `<...>` `[...]` `{...}` を
 * 原文で読み飛ばし、最後の引数の直後を見出しの終わりとする。空行(\par)か引数でない文字で止まる。
 * 閉じ文字が limit までに無ければ本文なしとして null。
 */
function frameHeaderEnd(source: string, start: number, limit: number): number | null {
  let end = start;
  let p = start;
  // 最後の引数から読んだ改行の数。2 つ目に当たれば、間は空白だけなので空行。
  let newlines = 0;
  while (p < limit) {
    const c = source[p] ?? "";
    if (c === " " || c === "\t" || c === "\r") {
      p++;
    } else if (c === "\n") {
      if (++newlines >= 2) break;
      p++;
    } else if (c === "%") {
      // コメントは行末の改行ごと読み捨てるので、次の行は行頭から始まる。
      const lineEnd = source.indexOf("\n", p);
      if (lineEnd < 0 || lineEnd >= limit) break;
      p = lineEnd + 1;
      newlines = 1;
    } else {
      const close = ARGUMENT_CLOSE[c];
      if (!close) break;
      const after = skipArgument(source, p, close, limit);
      if (after === null) return null;
      end = p = after;
      newlines = 0;
    }
  }
  return end;
}

/**
 * open の開き文字に対応する閉じ文字の直後を返す。`{}` のネストを数え、`[` は深さ 0 の `]` だけで
 * 閉じる。`\` の次の 1 文字と `%` から行末は読み飛ばす。limit までに閉じなければ null。
 */
function skipArgument(source: string, open: number, close: string, limit: number): number | null {
  if (close === ">") {
    const at = source.indexOf(">", open + 1);
    return at < 0 || at >= limit ? null : at + 1;
  }
  let depth = close === "}" ? 1 : 0;
  for (let p = open + 1; p < limit; p++) {
    const c = source[p];
    if (c === "\\") {
      p++;
    } else if (c === "%") {
      const lineEnd = source.indexOf("\n", p);
      if (lineEnd < 0) return null;
      p = lineEnd;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (close === "}" && depth === 0) return p + 1;
    } else if (c === "]" && close === "]" && depth === 0) {
      return p + 1;
    }
  }
  return null;
}

/** offset が raw frame の原文 [start, end) の中の `\begin{deckcanvas}`〜`\end{deckcanvas}` の間にあるか。 */
function insideRawCanvas(source: string, start: number, end: number, offset: number): boolean {
  const frame = source.slice(start, end);
  for (let at = frame.indexOf(BEGIN_CANVAS); at >= 0; at = frame.indexOf(BEGIN_CANVAS, at + 1)) {
    const close = frame.indexOf(END_CANVAS, at);
    // 閉じが無ければフレームの終わりまでを deckcanvas の中と見なす。
    const canvasEnd = close < 0 ? frame.length : close + END_CANVAS.length;
    if (offset > start + at && offset < start + canvasEnd) return true;
  }
  return false;
}

function indentOf(source: string, offset: number): string {
  const line = source.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(source.slice(line, offset))?.[0] ?? "";
}
