import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { USAGE } from "../src/cli.ts";
import { buildSkillFiles } from "../src/skill-generator.ts";
import { CLI_VERSION } from "../src/version.ts";

const root = resolve(import.meta.dirname, "../../..");
const files = buildSkillFiles({
  subsetSpec: await readFile(resolve(root, "docs/subset-spec.md"), "utf8"),
  protocol: await readFile(resolve(root, "docs/ai-protocol.md"), "utf8"),
  cliUsage: USAGE,
  version: CLI_VERSION,
});
for (const directory of ["skills/beamer-deck", ".claude/skills/beamer-deck"]) {
  for (const [name, content] of Object.entries(files)) {
    const path = resolve(root, directory, name);
    if (process.argv.includes("--check")) {
      if ((await readFile(path, "utf8").catch(() => null)) !== content) {
        throw new Error(`生成物が古いか存在しません: ${path} (pnpm build:skills)`);
      }
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
  }
}
