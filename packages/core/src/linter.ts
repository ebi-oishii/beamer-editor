import {
  type DeckDocument,
  type FrameNode,
  framesOf,
  isCanvasFrame,
  type RawFrameNode,
  type SourceSpan,
} from "./ast.js";

export type LintCode = "L009" | "L011" | "L017" | "L018" | "L020";

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
}

export const CURRENT_DECK_SOURCE_VERSION = 1;

type AnyFrame = FrameNode | RawFrameNode;

function frameLabel(frame: AnyFrame): string | null {
  const label = frame.type === "frame" ? frame.options.label : frame.label;
  return label?.trim() || null;
}

function frameLabelSpan(frame: AnyFrame): SourceSpan {
  return frame.type === "frame" ? (frame.options.span ?? frame.span) : frame.span;
}

function lintDuplicateLabels(frames: AnyFrame[]): LintDiagnostic[] {
  const byLabel = new Map<string, AnyFrame[]>();

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

/**
 * AST だけで判定できる lint 規則を実行する。
 *
 * ファイル参照や画像寸法など、外部環境が必要な規則は別途注入可能な
 * lint コンテキストを追加して実装する。
 */
export function lintDeck(doc: DeckDocument, options: LintOptions = {}): LintDiagnostic[] {
  const expectedSourceVersion = options.expectedSourceVersion ?? CURRENT_DECK_SOURCE_VERSION;
  const diagnostics = [
    ...lintDuplicateLabels(framesOf(doc)),
    ...lintCanvasFrames(doc),
    ...lintSourceVersion(doc, expectedSourceVersion),
    ...lintStyle(doc),
  ];

  return diagnostics.sort((a, b) => a.span.start - b.span.start || a.code.localeCompare(b.code));
}
