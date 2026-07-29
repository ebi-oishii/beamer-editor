import type { LintDiagnostic } from "@beamer-editor/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LINT_DEBOUNCE_MS,
  type LintableDocument,
  LintController,
  type LintEvents,
  lintDocumentText,
} from "../src/diagnostics";

function deckSource(body: string, versionComment = "%% deck-source-version: 1\n"): string {
  return `${versionComment}\\documentclass[aspectratio=169]{beamer}
\\begin{document}
${body}
\\end{document}`;
}

const DUPLICATE_LABELS = deckSource(`
\\begin{frame}[label=dup]{One}
first
\\end{frame}
\\begin{frame}[label=dup]{Two}
second
\\end{frame}`);

const CLEAN = deckSource("\\begin{frame}{One}\nfirst\n\\end{frame}");

/** 内容を書き換えられるフェイク文書。 */
function makeDoc(fileName = "/work/deck.tex", scheme = "file") {
  return {
    uri: { toString: () => `${scheme}://${fileName}`, scheme },
    fileName,
    text: CLEAN,
    getText() {
      return this.text;
    },
  };
}
type FakeDoc = ReturnType<typeof makeDoc>;

/** set / delete を uri 単位で記録するフェイク sink。 */
function makeSink() {
  const byUri = new Map<string, LintDiagnostic[]>();
  const deleted: string[] = [];
  return {
    sink: {
      set: (document: LintableDocument, diagnostics: LintDiagnostic[]) => {
        byUri.set(document.uri.toString(), diagnostics);
      },
      delete: (document: LintableDocument) => {
        deleted.push(document.uri.toString());
        byUri.delete(document.uri.toString());
      },
    },
    byUri,
    deleted,
  };
}

/** open / change / close を発火できるフェイク events。 */
function makeEvents() {
  let onOpen: ((doc: FakeDoc) => void) | undefined;
  let onChange:
    | ((event: { document: FakeDoc; contentChanges: readonly unknown[] }) => void)
    | undefined;
  let onClose: ((doc: FakeDoc) => void) | undefined;
  const disposables = [{ dispose: vi.fn() }, { dispose: vi.fn() }, { dispose: vi.fn() }];
  const events: LintEvents<FakeDoc> = {
    onDidOpenTextDocument(l) {
      onOpen = l;
      return disposables[0] as { dispose(): void };
    },
    onDidChangeTextDocument(l) {
      onChange = l;
      return disposables[1] as { dispose(): void };
    },
    onDidCloseTextDocument(l) {
      onClose = l;
      return disposables[2] as { dispose(): void };
    },
  };
  return {
    events,
    open: (doc: FakeDoc) => onOpen?.(doc),
    change: (doc: FakeDoc, contentChanges: readonly unknown[] = [{}]) =>
      onChange?.({ document: doc, contentChanges }),
    close: (doc: FakeDoc) => onClose?.(doc),
    disposables,
  };
}

describe("lintDocumentText", () => {
  it("元ソース座標の span 付きで診断を返す", () => {
    const diagnostics = lintDocumentText(DUPLICATE_LABELS);

    const l009 = diagnostics.filter((d) => d.code === "L009");
    expect(l009).toHaveLength(2);
    for (const d of l009) {
      expect(DUPLICATE_LABELS.slice(d.span.start, d.span.end)).toContain("label=dup");
    }
  });

  it("違反のないデッキでは空", () => {
    expect(lintDocumentText(CLEAN)).toEqual([]);
  });
});

describe("LintController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("開いた .tex を即時 lint し、修正すると診断が消える", () => {
    const { events, open, change } = makeEvents();
    const { sink, byUri } = makeSink();
    new LintController(events, sink);

    const doc = makeDoc();
    doc.text = DUPLICATE_LABELS;
    open(doc);
    expect(byUri.get(doc.uri.toString())).toHaveLength(2);

    doc.text = CLEAN;
    change(doc);
    vi.advanceTimersByTime(LINT_DEBOUNCE_MS);
    expect(byUri.get(doc.uri.toString())).toEqual([]);
  });

  it("起動時に開いている文書を lint する", () => {
    const { events } = makeEvents();
    const { sink, byUri } = makeSink();
    const doc = makeDoc();
    doc.text = DUPLICATE_LABELS;

    new LintController(events, sink, [doc]);

    expect(byUri.get(doc.uri.toString())).toHaveLength(2);
  });

  it("複数の .tex を開いても診断が混ざらない", () => {
    const { events, open } = makeEvents();
    const { sink, byUri } = makeSink();
    new LintController(events, sink);

    const dirty = makeDoc("/work/a.tex");
    dirty.text = DUPLICATE_LABELS;
    const clean = makeDoc("/work/b.tex");
    open(dirty);
    open(clean);

    expect(byUri.get(dirty.uri.toString())).toHaveLength(2);
    expect(byUri.get(clean.uri.toString())).toEqual([]);
  });

  it(".tex 以外や file 以外の scheme は対象外", () => {
    const { events, open } = makeEvents();
    const { sink, byUri } = makeSink();
    new LintController(events, sink);

    open(makeDoc("/work/notes.md"));
    open(makeDoc("/work/deck.tex", "git"));

    expect(byUri.size).toBe(0);
  });

  it("連続入力は 1 回の lint へまとめられる", () => {
    const { events, open, change } = makeEvents();
    const { sink, byUri } = makeSink();
    new LintController(events, sink);
    const doc = makeDoc();
    open(doc);
    byUri.clear();

    change(doc);
    change(doc);
    vi.advanceTimersByTime(LINT_DEBOUNCE_MS - 1);
    expect(byUri.size).toBe(0);
    vi.advanceTimersByTime(1);
    expect(byUri.size).toBe(1);
  });

  it("contentChanges が空のイベント(保存など)では再 lint しない", () => {
    const { events, change } = makeEvents();
    const { sink, byUri } = makeSink();
    new LintController(events, sink);

    change(makeDoc(), []);
    vi.advanceTimersByTime(LINT_DEBOUNCE_MS * 2);

    expect(byUri.size).toBe(0);
  });

  it("文書を閉じると診断を削除し、保留中の lint も走らない", () => {
    const { events, open, change, close } = makeEvents();
    const { sink, byUri, deleted } = makeSink();
    new LintController(events, sink);
    const doc = makeDoc();
    open(doc);

    change(doc);
    close(doc);
    vi.advanceTimersByTime(LINT_DEBOUNCE_MS * 2);

    expect(deleted).toEqual([doc.uri.toString()]);
    expect(byUri.size).toBe(0);
  });

  it("dispose 後は購読が解除され、保留中の lint も走らない", () => {
    const { events, open, change, disposables } = makeEvents();
    const { sink, byUri } = makeSink();
    const controller = new LintController(events, sink);
    const doc = makeDoc();
    open(doc);
    byUri.clear();

    change(doc);
    controller.dispose();
    vi.advanceTimersByTime(LINT_DEBOUNCE_MS * 2);

    expect(byUri.size).toBe(0);
    for (const disposable of disposables) {
      expect(disposable.dispose).toHaveBeenCalledTimes(1);
    }
  });
});
