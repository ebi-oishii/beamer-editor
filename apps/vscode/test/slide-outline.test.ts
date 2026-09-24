import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { editSlide } from "@beamer-editor/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasSlideOutlineContentChanges,
  managedOutlineDocument,
  SlideOutlineRefreshScheduler,
  SlideOutlineState,
  slideOutlineEntries,
} from "../src/slide-outline";

function document(source: string, version = 1) {
  return { uri: { toString: () => "file:///deck.slide.tex" }, version, getText: () => source };
}

describe("slideOutlineEntries", () => {
  it("lists exactly the frames that slide edits target, and delete removes one listed slide", () => {
    const deck = (preamble: string, body: string) =>
      `\\documentclass{beamer}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;
    const sources = [
      deck(
        "",
        "\\begin{frame}[fragile]{A}\n\\verb|\\end{frame} \\begin{frame}|\n\\end{frame}\n\\begin{frame}{B}\n\\end{frame}",
      ),
      deck(
        "",
        "\\begin{frame}[fragile]{A}\n\\begin{Verbatim}\n\\end{frame}\n\\begin{frame}{X}\n\\end{Verbatim}\n\\end{frame}\n\\begin{frame}{B}\n\\end{frame}",
      ),
      deck(
        "",
        "% \\begin{frame}{Old}\n% \\end{frame}\n\\begin{frame}{A}\n\\end{frame}\n\\begin{frame}{B}\n\\end{frame}",
      ),
      deck(
        "\\newcommand{\\mk}{\\begin{frame}{M}\\end{frame}}",
        "\\newcommand{\\between}{%\n\\begin{frame}{Fake}\n\\end{frame}\n}\n\\begin{frame}{A}\n\\end{frame}\n\\begin{frame}{B}\n\\end{frame}",
      ),
    ];
    for (const source of sources) {
      const entries = slideOutlineEntries(document(source));
      expect(entries.map((entry) => entry.title)).toEqual(["A", "B"]);
      for (const entry of entries) {
        const result = editSlide(source, "delete", entry.start);
        if (!result.ok) throw new Error(result.reason);
        let next = source;
        for (const { span, text } of result.edits)
          next = next.slice(0, span.start) + text + next.slice(span.end);
        expect(slideOutlineEntries(document(next)).map((e) => e.title)).toEqual(
          entries.filter((e) => e !== entry).map((e) => e.title),
        );
      }
    }
  });

  it("lists explicit source frames in source order with titles, labels, and raw context", () => {
    const source = String.raw`\newcommand{\madeframe}{\begin{frame}{virtual}\end{frame}}
\begin{frame}[label=intro]{\textbf{Intro} $x$}
body
\end{frame}
\begin{frame}[unsupported,label=raw]{Raw title}
\end{frame}
\begin{frame}
\end{frame}`;
    const entries = slideOutlineEntries(document(source));

    expect(
      entries.map(({ frameNumber, title, label, raw }) => ({ frameNumber, title, label, raw })),
    ).toEqual([
      { frameNumber: 1, title: "Intro$x$", label: "intro", raw: false },
      { frameNumber: 2, title: "Raw title", label: "raw", raw: true },
      { frameNumber: 3, title: "frame 3", label: null, raw: false },
    ]);
    expect(source.slice(entries[0]?.start).startsWith("\\begin{frame}")).toBe(true);
  });

  it("omits macro-generated virtual frames while preserving preview frame numbers", () => {
    const source = String.raw`\documentclass{beamer}
%% macros:begin
\newcommand{\virtual}{\begin{frame}{Second}\end{frame}}
%% macros:end
\begin{document}
\begin{frame}{First}\end{frame}
\virtual
\begin{frame}{Third$x$}\end{frame}
\end{document}`;
    const entries = slideOutlineEntries(document(source));

    expect(entries.map(({ frameNumber, title }) => [frameNumber, title])).toEqual([
      [1, "First"],
      [3, "Third$x$"],
    ]);
  });

  it("uses UTF-16 source offsets without transforming the input", () => {
    const source = "😀\n\\begin{frame}{日本語}\n\\end{frame}";
    const [entry] = slideOutlineEntries(document(source));
    expect(entry?.start).toBe(source.indexOf("\\begin{frame}"));
  });
});

describe("SlideOutlineState", () => {
  it("refreshes only its active document and rejects stale entries", () => {
    const first = document("\\begin{frame}{one}\\end{frame}", 1);
    const other = document("\\begin{frame}{other}\\end{frame}", 1);
    const state = new SlideOutlineState<typeof first>();
    expect(state.setDocument(first)).toBe(true);
    const entry = state.getEntries()[0];
    if (!entry) throw new Error("expected a frame entry");
    expect(state.isCurrent(entry)).toBe(true);
    expect(state.refresh(other)).toBe(false);
    expect(state.setDocument({ ...first, version: 2 })).toBe(true);
    expect(state.isCurrent(entry)).toBe(false);
    expect(state.setDocument(undefined)).toBe(true);
    expect(state.getEntries()).toEqual([]);
  });

  it("refreshes when the same document object has a newer version and reads its text once", () => {
    let source = "\\begin{frame}{one}\\end{frame}";
    const current = {
      uri: { toString: () => "file:///deck.slide.tex" },
      version: 1,
      getText: vi.fn(() => source),
    };
    const state = new SlideOutlineState<typeof current>();
    state.setDocument(current);
    current.getText.mockClear();
    source = "\\begin{frame}{two}\\end{frame}";
    current.version = 2;

    expect(state.refresh(current)).toBe(true);
    expect(state.getEntries()[0]?.title).toBe("two");
    expect(current.getText).toHaveBeenCalledTimes(1);
  });
});

describe("SlideOutlineRefreshScheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("ignores empty changes at the caller and renders only the latest debounced version", () => {
    vi.useFakeTimers();
    let source = "\\begin{frame}{one}\\end{frame}";
    const current = {
      uri: { toString: () => "file:///deck.slide.tex" },
      version: 1,
      getText: () => source,
    };
    const state = new SlideOutlineState<typeof current>();
    const changed = vi.fn();
    state.setDocument(current);
    const scheduler = new SlideOutlineRefreshScheduler(state, changed);

    expect(hasSlideOutlineContentChanges([])).toBe(false);
    expect(hasSlideOutlineContentChanges([{}])).toBe(true);

    current.version = 2;
    scheduler.schedule(current);
    source = "\\begin{frame}{latest}\\end{frame}";
    current.version = 3;
    scheduler.schedule(current);
    vi.advanceTimersByTime(119);
    expect(changed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(changed).toHaveBeenCalledTimes(1);
    expect(state.getEntries()[0]?.title).toBe("latest");
    scheduler.dispose();
  });
});

describe("slide outline manifest", () => {
  it("contributes the native Explorer view and reveal command", () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as {
      activationEvents: string[];
      contributes: {
        commands: { command: string }[];
        views: { explorer: { id: string }[] };
        viewsWelcome: { view: string; when: string }[];
      };
    };
    expect(manifest.activationEvents).not.toContain("onView:beamerEditor.slides");
    expect(manifest.contributes.views.explorer).toContainEqual({
      id: "beamerEditor.slides",
      name: "Beamer Slides",
    });
    expect(
      manifest.contributes.commands.some(
        (command) => command.command === "beamerEditor.revealSlide",
      ),
    ).toBe(false);
    expect(manifest.contributes.viewsWelcome).toContainEqual({
      view: "beamerEditor.slides",
      when: "!beamerEditor.hasSlideOutlineDocument",
      contents: "Open a managed Beamer slide to show its frames.",
    });
  });
});

describe("managedOutlineDocument", () => {
  it("retains the outlined preview source when settings change while its webview has focus", () => {
    const previewSource = document("\\begin{frame}{kept}\\end{frame}");
    expect(managedOutlineDocument(undefined, previewSource, () => true)).toBe(previewSource);
  });

  it("clears the outlined preview source when it is no longer managed", () => {
    const previewSource = document("\\begin{frame}{cleared}\\end{frame}");
    expect(managedOutlineDocument(undefined, previewSource, () => false)).toBeUndefined();
  });
});
