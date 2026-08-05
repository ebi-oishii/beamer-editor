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
    expect(workspaceSettings["latex-workshop.latex.autoBuild.run"]).not.toBe("never");
    expect(workspaceSettings["latex-workshop.latex.watch.files.ignore"]).toEqual([fixtureGlob]);
    expect(workspaceSettings["latex-workshop.latex.autoBuild.onSave.files.ignore"]).toEqual([
      fixtureGlob,
    ]);
  });
});
