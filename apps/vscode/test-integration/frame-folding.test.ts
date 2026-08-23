import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const tempDirs: string[] = [];

suite("VS-7: フレーム折りたたみ", () => {
  suiteTeardown(async () => {
    for (const directory of tempDirs.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  test("managed slide file exposes its complete frame range", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "beamer-folding-"));
    tempDirs.push(directory);
    const file = path.join(directory, "fold.slide.tex");
    await writeFile(
      file,
      "\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}{Fold me}\ncontent\n\\end{frame}\n\\end{document}\n",
    );
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document);
    const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
    assert.ok(extension, "拡張が見つかる");
    await extension.activate();

    const ranges = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
      "vscode.executeFoldingRangeProvider",
      document.uri,
    );
    assert.ok(ranges?.some((range) => range.start === 2 && range.end === 4));
  });
});
