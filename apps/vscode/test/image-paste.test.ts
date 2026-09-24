import { describe, expect, it } from "vitest";
import {
  imagePasteExtension,
  imagePasteInsertion,
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

describe("imagePasteInsertion", () => {
  it("通常フレームの本文には includegraphics をカーソル位置に入れる", () => {
    const { source, offset } = withCursor(
      `${PREAMBLE}\n\\begin{frame}{Title}\n  body\n  |\n\\end{frame}\n\\end{document}\n`,
    );
    expect(imagePasteInsertion(source, offset, "assets/image.png")).toEqual({
      text: "\\includegraphics[width=0.8\\textwidth]{assets/image.png}",
      offset,
    });
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
    expect(imagePasteInsertion(source, offset, "assets/image.png")).toEqual({
      text: "\\deckimage[x=0.100,y=0.100,w=0.400]{assets/image.png}",
      offset,
    });
  });

  it("decktext の中では deckimage をそのアイテムの直後に入れる", () => {
    const { source, offset } = withCursor(
      [
        PREAMBLE,
        "\\begin{frame}[label=canvas-1]{Canvas}",
        "  \\begin{deckcanvas}",
        "    \\begin{decktext}[x=0.050,y=0.100,w=0.420,size=normal]",
        "      text|",
        "    \\end{decktext}",
        "  \\end{deckcanvas}",
        "\\end{frame}",
        "\\end{document}",
        "",
      ].join("\n"),
    );
    const end = "\\end{decktext}";
    expect(imagePasteInsertion(source, offset, "assets/image.png")).toEqual({
      text: "\n    \\deckimage[x=0.100,y=0.100,w=0.400]{assets/image.png}",
      offset: source.indexOf(end) + end.length,
    });
  });

  it("deckimage の中でもそのアイテムの直後に入れる", () => {
    const { source, offset } = withCursor(
      [
        PREAMBLE,
        "\\begin{frame}[label=canvas-1]{Canvas}",
        "  \\begin{deckcanvas}",
        "    \\deckimage[x=0.520,y=0.140,w=0.400]{assets/ch|art.pdf}",
        "  \\end{deckcanvas}",
        "\\end{frame}",
        "\\end{document}",
        "",
      ].join("\n"),
    );
    const item = "\\deckimage[x=0.520,y=0.140,w=0.400]{assets/chart.pdf}";
    expect(imagePasteInsertion(source, offset, "assets/image.png")?.offset).toBe(
      source.indexOf(item) + item.length,
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
    expect(imagePasteInsertion(source, offset, "assets/image.jpg")).toEqual({
      text: "\\includegraphics[width=0.8\\textwidth]{assets/image.jpg}",
      offset,
    });
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
    expect(imagePasteInsertion(source, offset, "assets/image.png")?.text).toMatch(/^\\deckimage\[/);
  });

  it("フレームの見出し(タイトル・オプション)では入れない", () => {
    const title = withCursor(
      `${PREAMBLE}\n\\begin{frame}{Ti|tle}\n  body\n\\end{frame}\n\\end{document}\n`,
    );
    expect(imagePasteInsertion(title.source, title.offset, "assets/image.png")).toBeNull();
    const option = withCursor(
      `${PREAMBLE}\n\\begin{frame}[label=a|b]{Title}\n  body\n\\end{frame}\n\\end{document}\n`,
    );
    expect(imagePasteInsertion(option.source, option.offset, "assets/image.png")).toBeNull();
  });

  it("\\end{frame} の行末・次のフレームの行頭では入れない", () => {
    const deck = (cursor: string) =>
      withCursor(
        [
          PREAMBLE,
          "\\begin{frame}{One}",
          "  body",
          `\\end{frame}${cursor === "tail" ? "|" : ""}`,
          `${cursor === "head" ? "|" : ""}\\begin{frame}{Two}`,
          "  body",
          "\\end{frame}",
          "\\end{document}",
          "",
        ].join("\n"),
      );
    const tail = deck("tail");
    expect(imagePasteInsertion(tail.source, tail.offset, "assets/image.png")).toBeNull();
    const head = deck("head");
    expect(imagePasteInsertion(head.source, head.offset, "assets/image.png")).toBeNull();
  });

  it("空のタイトルの中では入れない", () => {
    const empty = withCursor(
      `${PREAMBLE}\n\\begin{frame}{|}\n  body\n\\end{frame}\n\\end{document}\n`,
    );
    expect(imagePasteInsertion(empty.source, empty.offset, "assets/image.png")).toBeNull();
  });

  it("raw frame では本文にだけ入れる", () => {
    const at = (body: string) => {
      const { source, offset } = withCursor(`${PREAMBLE}\n${body}\n\\end{document}\n`);
      return imagePasteInsertion(source, offset, "assets/image.png");
    };
    const RAW = "\\begin{frame}[unknownopt]{Title}";
    expect(at(`${RAW}\n  bo|dy\n\\end{frame}`)?.text).toMatch(/^\\includegraphics\[/);
    expect(at(`\\begin{frame}[unknownopt]{Ti|tle}\n  body\n\\end{frame}`)).toBeNull();
    expect(at(`${RAW}\n  body\n\\end{frame}|\n${RAW}\n  body\n\\end{frame}`)).toBeNull();
    expect(at(`${RAW}\n  body\n\\end{frame}\n|${RAW}\n  body\n\\end{frame}`)).toBeNull();
  });

  it("サブタイトルの中では入れず、その後の本文には入れる", () => {
    const at = (frame: string) => {
      const { source, offset } = withCursor(`${PREAMBLE}\n${frame}\n\\end{document}\n`);
      return imagePasteInsertion(source, offset, "assets/image.png");
    };
    expect(at("\\begin{frame}{T}{Su|b}\n  body\n\\end{frame}")).toBeNull();
    expect(at("\\begin{frame}{T}{Sub}\n  bo|dy\n\\end{frame}")?.text).toMatch(
      /^\\includegraphics\[/,
    );
  });

  it("タイトルの中の \\} や % コメントを閉じ括弧と見なさない", () => {
    const at = (frame: string) => {
      const { source, offset } = withCursor(`${PREAMBLE}\n${frame}\n\\end{document}\n`);
      return imagePasteInsertion(source, offset, "assets/image.png");
    };
    expect(at("\\begin{frame}{A \\} B|}\n  body\n\\end{frame}")).toBeNull();
    expect(at("\\begin{frame}{A % }\n  B|}\n  body\n\\end{frame}")).toBeNull();
  });

  it("空行の後の {...} は見出しではなく本文として扱う", () => {
    const { source, offset } = withCursor(
      `${PREAMBLE}\n\\begin{frame}{Title}\n\n  {gro|up}\n\\end{frame}\n\\end{document}\n`,
    );
    expect(imagePasteInsertion(source, offset, "assets/image.png")?.text).toMatch(
      /^\\includegraphics\[/,
    );
  });

  it("raw frame で見出しが 2 行にまたがっても、見出しには入れず本文には入れる", () => {
    const at = (frame: string) => {
      const { source, offset } = withCursor(`${PREAMBLE}\n${frame}\n\\end{document}\n`);
      return imagePasteInsertion(source, offset, "assets/image.png");
    };
    expect(at("\\begin{frame}[unknownopt]\n{Ti|tle}\n  body\n\\end{frame}")).toBeNull();
    expect(at("\\begin{frame}[unknownopt]\n{Title}\n  bo|dy\n\\end{frame}")?.text).toMatch(
      /^\\includegraphics\[/,
    );
  });

  it("1 行の raw frame でも見出しの後の本文には入れる", () => {
    const { source, offset } = withCursor(
      `${PREAMBLE}\n\\begin{frame}[unknownopt]{T} bo|dy \\end{frame}\n\\end{document}\n`,
    );
    expect(imagePasteInsertion(source, offset, "assets/image.png")?.text).toMatch(
      /^\\includegraphics\[/,
    );
  });

  it("raw frame の deckcanvas の中では入れず、その外の本文には入れる", () => {
    const deck = (inside: boolean) =>
      withCursor(
        [
          PREAMBLE,
          "\\begin{frame}[unknownopt]{Canvas}",
          `  flow${inside ? "" : "|"}`,
          "  \\begin{deckcanvas}",
          `    \\deckimage[x=0.520,y=0.140,w=0.400]{assets/chart.pdf}${inside ? "|" : ""}`,
          "  \\end{deckcanvas}",
          "\\end{frame}",
          "\\end{document}",
          "",
        ].join("\n"),
      );
    const inside = deck(true);
    expect(imagePasteInsertion(inside.source, inside.offset, "assets/image.png")).toBeNull();
    const outside = deck(false);
    expect(imagePasteInsertion(outside.source, outside.offset, "assets/image.png")?.text).toMatch(
      /^\\includegraphics\[/,
    );
  });

  it("プリアンブルでは入れない", () => {
    const { source, offset } = withCursor(
      `${PREAMBLE.replace("\\usepackage{graphicx}", "\\usepackage{graphicx}\n|")}\n\\end{document}\n`,
    );
    expect(imagePasteInsertion(source, offset, "assets/image.png")).toBeNull();
  });

  it("フレームの間では入れない", () => {
    const { source, offset } = withCursor(
      [
        PREAMBLE,
        "\\begin{frame}{One}",
        "  body",
        "\\end{frame}",
        "|",
        "\\begin{frame}{Two}",
        "  body",
        "\\end{frame}",
        "\\end{document}",
        "",
      ].join("\n"),
    );
    expect(imagePasteInsertion(source, offset, "assets/image.png")).toBeNull();
  });
});
