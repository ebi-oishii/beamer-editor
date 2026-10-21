import { CANVAS_FONT_SIZES } from "@beamer-editor/core";
import { CANVAS_HOVER_DOCUMENTATION } from "./canvas-hover";

/**
 * deck 語彙(キャンバスとスタイル)の入力補完(#149)。ここは VS Code に依存しない判断だけを持ち、
 * 文書と offset から候補を返す。挿入文は VS Code の snippet 構文。
 */

export type DeckCompletionKind = "environment" | "command" | "option" | "value";

export interface DeckCompletion {
  readonly label: string;
  readonly kind: DeckCompletionKind;
  /** VS Code の snippet 構文。 */
  readonly snippet: string;
  readonly detail: string;
  /** Markdown。 */
  readonly documentation?: string;
  /** 置き換える UTF-16 範囲(入力途中の語を含む)。 */
  readonly range: { start: number; end: number };
  /** 挿入後に続けて候補を出す(`size=` の値など)。 */
  readonly retrigger?: boolean;
}

interface Entry {
  label: string;
  snippet: string;
  detail: string;
  documentation?: string;
  retrigger?: boolean;
}

const POSITION_DOC = "本文領域を 1 とした値(小数 3 桁)。";
const SIZE_CHOICES = ["normal", ...CANVAS_FONT_SIZES.filter((size) => size !== "normal")];
const COLOR_ROLES = ["structure", "alert", "example", "text", "background"];
const FONT_ROLES = ["main", "mono"];

const ENVIRONMENTS: readonly Entry[] = [
  {
    label: "deckcanvas",
    snippet: "deckcanvas}\n\t$0\n\\end{deckcanvas}",
    detail: "キャンバス(1 フレームに 1 つ)",
    documentation: CANVAS_HOVER_DOCUMENTATION.deckcanvas.markdown,
  },
  {
    label: "decktext",
    snippet: `decktext}[x=\${1:0.100},y=\${2:0.100},w=\${3:0.400},size=\${4|${SIZE_CHOICES.join(",")}|}]\n\t$0\n\\end{decktext}`,
    detail: "キャンバス上のテキスト",
    documentation: CANVAS_HOVER_DOCUMENTATION.decktext.markdown,
  },
];

const COMMANDS: readonly Entry[] = [
  {
    label: "\\deckimage",
    snippet: `\\deckimage[x=\${1:0.100},y=\${2:0.100},w=\${3:0.400}]{\${4:assets/image.png}}`,
    detail: "キャンバス上の画像(deckcanvas の中)",
    documentation: CANVAS_HOVER_DOCUMENTATION.deckimage.markdown,
  },
  {
    label: "\\deckcolor",
    snippet: `\\deckcolor{\${1|${COLOR_ROLES.join(",")}|}}{\${2:0F62FE}}`,
    detail: "役割色(%% style の中)",
    documentation: `役割色を変えます。役割: ${COLOR_ROLES.map((role) => `\`${role}\``).join("、")}。色は 6 桁の 16 進数(\`#\` なし)。`,
  },
  {
    label: "\\deckfont",
    snippet: `\\deckfont{\${1|${FONT_ROLES.join(",")}|}}{\${2:Noto Sans CJK JP}}`,
    detail: "フォント(%% style の中)",
    documentation: "本文(`main`)か等幅(`mono`)のフォントを名前で指定します。",
  },
  {
    label: "\\decklogo",
    snippet: `\\decklogo[x=\${1:0.930},y=\${2:0.020},w=\${3:0.050}]{\${4:assets/logo.png}}`,
    detail: "全フレーム共通のロゴ(%% style の中)",
    documentation: `全フレームに同じ位置で出すロゴです。\`x\` / \`y\` / \`w\` はキャンバスと同じく${POSITION_DOC}`,
  },
  {
    label: "\\deckbackground",
    snippet: `\\deckbackground{\${1:assets/background.png}}`,
    detail: "背景画像(%% style の中)",
    documentation:
      "背景画像です。オプションなしは全スライド、`[title]` は表紙(`\\titlepage` を含むフレーム)だけで、表紙ではオプションなしより優先します。",
  },
  {
    label: "\\deckfooter",
    snippet: `\\deckfooter{\${1:テキスト}}`,
    detail: "フッター(%% style の中)",
    documentation: "フッターの左に出すテキストです。右にはページ番号が出ます。",
  },
];

const POSITION_OPTIONS: readonly Entry[] = [
  { label: "x", snippet: `x=\${1:0.100}`, detail: "左端の位置", documentation: POSITION_DOC },
  {
    label: "y",
    snippet: `y=\${1:0.100}`,
    detail: "上端の位置(下向きが正)",
    documentation: POSITION_DOC,
  },
  { label: "w", snippet: `w=\${1:0.400}`, detail: "幅", documentation: POSITION_DOC },
];

/** `[` の直前の名前ごとに、書けるオプション。 */
const OPTIONS: Readonly<Record<string, readonly Entry[]>> = {
  decktext: [
    ...POSITION_OPTIONS,
    {
      label: "size",
      snippet: "size=",
      detail: "文字サイズ",
      documentation: `${CANVAS_FONT_SIZES.map((size) => `\`${size}\``).join("、")}`,
      retrigger: true,
    },
  ],
  deckimage: POSITION_OPTIONS,
  decklogo: POSITION_OPTIONS,
  deckbackground: [{ label: "title", snippet: "title", detail: "表紙だけの背景" }],
};

const VALUES: Readonly<Record<string, readonly string[]>> = {
  "decktext:size": CANVAS_FONT_SIZES,
};

const ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  deckcolor: COLOR_ROLES,
  deckfont: FONT_ROLES,
};

/** 行頭から offset までにエスケープされていない `%` があるか。 */
function inComment(linePrefix: string): boolean {
  return /(^|[^\\])(\\\\)*%/.test(linePrefix);
}

function toCompletion(
  entry: Entry,
  kind: DeckCompletionKind,
  range: { start: number; end: number },
): DeckCompletion {
  return {
    label: entry.label,
    kind,
    snippet: entry.snippet,
    detail: entry.detail,
    range,
    ...(entry.documentation === undefined ? {} : { documentation: entry.documentation }),
    ...(entry.retrigger ? { retrigger: true } : {}),
  };
}

/** offset の位置で出す deck 語彙の候補。該当しなければ空。 */
export function deckCompletionsAt(source: string, offset: number): DeckCompletion[] {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const linePrefix = source.slice(lineStart, offset);
  if (inComment(linePrefix)) return [];

  // `\begin{` の後: 環境名。自動で閉じた `}` があればそれも置き換える。
  const begin = /\\begin\s*\{([A-Za-z]*)$/.exec(linePrefix);
  if (begin) {
    const start = offset - (begin[1] ?? "").length;
    const end = source[offset] === "}" ? offset + 1 : offset;
    return ENVIRONMENTS.map((entry) => toCompletion(entry, "environment", { start, end }));
  }

  // `\deckcolor{` / `\deckfont{` の 1 つ目の引数。
  const argument = /\\(deck[A-Za-z]+)\s*\{([A-Za-z]*)$/.exec(linePrefix);
  const argumentValues = argument && ARGUMENTS[argument[1] ?? ""];
  if (argument && argumentValues) {
    const start = offset - (argument[2] ?? "").length;
    return argumentValues.map((value) =>
      toCompletion({ label: value, snippet: value, detail: `\\${argument[1]}` }, "value", {
        start,
        end: offset,
      }),
    );
  }

  // `\begin{decktext}[` / `\deckimage[` などのオプション。
  const option =
    /(?:\\begin\s*\{(decktext)\}|\\(deckimage|decklogo|deckbackground))\s*\[([^\]]*)$/.exec(
      linePrefix,
    );
  if (option) {
    const name = option[1] ?? option[2] ?? "";
    const written = option[3] ?? "";
    const fragment = written.slice(written.lastIndexOf(",") + 1);
    const equals = fragment.indexOf("=");
    if (equals >= 0) {
      const key = fragment.slice(0, equals).trim();
      const values = VALUES[`${name}:${key}`];
      if (!values) return [];
      const typed = fragment.slice(equals + 1);
      const start = offset - typed.length + (typed.length - typed.trimStart().length);
      return values.map((value) =>
        toCompletion({ label: value, snippet: value, detail: key }, "value", {
          start,
          end: offset,
        }),
      );
    }
    const used = new Set(
      written
        .split(",")
        .slice(0, -1)
        .map((part) => (part.split("=")[0] ?? "").trim()),
    );
    const start = offset - fragment.trimStart().length;
    return (OPTIONS[name] ?? [])
      .filter((entry) => !used.has(entry.label))
      .map((entry) => toCompletion(entry, "option", { start, end: offset }));
  }

  // `\` から始まる命令名。`\d` `\dec` のように `deck` の途中でも出す。
  const command = /\\([A-Za-z]*)$/.exec(linePrefix);
  if (command) {
    const typed = command[1] ?? "";
    if (!("deck".startsWith(typed) || typed.startsWith("deck"))) return [];
    const start = offset - typed.length - 1;
    return COMMANDS.map((entry) => toCompletion(entry, "command", { start, end: offset }));
  }
  return [];
}
