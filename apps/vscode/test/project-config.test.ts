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

  it("declares the managed slide-file default without disabling LaTeX Workshop auto-build", () => {
    const contributes = packageJson.contributes as {
      configuration: { properties: Record<string, unknown> };
    };
    expect(contributes.configuration.properties["beamerEditor.managedFiles"]).toMatchObject({
      default: DEFAULT_MANAGED_FILE_PATTERNS,
      scope: "resource",
    });
    const settingsPath = fileURLToPath(new URL("../../../.vscode/settings.json", import.meta.url));
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    expect(settings["latex-workshop.latex.autoBuild.run"]).not.toBe("never");
  });
});
