import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceLocation } from "@beamer-editor/core";
import { editingPreviewOptions, nodeTemplateFileSystem } from "@beamer-editor/html-export";
import { describe, expect, it } from "vitest";
import { renderDocument } from "../src/document-controller";

const macrosSource = readFileSync(
  fileURLToPath(new URL("../../../fixtures/macros.slide.tex", import.meta.url)),
  "utf8",
);
const ROOT = resolve(import.meta.dirname, "../../..");
const require = createRequire(join(ROOT, "packages/cli/package.json"));
const tsxLoader = require.resolve("tsx");

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
      () => ({
        baseStyle: {
          colors: { structure: "123456" },
          fonts: {},
          background: { path: "templates/corp/assets/bg.png" },
        },
      }),
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

  it("展開後の KaTeX 診断をマクロ呼び出し元の位置へ戻す", () => {
    const source = String.raw`%% macros:begin
\newcommand{\custommath}{\TeXOnlyCommand{x}}
%% macros:end
\begin{document}\begin{frame}{Math}$\custommath$\end{frame}\end{document}`;
    const outcome = renderDocument(source, 1);
    const diagnostic = outcome.deck.diagnostics?.find((entry) => entry.code === "P001");

    expect(source.slice(diagnostic?.span.start, diagnostic?.span.end)).toContain("custommath");
  });

  it("CLI と編集プレビューは同じ保存済み入力の診断を返す", () => {
    const directory = mkdtempSync(join(tmpdir(), "beamer-preview-parity-"));
    try {
      mkdirSync(join(directory, "templates", "corp"), { recursive: true });
      writeFileSync(
        join(directory, "templates", "corp", "beamerthemecorp.sty"),
        String.raw`\logo{\includegraphics{templates/corp/missing-logo.png}}
\pgfdeclareimage{other}{templates/corp/other-logo.png}`,
      );
      const file = join(directory, "talk.tex");
      const source = String.raw`%% preamble-extra:begin
\usepackage{templates/corp/beamerthemecorp}
\usebackgroundtemplate{\includegraphics{missing-background.png}}
%% preamble-extra:end
%% macros:begin
\newcommand{\mathmacro}{\TeXOnlyCommand{x}}
\newcommand{\picturemacro}{\includegraphics{missing-flow.png}}
%% macros:end
\begin{document}
\begin{frame}[label=one]{$\mathmacro$}
  \picturemacro
\end{frame}
\begin{frame}[label=two]{Canvas}
  \begin{deckcanvas}\deckimage[x=0,y=0,w=1]{missing.png}\end{deckcanvas}
\end{frame}
\begin{frame}[label=three]{Normal}Normal frame\end{frame}
\end{document}`;
      writeFileSync(file, source);
      const files = nodeTemplateFileSystem(directory);
      const outcome = renderDocument(source, 1, (doc) => editingPreviewOptions(doc, files));
      const editor = (outcome.diagnostics ?? []).map((diagnostic) => {
        const start = sourceLocation(source, diagnostic.span.start);
        const end = sourceLocation(source, diagnostic.span.end);
        return [
          diagnostic.code,
          diagnostic.severity,
          diagnostic.frame?.number ?? null,
          start.line,
          start.column,
          end.line,
          end.column,
        ];
      });
      const cli = spawnSync(
        process.execPath,
        [`--import=${tsxLoader}`, "packages/cli/src/cli.ts", "preview-check", file, "--json"],
        { cwd: ROOT, encoding: "utf8" },
      );
      expect(cli.status).toBe(2);
      expect(editor.map(([code]) => code).sort()).toEqual([
        "L004",
        "L004",
        "L015",
        "L023",
        "L023",
        "P001",
      ]);
      const diagnostics = JSON.parse(cli.stdout).diagnostics.map(
        (diagnostic: {
          code: string;
          severity: string;
          frame: { number: number } | null;
          location: { line: number; column: number; endLine: number; endColumn: number };
        }) => [
          diagnostic.code,
          diagnostic.severity,
          diagnostic.frame?.number ?? null,
          diagnostic.location.line,
          diagnostic.location.column,
          diagnostic.location.endLine,
          diagnostic.location.endColumn,
        ],
      );
      expect(diagnostics).toEqual(editor);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
