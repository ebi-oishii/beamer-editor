import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension";

suite("#97: display math detachment", () => {
  test("preserves math and comments through one undo, redo and save", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beamer-math-"));
    const expression = String.raw`\begin{align*}a &= b % math comment
\end{align*}`;
    const source = `\\documentclass[aspectratio=169]{beamer}\n\\begin{document}\n\\begin{frame}[label=math]\n% before\n${expression}\n% after\n\\end{frame}\n\\end{document}\n`;
    const wait = async (condition: () => boolean) => {
      const until = Date.now() + 20_000;
      while (!condition()) {
        assert.ok(Date.now() < until, "timed out awaiting document/preview");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    try {
      const file = join(dir, "math.slide.tex");
      await writeFile(file, source);
      const doc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(doc);
      const ext = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
      assert.ok(ext);
      const api = (await ext.activate()) as TestApi;
      await wait(() => api._previewControllerForTest() !== undefined);
      const controller = api._previewControllerForTest();
      assert.ok(controller);
      const receive = (
        controller as unknown as { handleMessage(raw: unknown): void }
      ).handleMessage.bind(controller);
      receive({ type: "ready" });
      await wait(() => controller.latestOutcome?.version === doc.version);
      receive({
        type: "detachToCanvas",
        frameIndex: 0,
        version: doc.version,
        sourceSpan: {
          start: source.indexOf(expression),
          end: source.indexOf(expression) + expression.length,
        },
        rect: { x: 0.1, y: 0.2, width: 0.5 },
      });
      await wait(() => doc.getText().includes("\\begin{decktext}"));
      const moved = doc.getText();
      assert.ok(moved.includes("% before"));
      assert.ok(moved.includes("% after"));
      assert.ok(moved.includes("a &= b % math comment"));
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand("undo");
      await wait(() => doc.getText() === source);
      await vscode.commands.executeCommand("redo");
      await wait(() => doc.getText() === moved);
      assert.ok(await doc.save());
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      const reopened = await vscode.workspace.openTextDocument(file);
      assert.equal(reopened.getText(), moved);
    } finally {
      for (const document of vscode.workspace.textDocuments) {
        if (document.uri.fsPath.startsWith(dir) && document.isDirty) await document.save();
      }
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await rm(dir, { recursive: true, force: true });
    }
  });
});
