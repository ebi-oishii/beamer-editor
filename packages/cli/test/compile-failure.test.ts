import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PdfExportError } from "@beamer-editor/compiler";
import * as core from "@beamer-editor/core";
import { afterEach, expect, it, vi } from "vitest";
import { type CliDependencies, EXIT_CODE, run } from "../src/cli.ts";

vi.mock("@beamer-editor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@beamer-editor/core")>();
  return { ...actual, lintSource: vi.fn(actual.lintSource) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

// 管理プリアンブルに \deckbackground の定義が無いデッキ(L025)。
const OUTDATED = `\\documentclass[aspectratio=169]{beamer}
%% deck-source-version: 1
%% style:begin
\\deckbackground{bg.png}
%% style:end
\\begin{document}
\\end{document}
`;

it("E_COMPILE に添える lint が例外を投げても、元の E_COMPILE をそのまま出す", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beamer-compile-failure-"));
  directories.push(directory);
  const deck = join(directory, "talk.slide.tex");
  await writeFile(deck, OUTDATED);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.mocked(core.lintSource).mockImplementationOnce(() => {
    throw new Error("lint crashed");
  });
  const dependencies: CliDependencies = {
    exportPdf: async () =>
      Promise.reject(
        new PdfExportError("E_COMPILE", "Undefined control sequence", undefined, {
          texFailed: true,
        }),
      ),
  };
  expect(await run(["export", deck, "--format", "pdf", "--json"], dependencies)).toBe(
    EXIT_CODE.operationalFailure,
  );
  expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toEqual({
    error: { code: "E_COMPILE", message: "Undefined control sequence" },
  });
});
