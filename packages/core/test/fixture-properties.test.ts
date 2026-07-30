import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BlockNode, DeckDocument, SourceSpan } from "../src/ast.js";
import { formatDeck } from "../src/formatter.js";
import { parseDeck } from "../src/parser.js";

interface CanonicalFixture {
  name: string;
  source: string;
}

const fixturesDirectory = join(__dirname, "../../../fixtures");

function loadCanonicalFixtures(): CanonicalFixture[] {
  return readdirSync(fixturesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tex"))
    .map((entry) => entry.name)
    .filter(
      (name) =>
        !name.startsWith("lint-") &&
        !name.startsWith("measure-") &&
        !/^deck-.*-preamble\.tex$/.test(name),
    )
    .sort()
    .map((name) => ({ name, source: readFileSync(join(fixturesDirectory, name), "utf8") }));
}

function withoutSpans(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSpans);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, child]) =>
        key === "span" ? [] : [[key, withoutSpans(child)]],
      ),
    );
  }
  return value;
}

function collectFormatterOwnedSpans(document: DeckDocument): SourceSpan[] {
  const spans: SourceSpan[] = [];
  const collectBlocks = (blocks: BlockNode[]): void => {
    for (const block of blocks) {
      switch (block.type) {
        case "canvas":
          for (const item of block.items) {
            if (item.type === "canvasText" || item.type === "canvasImage") {
              spans.push(item.position.span);
            }
          }
          break;
        case "list":
          for (const item of block.items) collectBlocks(item.children);
          break;
        case "columns":
          for (const column of block.columns) collectBlocks(column.children);
          break;
        case "blockEnv":
        case "center":
          collectBlocks(block.children);
          break;
        default:
          break;
      }
    }
  };

  for (const element of document.body) {
    if (element.type === "frame") collectBlocks(element.body);
  }
  return spans;
}

function locationAt(source: string, offset: number): string {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return `UTF-16 offset ${offset} (line ${line}, column ${column})`;
}

function assertEqualSegment(
  original: string,
  formatted: string,
  originalStart: number,
  formattedStart: number,
  label: string,
): void {
  const length = Math.min(original.length, formatted.length);
  for (let index = 0; index < length; index += 1) {
    if (original[index] !== formatted[index]) {
      throw new Error(
        `${label} changed outside formatter-owned spans at ${locationAt(original, originalStart + index)}; ` +
          `formatted ${locationAt(formatted, formattedStart + index)}.`,
      );
    }
  }
  if (original.length !== formatted.length) {
    throw new Error(
      `${label} changed outside formatter-owned spans at ${locationAt(original, originalStart + length)}; ` +
        `formatted ${locationAt(formatted, formattedStart + length)}.`,
    );
  }
}

function assertBytesPreservedOutsideOwnedSpans(original: string, formatted: string): void {
  const originalSpans = collectFormatterOwnedSpans(parseDeck(original));
  const formattedSpans = collectFormatterOwnedSpans(parseDeck(formatted));
  expect(formattedSpans, "formatter-owned span count").toHaveLength(originalSpans.length);

  let originalCursor = 0;
  let formattedCursor = 0;
  for (let index = 0; index < originalSpans.length; index += 1) {
    const originalSpan = originalSpans[index];
    const formattedSpan = formattedSpans[index];
    if (originalSpan === undefined || formattedSpan === undefined) {
      throw new Error(`missing formatter-owned span ${index}`);
    }
    assertEqualSegment(
      original.slice(originalCursor, originalSpan.start),
      formatted.slice(formattedCursor, formattedSpan.start),
      originalCursor,
      formattedCursor,
      `segment before formatter-owned span ${index + 1}`,
    );
    originalCursor = originalSpan.end;
    formattedCursor = formattedSpan.end;
  }
  assertEqualSegment(
    original.slice(originalCursor),
    formatted.slice(formattedCursor),
    originalCursor,
    formattedCursor,
    "segment after formatter-owned spans",
  );
}

const canonicalFixtures = loadCanonicalFixtures();

describe("canonical fixture properties", () => {
  it("fixture discovery includes canonical baselines and excludes helper fixtures", () => {
    const names = canonicalFixtures.map(({ name }) => name);
    expect(names).toEqual(
      expect.arrayContaining([
        "basic.tex",
        "canvas.tex",
        "japanese.tex",
        "kitchen-sink.tex",
        "macros.tex",
        "styled.tex",
      ]),
    );
    for (const helper of [
      "lint-static.tex",
      "measure-body-area.tex",
      "deck-style-preamble.tex",
      "deck-canvas-preamble.tex",
    ]) {
      expect(names).not.toContain(helper);
    }
  });

  for (const { name, source } of canonicalFixtures) {
    it(`${name}: parse-format-parse preserves semantic AST`, () => {
      expect(withoutSpans(parseDeck(formatDeck(source)))).toEqual(withoutSpans(parseDeck(source)));
    });

    it(`${name}: formatting is idempotent`, () => {
      const formatted = formatDeck(source);
      expect(formatDeck(formatted)).toBe(formatted);
    });

    it(`${name}: bytes outside formatter-owned spans are preserved`, () => {
      assertBytesPreservedOutsideOwnedSpans(source, formatDeck(source));
    });
  }
});
