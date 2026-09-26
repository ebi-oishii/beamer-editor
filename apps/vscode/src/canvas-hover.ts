import { texTokens } from "@beamer-editor/core";

export type CanvasHoverName = "deckcanvas" | "decktext" | "deckimage";

/** ユーザーへ表示する独自キャンバス構文の説明。将来の翻訳はこの定義を置き換えて行う。 */
export interface CanvasHoverDocumentation {
  readonly name: CanvasHoverName;
  readonly markdown: string;
}

/**
 * Beamer 標準ではなく、この拡張が管理するキャンバス構文の日本語 Hover 説明。
 * 識別子と構文例は LaTeX の公開契約に合わせ、表示文だけをロケール依存にする。
 */
export const CANVAS_HOVER_DOCUMENTATION: Readonly<
  Record<CanvasHoverName, CanvasHoverDocumentation>
> = {
  deckcanvas: {
    name: "deckcanvas",
    markdown: `\`deckcanvas\`

テキストや画像を自由配置するキャンバス環境です。1 フレームにつき 1 つだけ置けます。

中には \`decktext\` または \`deckimage\` を置きます。

\`\`\`latex
\\begin{deckcanvas}
  % decktext / deckimage
\\end{deckcanvas}
\`\`\``,
  },
  decktext: {
    name: "decktext",
    markdown: `\`decktext\`

キャンバス上にテキストを配置する環境です。位置と幅は本文領域を 1 とした値で指定します。

オプション:
- \`x\`: 左端の位置（通常は 0〜1）
- \`y\`: 上端の位置（下向きが正、通常は 0〜1）
- \`w\`: 幅（通常は 0〜1）
- \`size\`: 文字サイズ（\`tiny\`、\`scriptsize\`、\`footnotesize\`、\`small\`、\`normal\`、\`large\`、\`Large\`）

\`\`\`latex
\\begin{decktext}[x=0.050,y=0.100,w=0.420,size=normal]
  テキスト
\\end{decktext}
\`\`\``,
  },
  deckimage: {
    name: "deckimage",
    markdown: `\`deckimage\`

キャンバス上に PNG、JPEG、PDF 画像を配置するコマンドです。位置と幅は本文領域を 1 とした値で指定し、高さは縦横比から自動で決まります。

オプション:
- \`x\`: 左端の位置（通常は 0〜1）
- \`y\`: 上端の位置（下向きが正、通常は 0〜1）
- \`w\`: 幅（通常は 0〜1）

\`\`\`latex
\\deckimage[x=0.520,y=0.140,w=0.400]{assets/image.pdf}
\`\`\``,
  },
};

function isCanvasHoverName(name: string): name is CanvasHoverName {
  return Object.hasOwn(CANVAS_HOVER_DOCUMENTATION, name);
}

export interface CanvasHoverDocument {
  getText(): string;
  offsetAt(position: unknown): number;
}

export interface CanvasHover {
  readonly documentation: CanvasHoverDocumentation;
  /** コマンド名だけの UTF-16 範囲。 */
  readonly range: { start: number; end: number };
}

/** managed な TeX 文書内で、カーソル位置にある独自キャンバス構文の Hover を返す。 */
export function canvasHoverAt(
  document: CanvasHoverDocument,
  position: unknown,
): CanvasHover | undefined {
  const source = document.getText();
  const offset = document.offsetAt(position);
  for (const token of texTokens(source)) {
    // 未閉鎖の verbatim 環境の後ろは入力途中でも本文として扱う。
    if (token.kind === "unterminated") break;
    const name = token.name;
    if (!isCanvasHoverName(name)) continue;
    const documentation = CANVAS_HOVER_DOCUMENTATION[name];

    const range =
      name === "deckimage" && token.kind === "command"
        ? { start: token.start + 1, end: token.end }
        : (name === "deckcanvas" || name === "decktext") &&
            (token.kind === "begin" || token.kind === "end")
          ? { start: token.end - name.length - 1, end: token.end - 1 }
          : undefined;
    if (range && offset >= range.start && offset < range.end)
      return { documentation, range };
  }
  return undefined;
}
