/**
 * #151: プレビューのスライド一覧からの並べ替え。Webview と同じメッセージ経路を通し、
 * スライド一覧(Explorer)が別の文書を表示していても動くこと、同じ内容の frame 同士の
 * 入れ替えでプレビューの編集が止まらないことを、実 VS Code で確かめる。
 */

import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension";

const dirs: string[] = [];

async function waitFor(predicate: () => boolean, name: string) {
  const limit = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > limit) assert.fail(`Timed out: ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const deck = (...frames: string[]) =>
  `\\documentclass[aspectratio=169]{beamer}\n\\begin{document}\n${frames.join("\n")}\n\\end{document}\n`;

async function openWithPreview(source: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "beamer-151-"));
  dirs.push(dir);
  const file = path.join(dir, "deck.slide.tex");
  await writeFile(file, source);
  const document = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(document);
  const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
  assert.ok(extension);
  const api = (await extension.activate()) as TestApi;
  await waitFor(() => api._previewControllerForTest() !== undefined, "preview opens");
  const controller = api._previewControllerForTest();
  assert.ok(controller);
  await controller.handleMessageForTest({ type: "ready" });
  await waitFor(() => controller.latestOutcome?.version === document.version, "preview renders");
  return { api, controller, document };
}

suite("#151: preview slide reorder", () => {
  teardown(async () => {
    for (const document of vscode.workspace.textDocuments) {
      if (document.isDirty && document.uri.scheme === "file") {
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand("workbench.action.files.revert");
      }
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });
  suiteTeardown(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  test("moves a slide while the slide list shows another document, with one undo", async () => {
    const A = "\\begin{frame}[label=a]{A}\nA body\n\\end{frame}";
    const B = "\\begin{frame}[label=b]{B}\nB body\n\\end{frame}";
    const source = deck(A, B);
    const { api, controller, document } = await openWithPreview(source);
    // 別の(管理対象でない)文書をアクティブにして、スライド一覧の表示対象を外す。
    const other = await vscode.workspace.openTextDocument({
      content: "notes",
      language: "plaintext",
    });
    await vscode.window.showTextDocument(other, { preview: false });
    await waitFor(
      () =>
        !api
          ._slideItemsForTest()
          .some(
            (item) => (item as { entry?: { document?: unknown } }).entry?.document === document,
          ),
      "slide list no longer shows the deck",
    );
    const version = document.version;
    await controller.handleMessageForTest({
      type: "editSlide",
      action: "moveDown",
      frameIndex: 0,
      version,
    });
    await waitFor(() => document.version !== version, "move applies");
    assert.equal(document.getText(), deck(B, A));
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand("undo");
    await waitFor(() => document.getText() === source, "one undo restores the order");
  });

  test("offers reordering only for managed decks", async () => {
    const A = "\\begin{frame}[label=a]{A}\nA body\n\\end{frame}";
    const B = "\\begin{frame}[label=b]{B}\nB body\n\\end{frame}";
    const dir = await mkdtemp(path.join(tmpdir(), "beamer-151-"));
    dirs.push(dir);
    const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
    assert.ok(extension);
    const api = (await extension.activate()) as TestApi;
    // 既定の managed glob は **/*.slide.tex。plain.tex は「Open Preview」でだけ開ける管理対象外の文書。
    const editableIndexes = async (name: string, open: () => Thenable<unknown>) => {
      const file = path.join(dir, name);
      await writeFile(file, deck(A, B));
      const document = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(document);
      await open();
      await waitFor(
        () => api._previewControllerForTest()?.latestOutcome?.version === document.version,
        `${name} preview renders`,
      );
      const controller = api._previewControllerForTest();
      assert.ok(controller);
      // Webview へ送るメッセージを横取りして、描画時に渡す「移動できる frame」を読む。
      const webview = (
        controller as unknown as { panel: { webview: { postMessage(message: unknown): unknown } } }
      ).panel.webview;
      const sent: unknown[] = [];
      const post = webview.postMessage.bind(webview);
      webview.postMessage = (message: unknown) => {
        sent.push(message);
        return post(message);
      };
      controller.refresh();
      const updated = sent.find(
        (message): message is { type: string; editableFrameIndexes?: number[] } =>
          (message as { type?: string }).type === "deckUpdated",
      );
      assert.ok(updated, `${name}: deckUpdated was posted`);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      return updated.editableFrameIndexes;
    };
    assert.deepEqual(await editableIndexes("deck.slide.tex", async () => undefined), [0, 1]);
    assert.deepEqual(
      await editableIndexes("plain.tex", () =>
        vscode.commands.executeCommand("beamerEditor.openPreview"),
      ),
      [],
    );
  });

  test("a swap of identical slides does not block the next preview edit", async () => {
    const outline = "\\begin{frame}{Outline}\\tableofcontents\\end{frame}";
    const C = "\\begin{frame}[label=c]{C}\nC body\n\\end{frame}";
    const source = deck(outline, outline, C);
    const { controller, document } = await openWithPreview(source);
    const version = document.version;
    await controller.handleMessageForTest({
      type: "editSlide",
      action: "moveDown",
      frameIndex: 0,
      version,
    });
    assert.equal(document.getText(), source);
    assert.equal(document.version, version);
    // 入れ替えが本文を変えなかった後も、次の移動はそのまま適用される。
    await waitFor(
      () => controller.latestOutcome?.version === document.version,
      "preview is current",
    );
    await controller.handleMessageForTest({
      type: "editSlide",
      action: "moveDown",
      frameIndex: 1,
      version,
    });
    await waitFor(() => document.version !== version, "next move applies");
    assert.equal(document.getText(), deck(outline, C, outline));
  });
});
