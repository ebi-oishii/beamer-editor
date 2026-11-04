import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { managedPreambleBlock } from "@beamer-editor/core";
import * as vscode from "vscode";

const tempDirs: string[] = [];

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`待機がタイムアウトしました: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

suite("L025: 管理プリアンブルを差し替える Quick Fix", () => {
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
    for (const directory of tempDirs.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  test("CRLF のデッキでも、中身が現行と違う warning に Quick Fix が出て、当てると消える", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "beamer-l025-crlf-"));
    tempDirs.push(directory);
    const file = path.join(directory, "crlf.slide.tex");
    // 手で編集した管理プリアンブル(命令を 1 つ消した)。
    const edited = managedPreambleBlock().replace("\\setbeamertemplate{navigation symbols}{}", "");
    const source = [
      "\\documentclass[aspectratio=169]{beamer}",
      "%% deck-source-version: 1",
      edited,
      "\\begin{document}",
      "\\begin{frame}{T}x\\end{frame}",
      "\\end{document}",
      "",
    ]
      .join("\n")
      .replaceAll("\n", "\r\n");
    await writeFile(file, source);
    const document = await vscode.workspace.openTextDocument(file);
    assert.equal(document.eol, vscode.EndOfLine.CRLF);
    await vscode.window.showTextDocument(document);
    const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
    assert.ok(extension, "拡張が見つかる");
    await extension.activate();

    const l025 = () =>
      vscode.languages.getDiagnostics(document.uri).find((entry) => entry.code === "L025");
    await waitFor(() => l025() !== undefined, "L025 diagnostic");
    const diagnostic = l025();
    assert.ok(diagnostic);
    assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Warning);
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      document.uri,
      diagnostic.range,
      vscode.CodeActionKind.QuickFix.value,
    );
    const action = actions?.find(
      (candidate) => candidate.title === "ツール管理プリアンブルを最新に差し替える",
    );
    assert.ok(action?.edit, actions?.map((candidate) => candidate.title).join(", "));
    assert.equal(await vscode.workspace.applyEdit(action.edit), true);
    assert.ok(document.getText().includes("\\setbeamertemplate{navigation symbols}{}"));
    await waitFor(() => l025() === undefined, "L025 diagnostic removal");
  });
});
