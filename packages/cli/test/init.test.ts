import * as fs from "node:fs/promises";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDeck, framesOf, lintSource, parseDeck } from "@beamer-editor/core";
import { afterEach, expect, it, vi } from "vitest";
import { run } from "../src/cli.ts";
import { initDeck, initialDeckSource } from "../src/init.ts";
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

it("inlines the canonical non-fixture managed preamble", async () => {
  const source = await initialDeckSource();
  for (const name of [
    "deck-managed-header.tex",
    "deck-canvas-preamble.tex",
    "deck-style-preamble.tex",
  ]) {
    const canonical = await readFile(
      new URL(`../../core/resources/${name}`, import.meta.url),
      "utf8",
    );
    expect(source).toContain(canonical.trimEnd());
  }
  expect(source).not.toContain("\\input{deck-canvas-preamble}");
  expect(source).not.toContain("最終的には deck init");
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

it("updates only the bundled skill in an existing initialized project", async () => {
  const directory = join(await temp(), "project");
  await initDeck(directory);
  await writeFile(join(directory, "assets", "keep.txt"), "keep");
  await writeFile(join(directory, ".claude/skills/beamer-deck/SKILL.md"), "stale");
  const result = await initDeck(directory, { updateSkill: true });
  expect(result.files).toEqual(expect.arrayContaining([".claude/skills/beamer-deck/SKILL.md"]));
  expect(await readFile(join(directory, "assets", "keep.txt"), "utf8")).toBe("keep");
  expect(await readFile(join(directory, ".claude/skills/beamer-deck/SKILL.md"), "utf8")).toContain(
    "cli-version",
  );
});

it("recreates a missing bundled skill tree", async () => {
  const directory = join(await temp(), "project");
  await initDeck(directory);
  await rm(join(directory, ".claude"), { recursive: true, force: true });
  await initDeck(directory, { updateSkill: true });
  expect(await readFile(join(directory, ".claude/skills/beamer-deck/SKILL.md"), "utf8")).toContain(
    "cli-version",
  );
});

it("refuses symlinks while updating a skill without changing their targets", async () => {
  const directory = join(await temp(), "project");
  await initDeck(directory);
  const outside = join(await temp(), "outside.txt");
  await writeFile(outside, "keep");
  const skill = join(directory, ".claude/skills/beamer-deck/SKILL.md");
  await rm(skill);
  await symlink(outside, skill);
  await expect(initDeck(directory, { updateSkill: true })).rejects.toMatchObject({
    code: "E_OUTPUT_EXISTS",
  });
  expect(await readFile(outside, "utf8")).toBe("keep");
});

it("does not replace any skill file when staging an update fails", async () => {
  const directory = join(await temp(), "project");
  const result = await initDeck(directory);
  const skillFiles = result.files.filter((file) => file.includes("beamer-deck"));
  const before = await Promise.all(
    skillFiles.map((file) => readFile(join(directory, file), "utf8")),
  );
  vi.mocked(fs.open).mockResolvedValueOnce({
    writeFile: vi.fn().mockRejectedValue(new Error("disk full")),
    close: vi.fn(),
  } as never);
  await expect(initDeck(directory, { updateSkill: true })).rejects.toMatchObject({ code: "E_IO" });
  expect(
    await Promise.all(skillFiles.map((file) => readFile(join(directory, file), "utf8"))),
  ).toEqual(before);
  expect(
    (await readdir(join(directory, ".claude/skills/beamer-deck"))).some((name) =>
      name.includes(".deck-update-"),
    ),
  ).toBe(false);
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
    ["init", join(directory, "extra-target"), "extra"],
    ["init", join(directory, "write-target"), "--write"],
    ["init", join(directory, "overwrite-target"), "--overwrite"],
  ]) {
    stdout.mockClear();
    stderr.mockClear();
    expect(await run([...args, "--json"])).toBe(3);
    expect(stdout).not.toHaveBeenCalled();
    expect(JSON.parse(stderr.mock.calls.map((c) => c[0]).join(""))).toMatchObject({
      error: { code: "E_USAGE" },
    });
    await expect(lstat(args[1] as string)).rejects.toMatchObject({ code: "ENOENT" });
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

it("rolls back every newly created ancestor after a nested initialization failure", async () => {
  const root = await temp();
  const directory = join(root, "one", "two", "deck");
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.open)
    .mockImplementationOnce(actual.open)
    .mockRejectedValueOnce(new Error("disk full"));
  await expect(initDeck(directory)).rejects.toMatchObject({ code: "E_IO" });
  expect(await readdir(root)).toEqual([]);
});
