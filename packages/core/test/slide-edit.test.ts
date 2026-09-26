import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatDeck, frameLabel, framesOf, type SlideEditAction } from "../src/index.js";
import { parseDeck } from "../src/parser.js";
import { editSlide } from "../src/slide-edit.js";

const frame = (title: string, options = "") =>
  `\\begin{frame}${options}{${title}}\n${title} body\n\\end{frame}`;
const deck = (body: string) =>
  `%% deck-source-version: 1\n\\documentclass{beamer}\n\\begin{document}\n${body}\n\\end{document}\n`;
function apply(source: string, action: SlideEditAction, index?: number) {
  const start = index === undefined ? undefined : framesOf(parseDeck(source))[index]?.span.start;
  const result = editSlide(source, action, start);
  if (!result.ok) throw new Error(result.reason);
  for (const { span, text } of [...result.edits].sort((a, b) => b.span.start - a.span.start))
    source = source.slice(0, span.start) + text + source.slice(span.end);
  return source;
}
function labels(source: string) {
  return framesOf(parseDeck(source)).map(frameLabel);
}

describe("slide source edits", () => {
  it("reorders original bytes with attached comments, leaving sections and opaque inter-frame code in place", () => {
    const a = `% A 😀\n${frame("A", "[label=a]")} % tail A\n`;
    const b = `% B\n${frame("B", "[unknown,label=b]")} % tail B\n`;
    const between = "\n\\section{Next}\n\\unknown{keep me}\n\n";
    const source = deck(a + between + b);
    const moved = apply(source, "moveDown", 0);
    expect(moved).toBe(deck(b + between + a));
    expect(labels(moved)).toEqual(["b", "a"]);
    expect(apply(moved, "moveUp", 1)).toBe(source);
  });
  it("duplicates a labeled frame with a fresh address and preserves its body and options", () => {
    const source = deck(
      `${frame("A", "[fragile,label=slide-1,plain]")}\n${frame("B", "[label=slide-2]")}`,
    );
    const next = apply(source, "duplicate", 0);
    expect(labels(next)).toEqual(["slide-1", "slide-3", "slide-2"]);
    expect(next).toContain(frame("A", "[fragile,label=slide-3,plain]"));
  });
  it("copies an opaque frame and ignores a fake frame token inside an attached comment", () => {
    const source = deck(`% example: \\begin{frame} 😀\n${frame("Raw", "[unsupported,label=r]")}`);
    const next = apply(source, "duplicate", 0);
    expect(next.match(/% example: \\begin\{frame\} 😀/g)).toHaveLength(2);
    expect(labels(next)).toEqual(["r", "slide-1"]);
    expect(next).toContain(frame("Raw", "[unsupported,label=slide-1]"));
  });
  it("updates a simple label after header trivia and one overlay specification", () => {
    const source = deck(
      "\\begin{frame}\n% header note\n<2->\n[fragile, label=old]\n{A}\nA body\n\\end{frame}",
    );
    const next = apply(source, "duplicate", 0);
    expect(next).toContain("<2->\n[fragile, label=slide-1]\n{A}");
    expect(next).toContain("<2->\n[fragile, label=old]\n{A}");

    const unlabeled = deck("\\begin{frame}\n% header note\n<1>\n{A}\nA body\n\\end{frame}");
    expect(apply(unlabeled, "duplicate", 0)).toContain("<1>[label=slide-1]\n{A}");
  });
  it("adds a label to an unlabeled copy and supports adjacent frames without newlines", () => {
    const source = deck(frame("A") + frame("B"));
    expect(labels(apply(source, "duplicate", 0))).toEqual([null, "slide-1", null]);
    expect(apply(source, "delete", 0)).toBe(deck(frame("B")));
  });
  it("inserts after the selected frame and appends when no item is supplied", () => {
    const source = deck(`${frame("A", "[label=a]")}\n${frame("B", "[label=b]")}`);
    expect(labels(apply(source, "insert", 0))).toEqual(["a", "slide-1", "b"]);
    expect(labels(apply(source, "insert"))).toEqual(["a", "b", "slide-1"]);
  });
  it("can delete the final frame and insert into an empty deck, preserving preamble and sections", () => {
    const source = deck(`\\section{Keep}\n% note\n${frame("A")} % tail\n`);
    const empty = apply(source, "delete", 0);
    expect(empty).toBe(deck("\\section{Keep}\n"));
    expect(labels(apply(empty, "insert"))).toEqual(["slide-1"]);
  });
  it("preserves CRLF and Unicode through insertion and duplication", () => {
    const source = deck(`% 😀\n${frame("日本語")}`).replace(/\n/g, "\r\n");
    for (const action of ["insert", "duplicate"] as const) {
      const next = apply(source, action, 0);
      expect(next).not.toMatch(/(?<!\r)\n/);
      expect(next).toContain("日本語");
      expect(framesOf(parseDeck(next))).toHaveLength(2);
    }
  });
  it("refuses stale offsets, missing document boundaries, broken frames, and ambiguous duplicate headers", () => {
    const source = deck(frame("A"));
    expect(editSlide(source, "delete", 1).ok).toBe(false);
    expect(editSlide(frame("A"), "insert").ok).toBe(false);
    expect(editSlide(deck("\\begin{frame}{Broken}"), "insert").ok).toBe(false);
    const bad = deck(frame("A", "[label=a,label=b]"));
    expect(editSlide(bad, "duplicate", framesOf(parseDeck(bad))[0]?.span.start).ok).toBe(false);
  });
  it("does not duplicate internal TeX reference targets", () => {
    const source = deck(frame("A").replace("A body", "\\label{eq:one} $x=1$"));
    expect(editSlide(source, "duplicate", framesOf(parseDeck(source))[0]?.span.start).ok).toBe(
      false,
    );
    expect(labels(apply(source, "moveUp", 0))).toHaveLength(1);
  });
  it("does not duplicate hyperlink anchors or global register allocations", () => {
    for (const body of [
      "\\hypertarget{ht}{x}",
      "\\newcounter{mycnt}",
      "\\newlength{\\mylen}",
      "\\newtheorem{claim}{Claim}",
    ]) {
      const source = deck(frame("A").replace("A body", body));
      expect(editSlide(source, "duplicate", source.indexOf("\\begin{frame}")).ok, body).toBe(false);
    }
    const producer = deck(frame("A").replace("A body", "\\anchor")).replace(
      "\\begin{document}",
      "\\newcommand{\\anchor}{\\hypertarget{ht}{x}}\n\\begin{document}",
    );
    expect(editSlide(producer, "duplicate", producer.indexOf("\\begin{frame}")).ok).toBe(false);
    for (const body of ["\\hyperlink{ht}{go}", "\\newcommand{\\local}{x}", "\\def\\local{x}"]) {
      const source = deck(frame("A").replace("A body", body));
      expect(labels(apply(source, "duplicate", 0)), body).toEqual([null, "slide-1"]);
    }
  });
  it("does not treat a commented internal label as a reference target", () => {
    const source = deck(frame("A").replace("A body", "% \\label{example}"));
    expect(labels(apply(source, "duplicate", 0))).toEqual([null, "slide-1"]);
  });
  it("ignores document, frame, and label tokens in comments and verbatim environments", () => {
    for (const environment of ["verbatim", "verbatim*", "semiverbatim", "lstlisting", "minted"]) {
      const source = deck(
        frame("A").replace(
          "A body",
          [
            "% \\end{document} \\begin{frame} \\label{comment}",
            `\\begin{${environment}}`,
            "\\end{document} \\begin{frame} \\label{opaque}",
            `\\end{${environment}}`,
          ].join("\n"),
        ),
      );
      const result = editSlide(source, "duplicate", source.indexOf("\\begin{frame}"));
      expect(result).toEqual(expect.objectContaining({ ok: true }));
    }
  });
  it("ignores structure and labels inside verb and verb* delimiters", () => {
    for (const command of [
      "\\verb|\\end{document} \\begin{frame} \\label{fake}|",
      "\\verb*+\\end{frame} \\label{fake}+",
    ]) {
      const source = deck(frame("A").replace("A body", command));
      const result = editSlide(source, "duplicate", source.indexOf("\\begin{frame}"));
      expect(result).toEqual(expect.objectContaining({ ok: true }));
    }
  });
  it("still rejects a live label immediately after opaque text", () => {
    for (const body of [
      "\\verb|\\label{fake}|\\label{live}",
      "\\begin{semiverbatim}\n\\label{fake}\n\\end{semiverbatim}\\label{live}",
    ]) {
      const source = deck(frame("A").replace("A body", body));
      const result = editSlide(source, "duplicate", source.indexOf("\\begin{frame}"));
      expect(result).toEqual(expect.objectContaining({ ok: false }));
    }
  });
  it("keeps later lines live after an unclosed verb command", () => {
    const source = deck(frame("A").replace("A body", "\\verb|\\label{fake}\n\\label{live}"));
    const result = editSlide(source, "duplicate", source.indexOf("\\begin{frame}"));
    expect(result).toEqual(expect.objectContaining({ ok: false }));
  });
  it("allows a macro expansion that produces a verbatim label", () => {
    const source = [
      "%% deck-source-version: 1",
      "\\documentclass{beamer}",
      "%% macros:begin",
      "\\newcommand{\\maskedLabel}{\\verb|\\label{x}|}",
      "%% macros:end",
      "\\begin{document}",
      frame("A").replace("A body", "\\maskedLabel"),
      "\\end{document}",
      "",
    ].join("\n");
    const result = editSlide(source, "duplicate", source.indexOf("\\begin{frame}"));
    expect(result).toEqual(expect.objectContaining({ ok: true }));
  });
  it("keeps a live label visible after stringified opaque commands in macro definitions", () => {
    for (const definition of [
      "\\detokenize{\\begin{verbatim}}",
      "\\string\\begin{verbatim}",
      "\\meaning\\begin{verbatim}",
    ]) {
      const source = [
        "%% deck-source-version: 1",
        "\\documentclass{beamer}",
        "%% macros:begin",
        `\\newcommand{\\literal}{${definition}}`,
        "%% macros:end",
        "\\begin{document}",
        frame("A").replace("A body", "\\label{live}"),
        "\\end{document}",
        "",
      ].join("\n");
      const result = editSlide(source, "duplicate", source.indexOf("\\begin{frame}"));
      expect(result).toEqual(expect.objectContaining({ ok: false }));
    }
  });
  it("keeps a live label visible after a stringified command and comment", () => {
    for (const command of ["\\string", "\\meaning"]) {
      const source = deck(
        frame("A").replace(
          "A body",
          `${command}% comment\n\\begin{verbatim}\\label{live}${command}\\end{verbatim}`,
        ),
      );
      const result = editSlide(source, "duplicate", source.indexOf("\\begin{frame}"));
      expect(result).toEqual(expect.objectContaining({ ok: false }));
    }
  });
  it("ignores structural tokens in macro definition replacement bodies", () => {
    for (const definition of [
      "\\newcommand{\\literal}{\\begin{frame}\\end{frame}\\verb|\\label{x}|}",
      "\\renewcommand{\\literal}{\\begin{frame}\\end{frame}}",
      "\\providecommand{\\literal}[1]{\\begin{frame}\\end{frame}}",
      "\\DeclareRobustCommand{\\literal}{\\begin{frame}\\end{frame}}",
      "\\def\\literal#1{\\begin{frame}\\end{frame}}",
      "\\gdef\\literal{\\begin{frame}\\end{frame}}",
      "\\edef\\literal{\\begin{frame}\\end{frame}}",
      "\\xdef\\literal{\\begin{frame}\\end{frame}}",
    ]) {
      const source = deck(frame("A").replace("A body", definition));
      const result = editSlide(source, "duplicate", source.indexOf("\\begin{frame}"));
      expect(result).toEqual(expect.objectContaining({ ok: true }));
    }
  });
  it("rejects a live label after fake structural tokens in a macro definition", () => {
    const source = deck(
      frame("A").replace(
        "A body",
        [
          "\\newcommand{\\fakeopen}{\\begin{verbatim}}",
          "\\label{live}",
          "\\newcommand{\\fakeclose}{\\end{verbatim}}",
        ].join("\n"),
      ),
    );
    const result = editSlide(source, "duplicate", source.indexOf("\\begin{frame}"));
    expect(result).toEqual(expect.objectContaining({ ok: false }));
  });
  it("ignores structural tokens in environment definition bodies", () => {
    for (const definition of [
      "\\newenvironment{literal}[1][default]{\\begin{frame}}{\\end{frame}\\verb|\\label{x}|}",
      "\\renewenvironment{literal}{\\begin{frame}}{\\end{frame}}",
      "\\provideenvironment{literal}{\\begin{frame}}{\\end{frame}}",
    ]) {
      const source = deck(frame("A").replace("A body", definition));
      const result = editSlide(source, "duplicate", source.indexOf("\\begin{frame}"));
      expect(result).toEqual(expect.objectContaining({ ok: true }));
    }
  });
  it("rejects a live label after fake environment and macro definition tokens", () => {
    for (const body of [
      [
        "\\newenvironment{fakeopen}{\\begin{verbatim}}{}",
        "\\label{live}",
        "\\newenvironment{fakeclose}{}{\\end{verbatim}}",
      ].join("\n"),
      [
        "\\newcommand% comment\n{\\fakeopen}{\\begin{verbatim}}",
        "\\label{live}",
        "\\newcommand{\\fakeclose}{\\end{verbatim}}",
      ].join("\n"),
      [
        "\\newcommand{\\fakeopen}{% comment { }\n\\begin{verbatim}\n}",
        "\\label{live}",
        "\\newcommand{\\fakeclose}{\\end{verbatim}}",
      ].join("\n"),
    ]) {
      const source = deck(frame("A").replace("A body", body));
      const result = editSlide(source, "duplicate", source.indexOf("\\begin{frame}"));
      expect(result).toEqual(expect.objectContaining({ ok: false }));
    }
  });
  it("ignores comments and optional defaults in complete macro definitions", () => {
    for (const definition of [
      "\\newcommand% \\end{document}\n{\\literal}{text}",
      "\\newcommand{\\literal}[1][\\begin{frame}\\end{frame}]{text}",
    ]) {
      const source = deck(frame("A").replace("A body", definition));
      const result = editSlide(source, "duplicate", source.indexOf("\\begin{frame}"));
      expect(result).toEqual(expect.objectContaining({ ok: true }));
    }
  });
  it("handles long backslash runs without changing slide detection", () => {
    const source = deck(frame("A").replace("A body", "\\".repeat(20_000)));
    const result = editSlide(source, "duplicate", source.indexOf("\\begin{frame}"));
    expect(result).toEqual(expect.objectContaining({ ok: true }));
  });
  it("refuses a macro-generated internal label only for the frame containing its call site", () => {
    const source = [
      "%% deck-source-version: 1",
      "\\documentclass{beamer}",
      "%% macros:begin",
      "\\newcommand{\\anchor}{\\label{eq:one}}",
      "%% macros:end",
      "\\begin{document}",
      frame("A").replace("A body", "\\anchor"),
      frame("B"),
      "\\end{document}",
      "",
    ].join("\n");
    const first = framesOf(parseDeck(source))[0];
    expect(editSlide(source, "duplicate", first?.span.start)).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(labels(apply(source, "duplicate", 1))).toEqual([null, null, "slide-1"]);
  });
  it("refuses malformed nested or unclosed frames without returning edits", () => {
    const source = deck(
      `${frame("A").replace("A body", "\\begin{frame}{Nested}\nNested body")}\n${frame("B")}`,
    );
    const result = editSlide(source, "delete", framesOf(parseDeck(source))[0]?.span.start);
    expect(result).toEqual(expect.objectContaining({ ok: false }));
    expect(result).not.toHaveProperty("edits");
  });
  it("recognizes a frame end after a TeX line break", () => {
    const source = deck(frame("A").replace("A body\n", "A body\\\\"));
    const next = apply(source, "delete", 0);
    expect(labels(next)).toEqual([]);
    expect(next).toContain("\\end{document}");
  });
  it("does not create edits when moving past an edge", () => {
    const source = deck(frame("A"));
    for (const action of ["moveUp", "moveDown"] as const)
      expect(editSlide(source, action, framesOf(parseDeck(source))[0]?.span.start)).toEqual({
        ok: true,
        edits: [],
      });
  });
  it("does not expand or mutate macro definitions or opaque content", () => {
    const source = deck(
      frame("A").replace(
        "A body",
        "\\custom{keep}\n\\begin{verbatim}\n  % text 😀\n\\end{verbatim}",
      ),
    );
    const next = apply(source, "duplicate", 0);
    expect(next.match(/\\custom\{keep\}/g)).toHaveLength(2);
    expect(next.match(/ {2}% text 😀/g)).toHaveLength(2);
  });

  const withPreamble = (preamble: string, body: string) =>
    `%% deck-source-version: 1\n\\documentclass{beamer}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;
  const frameTexts = (source: string) =>
    framesOf(parseDeck(source)).map((frame) => source.slice(frame.span.start, frame.span.end));

  describe("uses the same frame segmentation as the slide list", () => {
    const tricky: Array<[string, string, number]> = [
      [
        "verb with frame tags in a fragile frame",
        deck(
          `${frame("A", "[fragile]").replace("A body", "\\verb|\\end{frame} \\begin{frame}|")}\n${frame("B")}`,
        ),
        2,
      ],
      ...[
        "verbatim",
        "lstlisting",
        "minted",
        "Verbatim",
        "Verbatim*",
        "BVerbatim",
        "LVerbatim",
      ].map((environment): [string, string, number] => [
        `${environment} with frame tags`,
        deck(
          `${frame("A", "[fragile]").replace(
            "A body",
            `\\begin{${environment}}\n\\end{frame}\n\\begin{frame}{Fake}\n\\end{${environment}}`,
          )}\n${frame("B")}`,
        ),
        2,
      ]),
      [
        "commented-out frames",
        deck(
          `% \\begin{frame}{Old}\n% old\n% \\end{frame}\n${frame("A")} % \\end{frame}\n${frame("B")}`,
        ),
        2,
      ],
      [
        "macro bodies with frame tags",
        withPreamble(
          "\\newcommand{\\mkframe}{\\begin{frame}{M}\\end{frame}}",
          `${frame("A").replace("A body", "\\newcommand{\\inner}{\\end{frame}\\begin{frame}}")}\n\\newcommand{\\between}{%\n\\begin{frame}{Fake}\n\\end{frame}\n}\n${frame("B")}`,
        ),
        2,
      ],
    ];
    for (const [name, source, count] of tricky) {
      it(`${name}: every listed frame is a target and delete removes exactly it`, () => {
        const listed = framesOf(parseDeck(source));
        expect(listed).toHaveLength(count);
        const texts = frameTexts(source);
        listed.forEach((frame, index) => {
          const result = editSlide(source, "delete", frame.span.start);
          expect(result).toEqual(expect.objectContaining({ ok: true }));
          const next = apply(source, "delete", index);
          expect(frameTexts(next)).toEqual(texts.filter((_, i) => i !== index));
          expect(next).toContain("\\end{document}");
        });
      });
    }
  });

  it("refuses a frame end after the document end on the same line", () => {
    const broken = deck("\\begin{frame}{A}\nA body\n\\end{document}\\end{frame}").replace(
      /\n\\end\{document\}\n$/,
      "\n",
    );
    expect(editSlide(broken, "insert")).toEqual({
      ok: false,
      reason: "閉じていない、または入れ子になったフレームがあります。ソースを確認してください。",
    });
    const valid = `${deck(frame("A")).replace(/\n\\end\{document\}\n$/, "")}\\end{document}\n`;
    expect(valid).toContain("\\end{frame}\\end{document}");
    expect(labels(apply(valid, "duplicate", 0))).toEqual([null, "slide-1"]);
  });

  it("does not treat body text after a line break as frame options", () => {
    const blank = deck("\\begin{frame}\n\n[1] Author, 2020.\n\\end{frame}");
    const copied = apply(blank, "duplicate", 0);
    expect(copied).toContain("\\begin{frame}[label=slide-1]\n\n[1] Author, 2020.\n\\end{frame}");
    expect(copied.match(/\n\[1\] Author, 2020\./g)).toHaveLength(2);

    // TeX reads `[1]` as frame options here; its header is not a plain option list.
    const newline = deck("\\begin{frame}\n[1] Author, 2020.\n\\end{frame}");
    expect(editSlide(newline, "duplicate", newline.indexOf("\\begin{frame}"))).toEqual({
      ok: false,
      reason: "フレームのlabelを安全に変更できません。ソースを確認してください。",
    });
  });

  it("labels a title-less copy whose header is followed by a blank line", () => {
    const source = deck("\\begin{frame}\n\n\\frametitle{T}\nbody\n\\end{frame}");
    const next = apply(source, "duplicate", 0);
    expect(next).toContain("\\begin{frame}[label=slide-1]\n\n\\frametitle{T}");
    expect(labels(next)).toEqual([null, "slide-1"]);
  });

  it("replaces existing labels in every header form the parser recognizes", () => {
    for (const [header, expected] of [
      ["<2->[label=old]{A}", "<2->[label=slide-1]{A}"],
      ["[fragile, label = old ]{A}", "[fragile, label = slide-1 ]{A}"],
      ["\n[label=old]\n{A}", "\n[label=slide-1]\n{A}"],
      ["% note\n[plain,label=old]{A}", "% note\n[plain,label=slide-1]{A}"],
      ["<2->{A}", "<2->[label=slide-1]{A}"],
    ]) {
      const source = deck(`\\begin{frame}${header}\nA body\n\\end{frame}`);
      const next = apply(source, "duplicate", 0);
      expect(next).toContain(`\\begin{frame}${header}\n`);
      expect(next).toContain(`\\begin{frame}${expected}\n`);
      expect(labels(next)).toContain("slide-1");
    }
  });

  it("refuses opaque frame headers it cannot read safely", () => {
    for (const header of ["[<+->][label=a]{A}", "[t,label={a,b}]{A}", "[t,%\nlabel=a]{A}"]) {
      const source = deck(`\\begin{frame}${header}\nA body\n\\end{frame}`);
      expect(editSlide(source, "duplicate", source.indexOf("\\begin{frame}")).ok).toBe(false);
    }
    const opaque = deck(frame("T", "[t]"));
    expect(apply(opaque, "duplicate", 0)).toContain(frame("T", "[t,label=slide-1]"));
  });

  it("refuses labels emitted by preamble macros of any definition form, transitively", () => {
    for (const [preamble, call] of [
      ["\\newcommand{\\keypoint}[2]{\\textbf{#1}\\label{#2}}", "\\keypoint{Main}{pt:one}"],
      ["\\renewcommand*\\keypoint[1]{\\label{#1}}", "\\keypoint{a}"],
      ["\\providecommand{\\keypoint}{\\label{a}}", "\\keypoint"],
      ["\\DeclareRobustCommand{\\keypoint}{\\label{a}}", "\\keypoint"],
      ["\\def\\keypoint#1{\\label{#1}}", "\\keypoint{a}"],
      ["\\NewDocumentCommand{\\keypoint}{m}{\\label{#1}}", "\\keypoint{a}"],
      ["\\NewDocumentCommand\\keypoint{m}{\\label{#1}}", "\\keypoint{a}"],
      ["\\let\\keypoint\\label", "\\keypoint{a}"],
      ["\\def\\inner{\\label{a}}\n\\newcommand{\\keypoint}{\\inner}", "\\keypoint"],
      ["\\newenvironment{anchored}{\\label{a}}{}", "\\begin{anchored}x\\end{anchored}"],
      [
        "\\NewDocumentEnvironment{anchored}{}{}{\\keypoint}\n\\def\\keypoint{\\label{a}}",
        "\\begin{anchored}x\\end{anchored}",
      ],
    ]) {
      const source = withPreamble(preamble, `${frame("A").replace("A body", call)}\n${frame("B")}`);
      expect(editSlide(source, "duplicate", source.indexOf("\\begin{frame}"))).toEqual({
        ok: false,
        reason:
          "本文に\\label・\\hypertarget・\\newcounterなど文書内で一意な定義があるスライドは、参照先を確認してソース上で複製してください。",
      });
      expect(labels(apply(source, "duplicate", 1))).toEqual([null, null, "slide-1"]);
    }
  });

  it("does not count macro labels hidden by comments, verb, or verbatim", () => {
    for (const [preamble, call] of [
      ["% \\newcommand{\\keypoint}{\\label{a}}\n\\newcommand{\\keypoint}{text}", "\\keypoint"],
      ["\\newcommand{\\keypoint}{\\verb|\\label{a}|}", "\\keypoint"],
      ["\\newcommand{\\keypoint}{\\label{a}}", "% \\keypoint"],
      ["\\newcommand{\\keypoint}{\\label{a}}", "\\verb|\\keypoint|"],
      ["\\newcommand{\\keypoint}{\\label{a}}", "\\begin{Verbatim}\n\\keypoint\n\\end{Verbatim}"],
    ]) {
      const source = withPreamble(preamble, frame("A", "[fragile]").replace("A body", call));
      expect(labels(apply(source, "duplicate", 0))).toEqual([null, "slide-1"]);
    }
  });

  it("keeps every fixture editable or refused, with idempotent formatting", () => {
    const directory = join(__dirname, "../../../fixtures");
    const fixtures = readdirSync(directory).filter((name) => name.endsWith(".slide.tex"));
    expect(fixtures.length).toBeGreaterThan(0);
    for (const name of fixtures) {
      const source = readFileSync(join(directory, name), "utf8");
      const frames = framesOf(parseDeck(source));
      for (const [index, frame] of frames.entries()) {
        for (const action of ["moveUp", "moveDown", "duplicate", "delete", "insert"] as const) {
          const result = editSlide(source, action, frame.span.start);
          if (!result.ok) {
            expect(action, `${name} #${index} ${action}: ${result.reason}`).toBe("duplicate");
            continue;
          }
          let next = source;
          for (const edit of [...result.edits].sort((a, b) => b.span.start - a.span.start))
            next = next.slice(0, edit.span.start) + edit.text + next.slice(edit.span.end);
          const delta =
            action === "delete" ? -1 : action === "duplicate" || action === "insert" ? 1 : 0;
          const moved = result.edits.length > 0 || delta !== 0;
          expect(framesOf(parseDeck(next)), `${name} #${index} ${action}`).toHaveLength(
            frames.length + (moved ? delta : 0),
          );
          const formatted = formatDeck(next);
          expect(formatDeck(formatted), `${name} #${index} ${action}`).toBe(formatted);
        }
      }
    }
  });
});
