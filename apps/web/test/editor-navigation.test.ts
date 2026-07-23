import { describe, expect, it } from "vitest";
import { sourceJumpTarget } from "../src/editor-navigation.js";

describe("sourceJumpTarget", () => {
  it("ジャンプ位置を含む行全体を選択する", () => {
    expect(sourceJumpTarget("before\n\\begin{frame}{Title}\nafter", 7, 18, 180)).toMatchObject({
      selectionStart: 7,
      selectionEnd: 27,
    });
  });

  it("移動先の行が表示領域の中央に来るスクロール位置を返す", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    const position = lines.indexOf("line 20");
    expect(sourceJumpTarget(lines, position, 18, 180).scrollTop).toBe(279);
  });

  it("文書先頭付近では負のスクロール位置を返さない", () => {
    expect(sourceJumpTarget("first\nsecond", 0, 18, 180).scrollTop).toBe(0);
  });
});
