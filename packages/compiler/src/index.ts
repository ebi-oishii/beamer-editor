import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

const MAX_PROCESS_OUTPUT = 1024 * 1024;
const DEFAULT_COMPILE_TIMEOUT_MS = 300_000;
const VERSION_TIMEOUT_MS = 10_000;
const TERMINATE_GRACE_MS = 1_000;
const HARD_SETTLE_GRACE_MS = 1_000;

export interface PdfExportRequest {
  inputPath: string;
  outputPath?: string;
  overwrite?: boolean;
  tectonicPath?: string;
  signal?: AbortSignal;
  /** Tectonic compile timeout. Defaults to 5 minutes. */
  timeoutMs?: number;
}

export interface PdfExportResult {
  format: "pdf";
  inputPath: string;
  outputPath: string;
  overwritten: boolean;
  engineVersion: string;
}

export type PdfExportErrorCode =
  | "E_INPUT"
  | "E_OUTPUT_EXISTS"
  | "E_TECTONIC_NOT_FOUND"
  | "E_TECTONIC_VERSION"
  | "E_COMPILE"
  | "E_IO"
  | "E_CANCELLED";

export class PdfExportError extends Error {
  constructor(
    public readonly code: PdfExportErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PdfExportError";
  }
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cancelled?: boolean;
  timedOut?: boolean;
}

export interface ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options: { cwd: string; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ProcessResult>;
}

export interface PdfExportDependencies {
  runner?: ProcessRunner;
  temporaryDirectory?: (prefix: string) => Promise<string>;
  /** no-overwrite の公開後に残った staging file を消すための注入点。 */
  removeStagingFile?: (path: string) => Promise<void>;
}

class ProcessNotFoundError extends Error {
  constructor(
    readonly command: string,
    cause?: unknown,
  ) {
    super(`Tectonic が見つかりません: ${command}`);
    this.name = "ProcessNotFoundError";
    this.cause = cause;
  }
}

function boundedCollector(limit: number) {
  let value = "";
  return {
    append(chunk: Buffer | string) {
      if (value.length < limit) value += String(chunk).slice(0, limit - value.length);
    },
    value: () => value,
  };
}

/** Node の spawn を shell なし・argv のままで呼ぶ標準ランナー。 */
export const nodeProcessRunner: ProcessRunner = {
  run(command, args, options) {
    return new Promise((resolveResult, reject) => {
      if (options.signal?.aborted) {
        resolveResult({ exitCode: null, stdout: "", stderr: "", cancelled: true });
        return;
      }
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, args, {
          cwd: options.cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        reject(error);
        return;
      }
      const stdout = boundedCollector(MAX_PROCESS_OUTPUT);
      const stderr = boundedCollector(MAX_PROCESS_OUTPUT);
      // The preflight above handled an already-aborted signal. Starting from
      // false here is essential: an abort in the spawn/listener gap must still
      // enter onAbort and terminate the child.
      let cancelled = false;
      let timedOut = false;
      let settled = false;
      let terminating = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let forceKill: ReturnType<typeof setTimeout> | undefined;
      let hardSettle: ReturnType<typeof setTimeout> | undefined;
      let pipesDestroyed = false;
      const destroyPipes = () => {
        if (pipesDestroyed) return;
        pipesDestroyed = true;
        // A killed child can leave a grandchild holding these inherited pipe
        // descriptors. Destroying them is only needed for the hard-settle
        // fallback; on a normal close, let Node drain all remaining output.
        child.stdout?.destroy();
        child.stderr?.destroy();
      };
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        if (hardSettle) clearTimeout(hardSettle);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveResult({
          exitCode,
          stdout: stdout.value(),
          stderr: stderr.value(),
          cancelled,
          timedOut,
        });
      };
      const terminate = () => {
        if (settled || terminating) return;
        terminating = true;
        child.kill();
        forceKill = setTimeout(() => {
          child.kill("SIGKILL");
          hardSettle = setTimeout(() => {
            destroyPipes();
            finish(null);
          }, HARD_SETTLE_GRACE_MS);
        }, TERMINATE_GRACE_MS);
      };
      const onAbort = () => {
        if (settled || cancelled) return;
        cancelled = true;
        terminate();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      // Close the preflight-to-listener race. onAbort owns both the cancellation
      // flag and child termination, and terminate/finish are idempotent.
      if (options.signal?.aborted) onAbort();
      child.stdout?.on("data", stdout.append);
      child.stderr?.on("data", stderr.append);
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error.code === "ENOENT") reject(new ProcessNotFoundError(command, error));
        else reject(error);
      });
      child.on("close", finish);
      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timeout = setTimeout(() => {
          if (settled) return;
          timedOut = true;
          terminate();
        }, options.timeoutMs);
      }
    });
  },
};

function defaultOutputPath(inputPath: string): string {
  const extension = extname(inputPath);
  const stem = inputPath.endsWith(".slide.tex")
    ? inputPath.slice(0, -".slide.tex".length)
    : extension.length > 0
      ? inputPath.slice(0, -extension.length)
      : inputPath;
  return `${stem}.pdf`;
}

function compiledPdfName(inputPath: string): string {
  return `${basename(inputPath, extname(inputPath))}.pdf`;
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

async function regularNonEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function existingEntry(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function sameFile(first: string, second: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([stat(first), stat(second)]);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runnerOptions(
  cwd: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { cwd: string; signal?: AbortSignal; timeoutMs: number } {
  return signal === undefined ? { cwd, timeoutMs } : { cwd, signal, timeoutMs };
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new PdfExportError("E_CANCELLED", "PDF 書き出しはキャンセルされました");
}

function isAlreadyExists(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST";
}

function versionFrom(output: string): string | undefined {
  // Current Tectonic formats this as "tectonic 0.x.y". Keep the entire semantic
  // version rather than coupling the public result to a particular banner layout.
  return /\b(?:tectonic\s+)?v?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?)/i.exec(output)?.[1];
}

function processDetail(result: ProcessResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail ? `: ${detail}` : "";
}

/** `tectonic --version` で実行できることを確かめ、バージョン文字列を返す(exportPdf / compileFragment 共通)。 */
async function ensureTectonic(
  runner: ProcessRunner,
  tectonic: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  let versionResult: ProcessResult;
  try {
    versionResult = await runner.run(
      tectonic,
      ["--version"],
      runnerOptions(cwd, signal, VERSION_TIMEOUT_MS),
    );
  } catch (error) {
    if (isAbort(error, signal))
      throw new PdfExportError("E_CANCELLED", "PDF 書き出しはキャンセルされました", error);
    if (error instanceof ProcessNotFoundError || isNotFound(error))
      throw new PdfExportError("E_TECTONIC_NOT_FOUND", errorMessage(error), error);
    throw new PdfExportError(
      "E_TECTONIC_VERSION",
      `Tectonic のバージョンを取得できません: ${String(error)}`,
      error,
    );
  }
  if (versionResult.cancelled || signal?.aborted)
    throw new PdfExportError("E_CANCELLED", "PDF 書き出しはキャンセルされました");
  if (versionResult.timedOut)
    throw new PdfExportError(
      "E_TECTONIC_VERSION",
      `Tectonic のバージョン確認が ${VERSION_TIMEOUT_MS / 1000} 秒でタイムアウトしました`,
    );
  const engineVersion =
    versionResult.exitCode === 0
      ? versionFrom(`${versionResult.stdout}\n${versionResult.stderr}`)
      : undefined;
  if (!engineVersion)
    throw new PdfExportError(
      "E_TECTONIC_VERSION",
      `Tectonic のバージョンを確認できません${processDetail(versionResult)}`,
    );
  return engineVersion;
}

/**
 * Compile the untouched input source through Tectonic, staging all compiler
 * output under the OS temp directory. The destination is replaced only after a
 * non-empty PDF has been produced.
 */
export async function exportPdf(
  request: PdfExportRequest,
  dependencies: PdfExportDependencies = {},
): Promise<PdfExportResult> {
  const runner = dependencies.runner ?? nodeProcessRunner;
  const tectonic = request.tectonicPath ?? "tectonic";
  const inputPath = resolve(request.inputPath);
  const outputPath = resolve(request.outputPath ?? defaultOutputPath(inputPath));
  const signal = request.signal;
  throwIfCancelled(signal);
  if (!(await regularFile(inputPath))) {
    throw new PdfExportError("E_INPUT", `入力 TeX を読み込めません: ${request.inputPath}`);
  }
  throwIfCancelled(signal);
  let outputEntry: Awaited<ReturnType<typeof existingEntry>>;
  try {
    outputEntry = await existingEntry(outputPath);
  } catch (error) {
    throw new PdfExportError(
      "E_IO",
      `出力先を確認できません: ${outputPath}: ${errorMessage(error)}`,
      error,
    );
  }
  const outputExists = outputEntry !== undefined;
  if (inputPath === outputPath || (outputExists && (await sameFile(inputPath, outputPath)))) {
    throw new PdfExportError("E_INPUT", "出力先を入力 TeX と同じファイルにはできません");
  }
  if (outputEntry !== undefined && !outputEntry.isFile() && !outputEntry.isSymbolicLink()) {
    throw new PdfExportError(
      "E_OUTPUT_EXISTS",
      `出力先は通常ファイルではありません: ${outputPath}`,
    );
  }
  if (outputExists && !request.overwrite) {
    throw new PdfExportError("E_OUTPUT_EXISTS", `出力先は既に存在します: ${outputPath}`);
  }
  throwIfCancelled(signal);

  const engineVersion = await ensureTectonic(runner, tectonic, dirname(inputPath), signal);

  const makeTemp =
    dependencies.temporaryDirectory ?? ((prefix: string) => mkdtemp(join(tmpdir(), prefix)));
  let tempDirectory: string | undefined;
  let stagingPath: string | undefined;
  try {
    tempDirectory = await makeTemp("beamer-editor-pdf-");
    throwIfCancelled(signal);
    let compileResult: ProcessResult;
    try {
      compileResult = await runner.run(
        tectonic,
        ["-X", "compile", "--outdir", tempDirectory, inputPath],
        runnerOptions(
          dirname(inputPath),
          signal,
          request.timeoutMs && request.timeoutMs > 0
            ? request.timeoutMs
            : DEFAULT_COMPILE_TIMEOUT_MS,
        ),
      );
    } catch (error) {
      if (isAbort(error, signal))
        throw new PdfExportError("E_CANCELLED", "PDF 書き出しはキャンセルされました", error);
      if (error instanceof ProcessNotFoundError || isNotFound(error))
        throw new PdfExportError("E_TECTONIC_NOT_FOUND", errorMessage(error), error);
      throw new PdfExportError(
        "E_COMPILE",
        `Tectonic の実行に失敗しました: ${String(error)}`,
        error,
      );
    }
    if (compileResult.cancelled || signal?.aborted)
      throw new PdfExportError("E_CANCELLED", "PDF 書き出しはキャンセルされました");
    if (compileResult.timedOut) {
      const timeoutMs =
        request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : DEFAULT_COMPILE_TIMEOUT_MS;
      throw new PdfExportError(
        "E_COMPILE",
        `PDF のコンパイルが ${timeoutMs / 1000} 秒でタイムアウトしました${processDetail(compileResult)}`,
      );
    }
    const compiledPdf = join(tempDirectory, compiledPdfName(inputPath));
    if (compileResult.exitCode !== 0 || !(await regularNonEmptyFile(compiledPdf))) {
      throw new PdfExportError(
        "E_COMPILE",
        `PDF のコンパイルに失敗しました${processDetail(compileResult)}`,
      );
    }
    // Stage in the target filesystem. `COPYFILE_EXCL` plus UUID prevents one
    // export from ever consuming another export's staging file.
    stagingPath = join(dirname(outputPath), `.${basename(outputPath)}.deck-export-${randomUUID()}`);
    await copyFile(compiledPdf, stagingPath, constants.COPYFILE_EXCL);
    throwIfCancelled(signal);
    if (request.overwrite) {
      await rename(stagingPath, outputPath);
    } else {
      try {
        // link is an atomic create-only operation on the destination filesystem.
        // It closes the preflight-to-commit no-clobber race without deleting any
        // file another process created while Tectonic was running.
        await link(stagingPath, outputPath);
      } catch (error) {
        if (isAlreadyExists(error))
          throw new PdfExportError(
            "E_OUTPUT_EXISTS",
            `出力先は既に存在します: ${outputPath}`,
            error,
          );
        throw error;
      }
      // The link has published the final file. Its staging peer can now be
      // removed best-effort; a cleanup failure must not turn a completed export
      // into E_IO.
      const publishedStagingPath = stagingPath;
      stagingPath = undefined;
      await (dependencies.removeStagingFile ?? ((path: string) => rm(path, { force: true })))(
        publishedStagingPath,
      ).catch(() => undefined);
    }
    stagingPath = undefined;
    return { format: "pdf", inputPath, outputPath, overwritten: outputExists, engineVersion };
  } catch (error) {
    if (error instanceof PdfExportError) throw error;
    if (isAbort(error, signal))
      throw new PdfExportError("E_CANCELLED", "PDF 書き出しはキャンセルされました", error);
    throw new PdfExportError("E_IO", `PDF の配置に失敗しました: ${String(error)}`, error);
  } finally {
    if (stagingPath) await rm(stagingPath, { force: true }).catch(() => undefined);
    if (tempDirectory)
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function defaultPdfOutputPath(inputPath: string): string {
  const absoluteInput = isAbsolute(inputPath) ? inputPath : resolve(inputPath);
  return defaultOutputPath(absoluteInput);
}

export interface FragmentCompileRequest {
  /** buildFragmentDocument で組み立てた standalone 文書の全文。 */
  document: string;
  tectonicPath?: string;
  /** \\includegraphics などの相対パスを解く作業ディレクトリ(デッキのディレクトリ)。無ければ一時ディレクトリ。 */
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface FragmentCompileResult {
  pdf: Uint8Array;
  engineVersion: string;
}

/**
 * 生ブロックの standalone 文書を一時ディレクトリでコンパイルし、PDF のバイト列を返す(#81)。
 * ファイルは残さない(キャッシュは呼び出し側が持つ)。失敗は exportPdf と同じ PdfExportError。
 */
export async function compileFragment(
  request: FragmentCompileRequest,
  dependencies: PdfExportDependencies = {},
): Promise<FragmentCompileResult> {
  const runner = dependencies.runner ?? nodeProcessRunner;
  const tectonic = request.tectonicPath ?? "tectonic";
  const signal = request.signal;
  const timeoutMs =
    request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : DEFAULT_COMPILE_TIMEOUT_MS;
  throwIfCancelled(signal);
  const makeTemp =
    dependencies.temporaryDirectory ?? ((prefix: string) => mkdtemp(join(tmpdir(), prefix)));
  let tempDirectory: string | undefined;
  try {
    tempDirectory = await makeTemp("beamer-editor-fragment-");
    const engineVersion = await ensureTectonic(runner, tectonic, tempDirectory, signal);
    const inputPath = join(tempDirectory, "fragment.tex");
    await writeFile(inputPath, request.document, "utf8");
    throwIfCancelled(signal);
    let compileResult: ProcessResult;
    try {
      compileResult = await runner.run(
        tectonic,
        ["-X", "compile", "--outdir", tempDirectory, inputPath],
        runnerOptions(request.cwd ?? tempDirectory, signal, timeoutMs),
      );
    } catch (error) {
      if (isAbort(error, signal))
        throw new PdfExportError("E_CANCELLED", "部分コンパイルはキャンセルされました", error);
      if (error instanceof ProcessNotFoundError || isNotFound(error))
        throw new PdfExportError("E_TECTONIC_NOT_FOUND", errorMessage(error), error);
      throw new PdfExportError(
        "E_COMPILE",
        `Tectonic の実行に失敗しました: ${String(error)}`,
        error,
      );
    }
    if (compileResult.cancelled || signal?.aborted)
      throw new PdfExportError("E_CANCELLED", "部分コンパイルはキャンセルされました");
    if (compileResult.timedOut)
      throw new PdfExportError(
        "E_COMPILE",
        `部分コンパイルが ${timeoutMs / 1000} 秒でタイムアウトしました${processDetail(compileResult)}`,
      );
    const compiledPdf = join(tempDirectory, "fragment.pdf");
    if (compileResult.exitCode !== 0 || !(await regularNonEmptyFile(compiledPdf)))
      throw new PdfExportError(
        "E_COMPILE",
        `部分コンパイルに失敗しました${processDetail(compileResult)}`,
      );
    const pdf = new Uint8Array(await readFile(compiledPdf));
    return { pdf, engineVersion };
  } catch (error) {
    if (error instanceof PdfExportError) throw error;
    if (isAbort(error, signal))
      throw new PdfExportError("E_CANCELLED", "部分コンパイルはキャンセルされました", error);
    throw new PdfExportError(
      "E_IO",
      `部分コンパイルの入出力に失敗しました: ${String(error)}`,
      error,
    );
  } finally {
    if (tempDirectory)
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export { buildFragmentDocument } from "./fragment.js";
