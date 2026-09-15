import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension";

suite("#82: canvas image resizing", () => {
  test("changes width only through one undo, redo and save", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beamer-math-"));
    const source = String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}[label=canvas]
\begin{deckcanvas}
% image comment
\deckimage[x=.1,y=.2,w=.3]{image.png}
\end{deckcanvas}
\end{frame}
\end{document}
`;
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
      const request = {
        type: "resizeCanvasElement",
        frameIndex: 0,
        elementId: "canvas-image-0",
        version: doc.version,
        width: 0.5,
      };
      receive(request);
      await wait(() => doc.getText() === source.replace("w=.3", "w=0.500"));
      const moved = doc.getText();
      // A stale request cannot overwrite the new document.
      receive({ ...request, width: 0.7 });
      assert.equal(doc.getText(), moved);
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
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await rm(dir, { recursive: true, force: true });
    }
  });
});
