/**
 * #199: VS Code の再起動・再読み込みでのプレビューの復元。実 VS Code で、復元されたパネルを
 * シリアライザと同じ経路でつなぎ直し、ソースの編集に追従すること・二重に開かないことを確かめる。
 */

import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension";
import { PREVIEW_VIEW_TYPE, previewTitle } from "../src/preview-restore";

const DECK = `%% deck-source-version: 1
\\documentclass[aspectratio=169]{beamer}
\\begin{document}
\\begin{frame}{Title}
restore me
\\end{frame}
\\end{document}
`;

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

/** VS Code が復元したのと同じ形のパネル(viewType・タブ名が同じ)。 */
function restoredPanel(fileName: string): vscode.WebviewPanel {
  return vscode.window.createWebviewPanel(
    PREVIEW_VIEW_TYPE,
    previewTitle(fileName),
    { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
    { enableScripts: true },
  );
}

function disposed(panel: vscode.WebviewPanel): () => boolean {
  let done = false;
  panel.onDidDispose(() => {
    done = true;
  });
  return () => done;
}

suite("#199: プレビューの復元", () => {
  let dir: string;
  let api: TestApi;

  suiteSetup(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    dir = await mkdtemp(path.join(tmpdir(), "beamer-199-"));
    const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
    assert.ok(extension);
    api = (await extension.activate()) as TestApi;
  });

  teardown(async () => {
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.fsPath.startsWith(dir) && document.isDirty) await document.save();
    }
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
  });

  suiteTeardown(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("復元したパネルを元ソースにつなぎ直し、ソースの編集に追従する", async () => {
    const file = path.join(dir, "manual.tex");
    await writeFile(file, DECK);
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);

    const panel = restoredPanel(file);
    await api._restorePreviewForTest(panel, {
      current: 0,
      step: 1,
      restore: { uri: document.uri.toString(), automatic: false },
    });
    const controller = api._previewControllerForTest();
    assert.ok(controller, "復元したパネルにプレビューがつながる");
    const receive = controller.handleMessageForTest.bind(controller);
    await receive({ type: "ready" });
    await waitFor(() => controller.latestOutcome?.version === document.version, "初回描画");

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(4, 0, 4, 10), "restored!");
    assert.ok(await vscode.workspace.applyEdit(edit));
    await waitFor(() => controller.latestOutcome?.version === document.version, "編集に追従");
    assert.equal(api._previewControllerForTest(), controller);
  });

  test("同じ文書のプレビューが既にあるとき・ソースのタブが無いときは、復元したパネルを閉じる", async () => {
    const file = path.join(dir, "auto.slide.tex");
    await writeFile(file, DECK);
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    await waitFor(() => api._previewControllerForTest() !== undefined, "自動プレビュー");
    const existing = api._previewControllerForTest();

    const duplicate = restoredPanel(file);
    const duplicateClosed = disposed(duplicate);
    await api._restorePreviewForTest(duplicate, {
      restore: { uri: document.uri.toString(), automatic: true },
    });
    await waitFor(duplicateClosed, "二重のパネルを閉じる");
    assert.equal(api._previewControllerForTest(), existing, "既存のプレビューはそのまま");

    const untabbed = path.join(dir, "untabbed.tex");
    await writeFile(untabbed, DECK);
    const orphan = restoredPanel(untabbed);
    const orphanClosed = disposed(orphan);
    await api._restorePreviewForTest(orphan, {
      restore: { uri: vscode.Uri.file(untabbed).toString(), automatic: false },
    });
    await waitFor(orphanClosed, "ソースのタブが無いパネルを閉じる");

    const broken = restoredPanel(untabbed);
    const brokenClosed = disposed(broken);
    await api._restorePreviewForTest(broken, { current: 0, step: 1 });
    await waitFor(brokenClosed, "元ソースの無い state のパネルを閉じる");
  });

  test("つながる前の復元タブがあれば、managed file を開いても自動プレビューを重ねて開かない", async () => {
    const file = path.join(dir, "pending.slide.tex");
    await writeFile(file, DECK);
    // VS Code が再読み込みで復元した、まだシリアライザに渡されていないタブの代わり。
    const panel = restoredPanel(file);
    const before = api._previewControllerForTest();
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    await sleep(1_000);
    const previews = vscode.window.tabGroups.all.flatMap((group) =>
      group.tabs.filter((tab) => tab.label === previewTitle(file)),
    );
    assert.equal(previews.length, 1, "復元タブのほかにプレビューを開かない");
    assert.equal(api._previewControllerForTest(), before);

    await api._restorePreviewForTest(panel, {
      restore: { uri: document.uri.toString(), automatic: true },
    });
    assert.notEqual(api._previewControllerForTest(), before, "復元タブにつながる");
  });
});
