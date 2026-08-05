import { describe, expect, it } from "vitest";
import {
  AutoPreviewDismissals,
  appendUniqueIgnorePatterns,
  DEFAULT_MANAGED_FILE_PATTERNS,
  globalOrDefaultArray,
  isManagedDocument,
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

    expect(registry.has(documentUri)).toBe(true);
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
    expect(registry.has(documentUri)).toBe(false);
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

  it("uses global then default ignore values and never workspace values", () => {
    expect(
      globalOrDefaultArray({
        defaultValue: ["default"],
        globalValue: ["global"],
        workspaceValue: ["workspace"],
        workspaceFolderValue: ["folder"],
      }),
    ).toEqual(["global"]);
    expect(
      globalOrDefaultArray({
        defaultValue: ["default"],
        workspaceValue: ["workspace"],
        workspaceFolderValue: ["folder"],
      }),
    ).toEqual(["default"]);
    expect(globalOrDefaultArray(undefined)).toEqual([]);
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
});
