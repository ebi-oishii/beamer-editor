import * as assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension";

const SOURCE = `\\documentclass[aspectratio=169]{beamer}
%% deck-source-version: 1
\\begin{document}
% comment A
\\begin{frame}[label=a]{A}
A body
\\end{frame}
\\section{Next}
% comment B
\\begin{frame}[label=b]{B}
B body
\\end{frame}
\\end{document}
`;
const dirs: string[] = [];
async function waitFor(predicate: () => boolean, name: string) {
  const limit = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > limit) assert.fail(`Timed out: ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
type Item = { entry: { version: number; document: vscode.TextDocument } };

suite("#85: slide list source edits", () => {
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
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  for (const action of ["moveDown", "moveUp", "duplicate", "delete", "insert"] as const) {
    test(`${action}: one undo, redo, and saved source`, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "beamer-slide-edit-"));
      dirs.push(dir);
      const file = path.join(dir, "deck.slide.tex");
      await writeFile(file, SOURCE);
      const document = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(document);
      const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
      assert.ok(extension);
      const api = (await extension.activate()) as TestApi;
      await waitFor(
        () => (api._slideItemsForTest()[0] as Item | undefined)?.entry.document === document,
        "outline ready",
      );
      const items = api._slideItemsForTest();
      const item = items[action === "moveUp" ? 1 : 0];
      assert.ok(item);
      assert.equal(
        await vscode.commands.executeCommand(`beamerEditor.slides.${action}`, item),
        true,
      );
      const changed = document.getText();
      assert.notEqual(changed, SOURCE);
      assert.ok(changed.includes("\\section{Next}"));
      const frameCount = (changed.match(/\\begin\{frame\}/g) ?? []).length;
      assert.equal(
        frameCount,
        action === "duplicate" || action === "insert" ? 3 : action === "delete" ? 1 : 2,
      );
      if (action.startsWith("move"))
        assert.ok(changed.indexOf("B body") < changed.indexOf("A body"));
      if (action === "duplicate" || action === "insert")
        assert.ok(changed.includes("label=slide-1"));
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand("undo");
      await waitFor(() => document.getText() === SOURCE, "single undo restores source");
      await vscode.commands.executeCommand("redo");
      await waitFor(() => document.getText() === changed, "redo restores edit");
      assert.equal(await document.save(), true);
      assert.equal(await readFile(file, "utf8"), changed);
      // The original tree item has an old document version and must not mutate again.
      assert.equal(await vscode.commands.executeCommand("beamerEditor.slides.delete", item), false);
      assert.equal(document.getText(), changed);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      const reopened = await vscode.workspace.openTextDocument(file);
      assert.equal(reopened.getText(), changed);
    });
  }

  test("inserts from the view toolbar into a deck with no frames", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "beamer-slide-empty-"));
    dirs.push(dir);
    const file = path.join(dir, "empty.slide.tex");
    const source = "\\documentclass{beamer}\n\\begin{document}\n\\end{document}\n";
    await writeFile(file, source);
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document);
    const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
    assert.ok(extension);
    const api = (await extension.activate()) as TestApi;
    await waitFor(() => api._slideItemsForTest().length === 0, "empty outline");
    assert.equal(
      await vscode.commands.executeCommand("beamerEditor.slides.append", {
        $treeViewId: "beamerEditor.slides",
      }),
      true,
    );
    assert.ok(document.getText().includes("label=slide-1"));
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand("undo");
    await waitFor(() => document.getText() === source, "empty deck restored");
  });
});

suite("#85: append ignores the focused item", () => {
  test("view title add appends even if a tree item is supplied", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "beamer-slide-append-"));
    try {
      const file = path.join(dir, "deck.slide.tex");
      await writeFile(file, SOURCE);
      const document = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(document);
      const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
      assert.ok(extension);
      const api = (await extension.activate()) as TestApi;
      await waitFor(
        () => (api._slideItemsForTest()[0] as Item | undefined)?.entry.document === document,
        "outline ready",
      );
      assert.equal(
        await vscode.commands.executeCommand(
          "beamerEditor.slides.append",
          api._slideItemsForTest()[0],
        ),
        true,
      );
      assert.ok(document.getText().indexOf("label=slide-1") > document.getText().indexOf("B body"));
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand("undo");
      await waitFor(() => document.getText() === SOURCE, "append undone");
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
