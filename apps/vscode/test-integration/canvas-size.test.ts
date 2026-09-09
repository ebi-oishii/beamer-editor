import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension";

suite("#84: canvas text size", () => {
  for (const initialSize of ["", ",size=small"]) {
    test(`${initialSize || "default"}: changes size only through one undo, redo and save`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "beamer-math-"));
      const options = `[x=.1,y=.2,w=.3${initialSize}]`;
      const element = `\\begin{decktext}${options}Text $x$\\end{decktext}`;
      const source = String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}[label=canvas]
\begin{deckcanvas}
% image comment
${element}
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
          type: "setCanvasFontSize",
          frameIndex: 0,
          elementId: "canvas-text-0",
          version: doc.version,
          size: "Large",
        };
        receive(request);
        await wait(() => doc.getText() === source.replace(options, "[x=.1,y=.2,w=.3,size=Large]"));
        const moved = doc.getText();
        // A stale request cannot overwrite the new document.
        receive({ ...request, size: "tiny" });
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
        for (const document of vscode.workspace.textDocuments) {
          if (document.uri.fsPath.startsWith(dir) && document.isDirty) await document.save();
        }
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
