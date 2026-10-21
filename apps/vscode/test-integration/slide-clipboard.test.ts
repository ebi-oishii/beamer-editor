/**
 * #174: プレビューで選択したスライドのコピー・貼り付けの統合テスト。実 VS Code で、Webview と
 * 同じメッセージ経路を通し、OS クリップボード・ソースの変化・undo・キャンバス要素への切り替えを確かめる。
 */

import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension";

const FRAME_A = String.raw`% note A
\begin{frame}[label=a]{A}
  A body
\end{frame}`;
const FRAME_B = String.raw`\begin{frame}[label=b]{B}
  \begin{deckcanvas}
    \deckimage[x=0.700,y=0.700,w=0.200]{assets/b.png}
  \end{deckcanvas}
\end{frame}`;
const SOURCE = `\\documentclass[aspectratio=169]{beamer}\n\\begin{document}\n${FRAME_A}\n${FRAME_B}\n\\end{document}\n`;
const IMAGE = String.raw`\deckimage[x=0.100,y=0.100,w=0.300]{assets/a.png}`;

suite("#174: slide clipboard", () => {
  test("copy a slide → paste after another slide, undo, paste a canvas element instead", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beamer-174-"));
    const wait = async (condition: () => boolean, label: string) => {
      const until = Date.now() + 20_000;
      while (!condition()) {
        assert.ok(Date.now() < until, `timed out: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const previousClipboard = await vscode.env.clipboard.readText();
    try {
      const file = join(dir, "slides.slide.tex");
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

      // コピー: 直前のコメント行ごと、スライドのソース原文が OS クリップボードに入る。
      await receive({ type: "copySlide", frameIndex: 0, version: doc.version });
      assert.equal(await vscode.env.clipboard.readText(), `${FRAME_A}\n`);

      // 貼り付け: B の後ろに、未使用の label を付けて入る。
      let version = doc.version;
      await receive({ type: "pasteSlides", frameIndex: 1, version });
      await wait(() => doc.version !== version, "paste applies");
      const pasted = SOURCE.replace(
        `${FRAME_B}\n`,
        `${FRAME_B}\n\n${FRAME_A.replace("[label=a]", "[label=slide-1]")}\n`,
      );
      assert.equal(doc.getText(), pasted);
      await rendered();

      // 1 回の undo で戻る。
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand("undo");
      await wait(() => doc.getText() === SOURCE, "undo removes the pasted slide");
      await rendered();

      // クリップボードがスライドでなければ、選択中のスライドへキャンバス要素として入る。
      await vscode.env.clipboard.writeText(IMAGE);
      version = doc.version;
      await receive({ type: "pasteSlides", frameIndex: 1, version });
      await wait(() => doc.version !== version, "canvas paste applies");
      assert.equal(
        doc.getText(),
        SOURCE.replace(
          "    \\deckimage[x=0.700,y=0.700,w=0.200]{assets/b.png}\n",
          `    \\deckimage[x=0.700,y=0.700,w=0.200]{assets/b.png}\n    ${IMAGE}\n`,
        ),
      );
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
