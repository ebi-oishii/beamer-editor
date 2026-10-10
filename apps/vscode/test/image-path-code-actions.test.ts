import { lintSource } from "@beamer-editor/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
  class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  }
  class Range {
    constructor(
      readonly start: Position,
      readonly end: Position,
    ) {}
    intersection(other: Range): Range | undefined {
      const before = (a: Position, b: Position) =>
        a.line < b.line || (a.line === b.line && a.character <= b.character);
      return before(this.start, other.end) && before(other.start, this.end) ? this : undefined;
    }
  }
  class CodeAction {
    diagnostics: unknown[] = [];
    edit: unknown;
    constructor(
      readonly title: string,
      readonly kind: string,
    ) {}
  }
  class WorkspaceEdit {
    readonly edits: { uri: unknown; range: Range; text: string }[] = [];
    replace(uri: unknown, range: Range, text: string): void {
      this.edits.push({ uri, range, text });
    }
  }
  return { Position, Range, CodeAction, WorkspaceEdit, CodeActionKind: { QuickFix: "quickfix" } };
});

import * as vscode from "vscode";
import { ImagePathCodeActionProvider } from "../src/image-path-code-actions";

function fakeDocument(text: string, scheme = "file") {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index++)
    if (text[index] === "\n") lineStarts.push(index + 1);
  return {
    uri: { scheme, toString: () => `${scheme}:///deck.slide.tex` },
    version: 1,
    positionAt(offset: number) {
      let line = lineStarts.length - 1;
      while ((lineStarts[line] ?? 0) > offset) line--;
      return new vscode.Position(line, offset - (lineStarts[line] ?? 0));
    },
    offsetAt(position: vscode.Position) {
      return (lineStarts[position.line] ?? 0) + position.character;
    },
  } as unknown as vscode.TextDocument;
}

const SOURCE = `%% deck-source-version: 1
\\documentclass{beamer}
\\begin{document}
\\begin{frame}{A}
\\includegraphics[width=0.5\\linewidth]{assets/fig}
\\end{frame}
\\end{document}
`;

function setup(source = SOURCE, scheme = "file") {
  const document = fakeDocument(source, scheme);
  const lint = lintSource(source, { fileExists: (path) => path === "assets/fig.png" });
  const l004 = lint.find((entry) => entry.code === "L004");
  if (!l004) throw new Error("L004 expected");
  const diagnostic = {
    source: "beamer-editor",
    code: "L004",
    range: new vscode.Range(
      document.positionAt(l004.span.start),
      document.positionAt(l004.span.end),
    ),
  } as unknown as vscode.Diagnostic;
  const provider = new ImagePathCodeActionProvider();
  provider.record(document, lint);
  const actions = (range = diagnostic.range, diagnostics = [diagnostic]) =>
    provider.provideCodeActions(document, range, { diagnostics } as never, {} as never);
  return { document, diagnostic, provider, actions };
}

describe("ImagePathCodeActionProvider", () => {
  it("L004 の提案を、波括弧の中のパスだけを置換する Quick Fix にする", () => {
    const { actions, document } = setup();
    const [action] = actions();
    expect(action?.title).toContain("assets/fig.png");
    const recorded = (
      (action as vscode.CodeAction).edit as unknown as {
        edits: { range: vscode.Range; text: string }[];
      }
    ).edits;
    const edit = recorded[0];
    expect(edit?.text).toBe("assets/fig.png");
    const start = document.offsetAt(edit?.range.start ?? new vscode.Position(0, 0));
    const end = document.offsetAt(edit?.range.end ?? new vscode.Position(0, 0));
    expect(SOURCE.slice(start, end)).toBe("assets/fig");
  });

  it("他の診断・範囲外・file 以外・記録の無い文書には出さない", () => {
    const { actions, diagnostic, provider, document } = setup();
    expect(actions(diagnostic.range, [{ ...diagnostic, code: "L021" } as never])).toEqual([]);
    expect(actions(new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)))).toEqual(
      [],
    );
    provider.forget(document);
    expect(actions()).toEqual([]);
    expect(setup(SOURCE, "untitled").actions()).toEqual([]);
  });

  it("lint した後に編集された(版が進んだ)文書には出さない", () => {
    const { actions, document } = setup();
    (document as unknown as { version: number }).version = 2;
    expect(actions()).toEqual([]);
  });
});
