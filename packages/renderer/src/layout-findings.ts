import {
  type ExpansionMap,
  mapExpandedRangeToSourceExact,
  type SourceSpan,
} from "@beamer-editor/core";
import { mapPreviewSpan, type PreviewSourceDiagnostic, type RenderedDeck } from "./render.js";

const diagnostics = {
  B001: { severity: "error", message: "ブラウザーが画像を読み込めませんでした。" },
  B002: { severity: "warning", message: "要素が編集プレビューの表示範囲からはみ出しています。" },
  B003: { severity: "error", message: "編集プレビューに必要な要素がありません。" },
} as const;

export type LayoutCode = keyof typeof diagnostics;

/** The webview sends element IDs or expanded source offsets, never VS Code positions. */
export interface LayoutFinding {
  code: LayoutCode;
  frame: number;
  elementId?: string;
  expandedSpan?: SourceSpan;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function parseLayoutFindings(value: unknown): LayoutFinding[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const findings: LayoutFinding[] = [];
  for (const item of value) {
    if (
      !record(item) ||
      (item.code !== "B001" && item.code !== "B002" && item.code !== "B003") ||
      typeof item.frame !== "number" ||
      !Number.isSafeInteger(item.frame) ||
      item.frame <= 0
    )
      return undefined;
    const span = item.expandedSpan;
    if (
      span !== undefined &&
      (!record(span) ||
        typeof span.start !== "number" ||
        typeof span.end !== "number" ||
        !Number.isSafeInteger(span.start) ||
        !Number.isSafeInteger(span.end) ||
        span.start < 0 ||
        span.start > span.end)
    )
      return undefined;
    if (item.elementId !== undefined && typeof item.elementId !== "string") return undefined;
    findings.push({
      code: item.code,
      frame: item.frame,
      ...(typeof item.elementId === "string" ? { elementId: item.elementId } : {}),
      ...(span === undefined ? {} : { expandedSpan: span as unknown as SourceSpan }),
    });
  }
  return findings;
}

export function withEditableCanvasElements(
  deck: RenderedDeck,
  expansionMap: ExpansionMap,
): RenderedDeck {
  return {
    ...deck,
    frames: deck.frames.map((frame) => ({
      ...frame,
      canvasElements: (frame.canvasElements ?? []).map((element) => {
        const sourceSpan = mapExpandedRangeToSourceExact(expansionMap, element.sourceSpan);
        return sourceSpan === null ? element : { ...element, sourceSpan, editable: true };
      }),
    })),
  };
}

export function layoutSourceDiagnostics(
  deck: RenderedDeck,
  expansionMap: ExpansionMap,
  findings: readonly LayoutFinding[],
): PreviewSourceDiagnostic[] {
  const frames = new Map(deck.frames.map((frame) => [frame.index, frame]));
  return findings.flatMap((finding) => {
    const frame = frames.get(finding.frame);
    if (!frame) return [];
    const { sourceSpan } = frame;
    const { expandedSpan } = finding;
    const element = frame.canvasElements?.find((item) => item.id === finding.elementId);
    const expanded =
      expandedSpan && expandedSpan.start >= sourceSpan.start && expandedSpan.end <= sourceSpan.end
        ? expandedSpan
        : sourceSpan;
    return [
      {
        category: "preview",
        code: finding.code,
        ...diagnostics[finding.code],
        frame: { number: frame.index, label: frame.label },
        span: element?.editable
          ? element.sourceSpan
          : mapPreviewSpan(expansionMap, element?.sourceSpan ?? expanded),
      },
    ];
  });
}
