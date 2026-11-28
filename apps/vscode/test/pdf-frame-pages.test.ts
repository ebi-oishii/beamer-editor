import { readFileSync } from "node:fs";
import { pdfSourceDigest } from "@beamer-editor/compiler";
import { describe, expect, it } from "vitest";
import { renderDocument } from "../src/document-controller";
import { matchPdfFramePages } from "../src/pdf-frame-pages";

describe("PDF frame pages", () => {
  const source = readFileSync(
    new URL("../../../fixtures/preview-phase3/pages.slide.tex", import.meta.url),
    "utf8",
  );
  const report = {
    sourceDigest: pdfSourceDigest(source),
    pages: [9, 9, 10, 28, 28, 28, 32, 35].map((line, index) => ({
      page: index + 1,
      lines: [line],
    })),
  };
  const lineAt = (offset: number) => source.slice(0, offset).split("\n").length;

  it("keeps overlay and break pages and discards generated pages and an omitted frame", () => {
    expect(matchPdfFramePages(source, lineAt, renderDocument(source, 1), report)).toEqual([
      { frameIndex: 0, pages: [1, 2] },
      { frameIndex: 1, pages: [4, 5, 6] },
      { frameIndex: 3, pages: [8] },
    ]);
  });

  it("rejects stale source and mixed frame evidence", () => {
    expect(
      matchPdfFramePages(`${source}% edit`, lineAt, renderDocument(source, 2), report),
    ).toEqual([]);
    expect(
      matchPdfFramePages(source, lineAt, renderDocument(source, 1), {
        ...report,
        pages: [
          { page: 1, lines: [9, 10] },
          { page: 2, lines: [9, 28] },
          { page: 3, lines: [] },
        ],
      }),
    ).toEqual([]);
  });

  it("rejects a line shared with a command outside the frame", () => {
    const oneLine = String.raw`\begin{document}
\section{Opening}\begin{frame}First\end{frame}
\end{document}`;
    expect(
      matchPdfFramePages(
        oneLine,
        (offset) => oneLine.slice(0, offset).split("\n").length,
        renderDocument(oneLine, 1),
        { sourceDigest: pdfSourceDigest(oneLine), pages: [{ page: 1, lines: [2] }] },
      ),
    ).toEqual([]);
  });
});
