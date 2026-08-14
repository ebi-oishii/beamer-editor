import { describe, expect, it } from "vitest";
import {
  AutoPreviewDismissals,
  appendUniqueIgnorePatterns,
  chooseLatexWorkshopTarget,
  DEFAULT_MANAGED_FILE_PATTERNS,
  effectiveArray,
  isManagedDocument,
  latexWorkshopPromptSignature,
  ManagedPreviewLifecycle,
  needsLatexWorkshopIgnorePrompt,
  normalizeLatexWorkshopIgnorePatterns,
  PreviewRegistry,
} from "../src/managed-files";

const uri = (value: string) => ({ toString: () => value });

describe("managed file helpers", () => {
  it("uses the injected VS Code glob matcher only for local documents", () => {
    const matched: string[] = [];
    const matcher = (_document: { fileName: string }, pattern: string) => {
      matched.push(pattern);
      return pattern === "slides/{a,b}.tex";
    };
    expect(
      isManagedDocument(
        { uri: { scheme: "file" }, fileName: "/work/slides/a.tex" },
        ["slides/{a,b}.tex"],
        matcher,
      ),
    ).toBe(true);
    expect(matched).toEqual(["slides/{a,b}.tex"]);
    expect(
      isManagedDocument(
        { uri: { scheme: "git" }, fileName: "/work/slides/a.tex" },
        DEFAULT_MANAGED_FILE_PATTERNS,
        matcher,
      ),
    ).toBe(false);
  });

  it("keeps automatic ownership unique, promotes manual use, and retains document ownership", () => {
    const registry = new PreviewRegistry<number, { fileName: string }>();
    const document = { fileName: "/work/talk.slide.tex" };
    const documentUri = uri("file:///work/talk.slide.tex");
    registry.add(documentUri, { controller: 1, document, automatic: true });

    expect(registry.get(documentUri)).toBeDefined();
    expect(registry.get(documentUri)).toMatchObject({ controller: 1, document, automatic: true });
    registry.promoteManual(documentUri);
    expect(registry.get(documentUri)?.automatic).toBe(false);
    const automaticUri = uri("file:///work/automatic.slide.tex");
    registry.add(automaticUri, {
      controller: 2,
      document: { fileName: "/work/automatic.slide.tex" },
      automatic: true,
    });
    // Configuration lifecycle closes only this automatic entry; promoted manual entries remain.
    expect(registry.automaticEntries()).toEqual([
      {
        controller: 2,
        document: { fileName: "/work/automatic.slide.tex" },
        automatic: true,
      },
    ]);
    registry.delete(documentUri);
    expect(registry.get(documentUri)).toBeUndefined();
  });

  it("does not restore auto-preview dismissal when a document closes before its panel disposes", () => {
    const dismissals = new AutoPreviewDismissals();
    const documentUri = uri("file:///work/talk.slide.tex");

    dismissals.dismiss(documentUri, true);
    expect(dismissals.has(documentUri)).toBe(true);

    // document close clears the suppression; a later panel dispose sees it is no longer open.
    dismissals.clear(documentUri);
    dismissals.dismiss(documentUri, false);
    expect(dismissals.has(documentUri)).toBe(false);
  });

  it("normalizes relative Workshop ignore globs and preserves absolute globs", () => {
    expect(
      normalizeLatexWorkshopIgnorePatterns([
        "slides/**/*.tex",
        "./slides/**/*.tex",
        "**/*.slide.tex",
        "/tmp/**/*.tex",
        "C:\\slides\\**\\*.tex",
      ]),
    ).toEqual(["**/slides/**/*.tex", "**/*.slide.tex", "/tmp/**/*.tex", "C:\\slides\\**\\*.tex"]);
  });

  it("preserves ignore arrays and adds normalized managed patterns idempotently", () => {
    const existing = ["**/node_modules/**", "**/*.slide.tex"];
    expect(appendUniqueIgnorePatterns(existing, ["**/*.slide.tex", "slides/**/*.tex"])).toEqual([
      "**/node_modules/**",
      "**/*.slide.tex",
      "**/slides/**/*.tex",
    ]);
    expect(
      appendUniqueIgnorePatterns(appendUniqueIgnorePatterns(existing, ["slides/**/*.tex"]), [
        "./slides/**/*.tex",
      ]),
    ).toEqual(["**/node_modules/**", "**/*.slide.tex", "**/slides/**/*.tex"]);
  });

  it("keeps existing Workshop patterns byte-for-byte while comparing their normalized meaning", () => {
    expect(appendUniqueIgnorePatterns(["build/*.tex"], ["build/*.tex"])).toEqual(["build/*.tex"]);
    expect(appendUniqueIgnorePatterns(["build/*.tex"], ["slides/**/*.tex"])).toEqual([
      "build/*.tex",
      "**/slides/**/*.tex",
    ]);
  });

  it("uses the same workspace-folder precedence as VS Code resource settings", () => {
    expect(
      effectiveArray({
        defaultValue: ["default"],
        globalValue: ["global"],
        workspaceValue: ["workspace"],
        workspaceFolderValue: ["folder"],
      }),
    ).toEqual(["folder"]);
    expect(
      effectiveArray({
        defaultValue: ["default"],
        workspaceValue: ["workspace"],
        workspaceFolderValue: ["folder"],
      }),
    ).toEqual(["folder"]);
    expect(effectiveArray(undefined)).toEqual([]);
  });

  it("writes Workshop ignores at the more specific managed or Workshop scope", () => {
    expect(
      chooseLatexWorkshopTarget({ workspaceValue: ["slides/**/*.tex"] }, { globalValue: [] }, true),
    ).toBe("workspace");
    expect(
      chooseLatexWorkshopTarget(
        { globalValue: ["**/*.slide.tex"] },
        { workspaceFolderValue: [] },
        true,
      ),
    ).toBe("workspaceFolder");
    expect(chooseLatexWorkshopTarget(undefined, undefined, false)).toBe("global");
  });

  it("prompts until both ignore arrays include every managed pattern", () => {
    const patterns = ["**/*.slide.tex", "slides/**/*.tex"];
    expect(needsLatexWorkshopIgnorePrompt(patterns, patterns, patterns)).toBe(false);
    expect(
      needsLatexWorkshopIgnorePrompt(
        ["**/slides/**/*.tex"],
        ["slides/**/*.tex"],
        ["./slides/**/*.tex"],
      ),
    ).toBe(false);
    expect(needsLatexWorkshopIgnorePrompt(patterns, [patterns[0] as string], patterns)).toBe(true);
    expect(needsLatexWorkshopIgnorePrompt([patterns[0] as string], patterns, patterns)).toBe(true);
    expect(needsLatexWorkshopIgnorePrompt([], [], patterns)).toBe(true);
    expect(needsLatexWorkshopIgnorePrompt([], [], [])).toBe(false);
  });

  it("drops blank patterns before normalizing them", () => {
    expect(normalizeLatexWorkshopIgnorePatterns(["", "  ", " ./slides/**/*.tex "])).toEqual([
      "**/slides/**/*.tex",
    ]);
  });

  it("shares persistent Workshop prompt refusal across files in a scope, but not other scopes", () => {
    const first = latexWorkshopPromptSignature("file:///work", [
      "slides/**/*.tex",
      "**/*.slide.tex",
    ]);
    const second = latexWorkshopPromptSignature("file:///work", [
      "**/*.slide.tex",
      "slides/**/*.tex",
    ]);
    const otherScope = latexWorkshopPromptSignature("file:///other", ["**/*.slide.tex"]);
    expect(second).toBe(first);
    expect(otherScope).not.toBe(first);
  });

  it("coordinates actual preview lifecycle transitions without duplicate automatic panels", () => {
    const lifecycle = new ManagedPreviewLifecycle<
      number,
      { uri: ReturnType<typeof uri>; managed: boolean }
    >();
    const documentUri = uri("file:///work/talk.slide.tex");
    const document = { uri: documentUri, managed: true };

    // openTextDocument alone does not call prepareOpen; only an active-editor event does.
    expect(lifecycle.registry.get(documentUri)).toBeUndefined();
    expect(lifecycle.prepareOpen(documentUri, true)).toEqual({ kind: "create" });
    lifecycle.register(documentUri, 1, document, true);
    expect(lifecycle.prepareOpen(documentUri, true)).toEqual({ kind: "existing", controller: 1 });
    // Manual command promotes the same panel. Its user-close suppresses later automatic reopen.
    expect(lifecycle.prepareOpen(documentUri, false)).toEqual({ kind: "existing", controller: 1 });
    expect(lifecycle.panelDisposed(documentUri, 1)).toBe(true);
    expect(lifecycle.prepareOpen(documentUri, true)).toEqual({ kind: "dismissed" });

    // Closing the source removes ownership and dismissal, then a new active session can create once.
    lifecycle.sourceClosed(documentUri);
    expect(lifecycle.prepareOpen(documentUri, true)).toEqual({ kind: "create" });
    lifecycle.register(documentUri, 2, document, true);

    const manualUri = uri("file:///work/manual.slide.tex");
    lifecycle.register(manualUri, 3, { uri: manualUri, managed: false }, false);
    document.managed = false;
    expect(lifecycle.managedFilesChanged((candidate) => candidate.managed)).toEqual([2]);
    expect(lifecycle.registry.get(documentUri)).toBeUndefined();
    expect(lifecycle.registry.get(manualUri)?.controller).toBe(3);
  });
});
