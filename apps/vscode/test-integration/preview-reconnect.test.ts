import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension";

const dirs: string[] = [];
const source = (title: string) =>
  `\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}{${title}}\n${title}\n\\end{frame}\n\\end{document}\n`;

async function waitFor(predicate: () => boolean, name: string) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`Timed out: ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function sourceTabs(uri: vscode.Uri) {
  return vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.filter(
      (tab) =>
        tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString(),
    ),
  );
}

suite("#155: preview reconnect", () => {
  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });
  suiteTeardown(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  test("retains the preview panel, becomes readonly, and rerenders a reopened source without edits", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "beamer-155-"));
    dirs.push(dir);
    const file = path.join(dir, "deck.slide.tex");
    await writeFile(file, source("Before"));
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document, { preview: false });
    const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
    assert.ok(extension);
    const api = (await extension.activate()) as TestApi;
    await waitFor(
      () => api._previewControllerForTest()?.latestOutcome !== undefined,
      "preview opens",
    );
    const controller = api._previewControllerForTest();
    assert.ok(controller);
    await controller.handleMessageForTest({ type: "ready" });
    const panel = (controller as unknown as { panel: { viewColumn?: vscode.ViewColumn } }).panel;
    const previewTab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs.map((tab) => ({ group, tab })))
      .find(({ tab }) => tab.label.startsWith("Beamer Preview:"));
    assert.ok(previewTab);

    await vscode.window.tabGroups.close(sourceTabs(document.uri));
    await waitFor(() => sourceTabs(document.uri).length === 0, "last source tab closes");
    await waitFor(() => !controller.isAttached, "preview detaches");
    assert.equal(api._previewControllerForTest(), controller, "controller is retained");
    assert.ok(previewTab.group.tabs.includes(previewTab.tab), "preview tab remains in its group");
    const staleVersion = controller.latestOutcome?.version;
    await controller.handleMessageForTest({
      type: "moveCanvasElement",
      frameIndex: 0,
      elementId: "canvas-image-0",
      version: staleVersion ?? 0,
      x: 1,
      y: 1,
      generation: controller.generation,
    });
    assert.equal(controller.isAttached, false, "detached edit is rejected");

    await writeFile(file, source("After"));
    const reopened = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(reopened, { preview: false });
    await waitFor(() => controller.isAttached, "reopened source attaches");
    await waitFor(
      () => controller.latestOutcome?.deck.frames[0]?.titleText === "After",
      "reopened source rerenders",
    );
    assert.match(controller.latestOutcome?.deck.frames[0]?.titleText ?? "", /After/);
    assert.equal(api._previewControllerForTest(), controller, "same panel controller is reused");
    assert.equal(
      (controller as unknown as { panel: unknown }).panel,
      panel,
      "same panel object is retained",
    );
  });

  test("closing one of two source tabs does not disconnect the preview", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "beamer-155-"));
    dirs.push(dir);
    const file = path.join(dir, "two.slide.tex");
    await writeFile(file, source("Two"));
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.commands.executeCommand("workbench.action.splitEditorRight");
    await vscode.window.showTextDocument(document, vscode.ViewColumn.Two, false);
    const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
    assert.ok(extension);
    const api = (await extension.activate()) as TestApi;
    await waitFor(
      () => api._previewControllerForTest()?.latestOutcome !== undefined,
      "preview opens",
    );
    const controller = api._previewControllerForTest();
    assert.ok(controller);
    const generation = controller.generation;
    const tabs = sourceTabs(document.uri);
    assert.ok(tabs.length >= 2, "two source tabs exist");
    const [firstTab] = tabs;
    assert.ok(firstTab);
    await vscode.window.tabGroups.close(firstTab);
    await waitFor(() => sourceTabs(document.uri).length >= 1, "one source tab remains");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(api._previewControllerForTest(), controller);
    assert.equal(controller.isAttached, true, "remaining source tab keeps preview connected");
    assert.equal(controller.generation, generation, "remaining tab does not reconnect preview");
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function previewGroups() {
  return vscode.window.tabGroups.all.filter((group) =>
    group.tabs.some((tab) => tab.label.startsWith("Beamer Preview:")),
  );
}

function sourceGroups(uri: vscode.Uri) {
  return vscode.window.tabGroups.all.filter((group) =>
    group.tabs.some(
      (tab) =>
        tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString(),
    ),
  );
}

/** source が左・プレビューが右の別グループにあり、空のグループが残っていない。 */
function sourceLeftOfPreview(uri: vscode.Uri): boolean {
  const sources = sourceGroups(uri);
  const previews = previewGroups();
  const [source] = sources;
  const [preview] = previews;
  return (
    sources.length === 1 &&
    previews.length === 1 &&
    source !== undefined &&
    preview !== undefined &&
    source !== preview &&
    source.viewColumn < preview.viewColumn &&
    vscode.window.tabGroups.all.every((group) => group.tabs.length > 0)
  );
}

async function openDeck(name: string): Promise<{ uri: vscode.Uri; api: TestApi; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "beamer-155-layout-"));
  dirs.push(dir);
  const file = path.join(dir, `${name}.slide.tex`);
  await writeFile(file, source("Before"));
  const uri = vscode.Uri.file(file);
  const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
  assert.ok(extension);
  const api = (await extension.activate()) as TestApi;
  await vscode.commands.executeCommand("vscode.open", uri);
  return { uri, api, dir };
}

suite("#155: preview layout after reopening the source", () => {
  setup(async () => {
    // ロック済みの空グループは closeAllEditors では消えないので、全グループを閉じてから始める。
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
  });
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    await vscode.workspace
      .getConfiguration("beamerEditor")
      .update("preview.lockGroup", undefined, vscode.ConfigurationTarget.Global);
  });

  for (const lockGroup of [true, false]) {
    test(`restores source-left / preview-right after the source group collapsed (lockGroup=${lockGroup})`, async () => {
      await vscode.workspace
        .getConfiguration("beamerEditor")
        .update(
          "preview.lockGroup",
          lockGroup ? undefined : false,
          vscode.ConfigurationTarget.Global,
        );
      const { uri, api, dir } = await openDeck(`layout-${lockGroup}`);
      await waitFor(
        () =>
          api._previewControllerForTest()?.latestOutcome !== undefined && sourceLeftOfPreview(uri),
        "preview opens beside the source",
      );
      const controller = api._previewControllerForTest();
      assert.ok(controller);

      // 既定の closeEmptyGroups で source のグループが消え、プレビューのグループだけが残る。
      await vscode.window.tabGroups.close(sourceTabs(uri));
      await waitFor(() => !controller.isAttached, "preview detaches");
      await waitFor(
        () =>
          vscode.window.tabGroups.all.length === 1 &&
          controller.viewColumn === vscode.window.tabGroups.all[0]?.viewColumn,
        "source group collapses",
      );
      // 残ったプレビューがアクティブになり、#94 のロックが掛かるのを待つ。
      await sleep(500);

      await vscode.commands.executeCommand("vscode.open", uri);
      await waitFor(() => controller.isAttached, "reopened source attaches");
      await waitFor(() => sourceLeftOfPreview(uri), "source-left / preview-right is restored");
      assert.equal(api._previewControllerForTest(), controller, "same controller is reused");

      // プレビューにフォーカスすると、スライド一覧は開き直した文書を指す(凍結した旧文書ではない)。
      const reopened = vscode.workspace.textDocuments.find(
        (document) => document.uri.toString() === uri.toString(),
      );
      assert.ok(reopened);
      controller.reveal(false);
      const previewColumn = previewGroups()[0]?.viewColumn;
      await waitFor(
        () => vscode.window.tabGroups.activeTabGroup.viewColumn === previewColumn,
        "preview is focused",
      );
      await waitFor(
        () =>
          (api._slideItemsForTest()[0] as { entry: { document: unknown } } | undefined)?.entry
            .document === reopened,
        "slide outline follows the reopened document",
      );

      if (lockGroup) {
        // 移した先のグループもロックし直す(#94)。別ファイルはプレビューのグループへ開かない。
        await sleep(1_000);
        const otherFile = path.join(dir, "other.tex");
        await writeFile(otherFile, source("Other"));
        const other = await vscode.workspace.openTextDocument(otherFile);
        const editor = await vscode.window.showTextDocument(other);
        assert.notEqual(editor.viewColumn, previewColumn, "moved preview group is locked again");
      }
    });
  }

  test("auto-opens the preview again after a dismissed preview's source is closed and reopened", async () => {
    const { uri, api } = await openDeck("dismissal");
    await waitFor(
      () => api._previewControllerForTest()?.latestOutcome !== undefined,
      "preview auto-opens",
    );
    const first = api._previewControllerForTest();
    assert.ok(first);
    const previewTab = previewGroups()
      .flatMap((group) => group.tabs)
      .find((tab) => tab.label.startsWith("Beamer Preview:"));
    assert.ok(previewTab);
    await vscode.window.tabGroups.close(previewTab);
    await waitFor(() => api._previewControllerForTest() === undefined, "preview is dismissed");

    await vscode.window.tabGroups.close(sourceTabs(uri));
    await waitFor(() => sourceTabs(uri).length === 0, "source tab closes");
    await sleep(200);

    await vscode.commands.executeCommand("vscode.open", uri);
    await waitFor(() => {
      const controller = api._previewControllerForTest();
      return controller !== undefined && controller !== first;
    }, "preview auto-opens again");
  });
});
