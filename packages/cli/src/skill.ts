import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { LintOptions } from "@beamer-editor/core";
import { GENERATED_SKILL_FINGERPRINT } from "./generated-skill-fingerprint.ts";

async function isGitRoot(directory: string): Promise<boolean> {
  try {
    await stat(join(directory, ".git"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Find the nearest project skill, starting at the deck (not the invocation cwd). */
export async function skillLintOptions(input: string): Promise<LintOptions> {
  let directory = dirname(resolve(input));
  const home = resolve(homedir());
  for (;;) {
    const path = join(directory, ".claude/skills/beamer-deck/SKILL.md");
    try {
      const source = await readFile(path, "utf8");
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
      const fingerprint = frontmatter?.match(/^ {2}fingerprint: "([a-f0-9]{64})"\s*$/m)?.[1];
      return {
        skillFingerprint: fingerprint ?? null,
        expectedSkillFingerprint: GENERATED_SKILL_FINGERPRINT,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (directory === home || (await isGitRoot(directory))) return {};
    const parent = dirname(directory);
    if (parent === directory) return {};
    directory = parent;
  }
}
