import { describe, expect, it } from "vitest";
import { lineSplitter } from "../src/line-splitter.ts";

function collect(limit: number) {
  const lines: string[] = [];
  return { lines, splitter: lineSplitter((line) => lines.push(line), limit) };
}

describe("lineSplitter", () => {
  it("joins a line split across chunks", () => {
    const { lines, splitter } = collect(100);
    splitter.append("note: down");
    splitter.append("loading latex.ltx\nnext");
    splitter.end();
    expect(lines).toEqual(["note: downloading latex.ltx", "next"]);
  });

  it("caps a line that reaches the limit and then gets its newline in a later chunk", () => {
    const { lines, splitter } = collect(4);
    splitter.append("abcd");
    splitter.append("e\n");
    splitter.end();
    expect(lines).toEqual(["abcd"]);
  });

  it("drops the overflow until the newline and starts the next line cleanly", () => {
    const { lines, splitter } = collect(4);
    splitter.append("ab");
    splitter.append("cdef");
    splitter.append("ghij");
    splitter.append("kl\nmn");
    splitter.append("o\npqrstuv\nw");
    splitter.end();
    expect(lines).toEqual(["abcd", "mno", "pqrs", "w"]);
  });

  it("keeps at most the limit while long chunks without a newline keep coming", () => {
    const { lines, splitter } = collect(8);
    for (let index = 0; index < 1_000; index++) splitter.append("x".repeat(1_000));
    splitter.end();
    expect(lines).toEqual(["x".repeat(8)]);
  });

  it("strips CRLF, including a CR and LF that arrive in separate chunks", () => {
    const { lines, splitter } = collect(100);
    splitter.append("first\r\nsecond\r");
    splitter.append("\nthird\r\n");
    splitter.end();
    expect(lines).toEqual(["first", "second", "third"]);
  });

  it("does not leave a CR on a line cut at the limit", () => {
    const { lines, splitter } = collect(4);
    splitter.append("abcd\r\nabc\r\n");
    splitter.end();
    expect(lines).toEqual(["abcd", "abc"]);
  });

  it("decodes a UTF-8 character split across chunk boundaries", () => {
    const { lines, splitter } = collect(100);
    const bytes = Buffer.from("取得: あ\nい", "utf8");
    // Split inside the 3-byte encodings of "得" and "い".
    for (const [start, end] of [
      [0, 4],
      [4, bytes.length - 1],
      [bytes.length - 1, bytes.length],
    ] as const)
      splitter.append(bytes.subarray(start, end));
    splitter.end();
    expect(lines).toEqual(["取得: あ", "い"]);
  });

  it("caps the trailing unterminated line at the end, including undecoded bytes", () => {
    const { lines, splitter } = collect(4);
    splitter.append(Buffer.from("abc", "utf8"));
    // An incomplete sequence decodes to a replacement character only at end().
    splitter.append(Buffer.from([0xe3, 0x81]));
    splitter.end();
    expect(lines).toEqual(["abc�"]);
    const capped = collect(3);
    capped.splitter.append(Buffer.from("abc", "utf8"));
    capped.splitter.append(Buffer.from([0xe3, 0x81]));
    capped.splitter.end();
    expect(capped.lines).toEqual(["abc"]);
  });
});
