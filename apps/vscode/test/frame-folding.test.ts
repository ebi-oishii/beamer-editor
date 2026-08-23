import { describe, expect, it } from "vitest";
import {
  FrameFoldCache,
  type FrameFoldDocument,
  frameFoldRanges,
  provideFrameFoldRanges,
} from "../src/frame-folding";

function positionAt(source: string, offset: number): { line: number } {
  return { line: source.slice(0, offset).split(/\r\n|\r|\n/).length - 1 };
}

function ranges(source: string) {
  return frameFoldRanges(source, (offset) => positionAt(source, offset));
}

describe("frameFoldRanges", () => {
  it("returns complete structured frames in source order", () => {
    const source = `before
\\begin{frame}{first}
one
\\end{frame}
middle
\\begin{frame}{second}
two
\\end{frame}
after`;
    expect(ranges(source)).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 7 },
    ]);
  });

  it("folds a complete raw frame but not terminal raw frames closed only in comments", () => {
    const complete = `\\begin{frame}[unsupported]{raw}
text
\\end{frame}`;
    const unmatched = `\\begin{frame}{unfinished}
text`;
    const commentedEnd = `\\begin{frame}{unfinished}
% \\end{frame}`;
    expect(ranges(complete)).toEqual([{ start: 0, end: 2 }]);
    expect(ranges(unmatched)).toEqual([]);
    expect(ranges(commentedEnd)).toEqual([]);
  });

  it("distinguishes escaped percent from a TeX comment before a closing delimiter", () => {
    const escapedPercent = `\\begin{frame}{escaped}
\\% literal percent \\end{frame}`;
    const evenBackslashes = `\\begin{frame}{commented}
\\\\% \\end{frame}`;
    expect(ranges(escapedPercent)).toEqual([{ start: 0, end: 1 }]);
    expect(ranges(evenBackslashes)).toEqual([]);
  });

  it("requires the outer frame to close even when an inner frame is balanced", () => {
    const nested = `\\begin{frame}{outer}
\\begin{frame}{inner}
inner
\\end{frame}
\\end{frame}`;
    const outerUnmatched = `\\begin{frame}{outer}
\\begin{frame}{inner}
inner
\\end{frame}`;
    expect(ranges(nested)).toEqual([{ start: 0, end: 4 }]);
    expect(ranges(outerUnmatched)).toEqual([]);
  });

  it("uses injected UTF-16 positions and supports CRLF", () => {
    const source = "😀\r\n\\begin{frame}{日本語}\r\n本文\r\n\\end{frame}\r\n";
    const seenOffsets: number[] = [];
    const actual = frameFoldRanges(source, (offset) => {
      seenOffsets.push(offset);
      return positionAt(source, offset);
    });
    expect(actual).toEqual([{ start: 1, end: 3 }]);
    expect(seenOffsets).toEqual([source.indexOf("\\begin{frame}"), source.lastIndexOf("}")]);
  });

  it("skips one-line frames and documents without frames", () => {
    expect(ranges("\\begin{frame}{one}\\end{frame}")).toEqual([]);
    expect(ranges("\\section{No frames}\nplain text")).toEqual([]);
  });

  it("caches by document identity and version, while preserving managed and cancellation gates", () => {
    let source = "\\begin{frame}{one}\nbody\n\\end{frame}";
    let version = 1;
    const doc: FrameFoldDocument = {
      get version() {
        return version;
      },
      getText: () => source,
      positionAt: (offset) => positionAt(source, offset),
    };
    const cache = new FrameFoldCache();
    const active = { isCancellationRequested: false };

    const first = provideFrameFoldRanges(doc, () => true, active, cache);
    const second = provideFrameFoldRanges(doc, () => true, active, cache);
    expect(first).toBe(second);
    expect(provideFrameFoldRanges(doc, () => false, active, cache)).toEqual([]);
    expect(
      provideFrameFoldRanges(doc, () => true, { isCancellationRequested: true }, cache),
    ).toBeUndefined();
    let cancellationChecks = 0;
    expect(
      provideFrameFoldRanges(
        doc,
        () => true,
        {
          get isCancellationRequested() {
            return ++cancellationChecks > 1;
          },
        },
        cache,
      ),
    ).toBeUndefined();

    source = "\\begin{frame}{two}\nbody\n\\end{frame}\n\\begin{frame}{three}\nbody\n\\end{frame}";
    version++;
    expect(provideFrameFoldRanges(doc, () => true, active, cache)).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
  });
});
