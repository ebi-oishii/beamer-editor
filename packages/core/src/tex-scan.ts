/**
 * TeX ソースの最小トークナイザ。
 *
 * parser(フレーム・環境・文書の境界)と slide-edit(本文の `\label` 検査)が、
 * 「実際に TeX に読まれる制御綴」を同じ規則で判定するための共有実装。
 * 次の範囲は中身を制御綴として数えない:
 * - `%` から行末までのコメント(`\%` は制御記号として先に消費される)
 * - `\verb<d>…<d>`(同じ行で閉じなければ行末まで)
 * - verbatim 系環境の本文(最初の literal な終了タグまで)
 * - `\string` / `\meaning` の直後の 1 トークンと `\detokenize{…}`
 * - マクロ定義の引数(定義は definition トークン 1 つにまとめ、本体の span を返す)
 */

import type { SourceSpan } from "./ast.js";

/**
 * 本文を TeX として解釈しない環境。parser / expander / linter / slide-edit 共通。
 * fancyvrb の Verbatim / BVerbatim / LVerbatim も終了タグを literal に探すため同じ扱い。
 */
export const VERBATIM_ENVS: ReadonlySet<string> = new Set([
  "verbatim",
  "verbatim*",
  "semiverbatim",
  "lstlisting",
  "minted",
  "Verbatim",
  "Verbatim*",
  "BVerbatim",
  "BVerbatim*",
  "LVerbatim",
  "LVerbatim*",
]);

export type TexToken =
  | { kind: "command"; name: string; start: number; end: number }
  | { kind: "begin" | "end"; name: string; start: number; end: number }
  | { kind: "verbatim"; name: string; start: number; end: number }
  | {
      kind: "definition";
      target: "command" | "environment";
      name: string;
      /** 置換テキスト(環境は begin / end の 2 つ、`\let` は代入元の制御綴)。 */
      bodies: SourceSpan[];
      start: number;
      end: number;
    }
  /**
   * 閉じない verbatim 系環境の開始タグ。TeX では以降が読めないが、入力途中の文書で
   * 後続の構造を失わないよう、走査は開始タグの直後から続ける。厳密さが要る呼び出し側
   * (slide-edit・折りたたみ)はこのトークンを見て処理を拒否する。
   */
  | { kind: "unterminated"; name: string; start: number; end: number };

const LETTER = /[A-Za-z@]/;

const LATEX_COMMAND_DEFINITIONS = new Set([
  "newcommand",
  "renewcommand",
  "providecommand",
  "DeclareRobustCommand",
  "newrobustcmd",
  "renewrobustcmd",
  "providerobustcmd",
]);
const LATEX_ENVIRONMENT_DEFINITIONS = new Set([
  "newenvironment",
  "renewenvironment",
  "provideenvironment",
]);
const DOCUMENT_COMMAND_DEFINITIONS = new Set([
  "NewDocumentCommand",
  "RenewDocumentCommand",
  "ProvideDocumentCommand",
  "DeclareDocumentCommand",
  "NewExpandableDocumentCommand",
  "RenewExpandableDocumentCommand",
  "ProvideExpandableDocumentCommand",
  "DeclareExpandableDocumentCommand",
]);
const DOCUMENT_ENVIRONMENT_DEFINITIONS = new Set([
  "NewDocumentEnvironment",
  "RenewDocumentEnvironment",
  "ProvideDocumentEnvironment",
  "DeclareDocumentEnvironment",
]);
const PRIMITIVE_DEFINITIONS = new Set(["def", "gdef", "edef", "xdef"]);

function lineEnd(src: string, at: number, to: number): number {
  let i = at;
  while (i < to && src[i] !== "\n" && src[i] !== "\r") i++;
  return i;
}

/** `\` の位置から制御綴の終端を返す。 */
function controlEnd(src: string, at: number, to: number): number {
  let i = at + 1;
  if (i >= to) return to;
  if (!LETTER.test(src[i] as string)) return i + 1;
  while (i < to && LETTER.test(src[i] as string)) i++;
  return i;
}

/** 空白(改行を含む)とコメントを読み飛ばす。 */
function skipTrivia(src: string, at: number, to: number): number {
  let i = at;
  for (;;) {
    while (i < to && /\s/.test(src[i] as string)) i++;
    if (i < to && src[i] === "%") {
      i = lineEnd(src, i, to);
      continue;
    }
    return i;
  }
}

/**
 * `open` にある `{`(または `[`)に対応する閉じの直後を返す。コメントとエスケープを考慮し、
 * `[…]` では TeX と同様に波括弧内の `]` を閉じとみなさない。
 */
function groupEnd(src: string, open: number, to: number, o = "{", c = "}"): number | null {
  if (src[open] !== o) return null;
  let depth = 0;
  let braces = 0;
  for (let i = open; i < to; i++) {
    const ch = src[i] as string;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "%") {
      i = lineEnd(src, i, to);
      continue;
    }
    if (o !== "{") {
      if (ch === "{") braces++;
      else if (ch === "}") braces--;
      if (braces > 0) continue;
    }
    if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i + 1;
  }
  return null;
}

/** 1 トークン(制御綴または 1 文字)の終端。 */
function tokenEnd(src: string, at: number, to: number): number {
  return src[at] === "\\" ? controlEnd(src, at, to) : Math.min(at + 1, to);
}

/**
 * `\verb` / `\verb*` の直後(`*` の手前)から verb 引数の終端を返す。区切り文字が無い、
 * または空白なら null(ただの制御綴)。同じ行で閉じなければ行末まで(TeX ではエラー)。
 */
export function verbArgumentEnd(src: string, at: number, to = src.length): number | null {
  let i = at;
  if (src[i] === "*") i++;
  const delimiter = src[i];
  if (i >= to || delimiter === undefined || /\s/.test(delimiter)) return null;
  const eol = lineEnd(src, i + 1, to);
  const close = src.indexOf(delimiter, i + 1);
  return close !== -1 && close < eol ? close + 1 : eol;
}

/** 定義される名前(`{\name}` / `\name` / 環境は `{name}`)を読む。 */
function readDefinedName(
  src: string,
  at: number,
  to: number,
  environment: boolean,
): { name: string; end: number } | null {
  if (src[at] === "{") {
    const end = groupEnd(src, at, to);
    if (end === null) return null;
    const name = src.slice(at + 1, end - 1).trim();
    if (environment) return name === "" ? null : { name, end };
    return /^\\(?:[A-Za-z@]+|.)$/.test(name) ? { name: name.slice(1), end } : null;
  }
  if (environment || src[at] !== "\\") return null;
  const end = controlEnd(src, at, to);
  return { name: src.slice(at + 1, end), end };
}

function readDefinition(
  src: string,
  command: string,
  start: number,
  at: number,
  to: number,
): Extract<TexToken, { kind: "definition" }> | null {
  const environment =
    LATEX_ENVIRONMENT_DEFINITIONS.has(command) || DOCUMENT_ENVIRONMENT_DEFINITIONS.has(command);
  const bodies: SourceSpan[] = [];
  const group = (from: number): number | null => {
    const open = skipTrivia(src, from, to);
    const end = groupEnd(src, open, to);
    if (end !== null) bodies.push({ start: open + 1, end: end - 1 });
    return end;
  };
  let cursor = skipTrivia(src, at, to);

  if (command === "let") {
    const name = readDefinedName(src, cursor, to, false);
    if (!name) return null;
    cursor = skipTrivia(src, name.end, to);
    if (src[cursor] === "=") cursor = skipTrivia(src, cursor + 1, to);
    if (cursor >= to) return null;
    const end = tokenEnd(src, cursor, to);
    bodies.push({ start: cursor, end });
    return { kind: "definition", target: "command", name: name.name, bodies, start, end };
  }
  if (PRIMITIVE_DEFINITIONS.has(command)) {
    const name = readDefinedName(src, cursor, to, false);
    if (!name) return null;
    // パラメータテキストは最初の `{` まで。
    cursor = name.end;
    while (cursor < to && src[cursor] !== "{") {
      if (src[cursor] === "}") return null;
      if (src[cursor] === "%") cursor = lineEnd(src, cursor, to);
      else cursor = tokenEnd(src, cursor, to);
    }
    const end = group(cursor);
    return end === null
      ? null
      : { kind: "definition", target: "command", name: name.name, bodies, start, end };
  }

  if (LATEX_COMMAND_DEFINITIONS.has(command) || LATEX_ENVIRONMENT_DEFINITIONS.has(command)) {
    if (src[cursor] === "*") cursor = skipTrivia(src, cursor + 1, to);
  }
  const name = readDefinedName(src, cursor, to, environment);
  if (!name) return null;
  cursor = name.end;
  if (DOCUMENT_COMMAND_DEFINITIONS.has(command) || DOCUMENT_ENVIRONMENT_DEFINITIONS.has(command)) {
    // 引数仕様は置換テキストではない。
    const spec = skipTrivia(src, cursor, to);
    const specEnd = groupEnd(src, spec, to);
    if (specEnd === null) return null;
    cursor = specEnd;
  } else {
    for (let count = 0; count < 2; count++) {
      const open = skipTrivia(src, cursor, to);
      const end = groupEnd(src, open, to, "[", "]");
      if (end === null) break;
      cursor = end;
    }
  }
  let end = group(cursor);
  if (end !== null && environment) end = group(end);
  if (end === null) return null;
  return {
    kind: "definition",
    target: environment ? "environment" : "command",
    name: name.name,
    bodies,
    start,
    end,
  };
}

function isDefinitionCommand(name: string): boolean {
  return (
    name === "let" ||
    PRIMITIVE_DEFINITIONS.has(name) ||
    LATEX_COMMAND_DEFINITIONS.has(name) ||
    LATEX_ENVIRONMENT_DEFINITIONS.has(name) ||
    DOCUMENT_COMMAND_DEFINITIONS.has(name) ||
    DOCUMENT_ENVIRONMENT_DEFINITIONS.has(name)
  );
}

/** [from, to) の生きたトークンを先頭から列挙する。 */
export function* texTokens(src: string, from = 0, to = src.length): Generator<TexToken> {
  let i = from;
  while (i < to) {
    const ch = src[i];
    if (ch === "%") {
      i = lineEnd(src, i, to);
      continue;
    }
    if (ch !== "\\") {
      i++;
      continue;
    }
    const start = i;
    const end = controlEnd(src, i, to);
    const name = src.slice(i + 1, end);
    i = end;

    if (name === "verb") {
      const verbEnd = verbArgumentEnd(src, end, to);
      if (verbEnd !== null) {
        i = verbEnd;
        continue;
      }
    } else if (name === "string" || name === "meaning") {
      const next = skipTrivia(src, end, to);
      if (next < to) i = tokenEnd(src, next, to);
      continue;
    } else if (name === "detokenize") {
      const next = skipTrivia(src, end, to);
      const close = groupEnd(src, next, to);
      if (close !== null) i = close;
      continue;
    } else if ((name === "begin" || name === "end") && src[end] === "{") {
      let close = end + 1;
      while (close < to && !"}\\\r\n".includes(src[close] as string)) close++;
      if (src[close] === "}" && close < to) {
        const environment = src.slice(end + 1, close);
        const tagEnd = close + 1;
        i = tagEnd;
        if (name === "begin" && VERBATIM_ENVS.has(environment)) {
          const endTag = `\\end{${environment}}`;
          const endAt = src.indexOf(endTag, tagEnd);
          if (endAt === -1 || endAt + endTag.length > to) {
            // 書きかけのコードブロックで後続のフレームを見失わないよう、
            // 開始タグだけを報告して以降は通常どおり走査する。
            yield { kind: "unterminated", name: environment, start, end: tagEnd };
            continue;
          }
          i = endAt + endTag.length;
          yield { kind: "verbatim", name: environment, start, end: i };
          continue;
        }
        yield { kind: name, name: environment, start, end: tagEnd };
        continue;
      }
    } else if (isDefinitionCommand(name)) {
      const definition = readDefinition(src, name, start, end, to);
      if (definition) {
        i = definition.end;
        yield definition;
        continue;
      }
    }
    yield { kind: "command", name, start, end };
  }
}

/** 定義本体の中の定義も含め、ソース中のマクロ定義をすべて集める。 */
export function macroDefinitions(
  src: string,
  from = 0,
  to = src.length,
): Extract<TexToken, { kind: "definition" }>[] {
  const out: Extract<TexToken, { kind: "definition" }>[] = [];
  for (const token of texTokens(src, from, to)) {
    if (token.kind !== "definition") continue;
    out.push(token);
    for (const body of token.bodies) out.push(...macroDefinitions(src, body.start, body.end));
  }
  return out;
}

/**
 * 最初の生きた `\begin{document}` と、その後の最初の生きた `\end{document}`。
 * 見つからなければ -1。
 */
export function documentTags(src: string): { begin: number; end: number } {
  let begin = -1;
  for (const token of texTokens(src)) {
    if (token.kind !== "begin" && token.kind !== "end") continue;
    if (token.name !== "document") continue;
    if (begin === -1 && token.kind === "begin") begin = token.start;
    else if (begin !== -1 && token.kind === "end") return { begin, end: token.start };
  }
  return { begin, end: -1 };
}
