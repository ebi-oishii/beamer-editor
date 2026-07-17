/**
 * Beamer サブセット v1.1 のパーサ(Phase 1)。
 *
 * 方針(design.md §4.1):
 * - ホワイトリスト文法。読めるものだけ読み、未知は生ブロックに落とす(3 段フォールバック)。
 * - パースは決して例外で失敗しない。フレーム単位で回復し、最悪でも RawFrame になる。
 *
 * 現時点の既知の制限(後続フェーズで実装):
 * - コメントはノードに付随させず読み飛ばす(フォーマッタ実装時に leading/trailing へ)。
 * - マクロ展開は未実装(展開器は Phase 3)。未知マクロ呼び出しは RawInline になる。
 */

import type {
  AspectRatio,
  BlockNode,
  CanvasFontSize,
  CanvasItemNode,
  CanvasNode,
  ColumnNode,
  DeckDocument,
  DeckElement,
  DeckStyle,
  DimFactor,
  FrameNode,
  FrameOptions,
  InlineNode,
  ListItemNode,
  ListNode,
  MacroDefinition,
  MacroSection,
  MetaField,
  OverlaySpec,
  ParagraphNode,
  RawBlockNode,
  RawFrameNode,
  SourceSpan,
  StyleColorRole,
  TableRow,
} from "./ast.js";

const BLOCK_ENVS = new Set([
  "itemize",
  "enumerate",
  "columns",
  "column",
  "block",
  "alertblock",
  "exampleblock",
  "center",
  "tabular",
  "equation",
  "equation*",
  "align",
  "align*",
  "deckcanvas",
  "decktext",
]);

const VERBATIM_ENVS = new Set(["verbatim", "verbatim*", "semiverbatim", "lstlisting", "minted"]);

const STYLE_COMMANDS = new Set(["textbf", "emph", "textit", "texttt", "alert"]);

const CANVAS_SIZES = new Set([
  "tiny",
  "scriptsize",
  "footnotesize",
  "small",
  "normal",
  "large",
  "Large",
]);

const STYLE_COLOR_ROLES = new Set(["structure", "alert", "example", "text", "background"]);
const STYLE_FONT_SLOTS = new Set(["main", "mono"]);

const span = (start: number, end: number): SourceSpan => ({ start, end });

/** 対応する閉じ括弧までを読む。open 位置は `{` を指す。閉じが無ければ null。 */
function readBalanced(src: string, open: number, o = "{", c = "}"): number | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
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

/** `\begin{name}` に対応する `\end{name}` の開始位置を返す(同名ネスト対応)。 */
function findEnvEnd(src: string, name: string, from: number): number | null {
  const begin = `\\begin{${name}}`;
  const end = `\\end{${name}}`;
  if (VERBATIM_ENVS.has(name)) {
    const i = src.indexOf(end, from);
    return i === -1 ? null : i;
  }
  let depth = 1;
  let pos = from;
  while (pos < src.length) {
    const nb = src.indexOf(begin, pos);
    const ne = src.indexOf(end, pos);
    if (ne === -1) return null;
    if (nb !== -1 && nb < ne) {
      depth++;
      pos = nb + begin.length;
    } else {
      depth--;
      if (depth === 0) return ne;
      pos = ne + end.length;
    }
  }
  return null;
}

function commandNameAt(src: string, backslash: number): string {
  let i = backslash + 1;
  let name = "";
  while (i < src.length && /[a-zA-Z@*]/.test(src[i] as string)) {
    name += src[i];
    i++;
  }
  return name;
}

function parseOverlayAt(src: string, pos: number): { overlay: OverlaySpec | null; next: number } {
  if (src[pos] !== "<") return { overlay: null, next: pos };
  const close = src.indexOf(">", pos);
  if (close === -1) return { overlay: null, next: pos };
  const body = src.slice(pos + 1, close);
  const ranges: OverlaySpec["ranges"] = [];
  for (const part of body.split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)?)?\s*$/.exec(part);
    if (!m) return { overlay: null, next: pos };
    const from = Number(m[1]);
    const to = part.includes("-") ? (m[2] ? Number(m[2]) : null) : from;
    ranges.push({ from, to });
  }
  return { overlay: { ranges, span: span(pos, close + 1) }, next: close + 1 };
}

function parseDimFactor(text: string, offset: number): DimFactor | null {
  const m = /^\s*([0-9.]+)\\(textwidth|linewidth)\s*$/.exec(text);
  if (!m) return null;
  return {
    factor: Number(m[1]),
    unit: m[2] as DimFactor["unit"],
    span: span(offset, offset + text.length),
  };
}

class Parser {
  constructor(readonly src: string) {}

  // ---------------------------------------------------------------------
  // インライン
  // ---------------------------------------------------------------------

  /** [start, end) をインライン列としてパースする。 */
  parseInlines(start: number, end: number): InlineNode[] {
    const out: InlineNode[] = [];
    let pos = start;
    let textStart = -1;
    let text = "";
    const flush = (at: number) => {
      const value = text.replace(/\s+/g, " ");
      if (value.trim() !== "") {
        out.push({ type: "text", value, span: span(textStart, at) });
      }
      text = "";
      textStart = -1;
    };
    const pushText = (s: string, at: number) => {
      if (textStart === -1) textStart = at;
      text += s;
    };

    while (pos < end) {
      const ch = this.src[pos] as string;
      if (ch === "%") {
        const eol = this.src.indexOf("\n", pos);
        pos = eol === -1 || eol > end ? end : eol + 1;
        pushText(" ", pos);
        continue;
      }
      if (ch === "$") {
        flush(pos);
        const close = this.src.indexOf("$", pos + 1);
        if (close === -1 || close > end) {
          pushText("$", pos);
          pos++;
          continue;
        }
        out.push({
          type: "inlineMath",
          delimiter: "dollar",
          tex: this.src.slice(pos + 1, close),
          span: span(pos, close + 1),
        });
        pos = close + 1;
        continue;
      }
      if (ch === "~") {
        pushText(" ", pos);
        pos++;
        continue;
      }
      if (ch === "-") {
        if (this.src.startsWith("---", pos)) {
          pushText("—", pos);
          pos += 3;
          continue;
        }
        if (this.src.startsWith("--", pos)) {
          pushText("–", pos);
          pos += 2;
          continue;
        }
        pushText("-", pos);
        pos++;
        continue;
      }
      if (ch === "\\") {
        const nextCh = this.src[pos + 1] ?? "";
        if (nextCh === "\\") {
          flush(pos);
          out.push({ type: "lineBreak", span: span(pos, pos + 2) });
          pos += 2;
          continue;
        }
        if ("%&_#{}".includes(nextCh)) {
          pushText(nextCh, pos);
          pos += 2;
          continue;
        }
        if (nextCh === "(") {
          flush(pos);
          const close = this.src.indexOf("\\)", pos + 2);
          if (close === -1 || close > end) {
            pos += 2;
            continue;
          }
          out.push({
            type: "inlineMath",
            delimiter: "paren",
            tex: this.src.slice(pos + 2, close),
            span: span(pos, close + 2),
          });
          pos = close + 2;
          continue;
        }
        const name = commandNameAt(this.src, pos);
        if (name === "") {
          pushText(nextCh, pos);
          pos += 2;
          continue;
        }
        flush(pos);
        const node = this.parseInlineCommand(pos, name, end);
        out.push(node.node);
        pos = node.next;
        continue;
      }
      pushText(ch, pos);
      pos++;
    }
    flush(end);
    return out;
  }

  private parseInlineCommand(
    pos: number,
    name: string,
    limit: number,
  ): { node: InlineNode; next: number } {
    const argStart = pos + 1 + name.length;
    const group = (from: number): { body: [number, number]; next: number } | null => {
      let i = from;
      while (i < limit && /\s/.test(this.src[i] as string)) i++;
      if (this.src[i] !== "{") return null;
      const close = readBalanced(this.src, i);
      if (close === null || close > limit) return null;
      return { body: [i + 1, close], next: close + 1 };
    };

    if (STYLE_COMMANDS.has(name)) {
      const g = group(argStart);
      if (g) {
        return {
          node: {
            type: "styled",
            style: name as "textbf",
            children: this.parseInlines(g.body[0], g.body[1]),
            span: span(pos, g.next),
          },
          next: g.next,
        };
      }
    }
    if (name === "textcolor") {
      const g1 = group(argStart);
      const g2 = g1 && group(g1.next);
      if (g1 && g2) {
        return {
          node: {
            type: "colorText",
            color: this.src.slice(g1.body[0], g1.body[1]).trim(),
            children: this.parseInlines(g2.body[0], g2.body[1]),
            span: span(pos, g2.next),
          },
          next: g2.next,
        };
      }
    }
    if (name === "url") {
      const g = group(argStart);
      if (g) {
        return {
          node: { type: "url", url: this.src.slice(g.body[0], g.body[1]), span: span(pos, g.next) },
          next: g.next,
        };
      }
    }
    if (name === "href") {
      const g1 = group(argStart);
      const g2 = g1 && group(g1.next);
      if (g1 && g2) {
        return {
          node: {
            type: "href",
            url: this.src.slice(g1.body[0], g1.body[1]),
            children: this.parseInlines(g2.body[0], g2.body[1]),
            span: span(pos, g2.next),
          },
          next: g2.next,
        };
      }
    }
    // 未知コマンド: コマンド + 後続の引数グループ([...] / {...} の並び)までを生ブロックに(§3-1)
    let next = argStart;
    for (;;) {
      let i = next;
      while (i < limit && /[ \t]/.test(this.src[i] as string)) i++;
      if (this.src[i] === "{") {
        const close = readBalanced(this.src, i);
        if (close === null || close > limit) break;
        next = close + 1;
      } else if (this.src[i] === "[") {
        const close = readBalanced(this.src, i, "[", "]");
        if (close === null || close > limit) break;
        next = close + 1;
      } else break;
    }
    return {
      node: {
        type: "rawInline",
        tex: this.src.slice(pos, next),
        reason: "unknown-command",
        span: span(pos, next),
      },
      next,
    };
  }

  // ---------------------------------------------------------------------
  // ブロック
  // ---------------------------------------------------------------------

  parseBlocks(start: number, end: number): BlockNode[] {
    const out: BlockNode[] = [];
    let pos = start;
    let paraStart = -1;

    const flushPara = (at: number) => {
      if (paraStart === -1) return;
      const children = this.parseInlines(paraStart, at);
      if (children.length > 0) {
        out.push({ type: "paragraph", children, span: span(paraStart, at) } as ParagraphNode);
      }
      paraStart = -1;
    };

    while (pos < end) {
      const ch = this.src[pos] as string;
      if (ch === "%") {
        const eol = this.src.indexOf("\n", pos);
        pos = eol === -1 || eol > end ? end : eol + 1;
        continue;
      }
      if (/\s/.test(ch)) {
        // 空行は段落区切り
        if (ch === "\n" && /^[ \t]*\n/.test(this.src.slice(pos + 1, end))) flushPara(pos);
        pos++;
        continue;
      }
      if (this.src.startsWith("\\begin{", pos)) {
        flushPara(pos);
        const parsed = this.parseEnvironment(pos, end);
        out.push(parsed.node);
        pos = parsed.next;
        continue;
      }
      if (this.src.startsWith("\\[", pos)) {
        flushPara(pos);
        const close = this.src.indexOf("\\]", pos + 2);
        const realClose = close === -1 || close > end ? end : close;
        out.push({
          type: "displayMath",
          kind: "bracket",
          tex: this.src.slice(pos + 2, realClose).trim(),
          span: span(pos, realClose + 2),
        });
        pos = realClose + 2;
        continue;
      }
      if (ch === "\\") {
        const name = commandNameAt(this.src, pos);
        if (name === "pause") {
          flushPara(pos);
          out.push({ type: "pause", span: span(pos, pos + 6) });
          pos += 6;
          continue;
        }
        if (name === "titlepage") {
          flushPara(pos);
          out.push({ type: "titlePage", span: span(pos, pos + 10) });
          pos += 10;
          continue;
        }
        if (name === "tableofcontents") {
          flushPara(pos);
          out.push({ type: "tableOfContents", span: span(pos, pos + 16) });
          pos += 16;
          continue;
        }
        if (name === "includegraphics") {
          flushPara(pos);
          const parsed = this.parseIncludeGraphics(pos, end);
          out.push(parsed.node);
          pos = parsed.next;
          continue;
        }
        // その他のコマンドはインラインとして段落に取り込む
        if (paraStart === -1) paraStart = pos;
        const step = this.parseInlineCommand(pos, name, end);
        pos = step.next;
        continue;
      }
      if (paraStart === -1) paraStart = pos;
      pos++;
    }
    flushPara(end);
    return out;
  }

  private parseIncludeGraphics(pos: number, limit: number): { node: BlockNode; next: number } {
    let i = pos + "\\includegraphics".length;
    let width: DimFactor | null = null;
    let height: DimFactor | null = null;
    let ok = true;
    if (this.src[i] === "[") {
      const close = readBalanced(this.src, i, "[", "]");
      if (close === null || close > limit) {
        ok = false;
      } else {
        for (const part of this.src.slice(i + 1, close).split(",")) {
          const m = /^\s*(width|height)\s*=\s*(.+?)\s*$/.exec(part);
          const dim = m ? parseDimFactor(m[2] as string, i + 1) : null;
          if (!m || !dim) {
            ok = false;
            break;
          }
          if (m[1] === "width") width = dim;
          else height = dim;
        }
        i = close + 1;
      }
    }
    const pathClose = this.src[i] === "{" ? readBalanced(this.src, i) : null;
    if (!ok || pathClose === null || pathClose > limit) {
      // オプションが語彙外(§2.4): コマンドごと生ブロックに
      const stop = pathClose !== null && pathClose <= limit ? pathClose + 1 : i;
      return { node: this.rawBlock(pos, stop, null, "unsupported-option"), next: stop };
    }
    return {
      node: {
        type: "image",
        path: this.src.slice(i + 1, pathClose),
        width,
        height,
        span: span(pos, pathClose + 1),
      },
      next: pathClose + 1,
    };
  }

  private rawBlock(
    startPos: number,
    endPos: number,
    environment: string | null,
    reason: RawBlockNode["reason"],
  ): RawBlockNode {
    return {
      type: "rawBlock",
      tex: this.src.slice(startPos, endPos),
      environment,
      reason,
      span: span(startPos, endPos),
    };
  }

  private parseEnvironment(pos: number, limit: number): { node: BlockNode; next: number } {
    const nameClose = this.src.indexOf("}", pos + 7);
    const name = this.src.slice(pos + 7, nameClose === -1 ? pos + 7 : nameClose);
    const bodyStart = nameClose + 1;
    const endPos = findEnvEnd(this.src, name, bodyStart);
    const endTag = `\\end{${name}}`;
    if (endPos === null || endPos + endTag.length > limit) {
      // 閉じが見つからない: 残り全部を生ブロックに
      return { node: this.rawBlock(pos, limit, name, "unknown-environment"), next: limit };
    }
    const next = endPos + endTag.length;
    const asRaw = (reason: RawBlockNode["reason"] = "unknown-environment") => ({
      node: this.rawBlock(pos, next, name, reason),
      next,
    });

    if (!BLOCK_ENVS.has(name)) return asRaw();

    try {
      switch (name) {
        case "itemize":
        case "enumerate":
          return { node: this.parseList(name, pos, bodyStart, endPos, next), next };
        case "columns":
          return { node: this.parseColumns(pos, bodyStart, endPos, next), next };
        case "column": {
          // columns の外に出現した column は生ブロック
          return asRaw();
        }
        case "block":
        case "alertblock":
        case "exampleblock":
          return { node: this.parseBlockEnv(name, pos, bodyStart, endPos, next), next };
        case "center":
          return {
            node: {
              type: "center",
              children: this.parseBlocks(bodyStart, endPos),
              span: span(pos, next),
            },
            next,
          };
        case "tabular": {
          const node = this.parseTabular(pos, bodyStart, endPos, next);
          return node ? { node, next } : asRaw("unsupported-table-spec");
        }
        case "equation":
        case "equation*":
        case "align":
        case "align*":
          return {
            node: {
              type: "displayMath",
              kind: name,
              tex: this.src.slice(bodyStart, endPos).trim(),
              span: span(pos, next),
            },
            next,
          };
        case "deckcanvas":
          return { node: this.parseCanvas(pos, bodyStart, endPos, next), next };
        case "decktext":
          // deckcanvas の外の decktext は生ブロック
          return asRaw("canvas-unsupported-content");
        default:
          return asRaw();
      }
    } catch {
      return asRaw();
    }
  }

  private parseList(
    kind: "itemize" | "enumerate",
    pos: number,
    bodyStart: number,
    bodyEnd: number,
    next: number,
  ): ListNode {
    const items: ListItemNode[] = [];
    // 深さ 0 の \item 位置を列挙
    const itemPositions: number[] = [];
    let i = bodyStart;
    let depth = 0;
    while (i < bodyEnd) {
      if (this.src.startsWith("\\begin{", i)) {
        depth++;
        i += 7;
        continue;
      }
      if (this.src.startsWith("\\end{", i)) {
        depth--;
        i += 5;
        continue;
      }
      if (
        depth === 0 &&
        this.src.startsWith("\\item", i) &&
        !/[a-zA-Z]/.test(this.src[i + 5] ?? "")
      ) {
        itemPositions.push(i);
        i += 5;
        continue;
      }
      if (this.src[i] === "%") {
        const eol = this.src.indexOf("\n", i);
        i = eol === -1 ? bodyEnd : eol + 1;
        continue;
      }
      i++;
    }
    for (let k = 0; k < itemPositions.length; k++) {
      const itemPos = itemPositions[k] as number;
      const contentEnd = k + 1 < itemPositions.length ? (itemPositions[k + 1] as number) : bodyEnd;
      let contentStart = itemPos + 5;
      const ov = parseOverlayAt(this.src, contentStart);
      contentStart = ov.next;
      items.push({
        type: "listItem",
        overlay: ov.overlay,
        children: this.parseBlocks(contentStart, contentEnd),
        span: span(itemPos, contentEnd),
      });
    }
    return { type: "list", kind, items, span: span(pos, next) };
  }

  private parseColumns(pos: number, bodyStart: number, bodyEnd: number, next: number): BlockNode {
    let cursor = bodyStart;
    let topAligned = false;
    while (cursor < bodyEnd && /\s/.test(this.src[cursor] as string)) cursor++;
    if (this.src[cursor] === "[") {
      const close = readBalanced(this.src, cursor, "[", "]");
      if (close !== null && close < bodyEnd) {
        const opt = this.src.slice(cursor + 1, close).trim();
        if (opt !== "T" && opt !== "t" && opt !== "c" && opt !== "") {
          return this.rawBlock(pos, next, "columns", "unsupported-option");
        }
        topAligned = opt === "T" || opt === "t";
        cursor = close + 1;
      }
    }
    const columns: ColumnNode[] = [];
    while (cursor < bodyEnd) {
      const nb = this.src.indexOf("\\begin{column}", cursor);
      if (nb === -1 || nb >= bodyEnd) break;
      const argOpen = nb + "\\begin{column}".length;
      const argClose = this.src[argOpen] === "{" ? readBalanced(this.src, argOpen) : null;
      if (argClose === null) return this.rawBlock(pos, next, "columns", "unsupported-option");
      const width = parseDimFactor(this.src.slice(argOpen + 1, argClose), argOpen + 1);
      const colEnd = findEnvEnd(this.src, "column", argClose + 1);
      if (width === null || colEnd === null || colEnd >= bodyEnd) {
        return this.rawBlock(pos, next, "columns", "unsupported-option");
      }
      columns.push({
        type: "column",
        width,
        children: this.parseBlocks(argClose + 1, colEnd),
        span: span(nb, colEnd + "\\end{column}".length),
      });
      cursor = colEnd + "\\end{column}".length;
    }
    return { type: "columns", topAligned, columns, span: span(pos, next) };
  }

  private parseBlockEnv(
    kind: "block" | "alertblock" | "exampleblock",
    pos: number,
    bodyStart: number,
    bodyEnd: number,
    next: number,
  ): BlockNode {
    let cursor = bodyStart;
    const ov = parseOverlayAt(this.src, cursor);
    cursor = ov.next;
    while (cursor < bodyEnd && /\s/.test(this.src[cursor] as string)) cursor++;
    let title: InlineNode[] = [];
    if (this.src[cursor] === "{") {
      const close = readBalanced(this.src, cursor);
      if (close !== null && close < bodyEnd) {
        title = this.parseInlines(cursor + 1, close);
        cursor = close + 1;
      }
    }
    return {
      type: "blockEnv",
      kind,
      overlay: ov.overlay,
      title,
      children: this.parseBlocks(cursor, bodyEnd),
      span: span(pos, next),
    };
  }

  private parseTabular(
    pos: number,
    bodyStart: number,
    bodyEnd: number,
    next: number,
  ): BlockNode | null {
    let cursor = bodyStart;
    while (cursor < bodyEnd && /\s/.test(this.src[cursor] as string)) cursor++;
    if (this.src[cursor] !== "{") return null;
    const specClose = readBalanced(this.src, cursor);
    if (specClose === null) return null;
    const spec = this.src.slice(cursor + 1, specClose).trim();
    if (!/^[lcr]+$/.test(spec)) return null;
    cursor = specClose + 1;

    const rows: TableRow[] = [];
    // \\ で分割(ブレース深さ 0 のみ)
    const segments: Array<[number, number]> = [];
    let segStart = cursor;
    let i = cursor;
    let depth = 0;
    while (i < bodyEnd) {
      const ch = this.src[i] as string;
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === "\\" && this.src[i + 1] === "\\" && depth === 0) {
        segments.push([segStart, i]);
        i += 2;
        segStart = i;
        continue;
      } else if (ch === "\\") {
        i += 2;
        continue;
      }
      i++;
    }
    segments.push([segStart, bodyEnd]);

    for (const [s, e] of segments) {
      let segCursor = s;
      // 行頭のルールコマンドを剥がす
      for (;;) {
        while (segCursor < e && /\s/.test(this.src[segCursor] as string)) segCursor++;
        const m = /^\\(toprule|midrule|bottomrule)/.exec(this.src.slice(segCursor, e));
        if (!m) break;
        rows.push({
          type: "tableRule",
          rule: m[1] as "toprule",
          span: span(segCursor, segCursor + m[0].length),
        });
        segCursor += m[0].length;
      }
      const rest = this.src.slice(segCursor, e).trim();
      if (rest === "") continue;
      // & で分割(深さ 0)
      const cells: InlineNode[][] = [];
      let cellStart = segCursor;
      let j = segCursor;
      let d = 0;
      while (j < e) {
        const ch = this.src[j] as string;
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === "{") d++;
        else if (ch === "}") d--;
        else if (ch === "&" && d === 0) {
          cells.push(this.parseInlines(cellStart, j));
          cellStart = j + 1;
        }
        j++;
      }
      cells.push(this.parseInlines(cellStart, e));
      rows.push({ type: "tableCells", cells, span: span(segCursor, e) });
    }
    return {
      type: "table",
      columns: [...spec] as Array<"l" | "c" | "r">,
      rows,
      span: span(pos, next),
    };
  }

  // ---------------------------------------------------------------------
  // キャンバス(§2.8)
  // ---------------------------------------------------------------------

  private parseCanvasKeys(
    text: string,
  ): { x: number; y: number; w: number; size: CanvasFontSize } | null {
    const result = { x: 0, y: 0, w: 1, size: "normal" as CanvasFontSize };
    for (const part of text.split(",")) {
      if (part.trim() === "") continue;
      const m = /^\s*(x|y|w|size)\s*=\s*(\S+)\s*$/.exec(part);
      if (!m) return null;
      const key = m[1] as "x" | "y" | "w" | "size";
      if (key === "size") {
        if (!CANVAS_SIZES.has(m[2] as string)) return null;
        result.size = m[2] as CanvasFontSize;
      } else {
        const v = Number(m[2]);
        if (!Number.isFinite(v)) return null;
        result[key] = v;
      }
    }
    return result;
  }

  private parseCanvas(pos: number, bodyStart: number, bodyEnd: number, next: number): CanvasNode {
    const items: CanvasItemNode[] = [];
    let cursor = bodyStart;
    while (cursor < bodyEnd) {
      const ch = this.src[cursor] as string;
      if (/\s/.test(ch)) {
        cursor++;
        continue;
      }
      if (ch === "%") {
        const eol = this.src.indexOf("\n", cursor);
        cursor = eol === -1 ? bodyEnd : eol + 1;
        continue;
      }
      if (this.src.startsWith("\\begin{decktext}", cursor)) {
        const optOpen = cursor + "\\begin{decktext}".length;
        const optClose =
          this.src[optOpen] === "[" ? readBalanced(this.src, optOpen, "[", "]") : null;
        const envEnd = findEnvEnd(this.src, "decktext", optClose === null ? optOpen : optClose + 1);
        if (envEnd === null || envEnd >= bodyEnd) {
          items.push(this.rawBlock(cursor, bodyEnd, "decktext", "canvas-unsupported-content"));
          cursor = bodyEnd;
          continue;
        }
        const itemNext = envEnd + "\\end{decktext}".length;
        const keys =
          optClose === null ? null : this.parseCanvasKeys(this.src.slice(optOpen + 1, optClose));
        if (keys === null) {
          items.push(this.rawBlock(cursor, itemNext, "decktext", "canvas-unsupported-content"));
          cursor = itemNext;
          continue;
        }
        const contentStart = optClose === null ? optOpen : optClose + 1;
        const children = this.parseBlocks(contentStart, envEnd).map((b) =>
          b.type === "paragraph" || b.type === "list" || b.type === "rawBlock"
            ? b
            : this.rawBlock(b.span.start, b.span.end, null, "canvas-unsupported-content"),
        );
        items.push({
          type: "canvasText",
          position: {
            x: keys.x,
            y: keys.y,
            width: keys.w,
            span: span(optOpen, optClose === null ? optOpen : optClose + 1),
          },
          size: keys.size,
          children,
          span: span(cursor, itemNext),
        });
        cursor = itemNext;
        continue;
      }
      if (this.src.startsWith("\\deckimage", cursor)) {
        const optOpen = cursor + "\\deckimage".length;
        const optClose =
          this.src[optOpen] === "[" ? readBalanced(this.src, optOpen, "[", "]") : null;
        const pathOpen = optClose === null ? optOpen : optClose + 1;
        const pathClose = this.src[pathOpen] === "{" ? readBalanced(this.src, pathOpen) : null;
        const keys =
          optClose === null ? null : this.parseCanvasKeys(this.src.slice(optOpen + 1, optClose));
        if (pathClose === null || keys === null) {
          const eol = this.src.indexOf("\n", cursor);
          const stop = eol === -1 || eol > bodyEnd ? bodyEnd : eol;
          items.push(this.rawBlock(cursor, stop, null, "canvas-unsupported-content"));
          cursor = stop;
          continue;
        }
        items.push({
          type: "canvasImage",
          position: {
            x: keys.x,
            y: keys.y,
            width: keys.w,
            span: span(optOpen, optClose === null ? optOpen : optClose + 1),
          },
          path: this.src.slice(pathOpen + 1, pathClose),
          span: span(cursor, pathClose + 1),
        });
        cursor = pathClose + 1;
        continue;
      }
      // 許容外の直下要素: 次の要素または環境末尾までを生ブロックに(L014)
      const nextText = this.src.indexOf("\\begin{decktext}", cursor);
      const nextImg = this.src.indexOf("\\deckimage", cursor);
      const candidates = [nextText, nextImg].filter((v) => v !== -1 && v < bodyEnd);
      const stop = candidates.length > 0 ? Math.min(...candidates) : bodyEnd;
      items.push(this.rawBlock(cursor, stop, null, "canvas-unsupported-content"));
      cursor = stop;
    }
    return { type: "canvas", items, span: span(pos, next) };
  }

  // ---------------------------------------------------------------------
  // フレームと文書
  // ---------------------------------------------------------------------

  private parseFrame(
    pos: number,
    bodyStart: number,
    bodyEnd: number,
    next: number,
  ): FrameNode | RawFrameNode {
    let cursor = bodyStart;
    const options: FrameOptions = {
      fragile: false,
      plain: false,
      allowframebreaks: false,
      label: null,
      span: null,
    };
    const rawFrame = (): RawFrameNode => {
      const titleMatch = /\\begin\{frame\}(?:\[[^\]]*\])?\{([^{}]*)\}/.exec(
        this.src.slice(pos, bodyEnd),
      );
      const labelMatch = /label=([^,\]]+)/.exec(this.src.slice(pos, bodyEnd));
      return {
        type: "rawFrame",
        tex: this.src.slice(pos, next),
        title: titleMatch ? (titleMatch[1] as string) : null,
        label: labelMatch ? (labelMatch[1] as string) : null,
        span: span(pos, next),
      };
    };

    if (this.src[cursor] === "[") {
      const close = readBalanced(this.src, cursor, "[", "]");
      if (close === null || close > bodyEnd) return rawFrame();
      options.span = span(cursor, close + 1);
      for (const part of this.src.slice(cursor + 1, close).split(",")) {
        const opt = part.trim();
        if (opt === "") continue;
        if (opt === "fragile") options.fragile = true;
        else if (opt === "plain") options.plain = true;
        else if (opt === "allowframebreaks") options.allowframebreaks = true;
        else if (opt.startsWith("label=")) options.label = opt.slice("label=".length).trim();
        else return rawFrame(); // 未知オプション → 生フレーム(§3-3)
      }
      cursor = close + 1;
    }
    let title: InlineNode[] | null = null;
    while (cursor < bodyEnd && /[ \t]/.test(this.src[cursor] as string)) cursor++;
    if (this.src[cursor] === "{") {
      const close = readBalanced(this.src, cursor);
      if (close === null || close > bodyEnd) return rawFrame();
      title = this.parseInlines(cursor + 1, close);
      cursor = close + 1;
    }
    return {
      type: "frame",
      options,
      title,
      body: this.parseBlocks(cursor, bodyEnd),
      span: span(pos, next),
    };
  }

  private parseMacroSection(start: number, end: number): MacroSection {
    const entries: MacroSection["entries"] = [];
    let cursor = start;
    while (cursor < end) {
      const ch = this.src[cursor] as string;
      if (/\s/.test(ch)) {
        cursor++;
        continue;
      }
      if (ch === "%") {
        const eol = this.src.indexOf("\n", cursor);
        cursor = eol === -1 ? end : eol + 1;
        continue;
      }
      const defMatch = /^\\(newcommand|renewcommand|newenvironment)/.exec(
        this.src.slice(cursor, end),
      );
      if (defMatch) {
        const kind = defMatch[1] as MacroDefinition["kind"];
        let i = cursor + defMatch[0].length;
        // 名前
        let name: string | null = null;
        if (this.src[i] === "{") {
          const close = readBalanced(this.src, i);
          if (close !== null) {
            name = this.src.slice(i + 1, close).replace(/^\\/, "");
            i = close + 1;
          }
        }
        // [引数個数][デフォルト]
        let paramCount = 0;
        let optionalDefault: string | null = null;
        for (let k = 0; k < 2; k++) {
          if (this.src[i] === "[") {
            const close = readBalanced(this.src, i, "[", "]");
            if (close === null) break;
            const v = this.src.slice(i + 1, close);
            if (k === 0 && /^\d+$/.test(v)) paramCount = Number(v);
            else optionalDefault = v;
            i = close + 1;
          }
        }
        // 本体(newenvironment は begin/end の 2 つ)
        let body: string | null = null;
        let endBody: string | undefined;
        if (this.src[i] === "{") {
          const close = readBalanced(this.src, i);
          if (close !== null) {
            body = this.src.slice(i + 1, close);
            i = close + 1;
          }
        }
        if (kind === "newenvironment" && this.src[i] === "{") {
          const close = readBalanced(this.src, i);
          if (close !== null) {
            endBody = this.src.slice(i + 1, close);
            i = close + 1;
          }
        }
        if (name !== null && body !== null) {
          const expandable = !/\\(if|expandafter|futurelet|csname|def)/.test(
            body + (endBody ?? ""),
          );
          entries.push({
            type: "macroDefinition",
            kind,
            name,
            paramCount,
            optionalDefault,
            body,
            ...(endBody !== undefined ? { endBody } : {}),
            expandable,
            span: span(cursor, i),
          });
          cursor = i;
          continue;
        }
      }
      // 解釈できない定義(\def 等): 行末までを生ブロックに
      const eol = this.src.indexOf("\n", cursor);
      const stop = eol === -1 || eol > end ? end : eol;
      entries.push(this.rawBlock(cursor, stop, null, "unknown-command"));
      cursor = stop + 1;
    }
    return { type: "macroSection", entries, span: span(start, end) };
  }

  /** `%% style` 領域(theme-design.md §2)。語彙外の記述は RawBlock("unknown-style")。 */
  private parseStyleSection(start: number, end: number): DeckStyle {
    const entries: DeckStyle["entries"] = [];
    let cursor = start;

    const group = (from: number): { body: string; next: number } | null => {
      if (this.src[from] !== "{") return null;
      const close = readBalanced(this.src, from);
      if (close === null || close > end) return null;
      return { body: this.src.slice(from + 1, close), next: close + 1 };
    };
    const rawToEol = (from: number): number => {
      const eol = this.src.indexOf("\n", from);
      const stop = eol === -1 || eol > end ? end : eol;
      entries.push(this.rawBlock(from, stop, null, "unknown-style"));
      return stop + 1;
    };

    while (cursor < end) {
      const ch = this.src[cursor] as string;
      if (/\s/.test(ch)) {
        cursor++;
        continue;
      }
      if (ch === "%") {
        const eol = this.src.indexOf("\n", cursor);
        cursor = eol === -1 ? end : eol + 1;
        continue;
      }
      if (this.src.startsWith("\\deckcolor", cursor)) {
        const g1 = group(cursor + "\\deckcolor".length);
        const g2 = g1 && group(g1.next);
        const role = g1?.body.trim() ?? "";
        const hex = g2?.body.trim() ?? "";
        if (!g1 || !g2 || !STYLE_COLOR_ROLES.has(role) || !/^[0-9A-Fa-f]{6}$/.test(hex)) {
          cursor = rawToEol(cursor);
          continue;
        }
        entries.push({
          type: "styleColor",
          role: role as StyleColorRole,
          hex: hex.toUpperCase(),
          span: span(cursor, g2.next),
        });
        cursor = g2.next;
        continue;
      }
      if (this.src.startsWith("\\deckfont", cursor)) {
        const g1 = group(cursor + "\\deckfont".length);
        const g2 = g1 && group(g1.next);
        const slot = g1?.body.trim() ?? "";
        if (!g1 || !g2 || !STYLE_FONT_SLOTS.has(slot) || g2.body.trim() === "") {
          cursor = rawToEol(cursor);
          continue;
        }
        entries.push({
          type: "styleFont",
          slot: slot as "main" | "mono",
          family: g2.body.trim(),
          span: span(cursor, g2.next),
        });
        cursor = g2.next;
        continue;
      }
      if (this.src.startsWith("\\decklogo", cursor)) {
        const optOpen = cursor + "\\decklogo".length;
        const optClose =
          this.src[optOpen] === "[" ? readBalanced(this.src, optOpen, "[", "]") : null;
        const g = optClose !== null ? group(optClose + 1) : null;
        const keys =
          optClose !== null ? this.parseCanvasKeys(this.src.slice(optOpen + 1, optClose)) : null;
        if (optClose === null || !g || keys === null) {
          cursor = rawToEol(cursor);
          continue;
        }
        entries.push({
          type: "styleLogo",
          position: { x: keys.x, y: keys.y, width: keys.w, span: span(optOpen, optClose + 1) },
          path: g.body.trim(),
          span: span(cursor, g.next),
        });
        cursor = g.next;
        continue;
      }
      if (this.src.startsWith("\\deckfooter", cursor)) {
        const gOpen = cursor + "\\deckfooter".length;
        if (this.src[gOpen] !== "{") {
          cursor = rawToEol(cursor);
          continue;
        }
        const close = readBalanced(this.src, gOpen);
        if (close === null || close > end) {
          cursor = rawToEol(cursor);
          continue;
        }
        entries.push({
          type: "styleFooter",
          text: this.parseInlines(gOpen + 1, close),
          span: span(cursor, close + 1),
        });
        cursor = close + 1;
        continue;
      }
      cursor = rawToEol(cursor);
    }
    return { type: "style", entries, span: span(start, end) };
  }

  parseDocument(): DeckDocument {
    const src = this.src;
    const dcMatch = /\\documentclass(?:\[([^\]]*)\])?\{beamer\}/.exec(src);
    let aspectRatio: AspectRatio = "43";
    if (dcMatch?.[1]?.includes("aspectratio=169")) aspectRatio = "169";

    const versionMatch = /^%% deck-source-version:\s*(\d+)\s*$/m.exec(src);
    const sourceVersion = versionMatch ? Number(versionMatch[1]) : null;

    const region = (name: string): [number, number] | null => {
      const begin = src.indexOf(`%% ${name}:begin`);
      const endMark = src.indexOf(`%% ${name}:end`);
      if (begin === -1 || endMark === -1) return null;
      const contentStart = src.indexOf("\n", begin) + 1;
      return [contentStart, endMark];
    };
    const macrosRegion = region("macros");
    const styleRegion = region("style");
    const extraRegion = region("preamble-extra");

    const docBegin = src.indexOf("\\begin{document}");
    const docEnd = src.lastIndexOf("\\end{document}");
    const bodyStart = docBegin === -1 ? 0 : docBegin + "\\begin{document}".length;
    const bodyEnd = docEnd === -1 ? src.length : docEnd;
    const preambleEnd = docBegin === -1 ? 0 : docBegin;

    // メタデータ
    const metadata: DeckDocument["metadata"] = { type: "metadata", span: span(0, preambleEnd) };
    for (const key of ["title", "subtitle", "author", "institute", "date"] as const) {
      const re = new RegExp(`\\\\${key}\\{`);
      const m = re.exec(src.slice(0, preambleEnd));
      if (!m) continue;
      const open = m.index + m[0].length - 1;
      const close = readBalanced(src, open);
      if (close === null) continue;
      const field: MetaField = {
        value: this.parseInlines(open + 1, close),
        span: span(m.index, close + 1),
      };
      metadata[key] = field;
    }

    // 本文
    const body: DeckElement[] = [];
    let cursor = bodyStart;
    while (cursor < bodyEnd) {
      const ch = src[cursor] as string;
      if (/\s/.test(ch)) {
        cursor++;
        continue;
      }
      if (ch === "%") {
        const eol = src.indexOf("\n", cursor);
        cursor = eol === -1 ? bodyEnd : eol + 1;
        continue;
      }
      const secMatch = /^\\(section|subsection)\{/.exec(src.slice(cursor, cursor + 20));
      if (secMatch) {
        const open = cursor + secMatch[0].length - 1;
        const close = readBalanced(src, open);
        if (close !== null) {
          body.push({
            type: "section",
            level: secMatch[1] as "section" | "subsection",
            title: this.parseInlines(open + 1, close),
            span: span(cursor, close + 1),
          });
          cursor = close + 1;
          continue;
        }
      }
      if (src.startsWith("\\begin{frame}", cursor)) {
        const frameBodyStart = cursor + "\\begin{frame}".length;
        const endPos = findEnvEnd(src, "frame", frameBodyStart);
        if (endPos === null) {
          body.push({
            type: "rawFrame",
            tex: src.slice(cursor, bodyEnd),
            title: null,
            label: null,
            span: span(cursor, bodyEnd),
          });
          cursor = bodyEnd;
          continue;
        }
        const next = endPos + "\\end{frame}".length;
        try {
          body.push(this.parseFrame(cursor, frameBodyStart, endPos, next));
        } catch {
          body.push({
            type: "rawFrame",
            tex: src.slice(cursor, next),
            title: null,
            label: null,
            span: span(cursor, next),
          });
        }
        cursor = next;
        continue;
      }
      // フレーム外の未知コンテンツは読み飛ばす
      const eol = src.indexOf("\n", cursor);
      cursor = eol === -1 ? bodyEnd : eol + 1;
    }

    return {
      type: "document",
      span: span(0, src.length),
      sourceVersion,
      aspectRatio,
      metadata,
      macros: macrosRegion
        ? this.parseMacroSection(macrosRegion[0], macrosRegion[1])
        : { type: "macroSection", entries: [], span: span(0, 0) },
      style: styleRegion
        ? this.parseStyleSection(styleRegion[0], styleRegion[1])
        : { type: "style", entries: [], span: span(0, 0) },
      preambleExtra: {
        type: "rawRegion",
        tex: extraRegion ? src.slice(extraRegion[0], extraRegion[1]) : "",
        span: extraRegion ? span(extraRegion[0], extraRegion[1]) : span(0, 0),
      },
      managedPreamble: {
        type: "rawRegion",
        tex: src.slice(0, preambleEnd),
        span: span(0, preambleEnd),
      },
      body,
    };
  }
}

/** ソース全体をパースする。決して throw しない(最悪でも RawFrame の列になる)。 */
export function parseDeck(source: string): DeckDocument {
  return new Parser(source).parseDocument();
}
