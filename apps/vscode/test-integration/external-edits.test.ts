/**
 * VS-6: 外部編集と競合(移植計画 §VS-6)の統合テスト。実 VS Code の Extension Host で
 * 動き、Claude Code / Codex / CLI などがディスク上の `.tex` を書き換えるケースを再現する。
 *
 * 検証する標準挙動(拡張は独自 file watcher を持たない):
 * - clean buffer への外部変更は VS Code が取り込み、onDidChangeTextDocument で追従できる
 * - dirty buffer は外部変更で強制再読込されず、入力内容が失われない
 */

import * as assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

function deckSource(marker: string): string {
  return `%% deck-source-version: 1
\\documentclass[aspectratio=169]{beamer}
\\begin{document}
\\begin{frame}{Title}
${marker}
\\end{frame}
\\end{document}
`;
}

async function makeDeckFile(name: string, marker: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "beamer-vs6-"));
  const file = path.join(dir, name);
  await writeFile(file, deckSource(marker));
  return file;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      assert.fail(`待機がタイムアウトしました: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

suite("VS-6: 外部編集と競合", () => {
  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("clean buffer への外部変更が onDidChangeTextDocument 経由で追従できる", async function () {
    // 起動直後は file watcher の準備前に書き込むと変更イベントを取りこぼすため、
    // 猶予を置いたうえで、それでも稀に落ちる場合に備えて 1 回だけ再試行する。
    this.retries(1);
    const file = await makeDeckFile("clean.tex", "ORIGINAL");
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document);
    assert.equal(document.isDirty, false);
    await sleep(2_000);

    // 拡張のプレビュー更新(VS-3)と同じイベント源で外部変更の到来を観測する。
    await writeFile(file, deckSource("EXTERNAL"));
    await waitFor(
      () => document.getText().includes("EXTERNAL"),
      "外部変更が clean buffer へ取り込まれる",
    );

    assert.equal(document.isDirty, false);
    assert.ok(!document.getText().includes("ORIGINAL"));
  });

  test("dirty buffer は外部変更で強制再読込されず、入力内容が失われない", async () => {
    const file = await makeDeckFile("dirty.tex", "ORIGINAL");
    const document = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(document);

    const applied = await editor.edit((builder) =>
      builder.insert(new vscode.Position(0, 0), "% USER-INPUT\n"),
    );
    assert.ok(applied);
    assert.ok(document.isDirty);

    await writeFile(file, deckSource("EXTERNAL"));
    // file watcher が反応する猶予を与えたうえで、buffer が上書きされないことを確認する。
    await sleep(3_000);

    assert.ok(document.getText().includes("% USER-INPUT"), "ユーザーの入力内容が失われない");
    assert.ok(!document.getText().includes("EXTERNAL"), "dirty buffer は強制再読込されない");
    assert.ok(document.isDirty, "競合の保存判断は VS Code 標準(保存時の確認)に委ねる");
  });

  test("プレビューを開いた文書への外部変更が最新テキスト・version に反映される", async () => {
    const file = await makeDeckFile("preview.tex", "ORIGINAL");
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document);
    const versionBefore = document.version;

    await vscode.commands.executeCommand("beamerEditor.openPreview");
    await waitFor(
      () =>
        vscode.window.tabGroups.all.some((group) =>
          group.tabs.some((tab) => tab.label.startsWith("Beamer Preview")),
        ),
      "プレビューパネルが開く",
    );

    await writeFile(file, deckSource("EXTERNAL"));
    await waitFor(
      () => document.getText().includes("EXTERNAL"),
      "外部変更がプレビュー対象文書へ取り込まれる",
    );

    // VS-4 のソースジャンプは document.version の一致を検査してから
    // 最新の RenderOutcome を使うため、version が進んでいれば位置は最新文書と一致する。
    assert.ok(document.version > versionBefore, "外部変更で document version が進む");
  });
});
