import { type PdfSourcePages, pdfSourceDigest } from "@beamer-editor/compiler";
import { framesOf, mapExpandedRangeToSourceExact, parseDeck } from "@beamer-editor/core";
import type { PdfFramePages } from "@beamer-editor/ui";
import type { RenderOutcome } from "./document-controller";

export function matchPdfFramePages(
  source: string,
  lineAt: (offset: number) => number,
  outcome: RenderOutcome,
  mapping: PdfSourcePages,
): PdfFramePages[] {
  if (mapping.sourceDigest !== pdfSourceDigest(source)) return [];
  const original = framesOf(parseDeck(source)).map(({ span }) => {
    const lineStart = source.lastIndexOf("\n", span.start - 1) + 1;
    const nextLine = source.indexOf("\n", span.end);
    const trailing = source.slice(span.end, nextLine < 0 ? source.length : nextLine);
    // SyncTeX cannot separate commands that share a source line with a frame.
    const exclusivelyStartsFrame = source.slice(lineStart, span.start).trim() === "";
    const exclusivelyEndsFrame = /^\s*(?:%.*)?$/.test(trailing);
    return {
      span,
      first: lineAt(span.start) + (exclusivelyStartsFrame ? 0 : 1),
      last: lineAt(span.end - 1) - (exclusivelyEndsFrame ? 0 : 1),
    };
  });
  const byStart = new Map<number, number[]>();
  for (const { page, lines } of mapping.pages) {
    if (lines.length === 0) continue;
    // Every main-input record must belong to the same original frame. Shared
    // lines and pages with only generated/input-file content are ambiguous.
    const owners = original.filter(({ first, last }) =>
      lines.some((line) => first <= line && line <= last),
    );
    const owner = owners[0];
    if (
      owners.length !== 1 ||
      !owner ||
      !lines.every((line) => owner.first <= line && line <= owner.last)
    )
      continue;
    const pages = byStart.get(owner.span.start) ?? [];
    pages.push(page);
    byStart.set(owner.span.start, pages);
  }
  return outcome.deck.frames.flatMap((frame, frameIndex) => {
    const start = mapExpandedRangeToSourceExact(outcome.expansionMap, {
      start: frame.sourceSpan.start,
      end: frame.sourceSpan.start + 1,
    });
    const pages = start && byStart.get(start.start);
    return pages ? [{ frameIndex, pages }] : [];
  });
}
