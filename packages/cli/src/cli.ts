/**
 * `deck` コマンドライン本体。outline / lint / format は core の解析・整形結果を、fonts は
 * スタイルトラック S2 のフォント解決結果をそのまま境界へ出す。
 *
 *   deck lint <file> [--json]             診断を stdout に出す
 *   deck format <file> [--write] [--json] 整形結果または書き込み結果を stdout に出す
 *   deck outline <file> [--json]          フレーム一覧を stdout に出す
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

import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type CanvasGeometry,
  type CanvasLayoutDiagnostic,
  type CompileWarning,
  compileDeckFrames,
  type DeckFramesResult,
  exportPdf,
  type PdfExportErrorCode,
  type PdfExportResult,
} from "@beamer-editor/compiler";
import {
  formatDeck,
  frameLabel,
  framesOf,
  frameTitleText,
  type LintDiagnostic,
  lintSource,
  parseDeck,
} from "@beamer-editor/core";
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
import { nodePdfRasterizer } from "./pdf-rasterizer.ts";

/** 既定で取得する標準フォント(theme-design.md §4)。 */
const DEFAULT_FAMILY = "Noto Sans CJK JP";

export const EXIT_CODE = {
  success: 0,
  lintWarning: 1,
  lintError: 2,
  operationalFailure: 3,
} as const;

type CliErrorCode = "E_USAGE" | "E_IO" | "E_INTERNAL" | PdfExportErrorCode;
const ERROR_EXIT_CODE: Record<CliErrorCode, number> = {
  E_USAGE: EXIT_CODE.operationalFailure,
  E_IO: EXIT_CODE.operationalFailure,
  E_INTERNAL: EXIT_CODE.operationalFailure,
  E_INPUT: EXIT_CODE.operationalFailure,
  E_OUTPUT_EXISTS: EXIT_CODE.operationalFailure,
  E_TECTONIC_NOT_FOUND: EXIT_CODE.operationalFailure,
  E_TECTONIC_VERSION: EXIT_CODE.operationalFailure,
  E_COMPILE: EXIT_CODE.operationalFailure,
  E_RASTERIZE: EXIT_CODE.operationalFailure,
  E_LIMIT: EXIT_CODE.operationalFailure,
  E_CANCELLED: EXIT_CODE.operationalFailure,
};

/** E_* は payload の種類にかかわらず、呼び出し側の操作失敗として同じ終了コードにする。 */
export function exitCodeForError(code: CliErrorCode): number {
  return ERROR_EXIT_CODE[code];
}

export interface ParsedArgs {
  /** トップコマンド(例 "fonts")。省略時は undefined。 */
  command: string | undefined;
  /** サブコマンド(例 "status" / "fetch")。省略時は undefined。 */
  sub: string | undefined;
  /** 位置引数の family(fetch の対象)。省略時は undefined。 */
  family: string | undefined;
  /** --json フラグ。 */
  json: boolean;
  /** --write フラグ。 */
  write: boolean;
  /** 未対応のオプション。 */
  unknownOptions: string[];
}

/**
 * argv(process.argv.slice(2) 相当)を解析する純関数。
 * --json / --write はどこに来ても拾う。フラグ以外の非フラグ語を command / sub / family
 * の順に割り当てる。family は空白を含みうるので、複数語の非フラグ引数は 3 つ目以降も
 * 連結して 1 つの family とする。
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
  for (const entry of FONT_CATALOG) {
    resolutions.push(await resolveFont(entry.family, paths, nodeFontIO));
  }
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
  if (resolutions.length === 0) {
    process.stdout.write("  (カタログが空です)\n");
  }
  for (const r of resolutions) {
    process.stdout.write(`${statusLine(r)}\n`);
  }
  return EXIT_CODE.success;
}

async function runFontsFetch(family: string, json: boolean): Promise<number> {
  const paths = defaultFontPaths();
  const before = await resolveFont(family, paths, nodeFontIO);
  if (before.status === "unknown-family") {
    // カタログ外は取得できない。名前参照のみとして案内し、非 0 で終える。
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
  for (const f of result.fetched) process.stdout.write(`  取得: ${f}\n`);
  for (const f of result.skipped) process.stdout.write(`  スキップ(キャッシュ済み): ${f}\n`);
  for (const f of result.installed) process.stdout.write(`  配置: ${f}\n`);
  if (paths.userFontDir === null) {
    process.stdout.write("  (userFontDir 不明のため配置はスキップ・キャッシュのみ)\n");
  }
  return EXIT_CODE.success;
}

const USAGE = `使い方: deck <command> ...

  deck lint <file> [--json]           デッキを検査
  deck format <file> [--write] [--json]  デッキを正規化
  deck outline <file> [--json]        フレーム一覧を表示
  deck check <file> [--tectonic <path>] [--json]  実コンパイルで検査
  deck snapshot <file> -o <directory> [--frame <N|LABEL|label:LABEL>] [--tectonic <path>] [--json]
  deck export <file> --format pdf [-o <file>] [--overwrite] [--tectonic <path>] [--json]
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
  const diagnostics = lintSource(source, probes);
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

async function runOutline(file: string, json: boolean): Promise<number> {
  let source: string;
  try {
    source = await readFile(resolve(file), "utf8");
  } catch (error) {
    writeError("E_IO", `読み込みに失敗しました: ${file}: ${errorMessage(error)}`, json);
    return exitCodeForError("E_IO");
  }
  const frames = framesOf(parseDeck(source)).map((frame, index) => ({
    number: index + 1,
    label: frameLabel(frame),
    title: frameTitleText(frame, index + 1),
  }));
  if (json) process.stdout.write(`${JSON.stringify({ file, frames }, null, 2)}\n`);
  else {
    for (const frame of frames) {
      process.stdout.write(`${frame.number}. [${frame.label ?? "-"}] ${frame.title}\n`);
    }
  }
  return EXIT_CODE.success;
}

export interface ParsedCheckArgs {
  input: string | undefined;
  tectonic: string | undefined;
  json: boolean;
  write: boolean;
  error: string | undefined;
}

/** check は値を伴う --tectonic を持つので汎用パーサとは分離する。 */
export function parseCheckArgs(argv: readonly string[]): ParsedCheckArgs {
  let input: string | undefined;
  let tectonic: string | undefined;
  let json = false;
  let write = false;
  let error: string | undefined;
  const seen = new Set<string>();
  const takeValue = (name: string, value: string | undefined): string | undefined => {
    if (seen.has(name)) {
      error ??= `オプションを重複して指定できません: ${name}`;
      return undefined;
    }
    seen.add(name);
    if (value === undefined || value.startsWith("-")) {
      error ??= `オプションには値が必要です: ${name}`;
      return undefined;
    }
    return value;
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) break;
    if (arg === "--tectonic") {
      const value = takeValue("--tectonic", argv[index + 1]);
      if (value !== undefined) {
        tectonic = value;
        index++;
      }
    } else if (arg === "--json" || arg === "--write") {
      if (seen.has(arg)) error ??= `オプションを重複して指定できません: ${arg}`;
      seen.add(arg);
      if (arg === "--json") json = true;
      else write = true;
    } else if (arg.startsWith("-")) {
      error ??= `不明なオプション: ${arg}`;
    } else if (input === undefined) {
      input = arg;
    } else {
      error ??= "check には入力ファイルを 1 つ指定してください";
    }
  }
  if (!error && input === undefined) error = "check には入力ファイルを指定してください";
  return { input, tectonic, json, write, error };
}

type CheckSeverity = "error" | "warning" | "info";

interface CheckFrame {
  number: number;
  label: string | null;
}

interface CheckDiagnostic {
  category: "lint" | "compile" | "layout";
  code: string;
  severity: CheckSeverity;
  message: string;
  frame: CheckFrame | null;
  location?: { line: number; column: number; endLine: number; endColumn: number };
  sourceLines?: { start: number; end: number };
  geometry?: CanvasGeometry;
  overlappingGeometry?: CanvasGeometry;
}

function checkFrame(frame: CheckFrame | null): string {
  return frame === null
    ? ""
    : ` [frame ${frame.number}${frame.label === null ? "" : ` (${frame.label})`}]`;
}

function frameForLint(diagnostic: LintDiagnostic, result: DeckFramesResult): CheckFrame | null {
  return (
    result.frames.find(
      (frame) =>
        diagnostic.span.start >= frame.span.start && diagnostic.span.start < frame.span.end,
    )?.address ?? null
  );
}

function lintCheckDiagnostics(
  source: string,
  diagnostics: readonly LintDiagnostic[],
  result: DeckFramesResult,
): CheckDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const start = location(source, diagnostic.span.start);
    const end = location(source, diagnostic.span.end);
    return {
      category: "lint",
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
      frame: frameForLint(diagnostic, result),
      location: {
        line: start.line,
        column: start.column,
        endLine: end.line,
        endColumn: end.column,
      },
    };
  });
}

function compileCheckDiagnostics(warnings: readonly CompileWarning[]): CheckDiagnostic[] {
  return warnings.map((warning) => ({
    category: "compile",
    code: warning.kind,
    severity: "warning",
    message: warning.message,
    frame: warning.frame,
    ...(warning.sourceLines === null ? {} : { sourceLines: warning.sourceLines }),
  }));
}

function layoutCheckDiagnostics(diagnostics: readonly CanvasLayoutDiagnostic[]): CheckDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    category: "layout",
    code: diagnostic.kind,
    severity: diagnostic.severity,
    message: diagnostic.message,
    frame: diagnostic.frame,
    geometry: diagnostic.geometry,
    ...(diagnostic.overlappingGeometry === undefined
      ? {}
      : { overlappingGeometry: diagnostic.overlappingGeometry }),
  }));
}

function checkSummary(diagnostics: readonly CheckDiagnostic[]) {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") errors++;
    else if (diagnostic.severity === "warning") warnings++;
    else infos++;
  }
  return { errors, warnings, infos };
}

function writeCheckText(file: string, diagnostics: readonly CheckDiagnostic[]): void {
  if (diagnostics.length === 0) {
    process.stdout.write(`${file}: OK\n`);
    return;
  }
  for (const diagnostic of diagnostics) {
    const position = diagnostic.location
      ? `${file}:${diagnostic.location.line}:${diagnostic.location.column}`
      : diagnostic.sourceLines
        ? `${file}:${diagnostic.sourceLines.start}${
            diagnostic.sourceLines.end === diagnostic.sourceLines.start
              ? ""
              : `-${diagnostic.sourceLines.end}`
          }`
        : file;
    process.stdout.write(
      `${position}: ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}${checkFrame(diagnostic.frame)}\n`,
    );
  }
}

async function runCheck(parsed: ParsedCheckArgs, dependencies: CliDependencies): Promise<number> {
  if (parsed.error) return usageError(parsed.error, parsed.json);
  if (parsed.write) return usageError("check は --write をサポートしません", parsed.json);
  const input = parsed.input as string;
  let source: string;
  try {
    source = await readFile(resolve(input), "utf8");
  } catch (error) {
    writeError("E_IO", `読み込みに失敗しました: ${input}: ${errorMessage(error)}`, parsed.json);
    return exitCodeForError("E_IO");
  }
  const lintDiagnostics = lintSource(source, createNodeFileProbes(dirname(resolve(input))));
  let compiled: DeckFramesResult;
  try {
    compiled = await (dependencies.compileDeckFrames ?? compileDeckFrames)({
      inputPath: input,
      ...(parsed.tectonic === undefined ? {} : { tectonicPath: parsed.tectonic }),
      includeImages: false,
    });
  } catch (error) {
    const possibleCode =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    const code: CliErrorCode =
      possibleCode !== undefined && possibleCode in ERROR_EXIT_CODE
        ? (possibleCode as CliErrorCode)
        : "E_INTERNAL";
    writeError(code, errorMessage(error), parsed.json);
    return exitCodeForError(code);
  }
  const diagnostics = [
    ...lintCheckDiagnostics(source, lintDiagnostics, compiled),
    ...compileCheckDiagnostics(compiled.warnings),
    ...layoutCheckDiagnostics(compiled.layoutDiagnostics),
  ];
  const summary = checkSummary(diagnostics);
  if (parsed.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          file: input,
          engine: { name: "tectonic", version: compiled.engineVersion },
          diagnostics,
          summary,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    writeCheckText(input, diagnostics);
  }
  if (summary.errors > 0) return EXIT_CODE.lintError;
  if (summary.warnings > 0) return EXIT_CODE.lintWarning;
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

export interface ParsedExportArgs {
  input: string | undefined;
  format: string | undefined;
  output: string | undefined;
  overwrite: boolean;
  tectonic: string | undefined;
  json: boolean;
  error: string | undefined;
}

/** export は短縮 -o と値を伴うオプションを持つため、既存の汎用パーサとは分離する。 */
export function parseExportArgs(argv: readonly string[]): ParsedExportArgs {
  let input: string | undefined;
  let format: string | undefined;
  let output: string | undefined;
  let tectonic: string | undefined;
  let overwrite = false;
  let json = false;
  let error: string | undefined;
  const seen = new Set<string>();
  const takeValue = (name: string, value: string | undefined): string | undefined => {
    if (seen.has(name)) {
      error ??= `オプションを重複して指定できません: ${name}`;
      return undefined;
    }
    seen.add(name);
    if (value === undefined || value.startsWith("-")) {
      error ??= `オプションには値が必要です: ${name}`;
      return undefined;
    }
    return value;
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) break;
    if (arg === "--format") {
      const value = takeValue("--format", argv[index + 1]);
      if (value !== undefined) {
        format = value;
        index++;
      }
    } else if (arg === "-o" || arg === "--output") {
      const value = takeValue("--output", argv[index + 1]);
      if (value !== undefined) {
        output = value;
        index++;
      }
    } else if (arg === "--tectonic") {
      const value = takeValue("--tectonic", argv[index + 1]);
      if (value !== undefined) {
        tectonic = value;
        index++;
      }
    } else if (arg === "--overwrite" || arg === "--json") {
      const name = arg;
      if (seen.has(name)) error ??= `オプションを重複して指定できません: ${name}`;
      seen.add(name);
      if (arg === "--overwrite") overwrite = true;
      else json = true;
    } else if (arg.startsWith("-")) {
      error ??= `不明なオプション: ${arg}`;
    } else if (input === undefined) {
      input = arg;
    } else {
      error ??= "export には入力ファイルを 1 つ指定してください";
    }
  }
  if (!error && input === undefined) error = "export には入力ファイルを指定してください";
  if (!error && format === undefined) error = "export には --format pdf を指定してください";
  if (!error && format !== "pdf") error = `未対応の出力形式: ${format}`;
  return { input, format, output, overwrite, tectonic, json, error };
}

export interface CliDependencies {
  compileDeckFrames?: (request: {
    inputPath: string;
    tectonicPath?: string;
    includeImages: boolean;
  }) => Promise<DeckFramesResult>;
  exportPdf?: (request: {
    inputPath: string;
    outputPath?: string;
    overwrite?: boolean;
    tectonicPath?: string;
  }) => Promise<PdfExportResult>;
}

export interface ParsedSnapshotArgs {
  input: string | undefined;
  output: string | undefined;
  frame: string | undefined;
  tectonic: string | undefined;
  json: boolean;
  error: string | undefined;
}

export function parseSnapshotArgs(argv: readonly string[]): ParsedSnapshotArgs {
  let input: string | undefined,
    output: string | undefined,
    frame: string | undefined,
    tectonic: string | undefined;
  let json = false,
    error: string | undefined;
  const seen = new Set<string>();
  const value = (name: string, next: string | undefined) => {
    if (seen.has(name)) {
      error ??= `オプションを重複して指定できません: ${name}`;
      return undefined;
    }
    seen.add(name);
    if (!next || next.startsWith("-")) {
      error ??= `オプションには値が必要です: ${name}`;
      return undefined;
    }
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-o" || arg === "--output" || arg === "--frame" || arg === "--tectonic") {
      const name = arg === "-o" ? "--output" : arg;
      const v = value(name, argv[i + 1]);
      if (v !== undefined) {
        if (name === "--output") output = v;
        else if (name === "--frame") frame = v;
        else tectonic = v;
        i++;
      }
    } else if (arg === "--json") {
      if (seen.has(arg)) error ??= "オプションを重複して指定できません: --json";
      seen.add(arg);
      json = true;
    } else if (arg?.startsWith("-")) error ??= `不明なオプション: ${arg}`;
    else if (!input) input = arg;
    else error ??= "snapshot には入力ファイルを 1 つ指定してください";
  }
  if (!error && !input) error = "snapshot には入力ファイルを指定してください";
  if (!error && !output) error = "snapshot には --output を指定してください";
  return { input, output, frame, tectonic, json, error };
}

/**
 * Present only while `deck snapshot` is writing into its output directory. Removing it is the
 * publication step, so its absence means the directory is complete.
 */
const INCOMPLETE_MARKER = ".deck-snapshot-incomplete";

function snapshotFileName(frame: number, page: number): string {
  return `frame-${String(frame).padStart(6, "0")}-page-${String(page).padStart(6, "0")}.png`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function selectedFrame(
  frame: string | undefined,
  frames: readonly DeckFramesResult["frames"][number][],
): readonly DeckFramesResult["frames"][number][] {
  if (!frame) return frames;
  if (/^[1-9]\d*$/.test(frame)) {
    const found = frames[Number(frame) - 1];
    if (!found) throw Object.assign(new Error("指定した frame がありません"), { code: "E_INPUT" });
    return [found];
  }
  const label = frame.startsWith("label:") ? frame.slice(6) : frame;
  if (/^\d+$/.test(frame) && !frame.startsWith("label:"))
    throw Object.assign(new Error("数字の label は label:<LABEL> で指定してください"), {
      code: "E_INPUT",
    });
  const found = frames.filter((item) => item.address.label === label);
  if (found.length !== 1)
    throw Object.assign(
      new Error(found.length > 1 ? "frame label が重複しています" : "指定した frame がありません"),
      { code: "E_INPUT" },
    );
  return found;
}

async function runSnapshot(
  parsed: ParsedSnapshotArgs,
  dependencies: CliDependencies,
): Promise<number> {
  if (parsed.error) return usageError(parsed.error, parsed.json);
  const input = parsed.input as string,
    displayOutput = parsed.output as string,
    output = resolve(displayOutput);
  // An early, readable rejection. mkdir below stays the authority on existence.
  if (await pathExists(output)) {
    writeError("E_OUTPUT_EXISTS", `出力先は既に存在します: ${output}`, parsed.json);
    return 3;
  }
  try {
    const parent = await lstat(dirname(output));
    if (!parent.isDirectory() || parent.isSymbolicLink())
      throw new Error("出力先の親は通常のディレクトリである必要があります");
  } catch (error) {
    writeError("E_IO", `出力先を作成できません: ${errorMessage(error)}`, parsed.json);
    return 3;
  }
  // Only a successful mkdir makes this process the owner of `output`, and only an owner may
  // remove it on failure.
  let reserved = false;
  try {
    const compiler =
      dependencies.compileDeckFrames ??
      ((request: { inputPath: string; tectonicPath?: string; includeImages: boolean }) =>
        compileDeckFrames(request, { rasterizer: nodePdfRasterizer }));
    const compiled = await compiler({
      inputPath: input,
      ...(parsed.tectonic ? { tectonicPath: parsed.tectonic } : {}),
      includeImages: true,
    });
    const frames = selectedFrame(parsed.frame, compiled.frames);
    const outputs = frames.flatMap((item) =>
      item.images.map((image) => ({
        frame: item.address.number,
        label: item.address.label,
        image,
        file: snapshotFileName(item.address.number, image.page),
      })),
    );
    if (!outputs.length)
      throw Object.assign(new Error("snapshot 可能な PDF page がありません"), {
        code: "E_COMPILE",
      });
    // mkdir is atomic and never replaces an existing directory, so it doubles as the publication
    // reservation: a concurrent creator wins and we leave their entry untouched.
    try {
      await mkdir(output);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw Object.assign(new Error(`出力先は既に存在します: ${output}`), {
          code: "E_OUTPUT_EXISTS",
        });
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        code: "E_IO",
      });
    }
    reserved = true;
    // The completion marker exists for the whole write. Its removal is what publishes the
    // directory, so a reader that sees it must treat the directory as unfinished.
    await writeFile(
      join(output, INCOMPLETE_MARKER),
      "deck snapshot はこのディレクトリへの書き込み中です。完了時にこのファイルは削除されます。\n",
      { flag: "wx" },
    );
    for (const item of outputs)
      await writeFile(join(output, item.file), item.image.png, { flag: "wx" });
    await rm(join(output, INCOMPLETE_MARKER));
    if (parsed.json)
      process.stdout.write(
        `${JSON.stringify(
          {
            file: input,
            output: displayOutput,
            frames: frames.map((item) => ({
              number: item.address.number,
              label: item.address.label,
              images: item.images.map((image) => ({
                page: image.page,
                file: snapshotFileName(item.address.number, image.page),
                width: image.width,
                height: image.height,
                bytes: image.png.byteLength,
              })),
            })),
            engine: { name: "tectonic", version: compiled.engineVersion },
          },
          null,
          2,
        )}\n`,
      );
    else
      for (const item of outputs)
        process.stdout.write(
          `${input}: frame ${item.frame}${item.label === null ? "" : ` (${item.label})`} page ${item.image.page} -> ${join(displayOutput, item.file)}\n`,
        );
    return 0;
  } catch (error) {
    if (reserved)
      try {
        await rm(output, { recursive: true, force: true });
      } catch {
        // Cleanup must not mask the failure that triggered it. The reserved directory stays
        // behind with its marker, and the original E_* classification below still reaches stderr.
      }
    const candidate =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "E_RASTERIZE";
    const code: CliErrorCode = candidate in ERROR_EXIT_CODE ? (candidate as CliErrorCode) : "E_IO";
    writeError(code, errorMessage(error), parsed.json);
    return 3;
  }
}

function defaultPdfOutputForDisplay(input: string): string {
  if (input.endsWith(".slide.tex")) return `${input.slice(0, -".slide.tex".length)}.pdf`;
  const extension = extname(input);
  return `${extension.length > 0 ? input.slice(0, -extension.length) : input}.pdf`;
}

async function runExport(parsed: ParsedExportArgs, dependencies: CliDependencies): Promise<number> {
  if (parsed.error) return usageError(parsed.error, parsed.json);
  // parseExportArgs has validated these conditions above.
  const input = parsed.input as string;
  try {
    const result = await (dependencies.exportPdf ?? exportPdf)({
      inputPath: input,
      ...(parsed.output === undefined ? {} : { outputPath: parsed.output }),
      ...(parsed.overwrite ? { overwrite: true } : {}),
      ...(parsed.tectonic === undefined ? {} : { tectonicPath: parsed.tectonic }),
    });
    if (parsed.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            format: result.format,
            input,
            output: parsed.output ?? defaultPdfOutputForDisplay(input),
            overwritten: result.overwritten,
            engine: { name: "tectonic", version: result.engineVersion },
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(`${input} -> ${parsed.output ?? defaultPdfOutputForDisplay(input)}\n`);
    }
    return EXIT_CODE.success;
  } catch (error) {
    const possibleCode =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    const code: CliErrorCode =
      possibleCode !== undefined && possibleCode in ERROR_EXIT_CODE
        ? (possibleCode as CliErrorCode)
        : "E_INTERNAL";
    writeError(code, errorMessage(error), parsed.json);
    return exitCodeForError(code);
  }
}

function usageError(message: string, json: boolean): number {
  writeError("E_USAGE", message, json);
  return exitCodeForError("E_USAGE");
}

/** サブコマンドのディスパッチ。終了コードを返す(副作用は stdout/stderr のみ)。 */
export async function run(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  if (argv[0] === "export") return runExport(parseExportArgs(argv.slice(1)), dependencies);
  if (argv[0] === "check") return runCheck(parseCheckArgs(argv.slice(1)), dependencies);
  if (argv[0] === "snapshot") return runSnapshot(parseSnapshotArgs(argv.slice(1)), dependencies);
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
  if (command === "outline") {
    if (write) return usageError("outline は --write をサポートしません", json);
    if (sub === undefined || family !== undefined)
      return usageError("outline にはファイルを 1 つ指定してください", json);
    return runOutline(sub, json);
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
