/**
 * #153: エディタへの画像の貼り付けの統合テスト。実 VS Code の Extension Host で、paste provider が
 * 返す edit(assets/ へのファイル作成 + 参照の挿入)を適用し、まだ無い assets/ ディレクトリごと
 * 作られることと、2 回目が別名になることを確認する。
 * (クリップボードに画像を置く操作は自動化できないので、DataTransfer は同じ面を持つ代替を渡す。)
 */

import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension";

const SOURCE = `\\documentclass[aspectratio=169]{beamer}
\\begin{document}
\\begin{frame}{Title}
body
\\end{frame}
\\end{document}
`;

// PNG のシグネチャだけ。中身の妥当性は問わない(バイト列がそのまま書かれることを見る)。
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

const tempDirs: string[] = [];

function pngTransfer(): vscode.DataTransfer {
  const item = { asFile: () => ({ name: "image.png", uri: undefined, data: async () => PNG }) };
  return {
    get: (mime: string) => (mime === "image/png" ? item : undefined),
  } as unknown as vscode.DataTransfer;
}

suite("#153: エディタへの画像の貼り付け", () => {
  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  suiteTeardown(async () => {
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  test("PNG を assets/ に保存して includegraphics を挿入し、2 回目は別名になる", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "beamer-153-"));
    tempDirs.push(dir);
    const file = path.join(dir, "deck.slide.tex");
    await writeFile(file, SOURCE);
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document);

    const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
    assert.ok(extension, "拡張が見つかる");
    const api = (await extension.activate()) as TestApi;
    const provider = api._imagePasteProviderForTest();

    const position = new vscode.Position(3, 4); // "body" の直後
    const context = { only: undefined, triggerKind: vscode.DocumentPasteTriggerKind.Automatic };
    const token = new vscode.CancellationTokenSource().token;
    const edits = await provider.provideDocumentPasteEdits(
      document,
      [new vscode.Range(position, position)],
      pngTransfer(),
      context,
      token,
    );
    assert.equal(edits?.length, 1);
    const edit = edits?.[0];
    assert.ok(edit);
    assert.equal(edit.insertText, "\\includegraphics[width=0.8\\textwidth]{assets/image.png}");

    // VS Code が paste edit を適用するのと同じく、ファイル作成と挿入を 1 つの WorkspaceEdit で行う。
    const workspaceEdit = edit.additionalEdit;
    assert.ok(workspaceEdit);
    workspaceEdit.insert(document.uri, position, edit.insertText as string);
    assert.ok(await vscode.workspace.applyEdit(workspaceEdit));

    const written = await vscode.workspace.fs.readFile(
      vscode.Uri.file(path.join(dir, "assets", "image.png")),
    );
    assert.deepEqual([...written], [...PNG]);
    assert.ok(
      document.getText().includes("body\\includegraphics[width=0.8\\textwidth]{assets/image.png}"),
    );

    const again = await provider.provideDocumentPasteEdits(
      document,
      [new vscode.Range(position, position)],
      pngTransfer(),
      context,
      token,
    );
    assert.equal(
      again?.[0]?.insertText,
      "\\includegraphics[width=0.8\\textwidth]{assets/image-1.png}",
    );
  });
});
