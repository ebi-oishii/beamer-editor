/**
 * テンプレート(会社・組織の Beamer テーマ `.sty` + 画像)の読み込み支援(#70)。
 *
 * デッキは Beamer 標準の書き方でテンプレートを読む: `%% preamble-extra` に
 * `\usetheme{X}`(デッキと同じディレクトリの beamertheme<X>.sty)または
 * `\usepackage{templates/<name>/beamertheme<name>}`(サブフォルダ)を書くだけ。
 * 専用の語彙・メタデータ・設定は増やさない。
 *
 * core はファイルシステムに触らない。ここでは
 * - preamble-extra からテンプレート参照を抽出する
 * - `.sty` の原文から、プレビューで近似できるスタイル(色・フォント・ロゴ・背景)を
 *   標準の Beamer / xcolor / fontspec 記法のまま抽出する
 * - `.sty` が参照する画像パスを抽出する
 * だけを行い、ファイルの解決・読み込み・存在確認はホスト(VS Code 拡張・CLI)が担う。
 */

import type { DeckDocument, SourceSpan, StyleColorRole } from "./ast.js";

// ---------------------------------------------------------------------------
// 参照の抽出
// ---------------------------------------------------------------------------

export interface TemplateReference {
  /** `\usetheme{X}`(theme)か `\usepackage{path}`(package)か。 */
  kind: "theme" | "package";
  /** `\usetheme{X}` の X、または `\usepackage{path}` の path(拡張子なし)。 */
  name: string;
  /** 参照先候補のファイル名(デッキのディレクトリ基準の相対パス)。 */
  file: string;
  /** 元ソース上の位置(診断用)。 */
  span: SourceSpan;
}

/**
 * Beamer 同梱のプレゼンテーションテーマ。これらの `\usetheme` はテンプレート参照とみなさない
 * (beamerug-themes 準拠)。
 */
export const BEAMER_BUILTIN_THEMES: ReadonlySet<string> = new Set([
  "default",
  "boxes",
  "AnnArbor",
  "Antibes",
  "Bergen",
  "Berkeley",
  "Berlin",
  "Boadilla",
  "CambridgeUS",
  "Copenhagen",
  "Darmstadt",
  "Dresden",
  "EastLansing",
  "Frankfurt",
  "Goettingen",
  "Hannover",
  "Ilmenau",
  "JuanLesPins",
  "Luebeck",
  "Madrid",
  "Malmoe",
  "Marburg",
  "Montpellier",
  "PaloAlto",
  "Pittsburgh",
  "Rochester",
  "Singapore",
  "Szeged",
  "Warsaw",
]);

/**
 * 行内の `%` コメントを落とす(`\%` は残す)。オフセットを保つため同じ長さの空白に置き換える。
 * TeX と同じく、コメントは行末の改行も読み捨てる(コメントだけの行は空行ではない)ので、
 * 改行も空白にする。
 */
export function blankComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "\\" && i + 1 < text.length) {
      out += ch + (text[i + 1] as string);
      i += 2;
      continue;
    }
    if (ch === "%") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
      if (i < text.length) {
        out += " ";
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** `\usetheme` / `\usepackage` の `{...}` を列挙する。オプション `[...]` は読み飛ばす。 */
function* commandArguments(
  text: string,
  command: string,
): Generator<{ names: string[]; start: number; end: number }> {
  const pattern = new RegExp(`\\\\${command}\\*?(?:\\[[^\\]]*\\])?\\{([^}]*)\\}`, "g");
  for (const match of text.matchAll(pattern)) {
    const names = (match[1] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "");
    yield { names, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length };
  }
}

/**
 * preamble-extra に書かれた `\usetheme{X}` / `\usepackage{path}` をテンプレート参照として抽出する。
 * 返す順はソース順(TeX では後の指定が勝つので、\usetheme と \usepackage が混在しても記述順で重ねる)。
 */
export function templateReferencesOf(doc: DeckDocument): TemplateReference[] {
  const region = doc.preambleExtra;
  const text = blankComments(region.tex);
  const base = region.span.start;
  const references: TemplateReference[] = [];
  for (const { names, start, end } of commandArguments(text, "usetheme")) {
    for (const name of names) {
      if (BEAMER_BUILTIN_THEMES.has(name)) continue;
      references.push({
        kind: "theme",
        name,
        file: `beamertheme${name}.sty`,
        span: { start: base + start, end: base + end },
      });
    }
  }
  for (const { names, start, end } of commandArguments(text, "usepackage")) {
    for (const name of names) {
      references.push({
        kind: "package",
        name,
        file: name.endsWith(".sty") ? name : `${name}.sty`,
        span: { start: base + start, end: base + end },
      });
    }
  }
  return references.sort((a, b) => a.span.start - b.span.start);
}

/**
 * ホストが参照を解決した結果。lint(L022 / L023)の入力。
 * resolvedPath はデッキのディレクトリ基準の相対パス(見つからなければ null)。
 */
export interface TemplateStatus {
  reference: TemplateReference;
  resolvedPath: string | null;
  /** `.sty` が参照する画像のうち、デッキのディレクトリ基準で見つからなかったもの。 */
  missingImages: string[];
}

// ---------------------------------------------------------------------------
// プレビュー用スタイルの抽出(標準の Beamer 記法から、近似できるものだけ)
// ---------------------------------------------------------------------------

/** 長さ指定。pt か、\paperwidth / \textwidth の係数。 */
export type LengthSpec =
  | { unit: "pt"; value: number }
  | { unit: "paperwidth"; value: number }
  | { unit: "textwidth"; value: number };

export type PreviewLogoPlacement =
  | { kind: "canvas"; x: number; y: number; width: number }
  | { kind: "corner"; width: LengthSpec | null };

export interface PreviewLogo {
  path: string;
  placement: PreviewLogoPlacement;
}

/**
 * プレビューが解釈できるスタイル。`%% style` 領域の語彙と同じ範囲(色・フォント・ロゴ・
 * フッター)に背景画像を加えたもの。テンプレートや preamble-extra の原文から抽出する。
 */
export interface PreviewStyle {
  colors: Partial<Record<StyleColorRole, string>>;
  fonts: { main?: string; mono?: string };
  logo?: PreviewLogo;
  /** 全スライドの背景画像(`\usebackgroundtemplate` / `background canvas` / `addtobeamertemplate`)。 */
  background?: { path: string };
  /**
   * `\graphicspath` の探索ディレクトリ(出現順、重複なし)。ホストは画像を、デッキのディレクトリ基準で
   * 先に探し、無ければここを順に探す。
   */
  imageSearchPaths?: string[];
  footer?: string;
  /** ブロック(block / alertblock / exampleblock)の配色と形。指定があるときだけ持つ。 */
  blocks?: PreviewBlockStyle;
}

/**
 * ブロックの種類。Beamer の色名 `block title` / `block title alerted` / `block title example`
 * (body も同様)の接尾辞に対応する。
 */
export type PreviewBlockKind = "normal" | "alerted" | "example";

/** ブロック 1 種類ぶんの配色(RRGGBB)。書かれていないものは持たない。 */
export interface PreviewBlockColors {
  titleFg?: string;
  titleBg?: string;
  bodyFg?: string;
  bodyBg?: string;
}

/**
 * preamble-extra / テンプレートの `\setbeamercolor{block title}` 等と
 * `\setbeamertemplate{blocks}[rounded]` から読んだブロックの見た目(近似)。
 *
 * 色は種類ごとに「書かれたものだけ」を持つ。解釈不能な bg を伴う指定は
 * 同じ部位の fg / bg を持たず、既定表示へ戻す。継承は Beamer 既定
 * (beamercolorthemedefault.sty)に合わせてプレビューの CSS が解く:
 * - `block title` は `parent=structure`、`block title alerted` は `parent=alerted text`、
 *   `block title example` は `parent=example text`。よって title の fg が無ければ
 *   その種類の文字色(structure / alert / example)になり、bg が無ければ帯は無い。
 *   alerted / example の title は `block title` の bg を**継がない**
 * - `block body` / `block body alerted` / `block body example` は親を持たない。
 *   bg が無ければ箱は無く、fg が無ければ周りの文字色のまま。alerted / example の body は
 *   `block body` を**継がない**
 */
export interface PreviewBlockStyle {
  colors: Partial<Record<PreviewBlockKind, PreviewBlockColors>>;
  /**
   * 解釈不能な背景色で消したスロット。抽出元(.sty と preamble-extra など)をまたぐ
   * マージでも、先行する近似色を復活させないための内部状態。
   */
  cleared?: Partial<Record<PreviewBlockKind, Partial<Record<keyof PreviewBlockColors, true>>>>;
  /**
   * `\setbeamertemplate{blocks}[rounded][shadow=true]` / `[default]`、
   * `\useinnertheme[shadow]{rounded}`。書かれていなければ持たない(既定の角形)。
   */
  shape?: { rounded: boolean; shadow: boolean };
}

const XCOLOR_BASE: Record<string, string> = {
  black: "000000",
  white: "FFFFFF",
  red: "FF0000",
  green: "00FF00",
  blue: "0000FF",
  cyan: "00FFFF",
  magenta: "FF00FF",
  yellow: "FFFF00",
  gray: "808080",
  darkgray: "404040",
  lightgray: "BFBFBF",
  brown: "BF8040",
  lime: "BFFF00",
  olive: "808000",
  orange: "FF8000",
  pink: "FFBFBF",
  purple: "BF0040",
  teal: "008080",
  violet: "800080",
};

const BEAMER_COLOR_ROLES: Record<string, { fg?: StyleColorRole; bg?: StyleColorRole }> = {
  structure: { fg: "structure" },
  "alerted text": { fg: "alert" },
  "example text": { fg: "example" },
  "normal text": { fg: "text", bg: "background" },
  "background canvas": { bg: "background" },
};

/** `\setbeamercolor` のブロック用の色名 → 種類と部位。 */
const BEAMER_BLOCK_COLORS: Record<string, { kind: PreviewBlockKind; part: "title" | "body" }> = {
  "block title": { kind: "normal", part: "title" },
  "block body": { kind: "normal", part: "body" },
  "block title alerted": { kind: "alerted", part: "title" },
  "block body alerted": { kind: "alerted", part: "body" },
  "block title example": { kind: "example", part: "title" },
  "block body example": { kind: "example", part: "body" },
};

function hex2(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .toUpperCase()
    .padStart(2, "0");
}

/** `\definecolor` のモデル別の値を RRGGBB に正規化する。対応外は null。 */
function colorFromModel(model: string, spec: string): string | null {
  const parts = spec.split(",").map((part) => Number(part.trim()));
  switch (model.trim()) {
    case "HTML": {
      const hex = spec.trim().toUpperCase();
      return /^[0-9A-F]{6}$/.test(hex) ? hex : null;
    }
    case "RGB":
      return parts.length === 3 && parts.every(Number.isFinite)
        ? parts.map((v) => hex2(v)).join("")
        : null;
    case "rgb":
      return parts.length === 3 && parts.every(Number.isFinite)
        ? parts.map((v) => hex2(v * 255)).join("")
        : null;
    case "gray":
      return parts.length === 1 && Number.isFinite(parts[0])
        ? hex2((parts[0] as number) * 255).repeat(3)
        : null;
    default:
      return null;
  }
}

/**
 * xcolor の色式を RRGGBB にする。色名・6 桁の 16 進に加え、混色 `a!p!b`(p% の a と残りの b)・
 * `a!p`(残りは white)・連鎖 `a!p1!b!p2!c`(左から順に、途中の結果を次の a として混ぜる)を読む。
 * p は 0〜100 に丸める。補色 `-red`・`rgb:...`・`structure.fg` のような参照など、それ以外は null。
 * 混色は RGB の線形補間(xcolor は色のモデルで混ぜるが、gray の基本色も RGB で混ぜて同じ値になる)。
 */
function resolveColorExpression(
  expression: string,
  lookup: (name: string) => string | undefined,
): string | null {
  const channels = (name: string): number[] | null => {
    const hex = /^[0-9A-Fa-f]{6}$/.test(name) ? name.toUpperCase() : lookup(name);
    return hex ? [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) : null;
  };
  const parts = expression.split("!").map((part) => part.trim());
  let current = channels(parts[0] as string);
  for (let i = 1; current && i < parts.length; i += 2) {
    const percent = parts[i] as string;
    if (!/^\d*\.?\d+$/.test(percent)) return null;
    const ratio = Math.min(100, Number(percent)) / 100;
    const other = channels(parts[i + 1] ?? "white");
    if (!other) return null;
    current = current.map((value, c) => value * ratio + (other[c] as number) * (1 - ratio));
  }
  return current ? current.map((value) => hex2(value)).join("") : null;
}

/** `\setbeamertemplate{blocks}[rounded][...]` / `\useinnertheme[...]{rounded}` の shadow(既定 false)。 */
function shadowOption(options: string | undefined): boolean {
  const match = /(?:^|,)\s*shadow\s*(?:=\s*(\w+)\s*)?(?:,|$)/.exec(options ?? "");
  return match !== null && match[1] !== "false";
}

/** `1.2cm` / `0.1\paperwidth` / `2em`(非対応)などの長さを解釈する。 */
export function parseLength(raw: string): LengthSpec | null {
  const value = raw.trim();
  const macro = /^([-+]?\d*\.?\d+)?\s*\\(paperwidth|textwidth|linewidth)$/.exec(value);
  if (macro) {
    const factor = macro[1] === undefined || macro[1] === "" ? 1 : Number(macro[1]);
    return {
      unit: macro[2] === "paperwidth" ? "paperwidth" : "textwidth",
      value: factor,
    };
  }
  const unit = /^([-+]?\d*\.?\d+)\s*(pt|bp|mm|cm|in)$/.exec(value);
  if (!unit) return null;
  const amount = Number(unit[1]);
  const perPt: Record<string, number> = { pt: 1, bp: 1.00375, mm: 2.845, cm: 28.45, in: 72.27 };
  return { unit: "pt", value: Math.round(amount * (perPt[unit[2] as string] ?? 1) * 1000) / 1000 };
}

/** `[width=...,height=...]` から width を取り出す。 */
function widthOption(options: string | undefined): LengthSpec | null {
  if (!options) return null;
  const match = /(?:^|,)\s*width\s*=\s*([^,\]]+)/.exec(options);
  return match ? parseLength(match[1] as string) : null;
}

/** `\includegraphics[opts]{path}` を全て返す。 */
function includeGraphics(text: string): { path: string; options: string | undefined }[] {
  return [...text.matchAll(/\\includegraphics\*?\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g)].map((m) => ({
    path: (m[2] as string).trim(),
    options: m[1],
  }));
}

/** `{...}` の中身を、入れ子を数えて取り出す。 */
function balancedGroup(text: string, open: number): { body: string; next: number } | null {
  if (text[open] !== "{") return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0)
      return { body: text.slice(open + 1, i), next: i + 1 };
  }
  return null;
}

/**
 * `from` から空白を読み飛ばす。ただし空行(= \par)は越えない(TeX は long でないマクロの
 * 引数探索を \par で打ち切る)。越えるなら null。コメントは blankComments で空白になっている。
 */
function skipArgumentSpace(text: string, from: number): number | null {
  let cursor = from;
  let newlines = 0;
  while (cursor < text.length && /\s/.test(text[cursor] as string)) {
    if (text[cursor] === "\n" && ++newlines >= 2) return null;
    cursor++;
  }
  return cursor;
}

/**
 * `\command{arg1}{arg2}...` の連続する `{}` 引数を読む(オプション `[...]` は 1 つまで読み飛ばす)。
 * コマンド名と引数、引数どうしの間の空白・改行は許す(空行は越えない)。index はコマンドの位置。
 */
function* commandGroups(
  text: string,
  command: string,
  count: number,
): Generator<{ index: number; options: string | undefined; groups: string[] }> {
  const pattern = new RegExp(`\\\\${command}\\*?(?=\\s*[\\[{])`, "g");
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    let cursor = skipArgumentSpace(text, index + match[0].length);
    if (cursor === null) continue;
    let options: string | undefined;
    if (text[cursor] === "[") {
      const close = text.indexOf("]", cursor);
      if (close === -1) continue;
      options = text.slice(cursor + 1, close);
      cursor = close + 1;
    }
    const groups: string[] = [];
    for (let i = 0; i < count; i++) {
      const open = skipArgumentSpace(text, cursor);
      if (open === null) break;
      const group = balancedGroup(text, open);
      if (!group) break;
      groups.push(group.body);
      cursor = group.next;
    }
    if (groups.length === count) yield { index, options, groups };
  }
}

const GRAPHICS_PATH = /\\graphicspath\s*\{((?:\s*\{[^{}]*\}\s*)+)\}/g;

/**
 * `\graphicspath{{images/}{figs/}}` の探索ディレクトリ(出現順、重複なし)。
 * `\includegraphics{foo}` の実体はこの下にもあり得る。ホストは画像を解決するとき、
 * デッキのディレクトリ基準を先に、次にここを順に探す。コメントの中は見ない。
 */
export function graphicsPathsOf(tex: string): string[] {
  const found = new Set<string>();
  for (const match of blankComments(tex).matchAll(GRAPHICS_PATH)) {
    for (const entry of (match[1] ?? "").matchAll(/\{([^{}]*)\}/g)) {
      const directory = (entry[1] ?? "").trim();
      if (directory !== "" && !/[\\\n%]/.test(directory)) found.add(directory);
    }
  }
  return [...found];
}

/**
 * `\graphicspath` の探索ディレクトリ 1 つと画像パスを、デッキのディレクトリ基準の相対パスにつなぐ。
 * `./` と末尾の `/` は整える(`..` や絶対パスはそのまま残すので、ホストの「デッキ配下に限る」検査が弾く)。
 */
export function joinImageSearchPath(directory: string, imagePath: string): string {
  const base = directory.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  return base === "" || base === "." ? imagePath : `${base}/${imagePath}`;
}

/**
 * 画像パスが `\name` だけで、同じ text に `\newcommand{\name}{path}` / `\newcommand\name{path}` /
 * `\renewcommand` / `\providecommand` / `\def\name{path}` があれば、その本文に置き換える
 * (最後の定義を採る)。本文が素の文字列(`\` `{` `}` `#` を含まない)の単純な場合だけで、
 * それ以外は元のパスのまま返す。
 */
function expandMacroPath(imagePath: string, text: string): string {
  const name = /^\\([A-Za-z@]+)$/.exec(imagePath)?.[1];
  if (name === undefined) return imagePath;
  const body = "\\{([^{}\\\\#]*)\\}";
  const patterns = [
    new RegExp(`\\\\(?:re|provide)?newcommand\\*?\\s*\\{\\s*\\\\${name}\\s*\\}\\s*${body}`, "g"),
    new RegExp(`\\\\(?:re|provide)?newcommand\\*?\\s*\\\\${name}(?![A-Za-z@])\\s*${body}`, "g"),
    new RegExp(`\\\\def\\s*\\\\${name}(?![A-Za-z@])\\s*${body}`, "g"),
  ];
  let found: { index: number; value: string } | null = null;
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      const value = (match[1] ?? "").trim();
      if (value !== "" && (found === null || index > found.index)) found = { index, value };
    }
  }
  return found?.value ?? imagePath;
}

/**
 * 標準の Beamer / xcolor / fontspec 記法からプレビュー用スタイルを抽出する(近似)。
 * 解釈するもの: \definecolor(HTML/RGB/rgb/gray)・\colorlet、xcolor の混色式(`blue!75!black` 等)、
 * \setbeamercolor の structure / alerted text / example text / normal text / background canvas と
 * block title / block body(alerted / example 含む)、\setbeamertemplate{blocks}[rounded] と
 * \useinnertheme{rounded}、
 * \setsansfont / \setmainfont / \setmonofont、\logo{\includegraphics...} と
 * \pgfdeclareimage + \pgfuseimage、\usebackgroundtemplate / \setbeamertemplate{background canvas}。
 * ツールの語彙(\deckcolor 等)が書かれていればそれも読む。それ以外は PDF 専用。
 */
export function extractPreviewStyle(source: string): PreviewStyle {
  const text = blankComments(source);
  const style: PreviewStyle = { colors: {}, fonts: {} };

  // 色名 → RRGGBB
  const palette = new Map<string, string>(Object.entries(XCOLOR_BASE));
  for (const { groups } of commandGroups(text, "definecolor", 3)) {
    const [name, model, spec] = groups as [string, string, string];
    const hex = colorFromModel(model, spec);
    if (hex) palette.set(name.trim(), hex);
  }
  const resolveColor = (expression: string): string | null =>
    resolveColorExpression(expression, (name) => palette.get(name));
  for (const { groups } of commandGroups(text, "colorlet", 2)) {
    const [name, other] = groups as [string, string];
    const hex = resolveColor(other);
    if (hex) palette.set(name.trim(), hex);
  }

  for (const { groups } of commandGroups(text, "setbeamercolor", 2)) {
    const [key, spec] = groups as [string, string];
    const roles = BEAMER_COLOR_ROLES[key.trim()];
    if (!roles) continue;
    for (const part of spec.split(",")) {
      const [k, v] = part.split("=").map((s) => s.trim());
      if (!k || v === undefined) continue;
      const role = k === "fg" ? roles.fg : k === "bg" ? roles.bg : undefined;
      const hex = resolveColor(v);
      if (role && hex) style.colors[role] = hex;
    }
  }

  // ブロックの配色(継承は PreviewBlockStyle の説明どおりプレビュー側で解く)
  const blocks: PreviewBlockStyle = { colors: {} };
  for (const { groups } of commandGroups(text, "setbeamercolor", 2)) {
    const [key, spec] = groups as [string, string];
    const target = BEAMER_BLOCK_COLORS[key.trim().replace(/\s+/g, " ")];
    if (!target) continue;
    const entries = spec.split(",").map((part) => {
      const [k, v] = part.split("=").map((s) => s.trim());
      return { key: k, value: v };
    });
    const background = [...entries].reverse().find((entry) => entry.key === "bg");
    const colors = blocks.colors[target.kind] ?? {};
    const fgSlot = `${target.part}Fg` as const;
    const bgSlot = `${target.part}Bg` as const;
    const cleared = blocks.cleared?.[target.kind] ?? {};

    // A foreground chosen for a background which the preview cannot resolve is
    // unsafe: it can turn into white text on the preview's white background.
    // Treat that part of the command as unsupported and clear an earlier preview
    // approximation, so CSS falls back to Beamer's readable default.  fg-only
    // commands remain supported because they have no background to approximate.
    if (background?.value !== undefined && !resolveColor(background.value)) {
      delete colors[fgSlot];
      delete colors[bgSlot];
      blocks.cleared = {
        ...blocks.cleared,
        [target.kind]: { ...cleared, [fgSlot]: true, [bgSlot]: true },
      };
      if (Object.keys(colors).length === 0) delete blocks.colors[target.kind];
      else blocks.colors[target.kind] = colors;
      continue;
    }

    const resolved: Partial<PreviewBlockColors> = {};
    for (const entry of entries) {
      if ((entry.key !== "fg" && entry.key !== "bg") || entry.value === undefined) continue;
      const hex = resolveColor(entry.value);
      if (!hex) continue;
      const slot = entry.key === "fg" ? fgSlot : bgSlot;
      resolved[slot] = hex;
      delete cleared[slot];
    }
    if (Object.keys(cleared).length === 0) {
      if (blocks.cleared) delete blocks.cleared[target.kind];
    } else blocks.cleared = { ...blocks.cleared, [target.kind]: cleared };
    if (Object.keys(resolved).length > 0) blocks.colors[target.kind] = { ...colors, ...resolved };
  }
  // ブロックの形(\setbeamertemplate{blocks}[...] と \useinnertheme{rounded} を記述順に。後が勝つ)
  const shapePattern =
    /\\(?:setbeamertemplate\*?\s*\{\s*blocks\s*\}((?:\s*\[[^\]]*\])+)|useinnertheme\s*(?:\[([^\]]*)\])?\s*\{\s*rounded\s*\})/g;
  for (const match of text.matchAll(shapePattern)) {
    if (match[1] === undefined) {
      blocks.shape = { rounded: true, shadow: shadowOption(match[2]) };
      continue;
    }
    const [template, options] = [...match[1].matchAll(/\[([^\]]*)\]/g)].map((m) =>
      (m[1] as string).trim(),
    );
    if (template === "rounded") blocks.shape = { rounded: true, shadow: shadowOption(options) };
    else if (template === "default") blocks.shape = { rounded: false, shadow: false };
  }
  if (
    Object.keys(blocks.colors).length > 0 ||
    Object.keys(blocks.cleared ?? {}).length > 0 ||
    blocks.shape
  )
    style.blocks = blocks;

  // フォント(名前参照)
  for (const command of ["setsansfont", "setmainfont"]) {
    for (const { groups } of commandGroups(text, command, 1)) {
      style.fonts.main = (groups[0] as string).trim();
    }
  }
  for (const { groups } of commandGroups(text, "setmonofont", 1)) {
    style.fonts.mono = (groups[0] as string).trim();
  }

  // 画像の名前参照(\pgfdeclareimage[opts]{name}{path} → \pgfuseimage{name})
  const declaredImages = new Map<string, { path: string; width: LengthSpec | null }>();
  for (const { options, groups } of commandGroups(text, "pgfdeclareimage", 2)) {
    const [name, path] = groups as [string, string];
    declaredImages.set(name.trim(), { path: path.trim(), width: widthOption(options) });
  }
  const imageIn = (body: string): { path: string; width: LengthSpec | null } | null => {
    const direct = includeGraphics(body)[0];
    if (direct) {
      return { path: expandMacroPath(direct.path, text), width: widthOption(direct.options) };
    }
    const use = /\\pgfuseimage\{([^}]+)\}/.exec(body);
    const declared = use ? declaredImages.get((use[1] as string).trim()) : undefined;
    return declared ? { ...declared, path: expandMacroPath(declared.path, text) } : null;
  };

  // ロゴ(既定テーマは右下に置く)
  for (const { groups } of commandGroups(text, "logo", 1)) {
    const image = imageIn(groups[0] as string);
    if (image) style.logo = { path: image.path, placement: { kind: "corner", width: image.width } };
  }

  // 背景画像。TeX では後の指定が勝つので、コマンドの種類をまたいでソース順に並べて最後を採る。
  const backgrounds: { index: number; path: string }[] = [];
  for (const { index, groups } of commandGroups(text, "usebackgroundtemplate", 1)) {
    const image = imageIn(groups[0] as string);
    if (image) backgrounds.push({ index, path: image.path });
  }
  for (const { index, groups } of commandGroups(text, "setbeamertemplate", 2)) {
    const [key, body] = groups as [string, string];
    const name = key.trim();
    if (name !== "background canvas" && name !== "background") continue;
    const image = imageIn(body);
    if (image) backgrounds.push({ index, path: image.path });
  }
  // \addtobeamertemplate{background}{前}{後}: 前後どちらかに画像があれば背景とみなす(後を優先)。
  for (const { index, groups } of commandGroups(text, "addtobeamertemplate", 3)) {
    const [key, pre, post] = groups as [string, string, string];
    const name = key.trim();
    if (name !== "background canvas" && name !== "background") continue;
    const image = imageIn(post) ?? imageIn(pre);
    if (image) backgrounds.push({ index, path: image.path });
  }
  backgrounds.sort((a, b) => a.index - b.index);
  const lastBackground = backgrounds.at(-1);
  if (lastBackground) style.background = { path: lastBackground.path };

  // ツールの語彙が .sty に書かれている場合(theme-design.md §2)
  for (const { groups } of commandGroups(text, "deckcolor", 2)) {
    const [role, hex] = groups as [string, string];
    const value = resolveColor(hex);
    if (value && role.trim() in BEAMER_COLOR_ROLES_BY_ROLE) {
      style.colors[role.trim() as StyleColorRole] = value;
    }
  }
  for (const { groups } of commandGroups(text, "deckfont", 2)) {
    const [slot, family] = groups as [string, string];
    if (slot.trim() === "main" || slot.trim() === "mono") {
      style.fonts[slot.trim() as "main" | "mono"] = family.trim();
    }
  }
  for (const { options, groups } of commandGroups(text, "decklogo", 1)) {
    const position = { x: 0, y: 0, width: 0.1 };
    for (const part of (options ?? "").split(",")) {
      const [k, v] = part.split("=").map((s) => s.trim());
      const n = Number(v);
      if (k === "x" && Number.isFinite(n)) position.x = n;
      if (k === "y" && Number.isFinite(n)) position.y = n;
      if (k === "w" && Number.isFinite(n)) position.width = n;
    }
    style.logo = {
      path: (groups[0] as string).trim(),
      placement: { kind: "canvas", ...position },
    };
  }
  for (const { options, groups } of commandGroups(text, "deckbackground", 1)) {
    // [title](表紙だけの背景)は土台スタイルでは扱わない(全スライドの背景だけを持つ)。
    if ((options ?? "").trim() === "") style.background = { path: (groups[0] as string).trim() };
  }
  for (const { groups } of commandGroups(text, "deckfooter", 1)) {
    style.footer = (groups[0] as string).trim();
  }
  const searchPaths = graphicsPathsOf(source);
  if (searchPaths.length > 0) style.imageSearchPaths = searchPaths;
  return style;
}

const BEAMER_COLOR_ROLES_BY_ROLE: Record<StyleColorRole, true> = {
  structure: true,
  alert: true,
  example: true,
  text: true,
  background: true,
};

/** 後のものが前のものを上書きして 1 つにまとめる。 */
export function mergePreviewStyles(...styles: PreviewStyle[]): PreviewStyle {
  const merged: PreviewStyle = { colors: {}, fonts: {} };
  for (const style of styles) {
    Object.assign(merged.colors, style.colors);
    Object.assign(merged.fonts, style.fonts);
    if (style.logo) merged.logo = style.logo;
    if (style.background) merged.background = style.background;
    // \graphicspath は TeX でもプリアンブル全体で積み上がる(どの画像にも効く)ので、
    // 供給元を区別せず、ソース順に連結して重複を除く。
    if (style.imageSearchPaths) {
      merged.imageSearchPaths = [
        ...new Set([...(merged.imageSearchPaths ?? []), ...style.imageSearchPaths]),
      ];
    }
    if (style.footer !== undefined) merged.footer = style.footer;
    if (style.blocks) {
      const blocks: PreviewBlockStyle = merged.blocks ?? { colors: {} };
      merged.blocks = blocks;
      for (const [kind, cleared] of Object.entries(style.blocks.cleared ?? {})) {
        const key = kind as PreviewBlockKind;
        const colors = blocks.colors[key] ?? {};
        for (const slot of Object.keys(cleared) as (keyof PreviewBlockColors)[])
          delete colors[slot];
        if (Object.keys(colors).length === 0) delete blocks.colors[key];
        else blocks.colors[key] = colors;
        blocks.cleared = { ...blocks.cleared, [key]: { ...blocks.cleared?.[key], ...cleared } };
      }
      for (const [kind, colors] of Object.entries(style.blocks.colors)) {
        const key = kind as PreviewBlockKind;
        blocks.colors[key] = { ...blocks.colors[key], ...colors };
        const cleared = blocks.cleared?.[key];
        if (cleared) {
          for (const slot of Object.keys(colors) as (keyof PreviewBlockColors)[])
            delete cleared[slot];
          if (Object.keys(cleared).length === 0) delete blocks.cleared?.[key];
        }
      }
      if (blocks.cleared && Object.keys(blocks.cleared).length === 0) delete blocks.cleared;
      if (style.blocks.shape) blocks.shape = style.blocks.shape;
    }
  }
  return merged;
}

/** `.sty` が参照する画像パス(\includegraphics / \pgfdeclareimage)。デッキのディレクトリ基準。 */
export function templateImagePaths(source: string): string[] {
  const text = blankComments(source);
  const paths = new Set<string>();
  for (const image of includeGraphics(text)) paths.add(expandMacroPath(image.path, text));
  for (const { groups } of commandGroups(text, "pgfdeclareimage", 2)) {
    paths.add(expandMacroPath((groups[1] as string).trim(), text));
  }
  return [...paths];
}
