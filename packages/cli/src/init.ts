import { lstat, mkdir, open, readdir, readFile, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CURRENT_DECK_SOURCE_VERSION } from "@beamer-editor/core";

export class InitError extends Error {
  constructor(
    readonly code: "E_OUTPUT_EXISTS" | "E_IO",
    message: string,
  ) {
    super(message);
  }
}

/** Inline the canonical macros: the generated source compiles independently of the repository. */
export async function initialDeckSource(): Promise<string> {
  const preamble = await Promise.all(
    ["deck-canvas-preamble.tex", "deck-style-preamble.tex"].map((name) =>
      readFile(new URL(`../../../fixtures/${name}`, import.meta.url), "utf8"),
    ),
  );
  return String.raw`\documentclass[aspectratio=169]{beamer}
%% deck-source-version: ${CURRENT_DECK_SOURCE_VERSION}
% ---- ツール管理プリアンブル: 編集は macros / style / preamble-extra 領域へ ----
\usetheme{default}
\setbeamertemplate{navigation symbols}{}
\usepackage{graphicx,amsmath,amssymb,booktabs,hyperref}
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
export async function initDeck(directory: string): Promise<{ directory: string; files: string[] }> {
  const target = resolve(directory);
  const files: Record<string, string> = { "main.slide.tex": await initialDeckSource() };
  for (const name of [
    "SKILL.md",
    "references/subset-cheatsheet.md",
    "references/cli.md",
    "examples/prompts.md",
  ]) {
    files[`.claude/skills/beamer-deck/${name}`] = await readFile(
      new URL(`../../../skills/beamer-deck/${name}`, import.meta.url),
      "utf8",
    );
  }
  let exists = false;
  try {
    const stat = await lstat(target);
    exists = true;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(target)).length > 0) {
      throw new InitError("E_OUTPUT_EXISTS", `空のディレクトリを指定してください: ${target}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const createdFiles: string[] = [];
  const createdDirectories: string[] = [];
  try {
    if (!exists) {
      await mkdir(dirname(target), { recursive: true });
      await mkdir(target);
      createdDirectories.push(target);
    }
    for (const name of [
      "assets",
      ".claude",
      ".claude/skills",
      ".claude/skills/beamer-deck",
      ".claude/skills/beamer-deck/references",
      ".claude/skills/beamer-deck/examples",
    ]) {
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
      `初期化に失敗しました: ${target}: ${String(error)}`,
    );
  }
}
