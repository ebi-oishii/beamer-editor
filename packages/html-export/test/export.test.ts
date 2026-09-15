import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportHtml, type HtmlExportError } from "../src/index.js";

const dirs: string[] = [];
async function fixture(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "deck-html-"));
  dirs.push(dir);
  const input = join(dir, "talk.slide.tex");
  await writeFile(input, source);
  return { dir, input };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const deck = (body: string) =>
  `\\documentclass{beamer}\n\\begin{document}\n${body}\n\\end{document}`;
describe("exportHtml", () => {
  it("writes a direct-open snapshot and rejects an existing destination", async () => {
    const { dir, input } = await fixture(deck("\\begin{frame}{Hi}text\\end{frame}"));
    const result = await exportHtml({ inputPath: input });
    expect(result.indexPath).toBe(join(dir, "talk-html", "index.html"));
    const html = await readFile(result.indexPath, "utf8");
    expect(html).toContain("script-src 'self'");
    expect(html).toContain("style-src-attr 'unsafe-inline'");
    expect(html).toContain("katex/katex.min.css");
    expect(html).toContain("viewer.js");
    expect(await readFile(join(dir, "talk-html", "deck.css"), "utf8")).toBeDefined();
    expect(await readFile(join(dir, "talk-html", "katex", "katex.min.css"), "utf8")).toContain(
      ".katex",
    );
    await expect(exportHtml({ inputPath: input })).rejects.toMatchObject({
      code: "E_OUTPUT_EXISTS",
    } satisfies Partial<HtmlExportError>);
  });
  it("expands macros and preserves preview style CSS", async () => {
    const { input } = await fixture(
      `%% macros:begin\n\\newcommand{\\word}{expanded}\n%% macros:end\n%% style:begin\n\\deckcolor{structure}{112233}\n%% style:end\n${deck("\\begin{frame}{Hi}\\word\\end{frame}")}`,
    );
    const result = await exportHtml({ inputPath: input });
    expect(await readFile(result.indexPath, "utf8")).toContain("expanded");
    expect(await readFile(join(result.outputPath, "deck.css"), "utf8")).toContain("112233");
  });
  it("rejects traversal assets before creating output", async () => {
    const { dir, input } = await fixture(
      deck("\\begin{frame}\\includegraphics{../outside.png}\\end{frame}"),
    );
    await expect(exportHtml({ inputPath: input })).rejects.toMatchObject({ code: "E_ASSET" });
    await expect(readFile(join(dir, "talk-html", "index.html"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("rejects an empty deck and an already-cancelled request without output", async () => {
    const empty = await fixture(deck(""));
    await expect(exportHtml({ inputPath: empty.input })).rejects.toMatchObject({ code: "E_INPUT" });
    const normal = await fixture(deck("\\begin{frame}{x}x\\end{frame}"));
    const abort = new AbortController();
    abort.abort();
    await expect(
      exportHtml({ inputPath: normal.input, signal: abort.signal }),
    ).rejects.toMatchObject({ code: "E_CANCELLED" });
  });

  it("copies and deduplicates local raster images while preserving remote and data URLs", async () => {
    const { dir, input } = await fixture(
      deck(`\\begin{frame}
\\includegraphics{assets/a&b.png}
\\includegraphics{assets/c.jpg}
\\includegraphics{https://example.com/remote.png}
\\includegraphics{data:image/png;base64,AAAA}
\\end{frame}`),
    );
    await mkdir(join(dir, "assets"));
    const bytes = Uint8Array.from([137, 80, 78, 71, 1, 2, 3]);
    await writeFile(join(dir, "assets", "a&b.png"), bytes);
    await writeFile(join(dir, "assets", "c.jpg"), bytes);
    const result = await exportHtml({ inputPath: input });
    const html = await readFile(result.indexPath, "utf8");
    const copied = await readdir(join(result.outputPath, "assets"));
    expect(copied).toHaveLength(1);
    expect(html).toContain(`assets/${copied[0]}`);
    expect(html).toContain("https://example.com/remote.png");
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).not.toContain("assets/a&amp;b.png");
  });

  it("decodes the complete renderer entity set in local image filenames", async () => {
    const { dir, input } = await fixture(
      deck('\\begin{frame}\\includegraphics{assets/a"b>c.png}\\end{frame}'),
    );
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "assets", 'a"b>c.png'), "image");
    const result = await exportHtml({ inputPath: input });
    const html = await readFile(result.indexPath, "utf8");
    expect(html).not.toContain("a&quot;b&gt;c.png");
    expect(await readdir(join(result.outputPath, "assets"))).toHaveLength(1);
  });

  it("keeps PDF images as placeholders without copying the source PDF", async () => {
    const { dir, input } = await fixture(
      deck("\\begin{frame}\\includegraphics{assets/chart.pdf}\\end{frame}"),
    );
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "assets", "chart.pdf"), "%PDF-1.7");
    const result = await exportHtml({ inputPath: input });
    const html = await readFile(result.indexPath, "utf8");
    expect(html).toContain("image-placeholder");
    await expect(readdir(join(result.outputPath, "assets"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects missing rasters and symlinks escaping the deck before reserving output", async () => {
    const missing = await fixture(
      deck("\\begin{frame}\\includegraphics{assets/missing.png}\\end{frame}"),
    );
    await expect(exportHtml({ inputPath: missing.input })).rejects.toMatchObject({
      code: "E_ASSET",
    });
    await expect(lstat(join(missing.dir, "talk-html"))).rejects.toMatchObject({ code: "ENOENT" });

    const escaped = await fixture(
      deck("\\begin{frame}\\includegraphics{assets/outside.png}\\end{frame}"),
    );
    const outside = await mkdtemp(join(tmpdir(), "deck-html-outside-"));
    dirs.push(outside);
    await writeFile(join(outside, "outside.png"), "outside");
    await mkdir(join(escaped.dir, "assets"));
    await symlink(join(outside, "outside.png"), join(escaped.dir, "assets", "outside.png"));
    await expect(exportHtml({ inputPath: escaped.input })).rejects.toMatchObject({
      code: "E_ASSET",
    });
    await expect(lstat(join(escaped.dir, "talk-html"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies local template and preamble styles and snapshots template images", async () => {
    const { dir, input } = await fixture(`\\documentclass{beamer}
%% preamble-extra:begin
\\usepackage{templates/corp/beamerthemecorp}
\\setbeamercolor{alerted text}{fg=red}
%% preamble-extra:end
\\begin{document}
\\begin{frame}{Styled}x\\end{frame}
\\end{document}`);
    await mkdir(join(dir, "templates", "corp", "assets"), { recursive: true });
    await writeFile(
      join(dir, "templates", "corp", "beamerthemecorp.sty"),
      `\\definecolor{corpblue}{HTML}{123456}
\\setbeamercolor{structure}{fg=corpblue}
\\logo{\\includegraphics{templates/corp/assets/logo.png}}
\\usebackgroundtemplate{\\includegraphics{templates/corp/assets/background}}`,
    );
    await writeFile(join(dir, "templates", "corp", "assets", "logo.png"), "logo");
    await writeFile(join(dir, "templates", "corp", "assets", "background.png"), "background");
    const result = await exportHtml({ inputPath: input });
    const css = await readFile(join(result.outputPath, "deck.css"), "utf8");
    const html = await readFile(result.indexPath, "utf8");
    expect(css).toContain("123456");
    expect(css).toContain("FF0000");
    expect(html).not.toContain("templates/corp/assets/");
    expect(await readdir(join(result.outputPath, "assets"))).toHaveLength(2);
  });

  it("escapes embedded JSON and emits shared overlay predicate data", async () => {
    const { input } = await fixture(
      deck(
        "\\begin{frame}{</script>\u2028}\\begin{block}<2-4,6->{B}visible\\end{block}\\pause later\\end{frame}",
      ),
    );
    const result = await exportHtml({ inputPath: input });
    const html = await readFile(result.indexPath, "utf8");
    const data = html.match(/<script id="deck-data"[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(data).not.toContain("</script>");
    expect(data).not.toContain("\u2028");
    expect(data).toContain("\\u003c");
    expect(data).toContain('data-overlay=\\"2-4,6-\\"');
    const viewer = await readFile(join(result.outputPath, "viewer.js"), "utf8");
    expect(viewer).toContain("dataset.overlay");
    expect(viewer).toContain("dataset.min");
    expect(viewer).not.toContain("[data-min],[data-overlay]");
    expect(viewer.indexOf("[data-min]")).toBeLessThan(viewer.indexOf("[data-overlay]"));
  });

  it("maps prevalidation filesystem failures into the public error taxonomy", async () => {
    const { dir, input } = await fixture(deck("\\begin{frame}x\\end{frame}"));
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "file");
    await expect(exportHtml({ inputPath: join(blocker, "talk.tex") })).rejects.toMatchObject({
      code: "E_INPUT",
    });
    await expect(
      exportHtml({ inputPath: input, outputPath: join(blocker, "output") }),
    ).rejects.toMatchObject({ code: "E_IO" });

    const assetDeck = await fixture(
      deck("\\begin{frame}\\includegraphics{assets/blocker/image.png}\\end{frame}"),
    );
    await mkdir(join(assetDeck.dir, "assets"));
    await writeFile(join(assetDeck.dir, "assets", "blocker"), "file");
    await expect(exportHtml({ inputPath: assetDeck.input })).rejects.toMatchObject({
      code: "E_ASSET",
    });
  });

  it("preserves every kind of existing output and classifies concurrent reservation races", async () => {
    const { dir, input } = await fixture(deck("\\begin{frame}x\\end{frame}"));
    const file = join(dir, "existing-file");
    const folder = join(dir, "existing-folder");
    const broken = join(dir, "broken-link");
    await writeFile(file, "keep");
    await mkdir(folder);
    await writeFile(join(folder, "keep"), "keep");
    await symlink(join(dir, "does-not-exist"), broken);
    for (const outputPath of [file, folder, broken]) {
      await expect(exportHtml({ inputPath: input, outputPath })).rejects.toMatchObject({
        code: "E_OUTPUT_EXISTS",
      });
    }
    expect(await readFile(file, "utf8")).toBe("keep");
    expect(await readFile(join(folder, "keep"), "utf8")).toBe("keep");

    const race = join(dir, "race");
    const settled = await Promise.allSettled([
      exportHtml({ inputPath: input, outputPath: race }),
      exportHtml({ inputPath: input, outputPath: race }),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "E_OUTPUT_EXISTS" } });
    expect(await readFile(join(race, "index.html"), "utf8")).toContain("viewer.js");
  });

  it("removes only its claimed output when cancelled after reservation", async () => {
    const { dir, input } = await fixture(deck("\\begin{frame}x\\end{frame}"));
    const outputPath = join(dir, "cancelled-output");
    const controller = new AbortController();
    const running = exportHtml({ inputPath: input, outputPath, signal: controller.signal });
    const rejected = expect(running).rejects.toMatchObject({ code: "E_CANCELLED" });
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        await lstat(join(outputPath, ".incomplete"));
        controller.abort();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    await rejected;
    await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
