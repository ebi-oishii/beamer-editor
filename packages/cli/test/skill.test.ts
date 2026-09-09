import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lintSource } from "@beamer-editor/core";
import { afterEach, expect, it, vi } from "vitest";
import { run, USAGE } from "../src/cli.ts";
import { skillLintOptions } from "../src/skill.ts";
import { buildSkillFiles } from "../src/skill-generator.ts";
import { CLI_VERSION } from "../src/version.ts";

const root = resolve(import.meta.dirname, "../../..");
const directories: string[] = [];
const source =
  "%% deck-source-version: 1\n\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}{Test}Hello\\end{frame}\n\\end{document}\n";
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("generates deterministic, portable artifacts and propagates spec and version changes", async () => {
  const input = {
    subsetSpec: await readFile(join(root, "docs/subset-spec.md"), "utf8"),
    protocol: await readFile(join(root, "docs/ai-protocol.md"), "utf8"),
    cliUsage: USAGE,
    version: CLI_VERSION,
  };
  const files = buildSkillFiles(input);
  expect(buildSkillFiles(input)).toEqual(files);
  for (const directory of ["skills/beamer-deck", ".claude/skills/beamer-deck"]) {
    for (const [path, content] of Object.entries(files)) {
      expect(await readFile(join(root, directory, path), "utf8")).toBe(content);
    }
  }
  const changed = buildSkillFiles({
    ...input,
    version: "9.8.7",
    subsetSpec: input.subsetSpec.replace("ネスト 3 段まで", "ネスト 2 段まで"),
  });
  expect(changed["references/subset-cheatsheet.md"]).toContain("ネスト 2 段まで");
  expect(changed["SKILL.md"]).toContain('cli-version: "9.8.7"');
  expect(files["references/subset-cheatsheet.md"]).not.toMatch(
    /\]\((?:theme-design|ai-protocol)\.md/,
  );
});

it("finds nearest bundled skill relative to the deck; missing, matching, unknown and stale versions differ", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beamer-skill-"));
  directories.push(directory);
  const nested = join(directory, "slides");
  await mkdir(nested);
  const deck = join(nested, "test.slide.tex");
  await writeFile(deck, source);
  expect(await skillLintOptions(deck)).toEqual({});
  const skill = join(directory, ".claude/skills/beamer-deck");
  await mkdir(skill, { recursive: true });
  for (const version of [CLI_VERSION, "0.0.0", null]) {
    await writeFile(
      join(skill, "SKILL.md"),
      version === null
        ? "---\nname: beamer-deck\n---\n"
        : `---\nmetadata:\n  cli-version: "${version}"\n---\n`,
    );
    const options = await skillLintOptions(deck);
    expect(options.skillVersion).toBe(version);
    expect(lintSource(source, options).filter((d) => d.code === "L010")).toHaveLength(
      version === CLI_VERSION ? 0 : 1,
    );
  }
  const closer = join(nested, ".claude/skills/beamer-deck");
  await mkdir(closer, { recursive: true });
  await writeFile(
    join(closer, "SKILL.md"),
    `---\nmetadata:\n  cli-version: "${CLI_VERSION}"\n---\n`,
  );
  expect((await skillLintOptions(deck)).skillVersion).toBe(CLI_VERSION);
});

it("deck lint exposes L010 as a warning with JSON and text exit status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beamer-skill-cli-"));
  directories.push(directory);
  const skill = join(directory, ".claude/skills/beamer-deck");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), '---\nmetadata:\n  cli-version: "0.0.0"\n---\n');
  const deck = join(directory, "test.slide.tex");
  await writeFile(deck, source);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  expect(await run(["lint", deck, "--json"])).toBe(1);
  const output = JSON.parse(stdout.mock.calls.map((c) => c[0]).join(""));
  expect(output.diagnostics).toContainEqual(
    expect.objectContaining({ code: "L010", severity: "warning" }),
  );
  stdout.mockClear();
  expect(await run(["lint", deck])).toBe(1);
  expect(stdout.mock.calls.map((c) => c[0]).join("")).toContain("warning L010");
});
