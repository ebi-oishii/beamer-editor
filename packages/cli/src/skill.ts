import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { LintOptions } from "@beamer-editor/core";
import { CLI_VERSION } from "./version.ts";

/** Find the nearest project skill, starting at the deck (not the invocation cwd). */
export async function skillLintOptions(input: string): Promise<LintOptions> {
  let directory = dirname(resolve(input));
  for (;;) {
    const path = join(directory, ".claude/skills/beamer-deck/SKILL.md");
    try {
      const source = await readFile(path, "utf8");
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
      const version = frontmatter?.match(/^ {2}cli-version: "([^"\r\n]+)"\s*$/m)?.[1];
      return { skillVersion: version ?? null, expectedSkillVersion: CLI_VERSION };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return {};
    directory = parent;
  }
}
