import {
  type ExpansionMap,
  mapExpandedRangeToSourceExact,
  type SourceSpan,
} from "@beamer-editor/core";
import {
  type DecorationSlot,
  mapPreviewSpan,
  type PreviewSourceDiagnostic,
  type RenderedDeck,
} from "./render.js";

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
  decoration?: DecorationSlot;
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
    const { decoration } = item;
    if (
      decoration !== undefined &&
      decoration !== "logo" &&
      decoration !== "background" &&
      decoration !== "titleBackground"
    )
      return undefined;
    findings.push({
      code: item.code,
      frame: item.frame,
      ...(typeof item.elementId === "string" ? { elementId: item.elementId } : {}),
      ...(decoration === undefined ? {} : { decoration }),
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
  const shared = new Map<string, PreviewSourceDiagnostic & { affectedFrames: number[] }>();
  const result: PreviewSourceDiagnostic[] = [];
  for (const finding of findings) {
    const frame = frames.get(finding.frame);
    if (!frame) continue;
    const decoration =
      finding.code === "B001" && finding.decoration
        ? deck.decorationAssets?.find(
            (asset) => asset.slot === finding.decoration && asset.frames.includes(frame.index),
          )
        : undefined;
    if (decoration) {
      const { span, reference } = decoration;
      const key = JSON.stringify([span.start, span.end, reference]);
      const previous = shared.get(key);
      if (previous) {
        if (!previous.affectedFrames.includes(frame.index))
          previous.affectedFrames.push(frame.index);
      } else {
        const diagnostic = {
          category: "preview" as const,
          code: "B001" as const,
          ...diagnostics.B001,
          frame: null,
          span,
          reference,
          affectedFrames: [frame.index],
        };
        shared.set(key, diagnostic);
        result.push(diagnostic);
      }
      continue;
    }
    const { sourceSpan } = frame;
    const { expandedSpan } = finding;
    const element = frame.canvasElements?.find((item) => item.id === finding.elementId);
    const expanded =
      expandedSpan && expandedSpan.start >= sourceSpan.start && expandedSpan.end <= sourceSpan.end
        ? expandedSpan
        : sourceSpan;
    result.push({
      category: "preview",
      code: finding.code,
      ...diagnostics[finding.code],
      frame: { number: frame.index, label: frame.label },
      span: element?.editable
        ? element.sourceSpan
        : mapPreviewSpan(expansionMap, element?.sourceSpan ?? expanded),
    });
  }
  for (const value of shared.values()) value.affectedFrames.sort((a, b) => a - b);
  return result;
}
