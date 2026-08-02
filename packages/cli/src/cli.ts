/** `deck` command line entry point. */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formatDeck, type LintDiagnostic, lintDeck, parseDeck } from "@beamer-editor/core";
import { createNodeFileProbes } from "./file-probes.ts";
import {
  defaultFontPaths,
  type FetchResult,
  FONT_CATALOG,
  type FontResolution,
  fetchFont,
  nodeFontIO,
  resolveFont,
} from "./fonts.ts";

const DEFAULT_FAMILY = "Noto Sans CJK JP";

export interface ParsedArgs {
  command: string | undefined;
  sub: string | undefined;
  family: string | undefined;
  json: boolean;
  write: boolean;
  unknownOptions: string[];
}

/** Parses options independently of their position. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const unknownOptions: string[] = [];
  let json = false;
  let write = false;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg === "--write") write = true;
    else if (arg.startsWith("-")) unknownOptions.push(arg);
    else positional.push(arg);
  }
  const [command, sub, ...rest] = positional;
  return {
    command,
    sub,
    family: rest.length > 0 ? rest.join(" ") : undefined,
    json,
    write,
    unknownOptions,
  };
}

function resolutionToJson(r: FontResolution) {
  return {
    family: r.family,
    status: r.status,
    license: r.license,
    files: r.files.map((f) => ({
      fileName: f.fileName,
      inUserDir: f.inUserDir,
      inCache: f.inCache,
    })),
  };
}

function statusLine(r: FontResolution): string {
  const detail =
    r.status === "unknown-family"
      ? "(名前参照のみ・各自インストール)"
      : `${r.files.length} ファイル / ${r.license ?? "-"}`;
  return `  [${r.status.padEnd(14)}] ${r.family}  ${detail}`;
}

async function runFontsStatus(json: boolean): Promise<number> {
  const paths = defaultFontPaths();
  const resolutions: FontResolution[] = [];
  for (const entry of FONT_CATALOG)
    resolutions.push(await resolveFont(entry.family, paths, nodeFontIO));
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          cacheDir: paths.cacheDir,
          userFontDir: paths.userFontDir,
          fonts: resolutions.map(resolutionToJson),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  process.stdout.write(`フォント解決状態(cache: ${paths.cacheDir})\n`);
  if (resolutions.length === 0) process.stdout.write("  (カタログが空です)\n");
  for (const resolution of resolutions) process.stdout.write(`${statusLine(resolution)}\n`);
  return 0;
}

async function runFontsFetch(family: string, json: boolean): Promise<number> {
  const paths = defaultFontPaths();
  const before = await resolveFont(family, paths, nodeFontIO);
  if (before.status === "unknown-family") {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ family, status: "unknown-family", fetched: [], installed: [] }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(
        `未知のフォント family: ${family}\n` +
          "  カタログに無いフォントは名前参照のみです。各自でインストールしてください。\n",
      );
    }
    return 1;
  }
  const result: FetchResult = await fetchFont(family, paths, nodeFontIO);
  if (json) {
    process.stdout.write(`${JSON.stringify({ family, status: "ok", ...result }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`フォント取得: ${family}\n`);
  process.stdout.write(
    `  取得 ${result.fetched.length} / スキップ ${result.skipped.length} / 配置 ${result.installed.length}\n`,
  );
  for (const file of result.fetched) process.stdout.write(`  取得: ${file}\n`);
  for (const file of result.skipped) process.stdout.write(`  スキップ(キャッシュ済み): ${file}\n`);
  for (const file of result.installed) process.stdout.write(`  配置: ${file}\n`);
  if (paths.userFontDir === null)
    process.stdout.write("  (userFontDir 不明のため配置はスキップ・キャッシュのみ)\n");
  return 0;
}

const USAGE = `使い方: deck <command> ...

  deck lint <file> [--json]           デッキを検査
  deck format <file> [--write] [--json]  デッキを正規化
  deck fonts status [--json]          フォントカタログ全 family の解決状態
  deck fonts fetch [family] [--json]  family(既定 "${DEFAULT_FAMILY}")を取得・配置
`;

function writeError(code: "E_USAGE" | "E_IO" | "E_INTERNAL", message: string, json: boolean): void {
  if (json) {
    process.stderr.write(`${JSON.stringify({ error: { code, message } }, null, 2)}\n`);
  } else {
    process.stderr.write(`${message}\n`);
    if (code === "E_USAGE") process.stderr.write(USAGE);
  }
}

function location(source: string, offset: number) {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line, column: offset - lineStart + 1 };
}

function lintJson(file: string, source: string, diagnostics: readonly LintDiagnostic[]) {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  const entries = diagnostics.map((diagnostic) => {
    if (diagnostic.severity === "error") errors++;
    else if (diagnostic.severity === "warning") warnings++;
    else infos++;
    const start = location(source, diagnostic.span.start);
    const end = location(source, diagnostic.span.end);
    return {
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
      location: {
        line: start.line,
        column: start.column,
        endLine: end.line,
        endColumn: end.column,
      },
    };
  });
  return { file, diagnostics: entries, summary: { errors, warnings, infos } };
}

async function runLint(file: string, json: boolean): Promise<number> {
  let source: string;
  try {
    source = await readFile(resolve(file), "utf8");
  } catch (error) {
    writeError("E_IO", `読み込みに失敗しました: ${file}: ${errorMessage(error)}`, json);
    return 1;
  }
  const probes = createNodeFileProbes(dirname(resolve(file)));
  const diagnostics = lintDeck(parseDeck(source), probes);
  const result = lintJson(file, source, diagnostics);
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (diagnostics.length === 0) process.stdout.write(`${file}: OK\n`);
  else {
    for (const diagnostic of diagnostics) {
      const start = location(source, diagnostic.span.start);
      process.stdout.write(
        `${file}:${start.line}:${start.column}: ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`,
      );
    }
  }
  if (result.summary.errors > 0) return 2;
  if (result.summary.warnings > 0) return 1;
  return 0;
}

async function runFormat(file: string, write: boolean, json: boolean): Promise<number> {
  let source: string;
  try {
    source = await readFile(resolve(file), "utf8");
  } catch (error) {
    writeError("E_IO", `読み込みに失敗しました: ${file}: ${errorMessage(error)}`, json);
    return 1;
  }
  let formatted: string;
  try {
    formatted = formatDeck(source);
  } catch (error) {
    writeError("E_INTERNAL", `整形に失敗しました: ${errorMessage(error)}`, json);
    return 1;
  }
  const changed = formatted !== source;
  if (write && changed) {
    try {
      await writeFile(resolve(file), formatted, "utf8");
    } catch (error) {
      writeError("E_IO", `書き込みに失敗しました: ${file}: ${errorMessage(error)}`, json);
      return 1;
    }
  }
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ file, changed, written: write && changed, formatted: write ? null : formatted }, null, 2)}\n`,
    );
  } else if (write) {
    process.stdout.write(`${file}: ${changed ? "formatted" : "unchanged"}\n`);
  } else {
    process.stdout.write(formatted);
  }
  return 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usageError(message: string, json: boolean): number {
  writeError("E_USAGE", message, json);
  return 2;
}

/** Dispatches subcommands and returns a process exit code. */
export async function run(argv: readonly string[]): Promise<number> {
  const { command, sub, family, json, write, unknownOptions } = parseArgs(argv);
  if (unknownOptions.length > 0) return usageError(`不明なオプション: ${unknownOptions[0]}`, json);
  if (command === "lint") {
    if (write) return usageError("lint は --write をサポートしません", json);
    if (sub === undefined || family !== undefined)
      return usageError("lint にはファイルを 1 つ指定してください", json);
    return runLint(sub, json);
  }
  if (command === "format") {
    if (sub === undefined || family !== undefined)
      return usageError("format にはファイルを 1 つ指定してください", json);
    return runFormat(sub, write, json);
  }
  if (command === "fonts") {
    if (write) return usageError("fonts は --write をサポートしません", json);
    if (sub === "status") return runFontsStatus(json);
    if (sub === "fetch") return runFontsFetch(family ?? DEFAULT_FAMILY, json);
    return usageError(`不明なサブコマンド: fonts ${sub ?? ""}`, json);
  }
  if (command === undefined && argv.length === 0) {
    process.stderr.write(USAGE);
    return 0;
  }
  if (command === undefined) return usageError("コマンドを指定してください", json);
  return usageError(`不明なコマンド: ${command}`, json);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const json = process.argv.slice(2).includes("--json");
      writeError("E_INTERNAL", `内部エラー: ${errorMessage(error)}`, json);
      process.exitCode = 1;
    });
}
