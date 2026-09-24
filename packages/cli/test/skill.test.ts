import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { lintSource } from "@beamer-editor/core";
import { afterEach, expect, it, vi } from "vitest";
import { run, USAGE } from "../src/cli.ts";
import { GENERATED_SKILL_FINGERPRINT } from "../src/generated-skill-fingerprint.ts";
import { skillLintOptions } from "../src/skill.ts";
import {
  buildProjectInstructions,
  buildSkillFiles,
  PROJECT_INSTRUCTIONS_PATH,
  SKILL_DIRECTORIES,
  skillFingerprint,
} from "../src/skill-generator.ts";
import { CLI_VERSION } from "../src/version.ts";

const root = resolve(import.meta.dirname, "../../..");
const directories: string[] = [];
const source =
  "%% deck-source-version: 1\n\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}{Test}Hello\\end{frame}\n\\end{document}\n";
async function writeBundle(
  directory: string,
  fingerprint = GENERATED_SKILL_FINGERPRINT,
): Promise<void> {
  const files = buildSkillFiles({
    subsetSpec: await readFile(join(root, "docs/subset-spec.md"), "utf8"),
    protocol: await readFile(join(root, "docs/ai-protocol.md"), "utf8"),
    cliUsage: USAGE,
    version: CLI_VERSION,
  });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(
      join(directory, path),
      path === "SKILL.md" ? content.replace(GENERATED_SKILL_FINGERPRINT, fingerprint) : content,
    );
  }
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
  expect(SKILL_DIRECTORIES).toEqual([
    "skills/beamer-deck",
    ".claude/skills/beamer-deck",
    ".agents/skills/beamer-deck",
  ]);
  for (const directory of SKILL_DIRECTORIES) {
    for (const [path, content] of Object.entries(files)) {
      expect(await readFile(join(root, directory, path), "utf8")).toBe(content);
    }
  }
  expect(await readFile(join(root, PROJECT_INSTRUCTIONS_PATH), "utf8")).toBe(
    buildProjectInstructions(input.protocol),
  );
  const changed = buildSkillFiles({
    ...input,
    version: "9.8.7",
    subsetSpec: input.subsetSpec.replace("ネスト 3 段まで", "ネスト 2 段まで"),
  });
  expect(changed["references/subset-cheatsheet.md"]).toContain("ネスト 2 段まで");
  expect(changed["SKILL.md"]).toContain('cli-version: "9.8.7"');
  expect(changed["SKILL.md"]).toMatch(/^ {2}fingerprint: "[a-f0-9]{64}"$/m);
  const generatedSkill = files["SKILL.md"];
  const changedSkill = changed["SKILL.md"];
  expect(generatedSkill).toBeDefined();
  expect(changedSkill).toBeDefined();
  expect(skillFingerprint(files)).toBe(
    generatedSkill?.match(/^ {2}fingerprint: "([a-f0-9]{64})"$/m)?.[1],
  );
  expect(skillFingerprint(changed)).toBe(
    changedSkill?.match(/^ {2}fingerprint: "([a-f0-9]{64})"$/m)?.[1],
  );
  expect(skillFingerprint(changed)).not.toBe(skillFingerprint(files));
  for (const path of ["references/subset-cheatsheet.md", "examples/prompts.md"] as const) {
    expect(files[path]).not.toMatch(/\]\((?:theme-design|ai-protocol)\.md/);
  }
  expect(files["references/cli.md"]).toContain("deck snapshot");
  expect(files["references/cli.md"]).not.toContain("snapshot等");
});

it("steers agents to canvas objects, deck export, and pptx only on explicit request", async () => {
  const files = buildSkillFiles({
    subsetSpec: await readFile(join(root, "docs/subset-spec.md"), "utf8"),
    protocol: await readFile(join(root, "docs/ai-protocol.md"), "utf8"),
    cliUsage: USAGE,
    version: CLI_VERSION,
  });
  const description = files["SKILL.md"].split("\n---\n")[0];
  for (const phrase of ["プレビュー", "PDF", "pptx"]) expect(description).toContain(phrase);
  for (const phrase of [
    "decktext",
    "deck export <file> --format pdf -o <pdf>",
    "明示したときだけ",
  ]) {
    expect(files["SKILL.md"]).toContain(phrase);
  }
  for (const pattern of ["プレビューで動かす", "PDF 出力", "pptx の明示"]) {
    expect(files["examples/prompts.md"]).toContain(`| ${pattern} |`);
  }
});

it("keeps canvas warnings from counting as done, since lint exits with only a warning", async () => {
  const protocol = await readFile(join(root, "docs/ai-protocol.md"), "utf8");
  const files = buildSkillFiles({
    subsetSpec: await readFile(join(root, "docs/subset-spec.md"), "utf8"),
    protocol,
    cliUsage: USAGE,
    version: CLI_VERSION,
  });
  const loop = files["SKILL.md"].split("## 作業ループ")[1]?.split("\n## ")[0] ?? "";
  for (const guidance of [loop, buildProjectInstructions(protocol)]) {
    for (const code of ["L011", "L012", "L014", "L018", "L019", "canvas-overflow"])
      expect(guidance).toContain(code);
    expect(guidance).toContain("完了にしない");
  }
  // The listed codes must stay warnings; if one becomes an error, the extra rule is redundant.
  const severities = lintSource(
    [
      "\\documentclass[aspectratio=43]{beamer}",
      "%% deck-source-version: 1",
      "\\begin{document}",
      "\\begin{frame}{Title}",
      "\\begin{deckcanvas}",
      "\\begin{decktext}[x=0.800,y=0.100,w=0.400]",
      "\\begin{block}{B}x\\end{block}",
      "\\end{decktext}",
      "\\end{deckcanvas}",
      "\\end{frame}",
      "\\end{document}",
      "",
    ].join("\n"),
  );
  for (const code of ["L011", "L012", "L014", "L018"])
    expect(severities.find((d) => d.code === code)?.severity).toBe("warning");
});

it("gives one PDF export instruction: absolute paths with an explicit -o", async () => {
  const protocol = await readFile(join(root, "docs/ai-protocol.md"), "utf8");
  const files = buildSkillFiles({
    subsetSpec: await readFile(join(root, "docs/subset-spec.md"), "utf8"),
    protocol,
    cliUsage: USAGE,
    version: CLI_VERSION,
  });
  expect(files["references/cli.md"]).toContain("出力先を省略しない");
  // cli.md forbids omitting the output, so no other guidance may show an export without -o.
  for (const content of [...Object.values(files), buildProjectInstructions(protocol)]) {
    expect(content).not.toMatch(/--format pdf(?! \[?-o )/);
  }
});

it("resolves a symlinked deck directory before finding its bundled skill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beamer-skill-symlink-"));
  directories.push(directory);
  const repository = join(directory, "repository");
  const slides = join(repository, "slides");
  const skill = join(repository, ".claude/skills/beamer-deck");
  await mkdir(slides, { recursive: true });
  await mkdir(join(repository, ".git"));
  await mkdir(skill, { recursive: true });
  await writeBundle(skill);
  const linkedRepository = join(directory, "linked-repository");
  await symlink(repository, linkedRepository, "dir");
  const deck = join(linkedRepository, "slides/test.slide.tex");
  await writeFile(join(slides, "test.slide.tex"), source);
  expect(await skillLintOptions(deck)).toEqual({
    skillFingerprint: GENERATED_SKILL_FINGERPRINT,
    skillContentFingerprint: GENERATED_SKILL_FINGERPRINT,
    expectedSkillFingerprint: GENERATED_SKILL_FINGERPRINT,
    // Canonical, not the symlink: `deck init <dir> --update-skill` refuses a symlinked target.
    skillProjectDirectory: await realpath(repository),
  });
});

it("does not search past the nearest Git repository boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beamer-skill-git-"));
  directories.push(directory);
  const repository = join(directory, "repository");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(join(directory, ".claude/skills/beamer-deck"), { recursive: true });
  await writeFile(
    join(directory, ".claude/skills/beamer-deck/SKILL.md"),
    '---\nmetadata:\n  fingerprint: "0000000000000000000000000000000000000000000000000000000000000000"\n---\n',
  );
  const deck = join(repository, "test.slide.tex");
  await writeFile(deck, source);
  expect(await skillLintOptions(deck)).toEqual({});
});

it("finds nearest bundled skill relative to the deck; missing, matching, unknown and stale fingerprints differ", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beamer-skill-"));
  directories.push(directory);
  const nested = join(directory, "slides");
  await mkdir(nested);
  const deck = join(nested, "test.slide.tex");
  await writeFile(deck, source);
  expect(await skillLintOptions(deck)).toEqual({});
  const skill = join(directory, ".claude/skills/beamer-deck");
  await mkdir(skill, { recursive: true });
  const fingerprint = (await readFile(join(root, "skills/beamer-deck/SKILL.md"), "utf8")).match(
    /^ {2}fingerprint: "([a-f0-9]{64})"$/m,
  )?.[1];
  expect(fingerprint).toBeDefined();
  for (const value of [fingerprint, "0".repeat(64), null]) {
    await writeBundle(skill, value ?? "f".repeat(64));
    if (value === null) await writeFile(join(skill, "SKILL.md"), "---\nname: beamer-deck\n---\n");
    const options = await skillLintOptions(deck);
    expect(options.skillFingerprint).toBe(value);
    expect(lintSource(source, options).filter((d) => d.code === "L010")).toHaveLength(
      value === fingerprint ? 0 : 1,
    );
  }
  const closer = join(nested, ".claude/skills/beamer-deck");
  await mkdir(closer, { recursive: true });
  await writeBundle(closer, fingerprint);
  expect((await skillLintOptions(deck)).skillFingerprint).toBe(fingerprint);
});

it("deck lint exposes L010 as a warning with JSON and text exit status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beamer-skill-cli-"));
  directories.push(directory);
  const skill = join(directory, ".claude/skills/beamer-deck");
  await mkdir(skill, { recursive: true });
  await writeBundle(skill, "0".repeat(64));
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

it("verifies bundled file contents, not only the recorded fingerprint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beamer-skill-content-"));
  directories.push(directory);
  const skill = join(directory, ".claude/skills/beamer-deck");
  await writeBundle(skill);
  await writeFile(join(skill, "references/cli.md"), "unrelated\n");
  const deck = join(directory, "test.slide.tex");
  await writeFile(deck, source);
  const options = await skillLintOptions(deck);
  expect(options.skillFingerprint).toBe(GENERATED_SKILL_FINGERPRINT);
  expect(options.skillContentFingerprint).not.toBe(GENERATED_SKILL_FINGERPRINT);
  expect(lintSource(source, options).filter((d) => d.code === "L010")).toHaveLength(1);
});

it("never fails lint because skill discovery fails, and ignores a user-level skill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beamer-skill-discovery-"));
  directories.push(directory);
  const nested = join(directory, "slides");
  await mkdir(nested);
  const deck = join(nested, "test.slide.tex");
  await writeFile(deck, source);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);

  vi.stubEnv("HOME", "/nonexistent-home-beamer-skill");
  expect(await skillLintOptions(deck)).toEqual({});
  expect(await run(["lint", deck])).not.toBe(3);

  await writeFile(join(directory, ".claude"), "not a directory\n");
  expect(await skillLintOptions(deck)).toEqual({});
  expect(await run(["lint", deck])).not.toBe(3);

  await rm(join(directory, ".claude"));
  // 権限で辿れない .claude も「同梱なし」。root では chmod が効かないので飛ばす。
  if (process.getuid?.() !== 0) {
    await mkdir(join(directory, ".claude"));
    await chmod(join(directory, ".claude"), 0o000);
    expect(await skillLintOptions(deck)).toEqual({});
    expect(await run(["lint", deck])).not.toBe(3);
    await chmod(join(directory, ".claude"), 0o755);
    await rm(join(directory, ".claude"), { recursive: true });
  }

  await writeBundle(join(directory, ".claude/skills/beamer-deck"), "0".repeat(64));
  vi.stubEnv("HOME", directory);
  expect(await skillLintOptions(deck)).toEqual({});
});
