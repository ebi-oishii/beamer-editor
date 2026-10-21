/**
 * #149: deck 語彙の入力補完の統合テスト。実 VS Code の補完 API で候補が出ることと、
 * 候補の snippet を候補の範囲に挿入すると、自動で閉じた `}` を含めて正しい構文になることを確かめる。
 */

import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const tempDirs: string[] = [];

const deck = (body: string) =>
  `\\documentclass[aspectratio=169]{beamer}\n\\begin{document}\n\\begin{frame}{T}\n${body}\n\\end{frame}\n\\end{document}\n`;

async function open(name: string, body: string): Promise<vscode.TextEditor> {
  const directory = await mkdtemp(path.join(tmpdir(), "beamer-149-"));
  tempDirs.push(directory);
  const file = path.join(directory, name);
  await writeFile(file, deck(body));
  const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
  assert.ok(extension, "拡張が見つかる");
  await extension.activate();
  return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
}

/** 本文中のマーカー `|` の位置(マーカーは文書に含めない)。 */
function cursorOf(body: string): { body: string; position: vscode.Position } {
  const index = body.indexOf("|");
  const before = body.slice(0, index);
  const lines = before.split("\n");
  return {
    body: body.slice(0, index) + body.slice(index + 1),
    // 本文はプリアンブル 3 行の後に入る。
    position: new vscode.Position(3 + lines.length - 1, (lines.at(-1) ?? "").length),
  };
}

async function completionsAt(editor: vscode.TextEditor, position: vscode.Position) {
  const list = await vscode.commands.executeCommand<vscode.CompletionList>(
    "vscode.executeCompletionItemProvider",
    editor.document.uri,
    position,
  );
  return list.items;
}

const label = (item: vscode.CompletionItem) =>
  typeof item.label === "string" ? item.label : item.label.label;

suite("#149: deck 語彙の入力補完", () => {
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

  test("decktext のオプションで、まだ書いていないキーと文字サイズの値が出る", async () => {
    const options = cursorOf("\\begin{deckcanvas}\n\\begin{decktext}[x=0.100,|]\n");
    const editor = await open("options.slide.tex", options.body);
    const keys = (await completionsAt(editor, options.position))
      .filter((item) => item.kind === vscode.CompletionItemKind.Property)
      .map(label);
    assert.deepEqual(keys, ["y", "w", "size"]);

    const sizes = cursorOf("\\begin{deckcanvas}\n\\begin{decktext}[size=|]\n");
    const sizeEditor = await open("sizes.slide.tex", sizes.body);
    const values = (await completionsAt(sizeEditor, sizes.position))
      .filter((item) => item.kind === vscode.CompletionItemKind.EnumMember)
      .map(label);
    assert.deepEqual(values, [
      "tiny",
      "scriptsize",
      "footnotesize",
      "small",
      "normal",
      "large",
      "Large",
    ]);
  });

  test("`\\begin{deck` の候補を挿入すると、閉じた `}` を重ねずに環境ができる", async () => {
    const begin = cursorOf("\\begin{deckcanvas}\n\\begin{deck|}\n\\end{deckcanvas}");
    const editor = await open("begin.slide.tex", begin.body);
    const item = (await completionsAt(editor, begin.position)).find(
      (candidate) => label(candidate) === "decktext",
    );
    assert.ok(item, "decktext の候補が出る");
    assert.ok(item.insertText instanceof vscode.SnippetString);
    assert.ok(item.range instanceof vscode.Range);
    assert.ok(await editor.insertSnippet(item.insertText, item.range));
    // 字下げ(タブか空白か)はエディタの設定で変わるので問わない。
    assert.match(
      editor.document.getText(),
      /\\begin\{decktext\}\[x=0\.100,y=0\.100,w=0\.400,size=normal\]\n[ \t]*\n\\end\{decktext\}\n\\end\{deckcanvas\}/,
    );
  });

  test("`\\deckim` の候補は `\\` ごと置き換え、管理対象外の .tex では出ない", async () => {
    const command = cursorOf("\\begin{deckcanvas}\n\\deckim|\n\\end{deckcanvas}");
    const editor = await open("command.slide.tex", command.body);
    const item = (await completionsAt(editor, command.position)).find(
      (candidate) => label(candidate) === "\\deckimage",
    );
    assert.ok(item, "\\deckimage の候補が出る");
    assert.ok(item.insertText instanceof vscode.SnippetString);
    assert.ok(item.range instanceof vscode.Range);
    assert.ok(await editor.insertSnippet(item.insertText, item.range));
    assert.ok(
      editor.document
        .getText()
        .includes("\n\\deckimage[x=0.100,y=0.100,w=0.400]{assets/image.png}\n"),
      editor.document.getText(),
    );

    const plain = await open("notes.tex", command.body);
    const labels = (await completionsAt(plain, command.position)).map(label);
    assert.ok(!labels.includes("\\deckimage"), labels.join(", "));
  });
});
