import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderDocument } from "../src/document-controller";

const macrosSource = readFileSync(
  fileURLToPath(new URL("../../../fixtures/macros.tex", import.meta.url)),
  "utf8",
);

describe("renderDocument", () => {
  it("マクロを展開してからレンダリングし、version を引き継ぐ", () => {
    const outcome = renderDocument(macrosSource, 42);

    expect(outcome.version).toBe(42);
    expect(outcome.deck.frames.length).toBeGreaterThan(0);
    // \greet(既定引数 world)が展開されて HTML に現れる。
    expect(outcome.deck.frames.map((f) => f.html).join("")).toContain("Hello, world!");
    // 展開後座標 → 元ソースの対応が返る(VS-4 のソースジャンプで使う)。
    expect(outcome.expansionMap.length).toBeGreaterThan(0);
  });

  it("baseStyle で渡した土台スタイルが CSS と装飾に反映される", () => {
    const outcome = renderDocument(
      "\\begin{document}\\begin{frame}{Hi}A\\end{frame}\\end{document}",
      3,
      {
        baseStyle: () => ({
          colors: { structure: "123456" },
          fonts: {},
          background: { path: "templates/corp/assets/bg.png" },
        }),
      },
    );
    expect(outcome.deck.css).toContain("--deck-structure: #123456;");
    expect(outcome.deck.frames[0]?.html).toContain('class="deck-background"');
  });

  it("マクロの無いデッキでもそのまま描画できる", () => {
    const outcome = renderDocument(
      "\\begin{document}\\begin{frame}{Hi}A\\end{frame}\\end{document}",
      1,
    );

    expect(outcome.deck.frames).toHaveLength(1);
    expect(outcome.expandDiagnostics).toEqual([]);
  });
});
