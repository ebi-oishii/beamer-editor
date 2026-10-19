import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension";

suite("#186: プレビューの要素からソース位置へのジャンプ", () => {
  test("要素の位置はマクロ展開の前の行へ、位置が無ければフレーム先頭へ移動する", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beamer-186-"));
    // \code は展開で長さが変わるので、後ろの要素は展開後と元ソースで位置がずれる。
    const source = [
      "\\documentclass[aspectratio=169]{beamer}",
      "%% macros:begin",
      "\\newcommand{\\code}[1]{\\texttt{#1}}",
      "%% macros:end",
      "\\begin{document}",
      "\\begin{frame}[label=jump]{Jump}",
      "  Run \\code{deck lint} first.",
      "  \\begin{itemize}",
      "    \\item \\code{one}",
      "    \\item second item",
      "  \\end{itemize}",
      "  \\begin{deckcanvas}",
      "    \\begin{decktext}[x=0.100,y=0.600,w=0.400,size=normal]",
      "      boxed",
      "    \\end{decktext}",
      "  \\end{deckcanvas}",
      "\\end{frame}",
      "\\end{document}",
      "",
    ].join("\n");
    const lineOf = (text: string) => source.split("\n").findIndex((line) => line.includes(text));
    const wait = async (condition: () => boolean, label: string) => {
      const until = Date.now() + 20_000;
      while (!condition()) {
        assert.ok(Date.now() < until, `timed out: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    try {
      const file = join(dir, "jump.slide.tex");
      await writeFile(file, source);
      const doc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(doc);
      const ext = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
      assert.ok(ext);
      const api = (await ext.activate()) as TestApi;
      await wait(() => api._previewControllerForTest() !== undefined, "preview");
      const controller = api._previewControllerForTest();
      assert.ok(controller);
      await controller.handleMessageForTest({ type: "ready" });
      await wait(() => controller.latestOutcome?.version === doc.version, "render");
      const html = controller.latestOutcome?.deck.frames[0]?.html ?? "";
      // プレビューに出た要素の位置(展開後座標)。ui はダブルクリックした要素のこの値を送る。
      const starts = [...html.matchAll(/<li data-source-start="(\d+)"/g)].map((m) => Number(m[1]));
      const box = /canvas-text"[^>]*data-source-start="(\d+)"/.exec(html)?.[1];
      assert.equal(starts.length, 2, html);
      assert.ok(box, html);

      const jump = async (sourceOffset: number | undefined, line: number) => {
        await controller.handleMessageForTest({
          type: "jumpToSource",
          frameIndex: 0,
          version: doc.version,
          ...(sourceOffset === undefined ? {} : { sourceOffset }),
        });
        await wait(
          () =>
            vscode.window.activeTextEditor?.document === doc &&
            vscode.window.activeTextEditor.selection.start.line === line,
          `line ${line}`,
        );
      };
      await jump(starts[1], lineOf("\\item second item"));
      await jump(Number(box), lineOf("\\begin{decktext}"));
      await jump(starts[0], lineOf("\\item \\code{one}"));
      await jump(undefined, lineOf("\\begin{frame}"));
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await rm(dir, { recursive: true, force: true });
    }
  });
});
