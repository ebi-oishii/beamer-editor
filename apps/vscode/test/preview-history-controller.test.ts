import { describe, expect, it, vi } from "vitest";
import {
  PreviewHistoryController,
  type PreviewHistoryHost,
} from "../src/preview-history-controller";

type Panel = { id: string; alive: boolean };
type Uri = { value: string };
type Document = { uri: Uri };

function hostFor(active: { panel: Panel; sourceUri: Uri } | undefined) {
  const host: PreviewHistoryHost<Panel, Uri, Document> = {
    activePreview: vi.fn(() => active),
    openTextDocument: vi.fn(async (uri) => ({ uri })),
    showTextDocument: vi.fn(async () => undefined),
    executeStandardCommand: vi.fn(async () => undefined),
    isPreviewAlive: vi.fn((panel) => panel.alive),
    revealPreview: vi.fn(),
  };
  return host;
}

describe("PreviewHistoryController", () => {
  it("is a no-op when no preview is active", async () => {
    const host = hostFor(undefined);
    await new PreviewHistoryController(host).undo();
    expect(host.openTextDocument).not.toHaveBeenCalled();
    expect(host.executeStandardCommand).not.toHaveBeenCalled();
  });

  it("uses the panel source captured at invocation, then restores that panel focus", async () => {
    const panel = { id: "first", alive: true };
    const uri = { value: "file:///first.slide.tex" };
    const host = hostFor({ panel, sourceUri: uri });
    await new PreviewHistoryController(host).undo();
    expect(host.openTextDocument).toHaveBeenCalledWith(uri);
    expect(host.showTextDocument).toHaveBeenCalledWith({ uri });
    expect(host.executeStandardCommand).toHaveBeenCalledWith("undo");
    expect(host.revealPreview).toHaveBeenCalledWith(panel, false);
  });

  it("serializes repeated operations and retains each invocation's distinct preview source", async () => {
    const first = { id: "first", alive: true };
    const second = { id: "second", alive: true };
    const firstUri = { value: "file:///first.slide.tex" };
    const secondUri = { value: "file:///second.slide.tex" };
    let active = { panel: first, sourceUri: firstUri };
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const firstStartedPromise = new Promise<void>((resolve) => (firstStarted = resolve));
    let commandCount = 0;
    const host = hostFor(active);
    host.activePreview = vi.fn(() => active);
    host.executeStandardCommand = vi.fn(() => {
      commandCount += 1;
      if (commandCount !== 1) return Promise.resolve();
      firstStarted?.();
      return new Promise<void>((resolve) => (releaseFirst = resolve));
    });
    const controller = new PreviewHistoryController(host);
    const undo = controller.undo();
    active = { panel: second, sourceUri: secondUri };
    const redo = controller.redo();
    await firstStartedPromise;
    expect(host.openTextDocument).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await Promise.all([undo, redo]);
    expect(host.openTextDocument).toHaveBeenNthCalledWith(1, firstUri);
    expect(host.openTextDocument).toHaveBeenNthCalledWith(2, secondUri);
    expect(host.executeStandardCommand).toHaveBeenNthCalledWith(2, "redo");
  });

  it("does not reveal a panel that closed while the source operation was running", async () => {
    const panel = { id: "closed", alive: true };
    const host = hostFor({ panel, sourceUri: { value: "file:///closed.slide.tex" } });
    host.executeStandardCommand = vi.fn(async () => {
      panel.alive = false;
    });
    await new PreviewHistoryController(host).redo();
    expect(host.revealPreview).not.toHaveBeenCalled();
  });
});
