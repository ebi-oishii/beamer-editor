/**
 * #94: プレビューのエディタグループをロックし、プレビューがアクティブなときに開いた別のファイルが
 * 同じグループへ開かないことを実 VS Code で確かめる。
 */

import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension";

const DECK = `%% deck-source-version: 1
\\documentclass[aspectratio=169]{beamer}
\\begin{document}
\\begin{frame}{Title}
lock me
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

suite("#94: プレビューのグループロック", () => {
  let dir: string;

  suiteSetup(async () => {
    // 前の suite が残したグループ(ロック済みで空のものを含む)を片付けてから始める。
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    dir = await mkdtemp(path.join(tmpdir(), "beamer-lock-"));
    await writeFile(path.join(dir, "deck.tex"), DECK);
    await writeFile(path.join(dir, "other.tex"), DECK.replace("lock me", "other"));
  });

  suiteTeardown(async () => {
    // ロックしたグループは空になっても残るので、他の suite に影響しないよう全グループを閉じる。
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    await rm(dir, { recursive: true, force: true });
  });

  test("プレビューをフォーカスした後に開いた別ファイルはソース側のグループへ開く", async () => {
    const deck = await vscode.workspace.openTextDocument(path.join(dir, "deck.tex"));
    await vscode.window.showTextDocument(deck, vscode.ViewColumn.One);
    const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
    assert.ok(extension);
    const api = (await extension.activate()) as TestApi;

    // 手動オープンはパネルにフォーカスが移る → その時点でグループがロックされる。
    await vscode.commands.executeCommand("beamerEditor.openPreview");
    await waitFor(
      () => api._previewControllerForTest()?.latestOutcome !== undefined,
      "プレビューの初回描画",
    );
    // lockEditorGroup は非同期に実行される。
    await sleep(1_000);

    const previewColumn = vscode.window.tabGroups.all.find((group) =>
      group.tabs.some((tab) => tab.label.startsWith("Beamer Preview")),
    )?.viewColumn;
    assert.ok(previewColumn !== undefined, "プレビューの列が分かる");
    assert.equal(vscode.window.tabGroups.activeTabGroup.viewColumn, previewColumn);

    // 列指定なし(= アクティブなグループ = プレビュー)で開く。ロック中なら別の列へ迂回する。
    const other = await vscode.workspace.openTextDocument(path.join(dir, "other.tex"));
    const editor = await vscode.window.showTextDocument(other);
    assert.notEqual(editor.viewColumn, previewColumn, "プレビューと同じグループには開かない");
    assert.equal(editor.viewColumn, vscode.ViewColumn.One, "ソース側の列へ開く");
  });
});
