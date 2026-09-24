import { lstat, mkdir, open, readdir, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CURRENT_DECK_SOURCE_VERSION } from "@beamer-editor/core";
import { GENERATED_SKILL_FINGERPRINT } from "./generated-skill-fingerprint.ts";
import {
  PROJECT_INSTRUCTIONS_PATH,
  PROJECT_SKILL_DIRECTORIES,
  SKILL_FILE_PATHS,
  type SkillFilePath,
  skillFingerprint,
} from "./skill-generator.ts";

export class InitError extends Error {
  constructor(
    readonly code: "E_OUTPUT_EXISTS" | "E_IO",
    message: string,
  ) {
    super(message);
  }
}

/**
 * The committed `buildSkillFiles` output (kept current by `pnpm check:skills`). Refuse to install a
 * bundle whose content does not match the fingerprint lint expects, so init never creates L010.
 */
async function generatedSkillFiles(): Promise<Record<SkillFilePath, string>> {
  const files = {} as Record<SkillFilePath, string>;
  for (const name of SKILL_FILE_PATHS) {
    files[name] = await readFile(
      new URL(`../../../skills/beamer-deck/${name}`, import.meta.url),
      "utf8",
    );
  }
  if (skillFingerprint(files) !== GENERATED_SKILL_FINGERPRINT)
    throw new InitError("E_IO", "同梱スキルの生成物が古いため中止しました (pnpm build:skills)");
  return files;
}

/**
 * Always-read agent instructions: AGENTS.md for Codex, and a CLAUDE.md that imports it so the
 * rules live in one file. Users may extend both, so they are never fingerprinted or overwritten.
 */
async function projectInstructionFiles(): Promise<Record<string, string>> {
  return {
    "AGENTS.md": await readFile(
      new URL(`../../../${PROJECT_INSTRUCTIONS_PATH}`, import.meta.url),
      "utf8",
    ),
    "CLAUDE.md": "@AGENTS.md\n",
  };
}

/** Every agent's skill directory receives the same generated files. */
function projectSkillFiles(skill: Record<SkillFilePath, string>): Record<string, string> {
  const files: Record<string, string> = {};
  for (const root of PROJECT_SKILL_DIRECTORIES)
    for (const [name, content] of Object.entries(skill)) files[`${root}/${name}`] = content;
  return files;
}

/** Create missing ancestors one by one so rollback never removes an existing directory. */
async function createMissingParents(path: string, created: string[]): Promise<void> {
  const missing: string[] = [];
  for (let cursor = path; ; cursor = dirname(cursor)) {
    try {
      await lstat(cursor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(cursor);
    }
  }
  for (const directory of missing.reverse()) {
    await mkdir(directory);
    created.push(directory);
  }
}

/** Inline the canonical macros: the generated source compiles independently of the repository. */
export async function initialDeckSource(): Promise<string> {
  const preamble = await Promise.all(
    ["deck-managed-header.tex", "deck-canvas-preamble.tex", "deck-style-preamble.tex"].map((name) =>
      readFile(new URL(`../../core/resources/${name}`, import.meta.url), "utf8"),
    ),
  );
  return String.raw`\documentclass[aspectratio=169]{beamer}
%% deck-source-version: ${CURRENT_DECK_SOURCE_VERSION}
% ---- ツール管理プリアンブル: 編集は macros / style / preamble-extra 領域へ ----
${preamble.join("\n").trimEnd()}
% ---- ツール管理ここまで ----

%% macros:begin
%% macros:end

%% style:begin
%% style:end

%% preamble-extra:begin
%% preamble-extra:end

\title{My Presentation}
\author{}
\date{}

\begin{document}

\begin{frame}[label=title]
  \titlepage
\end{frame}

\begin{frame}[label=introduction]{Introduction}
  \begin{itemize}
    \item Your first point.
  \end{itemize}
\end{frame}

\end{document}
`;
}

/** New or empty directory only; exclusive writes and rollback preserve existing data. */
export async function initDeck(
  directory: string,
  options: { updateSkill?: boolean } = {},
): Promise<{ directory: string; files: string[] }> {
  const target = resolve(directory);
  if (options.updateSkill) return updateSkill(target);
  const files: Record<string, string> = {
    "main.slide.tex": await initialDeckSource(),
    ...(await projectInstructionFiles()),
    ...projectSkillFiles(await generatedSkillFiles()),
  };
  let exists = false;
  try {
    const info = await lstat(target);
    exists = true;
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(target)).length > 0) {
      throw new InitError("E_OUTPUT_EXISTS", `空のディレクトリを指定してください: ${target}`);
    }
  } catch (error) {
    if (error instanceof InitError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new InitError(
        "E_IO",
        `出力先を確認できません: ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
  }
  const createdFiles: string[] = [];
  const createdDirectories: string[] = [];
  try {
    if (!exists) {
      await createMissingParents(dirname(target), createdDirectories);
      await mkdir(target);
      createdDirectories.push(target);
    }
    const directories = new Set(["assets"]);
    for (const name of Object.keys(files)) {
      let parent = dirname(name);
      while (parent !== ".") {
        directories.add(parent);
        parent = dirname(parent);
      }
    }
    for (const name of [...directories].sort((a, b) => a.split("/").length - b.split("/").length)) {
      const path = join(target, name);
      await mkdir(path);
      createdDirectories.push(path);
    }
    for (const [name, content] of Object.entries(files)) {
      const path = join(target, name);
      // Track only files that this invocation created, even if writing later fails.
      const handle = await open(path, "wx");
      createdFiles.push(path);
      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
    }
    return { directory: target, files: Object.keys(files) };
  } catch (error) {
    for (const path of createdFiles.reverse()) await unlink(path).catch(() => {});
    for (const path of createdDirectories.reverse()) await rmdir(path).catch(() => {});
    throw new InitError(
      (error as NodeJS.ErrnoException).code === "EEXIST" ? "E_OUTPUT_EXISTS" : "E_IO",
      `初期化に失敗しました: ${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Refresh generated skill files in every agent's skill directory; decks, assets, and unrelated
 * project data stay untouched. Missing project instructions are created, existing ones are kept.
 * The target is the project directory that owns (or will own) the skill directories,
 * i.e. the directory L010 names. It need not contain a particular deck file.
 */
async function updateSkill(target: string): Promise<{ directory: string; files: string[] }> {
  const invalid = () =>
    new InitError("E_OUTPUT_EXISTS", `既存のディレクトリを指定してください: ${target}`);
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalid();
  } catch (error) {
    if (error instanceof InitError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw invalid();
    throw new InitError(
      "E_IO",
      `対象ディレクトリを確認できません: ${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const files = projectSkillFiles(await generatedSkillFiles());
  const directories = new Set<string>();
  for (const name of Object.keys(files))
    for (let parent = dirname(name); parent !== "."; parent = dirname(parent))
      directories.add(join(target, parent));
  const createdDirectories: string[] = [];
  for (const directory of [...directories].sort((a, b) => a.length - b.length)) {
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new InitError(
          "E_OUTPUT_EXISTS",
          `スキルの保存先が通常のディレクトリではありません: ${directory}`,
        );
    } catch (error) {
      if (error instanceof InitError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          await mkdir(directory);
          createdDirectories.push(directory);
          continue;
        } catch (mkdirError) {
          for (const created of createdDirectories.reverse()) await rmdir(created).catch(() => {});
          throw new InitError(
            "E_IO",
            `スキルの保存先を作成できません: ${directory}: ${mkdirError instanceof Error ? mkdirError.message : String(mkdirError)}`,
          );
        }
      }
      throw new InitError(
        "E_IO",
        `スキルの保存先を確認できません: ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const transaction = `${process.pid}-${Date.now()}`;
  const entries: Array<{
    path: string;
    staged: string;
    backup: string;
    existed: boolean;
    installed: boolean;
  }> = [];
  const createdInstructions: string[] = [];
  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(target, name);
      let existed = false;
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink())
          throw new InitError(
            "E_OUTPUT_EXISTS",
            `スキルファイルが通常のファイルではありません: ${path}`,
          );
        existed = true;
      } catch (error) {
        if (error instanceof InitError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const staged = `${path}.deck-update-${transaction}`;
      const backup = `${path}.deck-backup-${transaction}`;
      const handle = await open(staged, "wx");
      const entry = { path, staged, backup, existed, installed: false };
      entries.push(entry);
      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
    }
    for (const entry of entries) {
      if (entry.existed) await rename(entry.path, entry.backup);
      try {
        await rename(entry.staged, entry.path);
        entry.installed = true;
      } catch (error) {
        if (entry.existed) await rename(entry.backup, entry.path).catch(() => {});
        throw error;
      }
    }
    for (const [name, content] of Object.entries(await projectInstructionFiles())) {
      const path = join(target, name);
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(path, "wx");
      } catch (error) {
        // Any existing entry (even a symlink) belongs to the user: keep it as is.
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      createdInstructions.push(path);
      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
      files[name] = content;
    }
    for (const entry of entries) if (entry.existed) await unlink(entry.backup).catch(() => {});
    return { directory: target, files: Object.keys(files) };
  } catch (error) {
    for (const path of createdInstructions.reverse()) await unlink(path).catch(() => {});
    for (const entry of [...entries].reverse()) {
      await unlink(entry.staged).catch(() => {});
      if (entry.installed) await unlink(entry.path).catch(() => {});
      if (entry.existed) await rename(entry.backup, entry.path).catch(() => {});
    }
    for (const directory of createdDirectories.reverse()) await rmdir(directory).catch(() => {});
    if (error instanceof InitError) throw error;
    throw new InitError(
      "E_IO",
      `スキル更新に失敗しました: ${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
