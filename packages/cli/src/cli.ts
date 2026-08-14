/**
 * `deck` コマンドライン本体。lint / format は core の解析・整形結果を、fonts は
 * スタイルトラック S2 のフォント解決結果をそのまま境界へ出す。
 *
 *   deck lint <file> [--json]             診断を stdout に出す
 *   deck format <file> [--write] [--json] 整形結果または書き込み結果を stdout に出す
 *
 * --json を含む成功結果は stdout、E_* エラーは stderr の JSON を維持する。人間向けの
 * 成功結果とエラーも、それぞれ stdout と stderr に出す。
 *
 * | 終了コード | 意味 |
 * | --- | --- |
 * | 0 | 成功または情報のみ |
 * | 1 | lint warning |
 * | 2 | lint error |
 * | 3 | 操作失敗 (E_USAGE / E_IO / E_INTERNAL / 取得不能な font など) |
 */

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

export const EXIT_CODE = {
  success: 0,
  lintWarning: 1,
  lintError: 2,
  operationalFailure: 3,
} as const;

type CliErrorCode = "E_USAGE" | "E_IO" | "E_INTERNAL";
const ERROR_EXIT_CODE: Record<CliErrorCode, number> = {
  E_USAGE: EXIT_CODE.operationalFailure,
  E_IO: EXIT_CODE.operationalFailure,
  E_INTERNAL: EXIT_CODE.operationalFailure,
};

/** E_* は payload の種類にかかわらず、呼び出し側の操作失敗として同じ終了コードにする。 */
export function exitCodeForError(code: CliErrorCode): number {
  return ERROR_EXIT_CODE[code];
}

export interface ParsedArgs {
  command: string | undefined;
  sub: string | undefined;
  family: string | undefined;
  json: boolean;
  write: boolean;
  unknownOptions: string[];
}

/**
 * argv(process.argv.slice(2) 相当)を解析する純関数。
 * フラグは位置に依存せず拾い、family は空白を含みうるため残りの位置引数を連結する。
 */
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

/** status の 1 family 分を JSON 向けの素な形へ落とす。 */
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

/** 状態の 1 行テキスト表現。 */
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
    return EXIT_CODE.success;
  }
  process.stdout.write(`フォント解決状態(cache: ${paths.cacheDir})\n`);
  if (resolutions.length === 0) process.stdout.write("  (カタログが空です)\n");
  for (const resolution of resolutions) process.stdout.write(`${statusLine(resolution)}\n`);
  return EXIT_CODE.success;
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
    return EXIT_CODE.operationalFailure;
  }
  const result: FetchResult = await fetchFont(family, paths, nodeFontIO);
  if (json) {
    process.stdout.write(`${JSON.stringify({ family, status: "ok", ...result }, null, 2)}\n`);
    return EXIT_CODE.success;
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
  return EXIT_CODE.success;
}

const USAGE = `使い方: deck <command> ...

  deck lint <file> [--json]           デッキを検査
  deck format <file> [--write] [--json]  デッキを正規化
  deck fonts status [--json]          フォントカタログ全 family の解決状態
  deck fonts fetch [family] [--json]  family(既定 "${DEFAULT_FAMILY}")を取得・配置
`;

/** E_* は成功出力と混ざらないよう常に stderr へ出す。 */
function writeError(code: CliErrorCode, message: string, json: boolean): void {
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
    return exitCodeForError("E_IO");
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
  if (result.summary.errors > 0) return EXIT_CODE.lintError;
  if (result.summary.warnings > 0) return EXIT_CODE.lintWarning;
  return EXIT_CODE.success;
}

async function runFormat(file: string, write: boolean, json: boolean): Promise<number> {
  let source: string;
  try {
    source = await readFile(resolve(file), "utf8");
  } catch (error) {
    writeError("E_IO", `読み込みに失敗しました: ${file}: ${errorMessage(error)}`, json);
    return exitCodeForError("E_IO");
  }
  let formatted: string;
  try {
    formatted = formatDeck(source);
  } catch (error) {
    writeError("E_INTERNAL", `整形に失敗しました: ${errorMessage(error)}`, json);
    return exitCodeForError("E_INTERNAL");
  }
  const changed = formatted !== source;
  if (write && changed) {
    try {
      await writeFile(resolve(file), formatted, "utf8");
    } catch (error) {
      writeError("E_IO", `書き込みに失敗しました: ${file}: ${errorMessage(error)}`, json);
      return exitCodeForError("E_IO");
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
  return EXIT_CODE.success;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usageError(message: string, json: boolean): number {
  writeError("E_USAGE", message, json);
  return exitCodeForError("E_USAGE");
}

/** サブコマンドのディスパッチ。終了コードを返す(副作用は stdout/stderr のみ)。 */
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
    return EXIT_CODE.success;
  }
  if (command === undefined) return usageError("コマンドを指定してください", json);
  return usageError(`不明なコマンド: ${command}`, json);
}

// エントリポイント(import されたときは実行しない)。Windows のパス形式でも一致するよう
// pathToFileURL で比較する(Node 標準イディオム)。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const json = process.argv.slice(2).includes("--json");
      writeError("E_INTERNAL", `内部エラー: ${errorMessage(error)}`, json);
      process.exitCode = exitCodeForError("E_INTERNAL");
    });
}
