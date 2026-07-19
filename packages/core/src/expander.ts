/**
 * マクロ展開器(Phase 3)。
 *
 * 方針(subset-spec.md §4、development-plan.md Phase 3):
 * - 展開は「プレビュー専用の近似」。PDF 書き出しは常に展開前ソースをコンパイルするため、
 *   ここでの挙動差は最終出力に影響しない(展開結果がサブセット内なら構造描画、外なら生ブロック)。
 * - 方式は AST 変換ではなく「テキストレベル展開 + 再パース」。展開後の全文を parseDeck に
 *   通し直し、その DeckDocument を返す。macros 領域・プリアンブルには手を触れないため、
 *   展開後ソースも定義を保持したまま正しい LaTeX としてコンパイルできる。
 * - 展開対象は `\begin{document}` 以降の本文のみ。パーサが expandable と判定した
 *   \newcommand / \renewcommand / \newenvironment の単純置換だけを展開する。
 *
 * 近似として割り切っている点(実 TeX とのずれ):
 * - 同名定義は後勝ち(\renewcommand セマンティクス)。本文の呼び出しはすべてプリアンブルより
 *   後にあるため、最終定義がすべての呼び出しに適用されるという単純化で足りる。
 * - 呼び出し直後の空白は消費しない(TeX は制御綴の後の空白を食うが、ここでは残す)。
 * - `\name*`(star form)は対象外。引数区切りは balanced な {...} / [...] のみ。
 * - コメント(`%`〜行末、`\%` は除く)・verbatim 系環境・`\verb` はスキップし、数式内は展開する。
 *
 * ソースマップ(ピース列方式):
 * - 展開後テキストを Piece の列として構築する。exact ピースは元ソースからの逐語コピーで
 *   オフセットが 1:1 に対応し、synthetic ピースはマクロ本体由来でその呼び出しサイトの span を持つ。
 * - 再帰展開でも Piece は常に元ソースに対する絶対オフセットを保持し続ける(引数テキスト内で
 *   さらに展開が起きても、その引数の元位置を基準に合成する)。
 */

import type { DeckDocument, MacroDefinition, SourceSpan } from "./ast.js";
import { parseDeck } from "./parser.js";

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

export interface ExpandDiagnostic {
  kind: "max-depth" | "missing-args";
  /** マクロ名(バックスラッシュを除く)。 */
  name: string;
  /** 元ソース上の呼び出し位置。 */
  span: SourceSpan;
}

/**
 * 展開後オフセット範囲 → 元ソースオフセット範囲の対応。exact=true は逐語コピーで
 * オフセットが 1:1(sourceEnd-sourceStart === expandedEnd-expandedStart)、false は
 * マクロ本体由来で呼び出しサイトへ丸める区間。
 */
export interface ExpansionSegment {
  expandedStart: number;
  expandedEnd: number;
  sourceStart: number;
  sourceEnd: number;
  exact: boolean;
}

export type ExpansionMap = ExpansionSegment[];

export interface ExpandResult {
  /** 展開後ソース全文。 */
  source: string;
  /** 展開後ソースの parseDeck 結果(展開が無ければ入力の解析結果を再利用)。 */
  doc: DeckDocument;
  map: ExpansionMap;
  diagnostics: ExpandDiagnostic[];
  /** 1 箇所でも展開したか。 */
  changed: boolean;
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

/** verbatim 系環境(内部は展開しない)。parser.ts と同一集合。 */
const VERBATIM_ENVS = new Set(["verbatim", "verbatim*", "semiverbatim", "lstlisting", "minted"]);

/** 呼び出し連鎖の深さ上限。これを超える展開は行わず max-depth を積む(無限再帰の停止)。 */
const MAX_DEPTH = 16;

/**
 * 展開後テキストの構成単位。
 * - src あり = 元ソース [src.start, src.end) の逐語コピー(text.length === src.end - src.start)。
 * - site あり = マクロ本体由来の合成テキスト。site はその呼び出しサイトの元ソース span。
 */
type Piece =
  | { readonly kind: "exact"; readonly text: string; readonly src: SourceSpan }
  | { readonly kind: "synthetic"; readonly text: string; readonly site: SourceSpan };

/** 対応する閉じ括弧の位置を返す。open は `o` を指す。閉じが無ければ null(parser.ts と同一)。 */
function readBalanced(s: string, open: number, o = "{", c = "}"): number | null {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === o) depth++;
    else if (ch === c) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/** 走査中に見つかった展開対象の呼び出し。 */
interface CallSite {
  /** `\` の位置(走査対象文字列 S 内)。 */
  cs: number;
  kind: "cmd" | "begin" | "end";
  name: string;
  def: MacroDefinition;
  /** cmd: 名前直後 / begin・end: `\begin{name}`・`\end{name}` の直後。引数はここから読む。 */
  headerEnd: number;
}

/** 読み取った引数。src は元ソース由来、default は省略可能引数のデフォルト値(合成)。 */
type ArgDesc = { kind: "src"; a: number; b: number } | { kind: "default"; text: string };

/** マクロ本体 body に引数を差し込んで Piece 列を作る。本体由来テキストは synthetic(site 付き)。 */
function buildBody(body: string, args: Piece[][], site: SourceSpan): Piece[] {
  const out: Piece[] = [];
  let lit = "";
  const flush = () => {
    if (lit !== "") {
      out.push({ kind: "synthetic", text: lit, site });
      lit = "";
    }
  };
  for (let j = 0; j < body.length; j++) {
    const ch = body.charAt(j);
    if (ch === "#") {
      const nx = body.charAt(j + 1);
      if (nx === "#") {
        // ## → # (左から走査)
        lit += "#";
        j++;
        continue;
      }
      if (nx >= "1" && nx <= "9") {
        flush();
        const arg = args[Number(nx) - 1];
        // 引数が与えられていない番号は空に落とす(近似)。
        if (arg) out.push(...arg);
        j++;
        continue;
      }
      lit += "#";
      continue;
    }
    lit += ch;
  }
  flush();
  return out;
}

class Expander {
  readonly commands = new Map<string, MacroDefinition>();
  readonly environments = new Map<string, MacroDefinition>();
  readonly diagnostics: ExpandDiagnostic[] = [];
  changed = false;

  constructor(doc: DeckDocument) {
    // 展開可能定義を収集。同名は後勝ち(Map.set の上書きで実現)。
    for (const entry of doc.macros.entries) {
      if (entry.type !== "macroDefinition" || !entry.expandable) continue;
      if (entry.kind === "newenvironment") this.environments.set(entry.name, entry);
      else this.commands.set(entry.name, entry);
    }
  }

  /** 展開すべき定義があるか(無ければ本文走査ごと省略できる)。 */
  get hasDefs(): boolean {
    return this.commands.size > 0 || this.environments.size > 0;
  }

  /**
   * S の from 以降から次の展開対象呼び出しを探す。コメント・verbatim・\verb はスキップし、
   * 数式区切り($ や \[ など)は無視する(= 数式内も走査対象になる)。
   */
  scan(s: string, from: number): CallSite | null {
    let i = from;
    while (i < s.length) {
      const ch = s.charAt(i);
      if (ch === "%") {
        // コメント: 行末まで読み飛ばす(直前が \ のケースは下の \ 処理で消費済み)。
        const nl = s.indexOf("\n", i);
        i = nl === -1 ? s.length : nl + 1;
        continue;
      }
      if (ch !== "\\") {
        i++;
        continue;
      }
      // 制御綴の名前(英字のみ)。語境界は「英字が尽きた地点」。
      let j = i + 1;
      let name = "";
      while (j < s.length && /[a-zA-Z]/.test(s.charAt(j))) {
        name += s.charAt(j);
        j++;
      }
      if (name === "") {
        // \\ \{ \% \$ などのエスケープ: 2 文字まとめて読み飛ばす。
        i += 2;
        continue;
      }
      if (name === "verb") {
        // \verb<delim>...<delim>(\verb* も)。区切り文字までを読み飛ばす。
        let k = j;
        if (s.charAt(k) === "*") k++;
        const delim = s.charAt(k);
        if (delim === "") {
          i = s.length;
          continue;
        }
        const close = s.indexOf(delim, k + 1);
        i = close === -1 ? s.length : close + 1;
        continue;
      }
      if (name === "begin" || name === "end") {
        if (s.charAt(j) !== "{") {
          i = j;
          continue;
        }
        const close = readBalanced(s, j);
        if (close === null) {
          i = j;
          continue;
        }
        const env = s.slice(j + 1, close);
        const headerEnd = close + 1;
        if (name === "begin" && VERBATIM_ENVS.has(env)) {
          const endTag = `\\end{${env}}`;
          const e = s.indexOf(endTag, headerEnd);
          i = e === -1 ? s.length : e + endTag.length;
          continue;
        }
        const def = this.environments.get(env);
        if (def)
          return { cs: i, kind: name === "begin" ? "begin" : "end", name: env, def, headerEnd };
        i = headerEnd;
        continue;
      }
      if (s.charAt(j) === "*") {
        // star form は対象外(そのまま残す)。
        i = j + 1;
        continue;
      }
      const def = this.commands.get(name);
      if (def) return { cs: i, kind: "cmd", name, def, headerEnd: j };
      i = j;
    }
    return null;
  }

  /**
   * 呼び出しの引数を読む。optionalDefault が非 null の定義は先頭の `[...]` を #1 に採用し、
   * 無ければデフォルト値を #1 に。残りの `{...}` を #2 以降に。読めなければ null(missing-args)。
   */
  readArgs(s: string, call: CallSite): { args: ArgDesc[]; ce: number } | null {
    if (call.kind === "end") return { args: [], ce: call.headerEnd };
    const def = call.def;
    const skipWs = (p: number) => {
      let q = p;
      while (q < s.length && (s.charAt(q) === " " || s.charAt(q) === "\t")) q++;
      return q;
    };
    let cursor = call.headerEnd;
    const args: ArgDesc[] = [];
    let mandatory = def.paramCount;
    if (def.optionalDefault !== null) {
      mandatory -= 1;
      const at = skipWs(cursor);
      if (s.charAt(at) === "[") {
        const close = readBalanced(s, at, "[", "]");
        if (close === null) return null;
        args.push({ kind: "src", a: at + 1, b: close });
        cursor = close + 1;
      } else {
        args.push({ kind: "default", text: def.optionalDefault });
      }
    }
    for (let k = 0; k < mandatory; k++) {
      const at = skipWs(cursor);
      if (s.charAt(at) !== "{") return null;
      const close = readBalanced(s, at);
      if (close === null) return null;
      args.push({ kind: "src", a: at + 1, b: close });
      cursor = close + 1;
    }
    return { args, ce: cursor };
  }

  /**
   * Piece 列を走査して展開対象を置換し、新しい Piece 列を返す。呼び出しの本体は depth+1 で
   * 再帰展開する(置換結果の中の呼び出しも展開されるが、深さは呼び出し連鎖でのみ増える)。
   */
  expandPieces(input: Piece[], depth: number): Piece[] {
    const pieces = input.filter((p) => p.text.length > 0);
    if (pieces.length === 0) return [];
    const starts: number[] = [];
    let acc = 0;
    for (const p of pieces) {
      starts.push(acc);
      acc += p.text.length;
    }
    const total = acc;
    const s = pieces.map((p) => p.text).join("");

    // S オフセット o を含む Piece の添字。
    const pieceAt = (o: number): number => {
      for (let idx = 0; idx < pieces.length; idx++) {
        const ps = starts[idx] as number;
        if (o < ps + (pieces[idx] as Piece).text.length) return idx;
      }
      return pieces.length - 1;
    };
    // S 開始オフセット → 元ソースオフセット(exact は 1:1、synthetic は site 先頭へ)。
    const mapStart = (o: number): number => {
      const idx = pieceAt(o);
      const p = pieces[idx] as Piece;
      return p.kind === "exact" ? p.src.start + (o - (starts[idx] as number)) : p.site.start;
    };
    // S 終端オフセット(半開)→ 元ソースオフセット。直前の文字が属する Piece で決める。
    const mapEnd = (o: number): number => {
      const idx = pieceAt(o - 1);
      const p = pieces[idx] as Piece;
      return p.kind === "exact" ? p.src.start + (o - (starts[idx] as number)) : p.site.end;
    };
    // S 範囲 [a, b) を、元ソース由来(exact)を保ったまま Piece 列へ切り出す。
    const slice = (a: number, b: number): Piece[] => {
      const out: Piece[] = [];
      for (let idx = 0; idx < pieces.length; idx++) {
        const p = pieces[idx] as Piece;
        const ps = starts[idx] as number;
        const pe = ps + p.text.length;
        const oa = Math.max(a, ps);
        const ob = Math.min(b, pe);
        if (ob <= oa) continue;
        const text = p.text.slice(oa - ps, ob - ps);
        if (p.kind === "exact") {
          out.push({
            kind: "exact",
            text,
            src: { start: p.src.start + (oa - ps), end: p.src.start + (ob - ps) },
          });
        } else {
          out.push({ kind: "synthetic", text, site: p.site });
        }
      }
      return out;
    };

    const out: Piece[] = [];
    let pos = 0;
    while (pos < total) {
      const call = this.scan(s, pos);
      if (call === null) {
        out.push(...slice(pos, total));
        break;
      }
      out.push(...slice(pos, call.cs));

      if (depth >= MAX_DEPTH) {
        // 上限超過: この呼び出しは未展開のまま残す。
        this.diagnostics.push({
          kind: "max-depth",
          name: call.name,
          span: { start: mapStart(call.cs), end: mapEnd(call.headerEnd) },
        });
        out.push(...slice(call.cs, call.headerEnd));
        pos = call.headerEnd;
        continue;
      }

      const read = this.readArgs(s, call);
      if (read === null) {
        // 引数が読めない: 未展開のまま残す。
        this.diagnostics.push({
          kind: "missing-args",
          name: call.name,
          span: { start: mapStart(call.cs), end: mapEnd(call.headerEnd) },
        });
        out.push(...slice(call.cs, call.headerEnd));
        pos = call.headerEnd;
        continue;
      }

      const site: SourceSpan = { start: mapStart(call.cs), end: mapEnd(read.ce) };
      const body = call.kind === "end" ? (call.def.endBody ?? "") : call.def.body;
      const argPieces: Piece[][] = read.args.map((d) =>
        d.kind === "src" ? slice(d.a, d.b) : [{ kind: "synthetic", text: d.text, site }],
      );
      const substituted = buildBody(body, argPieces, site);
      this.changed = true;
      out.push(...this.expandPieces(substituted, depth + 1));
      pos = read.ce;
    }
    return out;
  }
}

/** Piece 列から ExpansionMap を構築する。隣接して整合する区間は 1 セグメントに畳む。 */
function buildSegments(pieces: Piece[]): ExpansionMap {
  const segs: ExpansionSegment[] = [];
  let e = 0;
  for (const p of pieces) {
    if (p.text.length === 0) continue;
    const len = p.text.length;
    const seg: ExpansionSegment =
      p.kind === "exact"
        ? {
            expandedStart: e,
            expandedEnd: e + len,
            sourceStart: p.src.start,
            sourceEnd: p.src.end,
            exact: true,
          }
        : {
            expandedStart: e,
            expandedEnd: e + len,
            sourceStart: p.site.start,
            sourceEnd: p.site.end,
            exact: false,
          };
    const prev = segs[segs.length - 1];
    const contiguous =
      prev !== undefined &&
      prev.exact === seg.exact &&
      prev.expandedEnd === seg.expandedStart &&
      (seg.exact
        ? prev.sourceEnd === seg.sourceStart
        : prev.sourceStart === seg.sourceStart && prev.sourceEnd === seg.sourceEnd);
    if (contiguous && prev !== undefined) {
      prev.expandedEnd = seg.expandedEnd;
      if (seg.exact) prev.sourceEnd = seg.sourceEnd;
    } else {
      segs.push(seg);
    }
    e += len;
  }
  return segs;
}

/**
 * ソース全体を展開する。決して throw しない(パーサが回復するため最悪でも入力と同一を返す)。
 * `\begin{document}` 以降のみを対象にし、プリアンブル(macros 領域を含む)は逐語で残す。
 */
export function expandDeck(source: string): ExpandResult {
  const doc = parseDeck(source);
  const expander = new Expander(doc);

  const marker = "\\begin{document}";
  const docBegin = source.indexOf(marker);

  let pieces: Piece[];
  if (docBegin === -1 || !expander.hasDefs) {
    // 本文が無い、または展開対象定義が無い: 全文を 1 本の exact ピースとして素通し。
    pieces = [{ kind: "exact", text: source, src: { start: 0, end: source.length } }];
  } else {
    const bodyStart = docBegin + marker.length;
    const prefix: Piece = {
      kind: "exact",
      text: source.slice(0, bodyStart),
      src: { start: 0, end: bodyStart },
    };
    const bodyPieces = expander.expandPieces(
      [
        {
          kind: "exact",
          text: source.slice(bodyStart),
          src: { start: bodyStart, end: source.length },
        },
      ],
      0,
    );
    pieces = [prefix, ...bodyPieces];
  }

  const expandedSource = pieces.map((p) => p.text).join("");
  const map = buildSegments(pieces);
  // 展開が無ければ再パース結果は入力と同一なので doc を再利用する。
  const expandedDoc = expander.changed ? parseDeck(expandedSource) : doc;

  return {
    source: expandedSource,
    doc: expandedDoc,
    map,
    diagnostics: expander.diagnostics,
    changed: expander.changed,
  };
}

/**
 * 展開後オフセット → 元ソースオフセット。exact セグメントは 1:1、それ以外は sourceStart
 * (= 呼び出しサイト先頭)へ丸める。範囲外は端へクランプする。
 */
export function mapExpandedToSource(map: ExpansionMap, expandedOffset: number): number {
  if (map.length === 0) return expandedOffset;
  const first = map[0] as ExpansionSegment;
  const last = map[map.length - 1] as ExpansionSegment;
  if (expandedOffset <= first.expandedStart) return first.sourceStart;
  if (expandedOffset >= last.expandedEnd) return last.sourceEnd;
  let lo = 0;
  let hi = map.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = map[mid] as ExpansionSegment;
    if (expandedOffset < seg.expandedStart) hi = mid - 1;
    else if (expandedOffset >= seg.expandedEnd) lo = mid + 1;
    else
      return seg.exact ? seg.sourceStart + (expandedOffset - seg.expandedStart) : seg.sourceStart;
  }
  return first.sourceStart;
}
