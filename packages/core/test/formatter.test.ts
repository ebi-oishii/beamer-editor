import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { framesOf } from "../src/ast.js";
import { formatDeck } from "../src/formatter.js";
import { parseDeck } from "../src/parser.js";

const fixture = (name: string) => readFileSync(join(__dirname, "../../../fixtures", name), "utf8");

const UNFORMATTED = String.raw`\documentclass[aspectratio=169]{beamer}
%% deck-source-version: 1
\begin{document}

% frame comment remains byte-for-byte
\begin{frame}[label=sample]{Sample}
  \begin{deckcanvas}
    % item comment remains byte-for-byte
    \begin{decktext}[ size=small, w=.4, y=0.2, x=.1 ]
      Hello \textbf{world}.
    \end{decktext}
    \deckimage[w=0.333333,y=-0,x=0.666666]{asset.png}
    \unknown{raw content remains byte-for-byte}
  \end{deckcanvas}
\end{frame}

\end{document}
`;

const FORMATTED = String.raw`\documentclass[aspectratio=169]{beamer}
%% deck-source-version: 1
\begin{document}

% frame comment remains byte-for-byte
\begin{frame}[label=sample]{Sample}
  \begin{deckcanvas}
    % item comment remains byte-for-byte
    \begin{decktext}[x=0.100,y=0.200,w=0.400,size=small]
      Hello \textbf{world}.
    \end{decktext}
    \deckimage[x=0.667,y=0.000,w=0.333]{asset.png}
    \unknown{raw content remains byte-for-byte}
  \end{deckcanvas}
\end{frame}

\end{document}
`;

describe("formatDeck", () => {
  it("キャンバスのキー順と座標精度を正規化する", () => {
    expect(formatDeck(UNFORMATTED)).toBe(FORMATTED);
  });

  it("2回適用しても結果が変わらない", () => {
    const once = formatDeck(UNFORMATTED);
    expect(formatDeck(once)).toBe(once);
  });

  it("コメント・生LaTeX・その他のソースを変更しない", () => {
    const formatted = formatDeck(UNFORMATTED);
    expect(formatted.replaceAll(/\[[^\]]+\]/g, "[]")).toBe(
      FORMATTED.replaceAll(/\[[^\]]+\]/g, "[]"),
    );
    expect(formatted).toContain("% frame comment remains byte-for-byte");
    expect(formatted).toContain("\\unknown{raw content remains byte-for-byte}");
  });

  it("ASTで変更したキャンバス値を元ソースへ書き戻す", () => {
    const document = parseDeck(FORMATTED);
    const frame = framesOf(document)[0];
    if (frame?.type !== "frame") throw new Error("expected frame");
    const canvas = frame.body.find((block) => block.type === "canvas");
    if (canvas?.type !== "canvas") throw new Error("expected canvas");
    const text = canvas.items.find((item) => item.type === "canvasText");
    if (text?.type !== "canvasText") throw new Error("expected canvasText");

    text.position.x = 0.25;
    text.position.width = 0.5;
    text.size = "Large";

    const formatted = formatDeck(FORMATTED, document);
    expect(formatted).toContain("[x=0.250,y=0.200,w=0.500,size=Large]");
  });

  it("既存の正規形fixtureを変更しない", () => {
    for (const name of ["canvas.tex", "styled.tex"]) {
      const source = fixture(name);
      expect(formatDeck(source)).toBe(source);
    }
  });

  it("非有限の座標値は拒否する", () => {
    const document = parseDeck(FORMATTED);
    const frame = framesOf(document)[0];
    if (frame?.type !== "frame") throw new Error("expected frame");
    const canvas = frame.body.find((block) => block.type === "canvas");
    if (canvas?.type !== "canvas") throw new Error("expected canvas");
    const image = canvas.items.find((item) => item.type === "canvasImage");
    if (image?.type !== "canvasImage") throw new Error("expected canvasImage");
    image.position.width = Number.NaN;

    expect(() => formatDeck(FORMATTED, document)).toThrow("有限数");
  });
});
