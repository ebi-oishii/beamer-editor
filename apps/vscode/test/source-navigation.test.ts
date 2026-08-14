import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderDocument } from "../src/document-controller";
import { resolveJumpOffset, resolveSourceViewColumn } from "../src/source-navigation";

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

describe("resolveSourceViewColumn", () => {
  it("対象 URI を表示中の editor の列を優先する", () => {
    const targetUri = { toString: () => "file:///deck.tex" };

    expect(
      resolveSourceViewColumn(
        targetUri,
        [
          { documentUri: { toString: () => "file:///other.tex" }, viewColumn: 1 },
          { documentUri: { toString: () => "file:///deck.tex" }, viewColumn: 2 },
        ],
        3,
      ),
    ).toBe(2);
  });

  it("対象 editor が表示されていなければプレビュー作成時の列を使う", () => {
    expect(
      resolveSourceViewColumn(
        { toString: () => "file:///deck.tex" },
        [{ documentUri: { toString: () => "file:///other.tex" }, viewColumn: 1 }],
        3,
      ),
    ).toBe(3);
  });

  it("別インスタンスでも同じ URI なら同一文書として比較する", () => {
    expect(
      resolveSourceViewColumn(
        { toString: () => "file:///deck.tex" },
        [{ documentUri: { toString: () => "file:///deck.tex" }, viewColumn: 2 }],
        1,
      ),
    ).toBe(2);
  });

  it("対象 editor の列が未定義ならプレビュー作成時の列へ戻す", () => {
    expect(
      resolveSourceViewColumn(
        { toString: () => "file:///deck.tex" },
        [{ documentUri: { toString: () => "file:///deck.tex" }, viewColumn: undefined }],
        3,
      ),
    ).toBe(3);
  });
});
