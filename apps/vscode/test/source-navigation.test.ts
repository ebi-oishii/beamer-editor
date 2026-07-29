import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderDocument } from "../src/document-controller";
import { resolveJumpOffset } from "../src/source-navigation";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url)), "utf8");
}

describe("resolveJumpOffset", () => {
  it("マクロ展開後の deck からでも、各フレームの元ソース位置を解決できる", () => {
    const source = fixture("macros.tex");
    const outcome = renderDocument(source, 1);

    expect(outcome.deck.frames.length).toBeGreaterThan(0);
    for (const [i] of outcome.deck.frames.entries()) {
      const offset = resolveJumpOffset(outcome, i);
      expect(offset).not.toBeNull();
      // ジャンプ先は元ソースのフレーム先頭を指す。
      expect(source.slice(offset as number).startsWith("\\begin{frame}")).toBe(true);
    }
  });

  it("日本語(サロゲート・CJK)を含む文書でも UTF-16 オフセットが正しい", () => {
    const source = fixture("japanese.tex");
    const outcome = renderDocument(source, 1);

    expect(outcome.deck.frames.length).toBeGreaterThan(0);
    for (const [i] of outcome.deck.frames.entries()) {
      const offset = resolveJumpOffset(outcome, i);
      expect(source.slice(offset as number).startsWith("\\begin{frame}")).toBe(true);
    }
  });

  it("存在しない frameIndex は null", () => {
    const outcome = renderDocument(
      "\\begin{document}\\begin{frame}{Hi}A\\end{frame}\\end{document}",
      1,
    );

    expect(resolveJumpOffset(outcome, 99)).toBeNull();
    expect(resolveJumpOffset(outcome, -1)).toBeNull();
  });
});
