import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDeck, framesOf, lintSource, parseDeck } from "@beamer-editor/core";
import { afterEach, expect, it, vi } from "vitest";
import { run } from "../src/cli.ts";
import { initDeck } from "../src/init.ts";
import { skillLintOptions } from "../src/skill.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const dirs: string[] = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "beamer-init-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("generates a portable, formatted, lint-clean deck and the complete skill", async () => {
  const directory = join(await temp(), "my presentation");
  const result = await initDeck(directory);
  const source = await readFile(join(directory, "main.slide.tex"), "utf8");
  expect(framesOf(parseDeck(source))).toHaveLength(2);
  expect(formatDeck(source)).toBe(source);
  expect(lintSource(source, await skillLintOptions(join(directory, "main.slide.tex")))).toEqual([]);
  expect(source).not.toMatch(/\\input\{/);
  expect(await readdir(join(directory, "assets"))).toEqual([]);
  expect(result.files).toHaveLength(5);
  for (const file of result.files)
    expect((await readFile(join(directory, file), "utf8")).length).toBeGreaterThan(0);
});

it("accepts an existing empty directory and refuses repeat initialization without changes", async () => {
  const directory = await temp();
  const result = await initDeck(directory);
  const before = await Promise.all(result.files.map((f) => readFile(join(directory, f), "utf8")));
  await expect(initDeck(directory)).rejects.toMatchObject({ code: "E_OUTPUT_EXISTS" });
  expect(await Promise.all(result.files.map((f) => readFile(join(directory, f), "utf8")))).toEqual(
    before,
  );
});

it("rejects nonempty directories, files and symlink targets without overwriting", async () => {
  const directory = await temp();
  await writeFile(join(directory, "keep.txt"), "keep");
  await expect(initDeck(directory)).rejects.toMatchObject({ code: "E_OUTPUT_EXISTS" });
  await expect(initDeck(join(directory, "keep.txt"))).rejects.toMatchObject({
    code: "E_OUTPUT_EXISTS",
  });
  await mkdir(join(directory, "empty"));
  await symlink(join(directory, "empty"), join(directory, "link"), "dir");
  await expect(initDeck(join(directory, "link"))).rejects.toMatchObject({
    code: "E_OUTPUT_EXISTS",
  });
  expect(await readFile(join(directory, "keep.txt"), "utf8")).toBe("keep");
  expect(await readdir(join(directory, "empty"))).toEqual([]);
});

it("CLI reports JSON output, collision errors, and rejects invalid arguments", async () => {
  const directory = await temp();
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(await run(["init", directory, "--json"])).toBe(0);
  expect(JSON.parse(stdout.mock.calls.map((c) => c[0]).join(""))).toMatchObject({
    directory,
    files: expect.arrayContaining(["main.slide.tex"]),
  });
  expect(await run(["init", directory, "--json"])).toBe(3);
  expect(JSON.parse(stderr.mock.calls.map((c) => c[0]).join(""))).toMatchObject({
    error: { code: "E_OUTPUT_EXISTS" },
  });
  for (const args of [
    ["init", directory, "extra"],
    ["init", "--write"],
    ["init", "--overwrite"],
  ]) {
    expect(await run([...args, "--json"])).toBe(3);
  }
});

it("rolls back files from a partially failed initialization and preserves an existing directory", async () => {
  const directory = await temp();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.open)
    .mockImplementationOnce(actual.open)
    .mockRejectedValueOnce(new Error("disk full"));
  await expect(initDeck(directory)).rejects.toMatchObject({ code: "E_IO" });
  expect(await readdir(directory)).toEqual([]);
});
