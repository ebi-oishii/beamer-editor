import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;
const tasks = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../.vscode/tasks.json", import.meta.url)), "utf8"),
) as {
  tasks: Array<{
    command: string;
    problemMatcher: Array<{
      background: {
        activeOnStart: boolean;
        beginsPattern: string;
        endsPattern: string;
      };
    }>;
  }>;
};
const vscodeIgnore = readFileSync(
  fileURLToPath(new URL("../.vscodeignore", import.meta.url)),
  "utf8",
);
const workspaceSettings = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../.vscode/settings.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;
const WATCH_IGNORE_DEFAULTS_10_16_1 = [
  "**/*.aux",
  "**/*.bbx",
  "**/*.bbl",
  "**/*.cbx",
  "**/*.cfg",
  "**/*.clo",
  "**/*.cnf",
  "**/*.def",
  "**/*.dfu",
  "**/*.enc",
  "**/*.fd",
  "**/*.fmt",
  "**/*.gls",
  "**/*.lbx",
  "**/*.map",
  "**/*.mkii",
  "**/*.out",
  "**/*.pfb",
  "**/*.tfm",
  "**/*.vf",
  "**/*.code.tex",
  "**/*.sty",
  "**/texmf-{dist,var}/**",
  "**/Local/MiKTeX/**",
  "**/Local/Programs/MiKTeX/**",
  "**/Roaming/MiKTeX/**",
  "**/Program*/MiKTeX*/**",
  "**/.miktex/texmfs/**",
  "/var/cache/miktex-texmf/**",
  "/usr/local/share/miktex-texmf/**",
  "**/Library/Application Support/MiKTeX/texmfs/**",
  "/dev/null",
] as const;
const AUTO_BUILD_ON_SAVE_IGNORE_DEFAULTS_10_16_1 = ["**/*.sty", "**/*.cls"] as const;

describe("VS Code extension project configuration", () => {
  it("uses the approved extension ID and F5 watch task readiness protocol", () => {
    expect(`${packageJson.publisher}.${packageJson.name}`).toBe("ebi-oishii.beamer-editor");

    const watchTask = tasks.tasks.find((task) => task.command.includes("watch"));
    expect(watchTask?.command).toBe("pnpm --filter ./apps/vscode watch");
    expect(watchTask?.problemMatcher[0]?.background).toEqual({
      activeOnStart: false,
      beginsPattern: "^Starting watch mode$",
      endsPattern: "^Watch mode enabled$",
    });
  });

  it("excludes source maps from packaged extensions", () => {
    expect(vscodeIgnore).toContain("**/*.map");
  });

  it("keeps ordinary LaTeX auto-build enabled while ignoring only repository fixtures", () => {
    const fixtureGlob = "**/fixtures/**/*.tex";
    expect(workspaceSettings).not.toHaveProperty("latex-workshop.latex.autoBuild.run");
    expect(workspaceSettings["latex-workshop.latex.watch.files.ignore"]).toEqual(
      expect.arrayContaining([...WATCH_IGNORE_DEFAULTS_10_16_1, fixtureGlob]),
    );
    expect(workspaceSettings["latex-workshop.latex.autoBuild.onSave.files.ignore"]).toEqual(
      expect.arrayContaining([...AUTO_BUILD_ON_SAVE_IGNORE_DEFAULTS_10_16_1, fixtureGlob]),
    );
    expect(workspaceSettings["latex-workshop.latex.autoBuild.onSave.files.ignore"]).toEqual([
      ...AUTO_BUILD_ON_SAVE_IGNORE_DEFAULTS_10_16_1,
      fixtureGlob,
    ]);
  });
});
