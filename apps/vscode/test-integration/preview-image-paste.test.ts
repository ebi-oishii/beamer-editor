/**
 * #160: プレビューへの画像の貼り付けの統合テスト。実 VS Code で、Webview と同じメッセージ経路を通し、
 * assets/ への保存・deckcanvas への配置・undo を確かめる。
 */

import * as assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const SOURCE = String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}{A}
  Body
\end{frame}
\end{document}
`;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

suite("#160: preview image paste", () => {
  test("deckcanvas の無いフレームへ置き、2 枚目は別名・ずらした位置で置き、undo で戻る", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beamer-160-"));
    const wait = async (condition: () => boolean | Promise<boolean>, label: string) => {
      const until = Date.now() + 20_000;
      while (!(await condition())) {
        assert.ok(Date.now() < until, `timed out: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    try {
      const file = join(dir, "paste.slide.tex");
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
      const paste = (version: number) =>
        receive({
          type: "pasteImage",
          frameIndex: 0,
          version,
          mimeType: "image/png",
          dataBase64: PNG.toString("base64"),
        });

      // 1 枚目: assets/image.png に保存し、新しい deckcanvas に置く(ラベルも付く)。
      let version = doc.version;
      await paste(version);
      await wait(() => doc.version !== version, "first paste applies");
      const first = doc.getText();
      assert.match(first, /\\begin\{frame\}\[label=[^\]]+\]\{A\}/);
      assert.match(
        first,
        /\\begin\{deckcanvas\}\s*\\deckimage\[x=0\.100,y=0\.100,w=0\.400\]\{assets\/image\.png\}\s*\\end\{deckcanvas\}/,
      );
      assert.deepEqual(await readFile(join(dir, "assets", "image.png")), PNG);
      await rendered();

      // 2 枚目: 同じ位置に箱があるので少しずらし、別名で保存する。
      version = doc.version;
      await paste(version);
      await wait(() => doc.version !== version, "second paste applies");
      const second = doc.getText();
      assert.match(second, /\\deckimage\[x=0\.100,y=0\.100,w=0\.400\]\{assets\/image\.png\}/);
      assert.match(second, /\\deckimage\[x=0\.1\d*,y=0\.1\d*,w=0\.400\]\{assets\/image-1\.png\}/);
      assert.ok(!second.includes("x=0.100,y=0.100,w=0.400]{assets/image-1.png}"));
      assert.deepEqual(await readFile(join(dir, "assets", "image-1.png")), PNG);
      await rendered();

      // 1 回の undo で 2 枚目の配置が戻る。
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand("undo");
      await wait(() => doc.getText() === first, "undo removes the second image");
      await wait(
        async () => !(await exists(join(dir, "assets", "image-1.png"))),
        "undo deletes the file",
      );
    } finally {
      for (const document of vscode.workspace.textDocuments) {
        if (document.uri.fsPath.startsWith(dir) && document.isDirty) await document.save();
      }
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await rm(dir, { recursive: true, force: true });
    }
  });
});
