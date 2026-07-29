/**
 * VS-6: 外部編集と競合(移植計画 §VS-6)の統合テスト。実 VS Code の Extension Host で
 * 動き、Claude Code / Codex / CLI などがディスク上の `.tex` を書き換えるケースを再現する。
 *
 * 検証する標準挙動(拡張は独自 file watcher を持たない):
 * - clean buffer への外部変更は VS Code が取り込み、onDidChangeTextDocument で追従できる
 * - dirty buffer は外部変更で強制再読込されず、入力内容が失われない
 * - プレビュー対象文書への外部変更が、拡張のレンダリング結果(latestOutcome)まで届く
 */

import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension";

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

const tempDirs: string[] = [];

async function makeDeckFile(name: string, marker: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "beamer-vs6-"));
  tempDirs.push(dir);
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

/**
 * 外部書き込みを一定間隔で繰り返しながら、文書への取り込みを待つ。
 * watcher の準備完了を観測する公開 API は無く、起動直後の 1 回目の書き込みは
 * 取りこぼされ得るため、実運用の外部ツールと同じく「書き込みが続く」状況を
 * 再現して決定的に収束させる(固定 sleep やテスト retry に依存しない)。
 */
async function writeUntilPickedUp(
  file: string,
  content: string,
  document: vscode.TextDocument,
  marker: string,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  await writeFile(file, content);
  while (!document.getText().includes(marker)) {
    if (Date.now() - start > timeoutMs) {
      assert.fail(`外部変更が取り込まれませんでした: ${marker}`);
    }
    await sleep(1_000);
    // watcher 未準備で取りこぼした場合の再送(内容は同一)。
    await writeFile(file, content);
  }
}

suite("VS-6: 外部編集と競合", () => {
  teardown(async () => {
    // dirty なまま閉じると保存ダイアログでハングし得るため、先に revert する。
    for (const document of vscode.workspace.textDocuments) {
      if (document.isDirty) {
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand("workbench.action.files.revert");
      }
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  suiteTeardown(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("clean buffer への外部変更が onDidChangeTextDocument 経由で追従できる", async () => {
    const file = await makeDeckFile("clean.tex", "ORIGINAL");
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document);
    assert.equal(document.isDirty, false);

    await writeUntilPickedUp(file, deckSource("EXTERNAL"), document, "EXTERNAL");

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

  test("プレビュー対象への外部変更が最新 version でレンダリングまで届く", async () => {
    const file = await makeDeckFile("preview.tex", "ORIGINAL");
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document);

    const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
    assert.ok(extension, "拡張が見つかる");
    const api = (await extension.activate()) as TestApi;

    await vscode.commands.executeCommand("beamerEditor.openPreview");
    await waitFor(
      () =>
        vscode.window.tabGroups.all.some((group) =>
          group.tabs.some((tab) => tab.label.startsWith("Beamer Preview")),
        ),
      "プレビューパネルが開く",
    );

    await writeUntilPickedUp(file, deckSource("EXTERNAL"), document, "EXTERNAL");

    // 外部変更が debounce を経て再レンダリングされ、deckUpdated の元になる
    // latestOutcome が最新 document.version と一致することまでを観測する
    // (Webview への postMessage 配送自体は VS Code 基盤に委ねる)。
    await waitFor(() => {
      const outcome = api._previewControllerForTest()?.latestOutcome;
      return outcome !== undefined && outcome.version === document.version;
    }, "外部変更が最新 version でレンダリングされる");

    const html = api
      ._previewControllerForTest()
      ?.latestOutcome?.deck.frames.map((frame) => frame.html)
      .join("");
    assert.ok(html?.includes("EXTERNAL"), "レンダリング結果に外部変更の内容が反映される");

    // VS-4 のソースジャンプは document.version の一致を検査してから最新の
    // RenderOutcome を使うため、この時点でジャンプ位置は最新文書と一致する
    // (offset 解決の正確性は unit テストで担保)。
  });
});
