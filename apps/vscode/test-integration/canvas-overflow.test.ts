/**
 * #152: プレビューからの移動・幅変更は本文領域で止めず、余白・ページ外の座標もそのままソースへ書く。
 * その代わり L012 が Problems に警告として出ることを、実 VS Code で確認する。
 */

import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension";

const SOURCE = String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}[label=canvas]
\begin{deckcanvas}
\deckimage[x=.1,y=.2,w=.3]{image.png}
\end{deckcanvas}
\end{frame}
\end{document}
`;

suite("#152: canvas overflow", () => {
  test("writes positions and widths outside the body area and reports L012", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beamer-152-"));
    const wait = async (condition: () => boolean, label: string) => {
      const until = Date.now() + 20_000;
      while (!condition()) {
        assert.ok(Date.now() < until, `timed out: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    try {
      const file = join(dir, "overflow.slide.tex");
      await writeFile(file, SOURCE);
      const doc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(doc);
      const ext = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
      assert.ok(ext);
      const api = (await ext.activate()) as TestApi;
      await wait(() => api._previewControllerForTest() !== undefined, "preview opens");
      const controller = api._previewControllerForTest();
      assert.ok(controller);
      const receive = controller.handleMessageForTest.bind(controller);
      await receive({ type: "ready" });
      await wait(() => controller.latestOutcome?.version === doc.version, "preview renders");
      const diagnostics = (code: string) =>
        vscode.languages.getDiagnostics(doc.uri).filter((diagnostic) => diagnostic.code === code);
      const l012 = () => diagnostics("L012");
      // 初期ソースが必ず出す L017 を lint 完了の目印にする(L012 の不在を lint 前に空振りで確かめない)。
      await wait(() => diagnostics("L017").length === 1, "lint runs");
      assert.equal(l012().length, 0);

      // 右余白の外・上のページ外へ。clamp されずにそのまま書かれる。
      let version = doc.version;
      await receive({
        type: "moveCanvasElement",
        frameIndex: 0,
        elementId: "canvas-image-0",
        version,
        x: 1.2,
        y: -0.1,
      });
      await wait(() => doc.version !== version, "move applies");
      assert.equal(doc.getText(), SOURCE.replace("x=.1,y=.2", "x=1.200,y=-0.100"));
      await wait(() => controller.latestOutcome?.version === doc.version, "preview re-renders");
      await wait(() => l012().length === 1, "L012 is reported");
      assert.equal(l012()[0]?.severity, vscode.DiagnosticSeverity.Warning);

      // 幅も右端で止めない。
      version = doc.version;
      await receive({
        type: "resizeCanvasElement",
        frameIndex: 0,
        elementId: "canvas-image-0",
        version,
        width: 1.5,
      });
      await wait(() => doc.version !== version, "resize applies");
      assert.equal(doc.getText(), SOURCE.replace("x=.1,y=.2,w=.3", "x=1.200,y=-0.100,w=1.500"));
    } finally {
      for (const document of vscode.workspace.textDocuments) {
        if (document.uri.fsPath.startsWith(dir) && document.isDirty) await document.save();
      }
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await rm(dir, { recursive: true, force: true });
    }
  });
});
