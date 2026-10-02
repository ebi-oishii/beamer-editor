/**
 * #148: プレビューからのキャンバス要素の削除・コピー・貼り付けの統合テスト。実 VS Code で、
 * Webview と同じメッセージ経路を通し、ソースの変化・OS クリップボード・undo を確かめる。
 */

import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension";

const TEXT = String.raw`\begin{decktext}[x=0.100,y=0.200,w=0.400,size=normal]
  Hello \textbf{world}
\end{decktext}`;
const IMAGE = String.raw`\deckimage[x=0.500,y=0.100,w=0.300]{assets/a.png}`;

const FRAME_A = String.raw`\begin{frame}[label=a]{A}
  \begin{deckcanvas}
    \begin{decktext}[x=0.100,y=0.200,w=0.400,size=normal]
      Hello \textbf{world}
    \end{decktext}
    ${IMAGE}
  \end{deckcanvas}
\end{frame}`;
const FRAME_B = String.raw`\begin{frame}[label=b]{B}
  \begin{deckcanvas}
    \deckimage[x=0.700,y=0.700,w=0.200]{assets/b.png}
  \end{deckcanvas}
\end{frame}`;
const SOURCE = `\\documentclass[aspectratio=169]{beamer}\n\\begin{document}\n${FRAME_A}\n${FRAME_B}\n\\end{document}\n`;

suite("#148: canvas clipboard", () => {
  test("copy → paste into another frame, delete, undo, cut", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beamer-148-"));
    const wait = async (condition: () => boolean, label: string) => {
      const until = Date.now() + 20_000;
      while (!condition()) {
        assert.ok(Date.now() < until, `timed out: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const previousClipboard = await vscode.env.clipboard.readText();
    try {
      const file = join(dir, "clip.slide.tex");
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
      const rendered = () =>
        wait(() => controller.latestOutcome?.version === doc.version, "preview re-renders");
      await receive({ type: "ready" });
      await rendered();

      // コピー: 要素のソース原文が OS クリップボードに入る。
      await receive({
        type: "copyCanvasElement",
        frameIndex: 0,
        elementId: "canvas-text-0",
        version: doc.version,
        cut: false,
      });
      assert.equal(await vscode.env.clipboard.readText(), TEXT);

      // 別フレームへ貼り付け: 同じ位置のまま、B の deckcanvas の末尾に入る。
      let version = doc.version;
      await receive({ type: "pasteCanvasElements", frameIndex: 1, version });
      await wait(() => doc.version !== version, "paste applies");
      const pasted = SOURCE.replace(
        "    \\deckimage[x=0.700,y=0.700,w=0.200]{assets/b.png}\n",
        `    \\deckimage[x=0.700,y=0.700,w=0.200]{assets/b.png}\n    ${TEXT.split("\n").join("\n    ")}\n`,
      );
      assert.equal(doc.getText(), pasted);
      await rendered();

      // 削除: A の画像が行ごと消える。1 回の undo で戻る。
      version = doc.version;
      await receive({
        type: "deleteCanvasElement",
        frameIndex: 0,
        elementId: "canvas-image-0",
        version,
      });
      await wait(() => doc.version !== version, "delete applies");
      assert.equal(doc.getText(), pasted.replace(`    ${IMAGE}\n`, ""));
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand("undo");
      await wait(() => doc.getText() === pasted, "undo restores the image");
      await rendered();

      // 切り取り: クリップボードへ写してから消える。
      version = doc.version;
      await receive({
        type: "copyCanvasElement",
        frameIndex: 0,
        elementId: "canvas-image-0",
        version,
        cut: true,
      });
      await wait(() => doc.version !== version, "cut applies");
      assert.equal(await vscode.env.clipboard.readText(), IMAGE);
      assert.equal(doc.getText(), pasted.replace(`    ${IMAGE}\n`, ""));
    } finally {
      await vscode.env.clipboard.writeText(previousClipboard);
      for (const document of vscode.workspace.textDocuments) {
        if (document.uri.fsPath.startsWith(dir) && document.isDirty) await document.save();
      }
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await rm(dir, { recursive: true, force: true });
    }
  });
});
