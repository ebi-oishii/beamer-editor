import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const tempDirs: string[] = [];

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`待機がタイムアウトしました: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

suite("Issue #8: 円記号 Quick Fix", () => {
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
    for (const directory of tempDirs.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  test("L021 を表示だけして、Quick Fix 適用時だけ円記号を置換する", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "beamer-yen-action-"));
    tempDirs.push(directory);
    const file = path.join(directory, "yen.slide.tex");
    await writeFile(
      file,
      "%% deck-source-version: 1\n\\documentclass{beamer}\n\\begin{document}\n¥section{Title}\n価格は ¥100\n\\end{document}\n",
    );
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document);
    const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
    assert.ok(extension, "拡張が見つかる");
    await extension.activate();

    await waitFor(
      () =>
        vscode.languages
          .getDiagnostics(document.uri)
          .some((diagnostic) => diagnostic.code === "L021"),
      "L021 diagnostic",
    );
    const diagnostic = vscode.languages
      .getDiagnostics(document.uri)
      .find((entry) => entry.code === "L021");
    assert.ok(diagnostic);
    const before = document.getText();
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      document.uri,
      diagnostic.range,
      vscode.CodeActionKind.QuickFix.value,
    );
    assert.equal(document.getText(), before, "listing actions must not edit the document");
    const action = actions?.find((candidate) =>
      candidate.kind?.contains(vscode.CodeActionKind.QuickFix),
    );
    assert.ok(action?.edit, "L021 provides one Quick Fix edit");
    assert.equal(await vscode.workspace.applyEdit(action.edit), true);
    assert.ok(document.getText().includes("\\section{Title}"));
    assert.ok(document.getText().includes("¥100"), "currency must remain unchanged");
    await waitFor(
      () => !vscode.languages.getDiagnostics(document.uri).some((entry) => entry.code === "L021"),
      "L021 diagnostic removal",
    );
  });
});
