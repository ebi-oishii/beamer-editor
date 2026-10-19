import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
        (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()) ||
        (tab.input instanceof vscode.TabInputTextDiff &&
          tab.input.modified.toString() === uri.toString()),
    ),
  );
}

suite("#155: preview reconnect", () => {
  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllGroups");
    await waitFor(() => previewGroups().length === 0, "preview groups close");
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

  test("rename recreates an attached preview at the destination and deletion closes it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "beamer-198-rename-"));
    dirs.push(dir);
    const oldUri = vscode.Uri.file(path.join(dir, "old.slide.tex"));
    const newUri = vscode.Uri.file(path.join(dir, "renamed.slide.tex"));
    await vscode.workspace.fs.writeFile(oldUri, Buffer.from(source("Rename")));
    await vscode.commands.executeCommand("vscode.open", oldUri);
    const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
    assert.ok(extension);
    const api = (await extension.activate()) as TestApi;
    await waitFor(
      () => api._previewControllerForTest()?.latestOutcome !== undefined,
      "preview opens",
    );
    const oldController = api._previewControllerForTest();
    assert.ok(oldController);
    const rename = new vscode.WorkspaceEdit();
    rename.renameFile(oldUri, newUri);
    assert.equal(await vscode.workspace.applyEdit(rename), true);
    await waitFor(
      () =>
        api._previewControllerForTest() !== undefined &&
        api._previewControllerForTest() !== oldController,
      "URI-bound controller recreates",
    );
    const renamed = api._previewControllerForTest();
    assert.ok(renamed?.isAttached, "renamed source stays editable");
    await waitFor(() => {
      const tabs = previewGroups()
        .flatMap((group) => group.tabs)
        .filter((tab) => tab.label.startsWith("Beamer Preview:"));
      return tabs.length === 1 && tabs[0]?.label === "Beamer Preview: renamed.slide.tex";
    }, "only one destination preview remains");
    assert.equal(
      previewGroups()
        .flatMap((group) => group.tabs)
        .some((tab) => tab.label === "Beamer Preview: old.slide.tex"),
      false,
    );
    const deletion = new vscode.WorkspaceEdit();
    deletion.deleteFile(newUri);
    assert.equal(await vscode.workspace.applyEdit(deletion), true);
    await waitFor(
      () => api._previewControllerForTest() === undefined,
      "deleting source closes preview",
    );
  });

  test("rename keeps a detached preview readonly at its destination", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "beamer-198-detached-rename-"));
    dirs.push(dir);
    const oldUri = vscode.Uri.file(path.join(dir, "old.slide.tex"));
    const newUri = vscode.Uri.file(path.join(dir, "renamed.slide.tex"));
    await vscode.workspace.fs.writeFile(oldUri, Buffer.from(source("Rename")));
    await vscode.commands.executeCommand("vscode.open", oldUri);
    const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
    assert.ok(extension);
    const api = (await extension.activate()) as TestApi;
    await waitFor(
      () => api._previewControllerForTest()?.latestOutcome !== undefined,
      "preview opens",
    );
    await vscode.window.tabGroups.close(sourceTabs(oldUri));
    const oldController = api._previewControllerForTest();
    assert.ok(oldController);
    await waitFor(() => !oldController.isAttached, "preview detaches");
    const rename = new vscode.WorkspaceEdit();
    rename.renameFile(oldUri, newUri);
    assert.equal(await vscode.workspace.applyEdit(rename), true);
    await waitFor(() => api._previewControllerForTest() !== oldController, "preview follows URI");
    assert.equal(
      api._previewControllerForTest()?.isAttached,
      false,
      "rename does not show a detached source",
    );
    const deletion = new vscode.WorkspaceEdit();
    deletion.deleteFile(newUri);
    assert.equal(await vscode.workspace.applyEdit(deletion), true);
    await waitFor(
      () => api._previewControllerForTest() === undefined,
      "deleting detached source closes preview",
    );
  });

  test("folder rename follows a detached descendant preview", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "beamer-198-folder-"));
    dirs.push(dir);
    const oldFolder = vscode.Uri.file(path.join(dir, "old"));
    const newFolder = vscode.Uri.file(path.join(dir, "new"));
    await mkdir(oldFolder.fsPath);
    const oldUri = vscode.Uri.joinPath(oldFolder, "deck.slide.tex");
    const newUri = vscode.Uri.joinPath(newFolder, "deck.slide.tex");
    await writeFile(oldUri.fsPath, source("Folder"));
    const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
    assert.ok(extension);
    const api = (await extension.activate()) as TestApi;
    await vscode.commands.executeCommand("vscode.open", oldUri);
    await waitFor(
      () => api._previewControllerForTest()?.latestOutcome !== undefined,
      "preview opens",
    );
    const previous = api._previewControllerForTest();
    assert.ok(previous);
    await vscode.window.tabGroups.close(sourceTabs(oldUri));
    await waitFor(() => !previous.isAttached, "preview detaches");
    const rename = new vscode.WorkspaceEdit();
    rename.renameFile(oldFolder, newFolder);
    assert.equal(await vscode.workspace.applyEdit(rename), true);
    await waitFor(
      () => api._previewControllerForTest() !== previous,
      "folder descendant follows rename",
    );
    const replacement = api._previewControllerForTest();
    assert.ok(replacement);
    assert.equal(replacement.isAttached, false);
    await vscode.commands.executeCommand("vscode.open", newUri);
    await waitFor(() => replacement.isAttached, "renamed descendant reconnects");
  });

  test("failed rename leaves the existing preview intact", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "beamer-198-failed-"));
    dirs.push(dir);
    const oldUri = vscode.Uri.file(path.join(dir, "old.slide.tex"));
    const occupiedUri = vscode.Uri.file(path.join(dir, "occupied.slide.tex"));
    await writeFile(oldUri.fsPath, source("Original"));
    await writeFile(occupiedUri.fsPath, source("Occupied"));
    const extension = vscode.extensions.getExtension("ebi-oishii.beamer-editor");
    assert.ok(extension);
    const api = (await extension.activate()) as TestApi;
    await vscode.commands.executeCommand("vscode.open", oldUri);
    await waitFor(
      () => api._previewControllerForTest()?.latestOutcome !== undefined,
      "preview opens",
    );
    const previous = api._previewControllerForTest();
    const rename = new vscode.WorkspaceEdit();
    rename.renameFile(oldUri, occupiedUri, { overwrite: false });
    assert.equal(await vscode.workspace.applyEdit(rename), false);
    await sleep(200);
    assert.equal(api._previewControllerForTest(), previous);
    assert.equal(previous?.isAttached, true);
  });

  test("recreating a deleted source reopens its automatic preview", async () => {
    const { uri, api } = await openDeck("recreated");
    await waitFor(
      () => api._previewControllerForTest()?.latestOutcome !== undefined,
      "preview opens",
    );
    const oldDocument = await vscode.workspace.openTextDocument(uri);
    const deletion = new vscode.WorkspaceEdit();
    deletion.deleteFile(uri);
    assert.equal(await vscode.workspace.applyEdit(deletion), true);
    await waitFor(() => api._previewControllerForTest() === undefined, "deleted preview closes");
    const creation = new vscode.WorkspaceEdit();
    creation.createFile(uri);
    assert.equal(await vscode.workspace.applyEdit(creation), true);
    await vscode.window.showTextDocument(oldDocument, { preview: false });
    await waitFor(
      () => api._previewControllerForTest() !== undefined,
      "recreated source auto-opens preview",
    );
  });

  test("consecutive renames and deletion follow the final source URI", async () => {
    const { uri, api, dir } = await openDeck("rapid-old");
    await waitFor(
      () => api._previewControllerForTest()?.latestOutcome !== undefined,
      "preview opens",
    );
    const middle = vscode.Uri.file(path.join(dir, "rapid-middle.slide.tex"));
    const last = vscode.Uri.file(path.join(dir, "rapid-last.slide.tex"));
    const first = new vscode.WorkspaceEdit();
    first.renameFile(uri, middle);
    const second = new vscode.WorkspaceEdit();
    second.renameFile(middle, last);
    assert.equal(await vscode.workspace.applyEdit(first), true);
    assert.equal(await vscode.workspace.applyEdit(second), true);
    await waitFor(
      () =>
        previewGroups()
          .flatMap((group) => group.tabs)
          .some((tab) => tab.label === "Beamer Preview: rapid-last.slide.tex"),
      "preview follows both renames",
    );
    const deletion = new vscode.WorkspaceEdit();
    deletion.deleteFile(last);
    assert.equal(await vscode.workspace.applyEdit(deletion), true);
    await waitFor(() => previewGroups().length === 0, "preview closes after final source deletion");
  });

  for (const nextOperation of ["rename", "delete", "close"] as const) {
    test(`pending rename handles a later ${nextOperation}`, async () => {
      const { uri, api, dir } = await openDeck(`pending-${nextOperation}`);
      await waitFor(
        () => api._previewControllerForTest()?.latestOutcome !== undefined,
        "preview opens",
      );
      const controller = api._previewControllerForTest();
      assert.ok(controller);
      await vscode.window.tabGroups.close(sourceTabs(uri));
      await waitFor(() => !controller.isAttached, "preview detaches");
      const middle = vscode.Uri.file(path.join(dir, `middle-${nextOperation}.slide.tex`));
      const final = vscode.Uri.file(path.join(dir, `final-${nextOperation}.slide.tex`));
      let started = false;
      let release = () => {};
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      api._setRenameOpenBarrierForTest(async () => {
        started = true;
        await blocked;
      });
      try {
        const first = new vscode.WorkspaceEdit();
        first.renameFile(uri, middle);
        assert.equal(await vscode.workspace.applyEdit(first), true);
        await waitFor(() => started, "first rename waits for destination open");
        if (nextOperation === "close") {
          const tabs = previewGroups().flatMap((group) => group.tabs);
          await vscode.window.tabGroups.close(tabs);
        } else {
          const next = new vscode.WorkspaceEdit();
          if (nextOperation === "rename") next.renameFile(middle, final);
          else next.deleteFile(middle);
          assert.equal(await vscode.workspace.applyEdit(next), true);
          if (nextOperation === "delete")
            await waitFor(
              () => previewGroups().length === 0,
              "deleting pending destination closes preview",
            );
        }
        release();
        if (nextOperation === "rename") {
          await waitFor(
            () =>
              previewGroups()
                .flatMap((group) => group.tabs)
                .some((tab) => tab.label === `Beamer Preview: final-${nextOperation}.slide.tex`),
            "preview follows final destination",
          );
        } else {
          await sleep(500);
          assert.equal(
            previewGroups().length,
            0,
            "cancelled pending rename cannot resurrect preview",
          );
        }
      } finally {
        release();
        api._setRenameOpenBarrierForTest();
      }
    });
  }
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
    await vscode.commands.executeCommand("vscode.setEditorLayout", { groups: [{}] });
    await vscode.commands.executeCommand("workbench.action.unlockEditorGroup");
    await waitFor(() => previewGroups().length === 0, "previous preview groups close");
    await waitFor(
      () =>
        vscode.window.tabGroups.all.length === 1 &&
        vscode.window.tabGroups.all[0]?.tabs.length === 0,
      "editor starts in one empty group",
    );
    await vscode.workspace
      .getConfiguration("beamerEditor")
      .update("preview.lockGroup", undefined, vscode.ConfigurationTarget.Global);
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
      await waitFor(
        () =>
          previewGroups()[0]?.tabs.some(
            (tab) => tab.label.startsWith("Beamer Preview:") && !tab.isPreview,
          ) ?? false,
        "restored preview becomes a kept tab",
      );
      const restoredPreview = previewGroups()[0]?.tabs.find((tab) =>
        tab.label.startsWith("Beamer Preview:"),
      );
      assert.ok(restoredPreview);
      const reopened = await vscode.workspace.openTextDocument(uri);
      const sourceColumn = sourceGroups(uri)[0]?.viewColumn;
      assert.ok(sourceColumn);
      await vscode.window.showTextDocument(reopened, {
        viewColumn: sourceColumn,
        preview: false,
      });
      const replacementFile = path.join(dir, "replacement.tex");
      await writeFile(replacementFile, source("Replacement"));
      const replacement = await vscode.workspace.openTextDocument(replacementFile);
      const replacementColumn = previewGroups()[0]?.viewColumn;
      assert.ok(replacementColumn);
      await vscode.window.showTextDocument(replacement, { viewColumn: replacementColumn });
      assert.ok(
        previewGroups()[0]?.tabs.includes(restoredPreview),
        "opening another file does not replace it",
      );

      // プレビューにフォーカスすると、スライド一覧は開き直した文書を指す(凍結した旧文書ではない)。
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

  test("detached preview jump opens its source beside the preview instead of in the locked group", async () => {
    const { uri, api, dir } = await openDeck("detached-jump");
    await waitFor(
      () => api._previewControllerForTest()?.latestOutcome !== undefined,
      "preview opens",
    );
    const controller = api._previewControllerForTest();
    assert.ok(controller);
    await vscode.window.tabGroups.close(sourceTabs(uri));
    await waitFor(() => !controller.isAttached, "preview detaches");
    await controller.handleMessageForTest({
      type: "jumpToSource",
      frameIndex: 0,
      version: controller.latestOutcome?.version ?? 0,
      generation: controller.generation,
    });
    await waitFor(() => controller.isAttached, "jump reconnects source");
    await waitFor(
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      "jump focuses source",
    );
    const sourceEditor = vscode.window.activeTextEditor;
    assert.ok(sourceEditor);
    assert.equal(sourceEditor.document.uri.toString(), uri.toString());
    await waitFor(
      () =>
        sourceLeftOfPreview(uri) &&
        vscode.window.activeTextEditor?.document.uri.toString() === uri.toString() &&
        (previewGroups()[0]?.tabs.some(
          (tab) => tab.label.startsWith("Beamer Preview:") && !tab.isPreview,
        ) ??
          false),
      "jump restores layout and focus after keeping preview",
    );
    const sourceColumn = vscode.window.activeTextEditor?.viewColumn;
    const sourceOtherFile = path.join(dir, "source-after-jump.tex");
    await writeFile(sourceOtherFile, source("Source other"));
    const sourceOther = await vscode.workspace.openTextDocument(sourceOtherFile);
    const sourceOtherEditor = await vscode.window.showTextDocument(sourceOther);
    assert.equal(sourceOtherEditor.viewColumn, sourceColumn, "source group stays unlocked");
    controller.reveal(false);
    await sleep(500);
    const currentPreviewColumn = previewGroups()[0]?.viewColumn;
    const otherFile = path.join(dir, "after-jump.tex");
    await writeFile(otherFile, source("After jump"));
    const other = await vscode.workspace.openTextDocument(otherFile);
    const otherEditor = await vscode.window.showTextDocument(other);
    assert.notEqual(
      otherEditor.viewColumn,
      currentPreviewColumn,
      "preview group is locked after jump",
    );
  });

  test("a source visible only as the modified side of a diff keeps its preview editable", async () => {
    const { uri, api } = await openDeck("diff-only");
    await waitFor(
      () => api._previewControllerForTest()?.latestOutcome !== undefined,
      "preview opens",
    );
    const controller = api._previewControllerForTest();
    assert.ok(controller);
    await vscode.window.tabGroups.close(sourceTabs(uri));
    await waitFor(() => !controller.isAttached, "ordinary source tab closes");
    await vscode.commands.executeCommand("vscode.diff", uri, uri, "modified source");
    await waitFor(() => sourceTabs(uri).length > 0, "modified diff source tab opens");
    await waitFor(() => controller.isAttached, "diff modified side reconnects preview");
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(2, 0, 2, 0), "% edited\n");
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await waitFor(
      () =>
        controller.latestOutcome?.version ===
        vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString())
          ?.version,
      "diff edit rerenders preview",
    );
  });
});
