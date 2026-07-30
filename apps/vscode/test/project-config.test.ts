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
const workspaceSettings = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../.vscode/settings.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;
const vscodeIgnore = readFileSync(
  fileURLToPath(new URL("../.vscodeignore", import.meta.url)),
  "utf8",
);

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

  it("disables LaTeX Workshop automatic builds in this workspace", () => {
    expect(workspaceSettings["latex-workshop.latex.autoBuild.run"]).toBe("never");
  });
});
