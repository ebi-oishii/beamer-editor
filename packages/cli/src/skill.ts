import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { LintOptions } from "@beamer-editor/core";
import { GENERATED_SKILL_FINGERPRINT } from "./generated-skill-fingerprint.ts";
import { SKILL_FILE_PATHS, type SkillFilePath, skillFingerprint } from "./skill-generator.ts";

const skillRelativeDirectory = ".claude/skills/beamer-deck";

async function canonicalOrLexical(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

/** An inaccessible or malformed Git marker is a boundary: never search past it. */
async function isGitBoundary(directory: string): Promise<boolean> {
  try {
    await stat(join(directory, ".git"));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function readBundledSkill(projectDirectory: string): Promise<LintOptions | undefined> {
  const skillDirectory = join(projectDirectory, skillRelativeDirectory);
  try {
    await stat(skillDirectory);
  } catch {
    // 同梱物の有無を確かめられない(存在しない・種類が違う・辿れない)。同梱なしとして扱う。
    // ここで「古い同梱物あり」にすると、スキルを持たないデッキに L010 が出て lint が 1 で終わる。
    return undefined;
  }

  try {
    const files = {} as Record<SkillFilePath, string>;
    for (const path of SKILL_FILE_PATHS) {
      files[path] = await readFile(join(skillDirectory, path), "utf8");
    }
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(files["SKILL.md"])?.[1];
    const declared = frontmatter?.match(/^ {2}fingerprint: "([a-f0-9]{64})"\s*$/m)?.[1] ?? null;
    return skillOptions(projectDirectory, declared, skillFingerprint(files));
  } catch {
    // A discovered bundle that cannot be read is stale, but never prevents lint/check.
    return skillOptions(projectDirectory, null, null);
  }
}

function skillOptions(
  skillProjectDirectory: string,
  skillFingerprint: string | null,
  skillContentFingerprint: string | null,
): LintOptions {
  return {
    skillFingerprint,
    skillContentFingerprint,
    expectedSkillFingerprint: GENERATED_SKILL_FINGERPRINT,
    skillProjectDirectory,
  };
}

/**
 * Find the nearest project skill, starting at the deck (not the invocation cwd).
 * `skillProjectDirectory` is the directory that `deck init <dir> --update-skill` must receive.
 */
export async function skillLintOptions(input: string): Promise<LintOptions> {
  let directory = await canonicalOrLexical(dirname(resolve(input)));
  const home = await canonicalOrLexical(homedir());
  for (;;) {
    // A user-level skill is not a bundled project skill.
    if (directory === home) return {};
    const bundled = await readBundledSkill(directory);
    if (bundled) return bundled;
    if (await isGitBoundary(directory)) return {};
    const parent = dirname(directory);
    if (parent === directory) return {};
    directory = parent;
  }
}
