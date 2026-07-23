import { describe, expect, it } from "vitest";
import { editIndentation } from "../src/editor-text.js";

describe("editIndentation", () => {
  it("カーソル位置に Tab を挿入する", () => {
    expect(editIndentation("abc", 1, 1, false)).toEqual({
      value: "a\tbc",
      selectionStart: 2,
      selectionEnd: 2,
    });
  });

  it("選択された複数行をまとめてインデントする", () => {
    expect(editIndentation("first\nsecond\nthird", 2, 10, false)).toEqual({
      value: "\tfirst\n\tsecond\nthird",
      selectionStart: 3,
      selectionEnd: 12,
    });
  });

  it("選択末尾が行頭の場合は次の行をインデントしない", () => {
    expect(editIndentation("first\nsecond\nthird", 0, 13, false)).toEqual({
      value: "\tfirst\n\tsecond\nthird",
      selectionStart: 1,
      selectionEnd: 15,
    });
  });

  it("Shift+Tab で Tab または2文字までの空白を除去する", () => {
    expect(editIndentation("\tfirst\n  second\n third", 1, 22, true)).toEqual({
      value: "first\nsecond\nthird",
      selectionStart: 0,
      selectionEnd: 18,
    });
  });

  it("インデントのない行を Shift+Tab しても変更しない", () => {
    expect(editIndentation("first", 3, 3, true)).toEqual({
      value: "first",
      selectionStart: 3,
      selectionEnd: 3,
    });
  });

  it("行頭のカーソルからも Shift+Tab でインデントを除去する", () => {
    expect(editIndentation("\tfirst", 0, 0, true)).toEqual({
      value: "first",
      selectionStart: 0,
      selectionEnd: 0,
    });
  });
});
