import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSyncTexPages } from "../src/pdf-source-pages.js";

const input = resolve("deck with spaces.tex");
const syncTex = [
  "SyncTeX Version:1",
  `Input:1:${input}`,
  `Input:2:${resolve("other/deck with spaces.tex")}`,
  "Content:",
  "{1",
  "[1,8:0,0:0,0,0",
  "h1,9,3:0,0:0,0,0",
  "h2,30:0,0:0,0,0",
  "x1,9:0,0",
  "]",
  "}1",
  "{2",
  "[2,15:0,0:0,0,0",
  "]",
  "}2",
  "Postamble:",
].join("\n");

describe("SyncTeX sheets", () => {
  it("keeps physical pages and deduplicates main-source line records", () => {
    expect(parseSyncTexPages(syncTex, input)).toEqual([
      { page: 1, lines: [8, 9] },
      { page: 2, lines: [] },
    ]);
  });

  it("rejects incomplete or nonconsecutive sheets", () => {
    expect(parseSyncTexPages(syncTex.replace("}1", "}9"), input)).toEqual([]);
    expect(parseSyncTexPages(syncTex.replace("Postamble:", ""), input)).toEqual([]);
  });
});
