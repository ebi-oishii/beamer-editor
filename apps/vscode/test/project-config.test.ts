import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_MANAGED_FILE_PATTERNS } from "../src/managed-files";

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

  it("declares the preview command icon and editor-title placement contract", () => {
    const contributes = packageJson.contributes as {
      commands: Array<{ command: string; title: string; icon?: string }>;
      menus: { "editor/title": Array<{ command: string; when?: string; group?: string }> };
    };
    expect(contributes.commands).toContainEqual({
      command: "beamerEditor.openPreview",
      title: "Beamer Editor: Open Preview",
      icon: "$(open-preview)",
    });
    expect(contributes.menus["editor/title"]).toContainEqual({
      command: "beamerEditor.openPreview",
      when: "resourceScheme == file && resourceExtname == .tex",
      group: "navigation",
    });
  });

  it("keeps ordinary LaTeX auto-build enabled while ignoring only repository fixtures", () => {
    const fixtureGlob = "**/fixtures/**/*.tex";
    expect(workspaceSettings).not.toHaveProperty("latex-workshop.latex.autoBuild.run");
    expect(workspaceSettings["latex-workshop.latex.watch.files.ignore"]).toEqual([
      ...WATCH_IGNORE_DEFAULTS_10_16_1,
      fixtureGlob,
    ]);
    expect(workspaceSettings["latex-workshop.latex.autoBuild.onSave.files.ignore"]).toEqual([
      ...AUTO_BUILD_ON_SAVE_IGNORE_DEFAULTS_10_16_1,
      fixtureGlob,
    ]);
  });

  it("declares the managed slide-file default without disabling LaTeX Workshop auto-build", () => {
    const contributes = packageJson.contributes as {
      configuration: { properties: Record<string, unknown> };
    };
    expect(contributes.configuration.properties["beamerEditor.managedFiles"]).toMatchObject({
      default: DEFAULT_MANAGED_FILE_PATTERNS,
      scope: "resource",
    });
  });
});
