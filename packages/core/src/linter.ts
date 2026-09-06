import {
  type AnyFrameNode,
  type BlockNode,
  type CanvasNode,
  type DeckDocument,
  frameLabel,
  framesOf,
  type InlineNode,
  isCanvasFrame,
  type RawFrameNode,
  type SourceSpan,
} from "./ast.js";
import type { FileExistsProbe, ImageFormat, ImageProbe } from "./image.js";
import { parseDeck } from "./parser.js";
import type { TemplateStatus } from "./template.js";

export type LintCode =
  | "L001"
  | "L002"
  | "L004"
  | "L005"
  | "L007"
  | "L009"
  | "L011"
  | "L012"
  | "L013"
  | "L014"
  | "L015"
  | "L016"
  | "L017"
  | "L018"
  | "L019"
  | "L020"
  | "L021"
  | "L022"
  | "L023";

export type LintSeverity = "info" | "warning" | "error";

export interface LintDiagnostic {
  code: LintCode;
  severity: LintSeverity;
  message: string;
  span: SourceSpan;
}

export interface LintOptions {
  /** 対応する `%% deck-source-version`。 */
  expectedSourceVersion?: number;
  /** Optional external dependency; core itself never accesses the filesystem. */
  fileExists?: FileExistsProbe;
  /** Optional external dependency used for deckcanvas image validation. */
  probeImage?: ImageProbe;
  /**
   * preamble-extra のテンプレート参照(\usetheme / \usepackage)をホストが解決した結果。
   * 未指定ならテンプレートの lint(L022 / L023)は行わない。
   */
  templates?: readonly TemplateStatus[];
}

export const CURRENT_DECK_SOURCE_VERSION = 1;

const VERBATIM_ENVS = new Set(["verbatim", "verbatim*", "semiverbatim", "lstlisting", "minted"]);
const VERBATIM_DELIMITERS = [...VERBATIM_ENVS].map((environment) => ({
  begin: `\\begin{${environment}}`,
  end: `\\end{${environment}}`,
}));
const YEN = new Set(["¥", "￥"]);
function frameLabelSpan(frame: AnyFrameNode): SourceSpan {
  return frame.type === "frame" ? (frame.options.span ?? frame.span) : frame.span;
}

function lintDuplicateLabels(frames: AnyFrameNode[]): LintDiagnostic[] {
  const byLabel = new Map<string, AnyFrameNode[]>();

  for (const frame of frames) {
    const label = frameLabel(frame);
    if (label === null) continue;
    const occurrences = byLabel.get(label) ?? [];
    occurrences.push(frame);
    byLabel.set(label, occurrences);
  }

  return [...byLabel]
    .filter(([, occurrences]) => occurrences.length > 1)
    .flatMap(([label, occurrences]) =>
      occurrences.map((frame) => ({
        code: "L009" as const,
        severity: "warning" as const,
        message: `frame の label「${label}」が重複しています`,
        span: frameLabelSpan(frame),
      })),
    );
}

function lintCanvasFrames(doc: DeckDocument): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];

  for (const element of doc.body) {
    if (element.type !== "frame" || !isCanvasFrame(element)) continue;

    if (frameLabel(element) === null) {
      diagnostics.push({
        code: "L011",
        severity: "warning",
        message: "deckcanvas を持つ frame には一意な label が必要です",
        span: element.options.span ?? element.span,
      });
    }

    if (doc.aspectRatio === "43") {
      diagnostics.push({
        code: "L018",
        severity: "warning",
        message: "deckcanvas は aspectratio=169 のデッキでのみ正式に対応しています",
        span: element.span,
      });
    }
  }

  return diagnostics;
}

function diagnostic(
  code: LintCode,
  severity: LintSeverity,
  message: string,
  span: SourceSpan,
): LintDiagnostic {
  return { code, severity, message, span };
}

function lintRawSyntax(doc: DeckDocument): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const node = value as { type?: string; span?: SourceSpan };
    if (
      (node.type === "rawInline" || node.type === "rawBlock" || node.type === "rawFrame") &&
      node.span !== undefined
    ) {
      diagnostics.push(
        diagnostic("L001", "info", "サブセット外の構文は生ブロックとして扱われます", node.span),
      );
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(doc);
  return diagnostics;
}

type RawDefinitionState =
  | { phase: "primitive"; start: SourceSpan }
  | { phase: "target"; start: SourceSpan }
  | {
      phase: "body";
      start: SourceSpan;
      reservedTarget: boolean;
      depth: number;
      started: boolean;
    };

function skipTexTrivia(tex: string, start: number): number {
  let index = start;
  while (index < tex.length) {
    if (/\s/.test(tex[index] ?? "")) {
      index++;
      continue;
    }
    if (tex[index] === "%") {
      const newline = tex.indexOf("\n", index);
      index = newline === -1 ? tex.length : newline + 1;
      continue;
    }
    break;
  }
  return index;
}

function readControlWord(tex: string, start: number, names: readonly string[]): number | null {
  for (const name of names) {
    const command = `\\${name}`;
    if (tex.startsWith(command, start) && !/[A-Za-z@]/.test(tex[start + command.length] ?? "")) {
      return start + command.length;
    }
  }
  return null;
}

function readReservedTarget(tex: string, start: number): number | null {
  const match = /^\\deck[A-Za-z@]*/.exec(tex.slice(start));
  return match === null ? null : start + match[0].length;
}

function readDirectTarget(tex: string, start: number): number | null {
  const match = /^\\[A-Za-z@]+/.exec(tex.slice(start));
  return match === null ? null : start + match[0].length;
}

function scanBraceDepth(
  tex: string,
  start: number,
  initialDepth: number,
  initialBodyStarted: boolean,
): { depth: number; started: boolean; completed: boolean; nextIndex: number } {
  let depth = initialDepth;
  let started = initialBodyStarted;
  for (let index = start; index < tex.length; index++) {
    const ch = tex[index];
    if (ch === "\\") {
      index++;
      continue;
    }
    if (ch === "%") {
      const newline = tex.indexOf("\n", index);
      if (newline === -1) return { depth, started, completed: false, nextIndex: tex.length };
      index = newline;
      continue;
    }
    if (ch === "{") {
      depth++;
      started = true;
    } else if (ch === "}" && started) {
      depth--;
      if (depth === 0) return { depth, started, completed: true, nextIndex: index + 1 };
    }
  }
  return { depth, started, completed: false, nextIndex: tex.length };
}

/**
 * RawBlock は行単位なので、定義の prefix / primitive / target は隣接する
 * RawBlock に分かれうる。先頭からこの有限文法だけを読むことで、本文や呼び出しを
 * 定義として再走査しない。
 */
function scanRawReservedDefinition(
  tex: string,
  span: SourceSpan,
  state: RawDefinitionState | null,
): { consumed: boolean; diagnosticSpans: SourceSpan[]; state: RawDefinitionState | null } {
  let index = skipTexTrivia(tex, 0);
  let current = state;
  const diagnosticSpans: SourceSpan[] = [];

  while (index < tex.length || current !== null) {
    if (current?.phase === "body") {
      const body = scanBraceDepth(tex, index, current.depth, current.started);
      if (!body.completed) {
        return {
          diagnosticSpans,
          consumed: true,
          state: { ...current, depth: body.depth, started: body.started },
        };
      }
      if (current.reservedTarget) {
        diagnosticSpans.push({ start: current.start.start, end: span.start + body.nextIndex });
      }
      current = null;
      index = skipTexTrivia(tex, body.nextIndex);
      continue;
    }

    if (current?.phase === "target") {
      const pendingStart = current.start;
      const targetEnd = readDirectTarget(tex, index);
      if (targetEnd === null) return { consumed: false, diagnosticSpans, state: null };
      const reservedTarget = readReservedTarget(tex, index) !== null;
      const body = scanBraceDepth(tex, targetEnd, 0, false);
      if (reservedTarget && body.completed) {
        diagnosticSpans.push({ start: pendingStart.start, end: span.start + body.nextIndex });
      }
      current = body.completed
        ? null
        : {
            phase: "body",
            start: pendingStart,
            depth: body.depth,
            started: body.started,
            reservedTarget,
          };
      index = skipTexTrivia(tex, body.nextIndex);
      continue;
    }

    let definitionStart = current?.start ?? null;
    while (true) {
      const prefixStart = index;
      const prefixEnd = readControlWord(tex, index, ["global", "long", "outer", "protected"]);
      if (prefixEnd === null) break;
      definitionStart ??= { start: span.start + prefixStart, end: span.end };
      index = skipTexTrivia(tex, prefixEnd);
    }

    const primitiveStart = index;
    const primitiveEnd = readControlWord(tex, index, ["def", "gdef", "edef", "xdef"]);
    if (primitiveEnd === null) {
      if (definitionStart !== null && index === tex.length) {
        return {
          consumed: true,
          diagnosticSpans,
          state: { phase: "primitive", start: definitionStart },
        };
      }
      return {
        consumed: current?.phase !== "primitive",
        diagnosticSpans,
        state: null,
      };
    }
    definitionStart ??= { start: span.start + primitiveStart, end: span.end };
    index = skipTexTrivia(tex, primitiveEnd);

    const targetEnd = readDirectTarget(tex, index);
    if (targetEnd !== null) {
      const reservedTarget = readReservedTarget(tex, index) !== null;
      const body = scanBraceDepth(tex, targetEnd, 0, false);
      if (reservedTarget && body.completed) {
        diagnosticSpans.push({ start: definitionStart.start, end: span.start + body.nextIndex });
      }
      current = body.completed
        ? null
        : {
            phase: "body",
            start: definitionStart,
            depth: body.depth,
            started: body.started,
            reservedTarget,
          };
      index = skipTexTrivia(tex, body.nextIndex);
      continue;
    }
    if (index === tex.length) {
      return {
        consumed: true,
        diagnosticSpans,
        state: { phase: "target", start: definitionStart },
      };
    }
    return { consumed: true, diagnosticSpans, state: null };
  }
  return { consumed: true, diagnosticSpans, state: current };
}

/** マクロ領域は展開器に渡す前の AST 情報だけで検査する。 */
function lintMacros(doc: DeckDocument): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  let rawDefinitionState: RawDefinitionState | null = null;

  for (const entry of doc.macros.entries) {
    const stateWasPending = rawDefinitionState !== null;
    if (stateWasPending) {
      const result = scanRawReservedDefinition(entry.tex, entry.span, rawDefinitionState);
      rawDefinitionState = result.state;
      for (const diagnosticSpan of result.diagnosticSpans) {
        diagnostics.push(
          diagnostic("L016", "error", "deck で始まるマクロ名は予約されています", diagnosticSpan),
        );
      }
      // pending definition に続く structured entry は本文/未完部分として消費済みであり、
      // AST 単位の L002/L016 を重ねて出さない。
      if (entry.type === "macroDefinition" && result.consumed) continue;
    }

    if (entry.type === "rawBlock") {
      diagnostics.push(
        diagnostic("L002", "warning", "このマクロ領域の内容は展開に対応していません", entry.span),
      );
      if (!stateWasPending) {
        const result = scanRawReservedDefinition(entry.tex, entry.span, rawDefinitionState);
        rawDefinitionState = result.state;
        for (const diagnosticSpan of result.diagnosticSpans) {
          diagnostics.push(
            diagnostic("L016", "error", "deck で始まるマクロ名は予約されています", diagnosticSpan),
          );
        }
      }
      continue;
    }

    rawDefinitionState = null;

    if (!entry.expandable) {
      diagnostics.push(
        diagnostic("L002", "warning", "このマクロ定義は展開に対応していません", entry.span),
      );
    }

    if (entry.name.startsWith("deck")) {
      diagnostics.push(
        diagnostic("L016", "error", "deck で始まるマクロ名は予約されています", entry.span),
      );
    }
  }

  return diagnostics;
}

function visitBlocks(blocks: BlockNode[], visitor: (block: BlockNode) => void): void {
  for (const block of blocks) {
    visitor(block);
    switch (block.type) {
      case "list":
        for (const item of block.items) visitBlocks(item.children, visitor);
        break;
      case "columns":
        for (const column of block.columns) visitBlocks(column.children, visitor);
        break;
      case "blockEnv":
      case "center":
        visitBlocks(block.children, visitor);
        break;
      case "canvas":
        for (const item of block.items) {
          if (item.type === "canvasText") visitBlocks(item.children, visitor);
        }
        break;
      default:
        break;
    }
  }
}

function lintOverlays(doc: DeckDocument): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  for (const frame of framesOf(doc)) {
    if (frame.type !== "frame") continue;
    const overlays: Array<{ from: number; to: number | null; span: SourceSpan }> = [];
    visitBlocks(frame.body, (block) => {
      if (block.type === "list") {
        for (const item of block.items) {
          const overlay = item.overlay;
          if (overlay) {
            overlays.push(...overlay.ranges.map((range) => ({ ...range, span: overlay.span })));
          }
        }
      } else if (block.type === "blockEnv") {
        const overlay = block.overlay;
        if (overlay) {
          overlays.push(...overlay.ranges.map((range) => ({ ...range, span: overlay.span })));
        }
      }
    });

    const invalid = overlays.filter(({ from, to }) => from < 1 || (to !== null && to < from));
    for (const overlay of invalid) {
      diagnostics.push(
        diagnostic("L005", "warning", "オーバーレイ番号の範囲が不正です", overlay.span),
      );
    }
    const valid = overlays.filter(({ from, to }) => from >= 1 && (to === null || to >= from));
    const max = valid.reduce(
      (current, overlay) => Math.max(current, overlay.to ?? overlay.from),
      0,
    );
    const hasAlwaysVisibleContent = frame.body.some((block) => {
      if (block.type === "blockEnv") return block.overlay === null;
      if (block.type !== "list") return true;
      return block.items.some((item) => item.overlay === null);
    });
    for (let step = 1; step <= max; step++) {
      if (
        hasAlwaysVisibleContent ||
        valid.some(({ from, to }) => from <= step && (to === null || step <= to))
      ) {
        continue;
      }
      diagnostics.push(
        diagnostic(
          "L005",
          "warning",
          `オーバーレイのステップ ${step} に表示される要素がありません`,
          frame.span,
        ),
      );
    }
  }
  return diagnostics;
}

function lintFragileFrames(doc: DeckDocument): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  for (const frame of framesOf(doc)) {
    if (frame.type === "rawFrame") {
      if (rawFrameNeedsFragile(frame)) {
        diagnostics.push(
          diagnostic(
            "L007",
            "error",
            "verbatim 系を含む frame には fragile オプションが必要です",
            frame.span,
          ),
        );
      }
      continue;
    }
    if (frame.options.fragile) continue;
    visitBlocks(frame.body, (block) => {
      if (block.type === "rawBlock" && containsVerbatimEnvironment(stripTexComments(block.tex))) {
        diagnostics.push(
          diagnostic(
            "L007",
            "error",
            "verbatim 系を含む frame には fragile オプションが必要です",
            block.span,
          ),
        );
      }
    });
  }
  return diagnostics;
}

function rawFrameNeedsFragile(frame: RawFrameNode): boolean {
  const withoutComments = stripTexComments(frame.tex);
  const opening = /\\begin\{frame\}\s*(?:\[([^\]]*)\])?/.exec(withoutComments);
  if (!opening || /(?:^|,)\s*fragile(?:\s*=\s*[^,\]]+)?\s*(?:,|$)/.test(opening[1] ?? "")) {
    return false;
  }
  return containsVerbatimEnvironment(withoutComments);
}

function stripTexComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      for (let index = 0; index < line.length; index++) {
        if (line[index] !== "%") continue;
        let slashes = 0;
        for (let previous = index - 1; previous >= 0 && line[previous] === "\\"; previous--)
          slashes++;
        if (slashes % 2 === 0) return line.slice(0, index);
      }
      return line;
    })
    .join("\n");
}

function containsVerbatimEnvironment(source: string): boolean {
  let stringifyNextToken = false;
  for (let index = 0; index < source.length; ) {
    const char = source[index] as string;
    if (stringifyNextToken && /\s/.test(char)) {
      index++;
      continue;
    }
    if (char !== "\\") {
      stringifyNextToken = false;
      index++;
      continue;
    }
    const next = source[index + 1] ?? "";
    if (!/[a-zA-Z@]/.test(next)) {
      // `\\` は改行コマンドであり、後続の `begin` は通常文字列になる。
      stringifyNextToken = false;
      index += Math.min(2, source.length - index);
      continue;
    }
    let end = index + 1;
    while (end < source.length && /[a-zA-Z@]/.test(source[end] as string)) end++;
    const command = source.slice(index + 1, end);
    if (stringifyNextToken) {
      stringifyNextToken = false;
      index = end;
      continue;
    }
    if (command === "detokenize") {
      const argumentEnd = balancedArgumentEnd(source, end);
      index = argumentEnd ?? end;
      continue;
    }
    if (command === "string" || command === "meaning") {
      stringifyNextToken = true;
      index = end;
      continue;
    }
    if (command === "begin") {
      let cursor = end;
      while (cursor < source.length && /\s/.test(source[cursor] as string)) cursor++;
      const close = source.indexOf("}", cursor + 1);
      if (source[cursor] === "{" && close !== -1) {
        const environment = source.slice(cursor + 1, close);
        if (VERBATIM_ENVS.has(environment)) return true;
      }
    }
    index = end;
  }
  return false;
}

function balancedArgumentEnd(source: string, index: number): number | null {
  let cursor = index;
  while (cursor < source.length && /\s/.test(source[cursor] as string)) cursor++;
  if (source[cursor] !== "{") return null;

  let depth = 1;
  cursor++;
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      const next = source[cursor + 1] ?? "";
      if (/[a-zA-Z@]/.test(next)) {
        cursor += 2;
        while (cursor < source.length && /[a-zA-Z@]/.test(source[cursor] as string)) cursor++;
      } else {
        cursor += Math.min(2, source.length - cursor);
      }
      continue;
    }
    if (source[cursor] === "{") depth++;
    if (source[cursor] === "}" && --depth === 0) return cursor + 1;
    cursor++;
  }
  return null;
}

function lintCanvas(canvas: CanvasNode): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  for (const item of canvas.items) {
    if (item.type === "rawBlock") {
      diagnostics.push(
        diagnostic(
          "L014",
          "warning",
          "deckcanvas 直下には decktext または deckimage だけを置けます",
          item.span,
        ),
      );
      continue;
    }
    const { x, y, width, span } = item.position;
    if (x < 0 || x > 1 || y < 0 || y > 1 || width <= 0 || width > 1 || x + width > 1) {
      diagnostics.push(
        diagnostic(
          "L012",
          "warning",
          "キャンバスの x, y, w は本文領域内に収まる必要があります",
          span,
        ),
      );
    }
    if (item.type !== "canvasText") continue;
    if (item.invalidSize !== null) {
      diagnostics.push(
        diagnostic(
          "L013",
          "error",
          `許可されていない文字サイズです: ${item.invalidSize.value}`,
          item.invalidSize.span,
        ),
      );
    }
    const visitTextBlocks = (blocks: BlockNode[], listDepth: number): void => {
      for (const block of blocks) {
        if (block.type === "paragraph") {
          continue;
        }
        if (block.type === "rawBlock") {
          diagnostics.push(
            diagnostic(
              "L014",
              "warning",
              "decktext 内に許可されていない要素があります",
              block.span,
            ),
          );
        } else if (block.type === "list") {
          if (listDepth > 2) {
            diagnostics.push(
              diagnostic(
                "L014",
                "warning",
                "decktext 内のリストは 3 段までしかネストできません",
                block.span,
              ),
            );
          }
          for (const listItem of block.items) {
            if (listItem.overlay !== null) {
              diagnostics.push(
                diagnostic(
                  "L014",
                  "warning",
                  "decktext 内のリスト項目にオーバーレイ指定は使えません",
                  listItem.overlay.span,
                ),
              );
            }
            visitTextBlocks(listItem.children, listDepth + 1);
          }
        } else {
          diagnostics.push(
            diagnostic(
              "L014",
              "warning",
              "decktext 内に許可されていない要素があります",
              block.span,
            ),
          );
        }
      }
    };
    visitTextBlocks(item.children, 0);
  }
  return diagnostics;
}

function lintCanvasContent(doc: DeckDocument): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  for (const element of doc.body) {
    if (element.type !== "frame") continue;
    // フロー要素との共存は可。deckcanvas 自体はフレームに 1 つまで(2 つ目以降を報告)。
    let canvases = 0;
    for (const block of element.body) {
      if (block.type !== "canvas") continue;
      if (canvases++ > 0) {
        diagnostics.push(
          diagnostic("L014", "warning", "deckcanvas はフレームに 1 つまでです", block.span),
        );
      }
      diagnostics.push(...lintCanvas(block));
    }
  }
  return diagnostics;
}

function lintCanvasTitles(doc: DeckDocument): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  for (const element of doc.body) {
    if (element.type !== "frame" || !isCanvasFrame(element) || element.title === null) continue;
    if (!hasLineBreak(element.title)) continue;
    const first = element.title[0];
    const last = element.title.at(-1);
    diagnostics.push(
      diagnostic("L019", "warning", "キャンバスフレームのタイトルは 1 行に収めてください", {
        start: first?.span.start ?? element.span.start,
        end: last?.span.end ?? element.span.end,
      }),
    );
  }
  return diagnostics;
}

function hasLineBreak(nodes: InlineNode[]): boolean {
  return nodes.some((node) => {
    if (node.type === "lineBreak" || (node.type === "text" && node.value.includes("\n")))
      return true;
    return (
      (node.type === "styled" || node.type === "colorText" || node.type === "href") &&
      hasLineBreak(node.children)
    );
  });
}

function lintSourceVersion(doc: DeckDocument, expectedSourceVersion: number): LintDiagnostic[] {
  if (doc.sourceVersion === expectedSourceVersion) return [];

  const message =
    doc.sourceVersion === null
      ? `%% deck-source-version: ${expectedSourceVersion} がありません`
      : `deck-source-version ${doc.sourceVersion} には対応していません（対応版: ${expectedSourceVersion}）`;

  return [
    {
      code: "L017",
      severity: "warning",
      message,
      span: { start: 0, end: 0 },
    },
  ];
}

function lintStyle(doc: DeckDocument): LintDiagnostic[] {
  return doc.style.entries
    .filter((entry) => entry.type === "rawBlock" && entry.reason === "unknown-style")
    .map((entry) => ({
      code: "L020",
      severity: "error",
      message: "%% style 領域に対応していない記述があります",
      span: entry.span,
    }));
}

function lintImageReferences(
  doc: DeckDocument,
  fileExists: FileExistsProbe | undefined,
): LintDiagnostic[] {
  if (fileExists === undefined) return [];
  const diagnostics: LintDiagnostic[] = [];
  const check = (path: string, span: SourceSpan): void => {
    if (!fileExists(path)) {
      diagnostics.push(diagnostic("L004", "error", "画像の参照先ファイルが存在しません", span));
    }
  };
  for (const entry of doc.style.entries) {
    if (entry.type === "styleLogo") check(entry.path, entry.span);
  }
  for (const frame of framesOf(doc)) {
    if (frame.type !== "frame") continue;
    visitBlocks(frame.body, (block) => {
      if (block.type === "image") check(block.path, block.span);
    });
  }
  return diagnostics;
}

const IMAGE_FORMATS: Record<string, ImageFormat> = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  pdf: "pdf",
};

function validDimensions(value: { width: number; height: number }): boolean {
  return (
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    value.width > 0 &&
    value.height > 0
  );
}

function lintCanvasImages(doc: DeckDocument, probeImage: ImageProbe | undefined): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  for (const frame of framesOf(doc)) {
    if (frame.type !== "frame") continue;
    visitBlocks(frame.body, (block) => {
      if (block.type !== "canvas") return;
      for (const item of block.items) {
        if (item.type !== "canvasImage") continue;
        const extension = item.path.match(/\.([^.\\/]+)$/)?.[1]?.toLowerCase();
        const expectedFormat = extension === undefined ? undefined : IMAGE_FORMATS[extension];
        if (expectedFormat === undefined) {
          diagnostics.push(
            diagnostic(
              "L015",
              "error",
              "deckimage は PNG / JPEG / PDF のみ対応しています",
              item.span,
            ),
          );
          continue;
        }
        if (probeImage === undefined) continue;
        const result = probeImage(item.path);
        if (
          !result.ok ||
          result.metadata.format !== expectedFormat ||
          !validDimensions(result.metadata.dimensions)
        ) {
          diagnostics.push(
            diagnostic(
              "L015",
              "error",
              "deckimage の画像形式または寸法を確認できません",
              item.span,
            ),
          );
        }
      }
    });
  }
  return diagnostics;
}

/**
 * テンプレート参照の解決結果を診断にする。
 * - `\usepackage{templates/...}` のようにパスで指す参照が見つからない → L022 warning
 * - `\usetheme{X}` が見つからない → L022 info(TeX 配布に含まれるテーマならコンパイルは通る)
 * - パス無しの `\usepackage{name}` が見つからない → 通常のパッケージとみなして報告しない
 * - 見つかった `.sty` が参照する画像が無い → L023 warning
 */
function lintTemplates(statuses: readonly TemplateStatus[] | undefined): LintDiagnostic[] {
  if (statuses === undefined) return [];
  const diagnostics: LintDiagnostic[] = [];
  for (const { reference, resolvedPath, missingImages } of statuses) {
    if (resolvedPath === null) {
      if (reference.kind === "theme") {
        diagnostics.push(
          diagnostic(
            "L022",
            "info",
            `テンプレート ${reference.file} がデッキのディレクトリ配下(直下または templates/*/)に見つかりません。TeX 配布に含まれるテーマならコンパイルは通ります`,
            reference.span,
          ),
        );
      } else if (reference.name.includes("/")) {
        diagnostics.push(
          diagnostic(
            "L022",
            "warning",
            `テンプレート ${reference.file} が見つかりません(デッキのディレクトリ基準)`,
            reference.span,
          ),
        );
      }
      continue;
    }
    for (const image of missingImages) {
      diagnostics.push(
        diagnostic(
          "L023",
          "warning",
          `テンプレート ${resolvedPath} が参照する画像 ${image} が見つかりません(デッキのディレクトリ基準)`,
          reference.span,
        ),
      );
    }
  }
  return diagnostics;
}

/**
 * AST と、必要に応じて注入された外部プローブで lint 規則を実行する。
 */
export function lintDeck(doc: DeckDocument, options: LintOptions = {}): LintDiagnostic[] {
  const expectedSourceVersion = options.expectedSourceVersion ?? CURRENT_DECK_SOURCE_VERSION;
  const diagnostics = [
    ...lintRawSyntax(doc),
    ...lintMacros(doc),
    ...lintOverlays(doc),
    ...lintFragileFrames(doc),
    ...lintDuplicateLabels(framesOf(doc)),
    ...lintCanvasFrames(doc),
    ...lintCanvasContent(doc),
    ...lintCanvasTitles(doc),
    ...lintSourceVersion(doc, expectedSourceVersion),
    ...lintStyle(doc),
    ...lintImageReferences(doc, options.fileExists),
    ...lintCanvasImages(doc, options.probeImage),
    ...lintTemplates(options.templates),
  ];

  return diagnostics.sort((a, b) => a.span.start - b.span.start || a.code.localeCompare(b.code));
}

function findLineEnd(source: string, position: number): number {
  let cursor = position;
  while (cursor < source.length && source[cursor] !== "\n" && source[cursor] !== "\r") cursor++;
  return cursor;
}

function isYenCommandStart(source: string, position: number): boolean {
  const next = source[position + 1];
  return (
    next !== undefined &&
    (/[A-Za-z@]/.test(next) || "%#$&_{}~^\\[]".includes(next) || YEN.has(next))
  );
}

/** source-dependent な円記号/全角円記号の TeX command 誤記を検出する。 */
function lintYenBackslashes(source: string): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  let precedingBackslashes = 0;
  let lineEnd = findLineEnd(source, 0);
  for (let cursor = 0; cursor < source.length; cursor++) {
    if (cursor > lineEnd) lineEnd = findLineEnd(source, cursor);
    const char = source[cursor] as string;
    const escaped = precedingBackslashes % 2 === 1;
    if (char === "%" && !escaped) {
      cursor = lineEnd;
      precedingBackslashes = 0;
      continue;
    }
    if (char === "\\" && !escaped) {
      if (source.startsWith("\\verb", cursor) && !/[A-Za-z@]/.test(source[cursor + 5] ?? "")) {
        let literal = cursor + 5;
        if (source[literal] === "*") literal++;
        const delimiter = source[literal];
        if (delimiter === undefined || /\s/.test(delimiter)) {
          cursor = lineEnd;
          precedingBackslashes = 0;
          continue;
        }
        let close = literal + 1;
        while (close < lineEnd && source[close] !== delimiter) close++;
        cursor = close;
        precedingBackslashes = 0;
        continue;
      }
      let skippedVerbatim = false;
      for (const delimiter of VERBATIM_DELIMITERS) {
        if (!source.startsWith(delimiter.begin, cursor)) continue;
        const endAt = source.indexOf(delimiter.end, cursor + delimiter.begin.length);
        if (endAt === -1) return diagnostics;
        cursor = endAt + delimiter.end.length - 1;
        precedingBackslashes = 0;
        skippedVerbatim = true;
        break;
      }
      if (skippedVerbatim) continue;
    }
    if (YEN.has(char) && isYenCommandStart(source, cursor)) {
      diagnostics.push({
        code: "L021",
        severity: "warning",
        message: "円記号ではなくバックスラッシュを使って TeX コマンドを書いてください",
        span: { start: cursor, end: cursor + 1 },
      });
    }
    precedingBackslashes = char === "\\" ? precedingBackslashes + 1 : 0;
  }
  return diagnostics;
}

/** 元ソースを必要とする規則を含めて lint する公開 API。 */
export function lintSource(source: string, options: LintOptions = {}): LintDiagnostic[] {
  return [...lintDeck(parseDeck(source), options), ...lintYenBackslashes(source)].sort(
    (a, b) => a.span.start - b.span.start || a.code.localeCompare(b.code),
  );
}
