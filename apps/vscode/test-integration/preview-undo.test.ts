/**
 * #103: プレビューにフォーカスがあるときの Cmd/Ctrl+Z の統合テスト。実 VS Code の Extension Host で、
 * Webview からの undoRedo メッセージがソース文書の undo / redo を実行することを確認する。
 * (Webview のキー入力そのものは ui のユニットテストで担保し、ここは拡張側の経路を見る。)
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

const tempDirs: string[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) assert.fail(`待機がタイムアウトしました: ${label}`);
    await sleep(100);
  }
}

suite("#103: プレビューからの undo / redo", () => {
  teardown(async () => {
    for (const document of vscode.workspace.textDocuments) {
      if (document.isDirty) {
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand("workbench.action.files.revert");
      }
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  suiteTeardown(async () => {
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  test("undoRedo メッセージでソースの編集が取り消され、redo で戻る", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "beamer-103-"));
    tempDirs.push(dir);
    const file = path.join(dir, "deck.slide.tex");
    await writeFile(file, SOURCE);
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document);

    const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
    assert.ok(extension, "拡張が見つかる");
    const api = (await extension.activate()) as TestApi;
    await waitFor(() => api._previewControllerForTest() !== undefined, "自動プレビューが開く");
    const controller = api._previewControllerForTest();
    assert.ok(controller);

    // ドラッグや自由配置と同じく WorkspaceEdit で編集する(1 操作 = 1 undo)。
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(3, 0), "EDIT ");
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(document.getText().includes("EDIT body"));

    // Webview からのメッセージと同じ経路(parse → 注入された undoRedo)を通す。
    const receive = (
      controller as unknown as { handleMessage(raw: unknown): void }
    ).handleMessage.bind(controller);
    receive({ type: "undoRedo", kind: "undo" });
    await waitFor(() => !document.getText().includes("EDIT"), "undo で編集が消える");

    receive({ type: "undoRedo", kind: "redo" });
    await waitFor(() => document.getText().includes("EDIT body"), "redo で編集が戻る");
  });
});
