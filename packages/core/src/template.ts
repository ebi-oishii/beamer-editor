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

/** 行内の `%` コメントを落とす(`\%` は残す)。オフセットを保つため同じ長さの空白に置き換える。 */
function blankComments(text: string): string {
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

/** preamble-extra に書かれた `\usetheme{X}` / `\usepackage{path}` をテンプレート参照として抽出する。 */
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
  return references;
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
  /** 全スライドの背景画像(`\usebackgroundtemplate` / `background canvas`)。 */
  background?: { path: string };
  footer?: string;
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
  return [...text.matchAll(/\\includegraphics\*?(?:\[([^\]]*)\])?\{([^}]+)\}/g)].map((m) => ({
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

/** `\command{arg1}{arg2}...` の連続する `{}` 引数を読む(オプション `[...]` は 1 つまで読み飛ばす)。 */
function* commandGroups(
  text: string,
  command: string,
  count: number,
): Generator<{ options: string | undefined; groups: string[] }> {
  const pattern = new RegExp(`\\\\${command}\\*?(?=[\\[{])`, "g");
  for (const match of text.matchAll(pattern)) {
    let cursor = (match.index ?? 0) + match[0].length;
    let options: string | undefined;
    if (text[cursor] === "[") {
      const close = text.indexOf("]", cursor);
      if (close === -1) continue;
      options = text.slice(cursor + 1, close);
      cursor = close + 1;
    }
    const groups: string[] = [];
    for (let i = 0; i < count; i++) {
      const group = balancedGroup(text, cursor);
      if (!group) break;
      groups.push(group.body);
      cursor = group.next;
    }
    if (groups.length === count) yield { options, groups };
  }
}

/**
 * 標準の Beamer / xcolor / fontspec 記法からプレビュー用スタイルを抽出する(近似)。
 * 解釈するもの: \definecolor(HTML/RGB/rgb/gray)・\colorlet、\setbeamercolor の
 * structure / alerted text / example text / normal text / background canvas、
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
  for (const { groups } of commandGroups(text, "colorlet", 2)) {
    const [name, other] = groups as [string, string];
    const hex = palette.get(other.trim());
    if (hex) palette.set(name.trim(), hex);
  }
  const resolveColor = (expression: string): string | null => {
    const name = expression.trim();
    if (/^[0-9A-Fa-f]{6}$/.test(name)) return name.toUpperCase();
    return palette.get(name) ?? null;
  };

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
    if (direct) return { path: direct.path, width: widthOption(direct.options) };
    const use = /\\pgfuseimage\{([^}]+)\}/.exec(body);
    return use ? (declaredImages.get((use[1] as string).trim()) ?? null) : null;
  };

  // ロゴ(既定テーマは右下に置く)
  for (const { groups } of commandGroups(text, "logo", 1)) {
    const image = imageIn(groups[0] as string);
    if (image) style.logo = { path: image.path, placement: { kind: "corner", width: image.width } };
  }

  // 背景画像
  for (const { groups } of commandGroups(text, "usebackgroundtemplate", 1)) {
    const image = imageIn(groups[0] as string);
    if (image) style.background = { path: image.path };
  }
  for (const { groups } of commandGroups(text, "setbeamertemplate", 2)) {
    const [key, body] = groups as [string, string];
    const name = key.trim();
    if (name !== "background canvas" && name !== "background") continue;
    const image = imageIn(body);
    if (image) style.background = { path: image.path };
  }

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
  for (const { groups } of commandGroups(text, "deckfooter", 1)) {
    style.footer = (groups[0] as string).trim();
  }
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
    if (style.footer !== undefined) merged.footer = style.footer;
  }
  return merged;
}

/** `.sty` が参照する画像パス(\includegraphics / \pgfdeclareimage)。デッキのディレクトリ基準。 */
export function templateImagePaths(source: string): string[] {
  const text = blankComments(source);
  const paths = new Set<string>();
  for (const image of includeGraphics(text)) paths.add(image.path);
  for (const { groups } of commandGroups(text, "pgfdeclareimage", 2)) {
    paths.add((groups[1] as string).trim());
  }
  return [...paths];
}
