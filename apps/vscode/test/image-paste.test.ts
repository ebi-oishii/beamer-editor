import { describe, expect, it } from "vitest";
import {
  imagePasteExtension,
  imagePasteInsertText,
  nextImagePasteFileName,
} from "../src/image-paste";

const PREAMBLE = [
  "\\documentclass[aspectratio=169]{beamer}",
  "%% deck-source-version: 1",
  "\\usetheme{default}",
  "\\usepackage{graphicx}",
  "\\begin{document}",
].join("\n");

/** マーカー `|` の位置を offset として返し、本文からは取り除く。 */
function withCursor(text: string): { source: string; offset: number } {
  const offset = text.indexOf("|");
  if (offset < 0) throw new Error("cursor marker missing");
  return { source: text.slice(0, offset) + text.slice(offset + 1), offset };
}

describe("imagePasteExtension", () => {
  it("PNG と JPEG だけを受け付ける", () => {
    expect(imagePasteExtension("image/png")).toBe("png");
    expect(imagePasteExtension("image/jpeg")).toBe("jpg");
    expect(imagePasteExtension("image/gif")).toBeNull();
    expect(imagePasteExtension("image/svg+xml")).toBeNull();
  });
});

describe("nextImagePasteFileName", () => {
  it("image.<ext> から始め、既にあれば番号を足す", () => {
    expect(nextImagePasteFileName("png", () => false)).toBe("image.png");
    const taken = new Set(["image.png", "image-1.png"]);
    expect(nextImagePasteFileName("png", (name) => taken.has(name))).toBe("image-2.png");
    expect(nextImagePasteFileName("jpg", (name) => taken.has(name))).toBe("image.jpg");
  });
});

describe("imagePasteInsertText", () => {
  it("通常フレームの本文には includegraphics を入れる", () => {
    const { source, offset } = withCursor(
      `${PREAMBLE}\n\\begin{frame}{Title}\n  body\n  |\n\\end{frame}\n\\end{document}\n`,
    );
    expect(imagePasteInsertText(source, offset, "assets/image.png")).toBe(
      "\\includegraphics[width=0.8\\textwidth]{assets/image.png}",
    );
  });

  it("deckcanvas の中では deckimage を既定の位置・幅で入れる", () => {
    const { source, offset } = withCursor(
      [
        PREAMBLE,
        "\\begin{frame}[label=canvas-1]{Canvas}",
        "  \\begin{deckcanvas}",
        "    \\begin{decktext}[x=0.050,y=0.100,w=0.420,size=normal]",
        "      text",
        "    \\end{decktext}",
        "    |",
        "  \\end{deckcanvas}",
        "\\end{frame}",
        "\\end{document}",
        "",
      ].join("\n"),
    );
    expect(imagePasteInsertText(source, offset, "assets/image.png")).toBe(
      "\\deckimage[x=0.100,y=0.100,w=0.400]{assets/image.png}",
    );
  });

  it("同じフレームでも deckcanvas の外なら includegraphics", () => {
    const { source, offset } = withCursor(
      [
        PREAMBLE,
        "\\begin{frame}[label=canvas-1]{Canvas}",
        "  flow text",
        "  |",
        "  \\begin{deckcanvas}",
        "    \\deckimage[x=0.520,y=0.140,w=0.400]{assets/chart.pdf}",
        "  \\end{deckcanvas}",
        "\\end{frame}",
        "\\end{document}",
        "",
      ].join("\n"),
    );
    expect(imagePasteInsertText(source, offset, "assets/image.jpg")).toBe(
      "\\includegraphics[width=0.8\\textwidth]{assets/image.jpg}",
    );
  });

  it("CRLF の文書でも deckcanvas の中を見分ける", () => {
    const { source, offset } = withCursor(
      [
        PREAMBLE,
        "\\begin{frame}[label=canvas-1]{Canvas}",
        "  \\begin{deckcanvas}",
        "    |",
        "  \\end{deckcanvas}",
        "\\end{frame}",
        "\\end{document}",
        "",
      ]
        .join("\n")
        .replace(/\n/g, "\r\n"),
    );
    expect(imagePasteInsertText(source, offset, "assets/image.png")).toMatch(/^\\deckimage\[/);
  });

  it("フレームの外(プリアンブル)では includegraphics に倒す", () => {
    const { source, offset } = withCursor(
      `${PREAMBLE.replace("\\usepackage{graphicx}", "\\usepackage{graphicx}\n|")}\n\\end{document}\n`,
    );
    expect(imagePasteInsertText(source, offset, "assets/image.png")).toMatch(
      /^\\includegraphics\[/,
    );
  });
});
