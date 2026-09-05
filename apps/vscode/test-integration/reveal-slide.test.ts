/**
 * #66: ソース → プレビュー(beamerEditor.revealSlide)の統合テスト。実 VS Code の Extension Host で
 * 動き、対象外(managed でない文書・フレーム外の位置)ではプレビューを開かないことを確認する。
 */

import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const SOURCE = `\\documentclass[aspectratio=169]{beamer}
\\begin{document}
\\begin{frame}{Title}
body
\\end{frame}
\\end{document}
`;

const tempDirs: string[] = [];

function previewTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.filter((tab) => tab.label.startsWith("Beamer Preview")),
  );
}

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

async function openDeck(name: string): Promise<vscode.TextDocument> {
  const dir = await mkdtemp(path.join(tmpdir(), "beamer-66-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  await writeFile(file, SOURCE);
  const document = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(document);
  return document;
}

async function closePreviews(): Promise<void> {
  for (const tab of previewTabs()) await vscode.window.tabGroups.close(tab);
  await waitFor(() => previewTabs().length === 0, "プレビューが閉じる");
}

suite("#66: revealSlide の対象判定", () => {
  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  suiteTeardown(async () => {
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  test("managed でない .tex では、フレーム内の位置でもプレビューを開かない", async () => {
    const document = await openDeck("plain.tex");
    await vscode.commands.executeCommand(
      "beamerEditor.revealSlide",
      document.uri.toString(),
      SOURCE.indexOf("body"),
    );
    await sleep(1_000);
    assert.equal(previewTabs().length, 0);
  });

  test("managed 文書でも、フレーム外の位置では閉じたプレビューを開き直さず、フレーム内なら開き直す", async () => {
    const document = await openDeck("deck.slide.tex");
    // managed 文書は自動でプレビューが開く。閉じて(= 自動オープンを断って)からコマンドを試す。
    await waitFor(() => previewTabs().length === 1, "自動プレビューが開く");
    await closePreviews();
    const uri = document.uri.toString();

    await vscode.commands.executeCommand("beamerEditor.revealSlide", uri, 0);
    await sleep(1_000);
    assert.equal(previewTabs().length, 0, "プリアンブルでは開かない");

    await vscode.commands.executeCommand("beamerEditor.revealSlide", uri, SOURCE.indexOf("body"));
    await waitFor(() => previewTabs().length === 1, "フレーム内なら開き直す");
    assert.equal(
      vscode.window.activeTextEditor?.document.uri.toString(),
      uri,
      "フォーカスはソースに残る",
    );
  });
});
