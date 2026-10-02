import { describe, expect, it } from "vitest";
import { CANVAS_HOVER_DOCUMENTATION, canvasHoverAt } from "../src/canvas-hover";

function documentFor(source: string, offset: number) {
  return { getText: () => source, offsetAt: () => offset };
}

describe("canvasHoverAt", () => {
  it("keeps the Japanese canvas specifications, option meanings, and syntax examples together", () => {
    expect(CANVAS_HOVER_DOCUMENTATION.deckcanvas.markdown).toContain("\\begin{deckcanvas}");
    expect(CANVAS_HOVER_DOCUMENTATION.decktext.markdown).toContain("`size`");
    expect(CANVAS_HOVER_DOCUMENTATION.decktext.markdown).toContain("\\begin{decktext}");
    expect(CANVAS_HOVER_DOCUMENTATION.deckimage.markdown).toContain("`x`");
    expect(CANVAS_HOVER_DOCUMENTATION.deckimage.markdown).toContain("`y`");
    expect(CANVAS_HOVER_DOCUMENTATION.deckimage.markdown).toContain("`w`");
    expect(CANVAS_HOVER_DOCUMENTATION.deckimage.markdown).toContain("\\deckimage[");
  });

  it("returns Japanese documentation and the command-name range for each canvas construct", () => {
    const source = String.raw`\begin{deckcanvas}
  \begin{decktext}[x=0.050,y=0.100,w=0.420,size=normal]Text\end{decktext}
  \deckimage[x=0.520,y=0.140,w=0.400]{assets/image.pdf}
\end{deckcanvas}`;

    for (const name of ["deckcanvas", "decktext", "deckimage"] as const) {
      const start = source.indexOf(name);
      const hover = canvasHoverAt(documentFor(source, start + 2), undefined);
      expect(hover).toMatchObject({ range: { start, end: start + name.length } });
      expect(hover?.documentation).toBe(CANVAS_HOVER_DOCUMENTATION[name]);
      expect(hover?.documentation.markdown).toContain("キャンバス");
    }
  });

  it("does not recognize commands in comments, verbatim text, or unrelated commands", () => {
    const source = String.raw`% \deckimage[x=0,y=0,w=1]{comment.png}
\begin{verbatim}\decktext[x=0,y=0,w=1]\end{verbatim}
\includegraphics{image.png}`;

    for (const offset of [
      source.indexOf("deckimage") + 2,
      source.indexOf("decktext") + 2,
      source.indexOf("includegraphics") + 2,
    ])
      expect(canvasHoverAt(documentFor(source, offset), undefined)).toBeUndefined();
  });

  it("only responds while the cursor is on the command name", () => {
    const source = String.raw`\deckimage[x=0,y=0,w=1]{image.png}`;
    expect(canvasHoverAt(documentFor(source, source.indexOf("\\")), undefined)).toBeUndefined();
    expect(canvasHoverAt(documentFor(source, source.indexOf("[")), undefined)).toBeUndefined();
  });

  it("recognizes only each construct's public syntax", () => {
    const source = String.raw`\deckcanvas
\decktext
\begin{deckimage}
\end{deckimage}`;

    for (const name of ["deckcanvas", "decktext", "deckimage"])
      expect(
        canvasHoverAt(documentFor(source, source.indexOf(name) + 2), undefined),
      ).toBeUndefined();
  });

  it("recognizes environment names in both begin and end tags", () => {
    const source = String.raw`\begin{decktext}[x=0,y=0,w=1]内容\end{decktext}`;
    const start = source.lastIndexOf("decktext");

    expect(canvasHoverAt(documentFor(source, start + 2), undefined)).toMatchObject({
      range: { start, end: start + "decktext".length },
      documentation: CANVAS_HOVER_DOCUMENTATION.decktext,
    });
  });

  it("does not recognize canvas syntax after an unterminated verbatim environment", () => {
    const source = String.raw`\begin{verbatim}
\deckimage[x=0,y=0,w=1]{literal.png}`;

    expect(
      canvasHoverAt(documentFor(source, source.indexOf("deckimage") + 2), undefined),
    ).toBeUndefined();
  });
});
