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
const DEFAULT_DECK_PAGE_LIMIT = 200;
const DEFAULT_DECK_PDF_BYTES_LIMIT = 64 * 1024 * 1024;
const DEFAULT_DECK_PNG_BYTES_LIMIT = 64 * 1024 * 1024;
const DEFAULT_DECK_LOG_BYTES_LIMIT = 8 * 1024 * 1024;
const DEFAULT_DECK_IMAGE_PIXELS_LIMIT = 32 * 1024 * 1024;
const DEFAULT_DECK_IMAGE_DIMENSION_LIMIT = 8_192;

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
  | "E_RASTERIZE"
  | "E_LIMIT"
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

// ---------------------------------------------------------------------------
// Deck/frame compilation
// ---------------------------------------------------------------------------

/** A logical Beamer frame. `number` is its one-based source order. */
export interface FrameAddress {
  number: number;
  label: string | null;
}

/** A PNG rendered from one physical PDF page. */
export interface FrameImage {
  /** One-based physical PDF page number. */
  page: number;
  png: Uint8Array;
  width: number;
  height: number;
}

export interface SourceLineRange {
  start: number;
  end: number;
}

export interface CompileWarning {
  kind: "overfull-hbox" | "overfull-vbox";
  message: string;
  excessPt: number | null;
  frame: FrameAddress | null;
  sourceLines: SourceLineRange | null;
}

export interface CompiledFrame {
  address: FrameAddress;
  /** UTF-16 offsets in the original, unmodified source. */
  span: { start: number; end: number };
  images: readonly FrameImage[];
}

export interface DeckFramesResult {
  engineVersion: string;
  frames: readonly CompiledFrame[];
  warnings: readonly CompileWarning[];
  /** Canvas object positions measured by the tool-managed TeX preamble. */
  layoutDiagnostics: readonly CanvasLayoutDiagnostic[];
}

export interface CanvasGeometry {
  /** The source frame that most recently emitted a frame marker. */
  frame: FrameAddress;
  /** Physical PDF page on which Tectonic measured this object. */
  page: number;
  kind: "text" | "image";
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasLayoutDiagnostic {
  kind: "canvas-overflow" | "canvas-overlap";
  severity: "warning" | "info";
  frame: FrameAddress;
  message: string;
  /** The object outside the body, or the first object in an overlap pair. */
  geometry: CanvasGeometry;
  /** Present only for an overlap diagnostic. */
  overlappingGeometry?: CanvasGeometry;
}

export interface CompileDeckFramesRequest {
  inputPath: string;
  tectonicPath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Whether to render physical PDF pages as PNGs. Defaults to true. */
  includeImages?: boolean;
  /** Maximum physical PDF pages accepted. Defaults to 200. */
  maxPages?: number;
  /** Maximum compiled PDF size. Defaults to 64 MiB. */
  maxPdfBytes?: number;
  /** Maximum combined PNG size. Defaults to 64 MiB. */
  maxPngBytes?: number;
  /** Maximum Tectonic log size accepted for frame mapping. Defaults to 8 MiB. */
  maxLogBytes?: number;
  /** Maximum decoded pixels for one rendered page. Defaults to 32 megapixels. */
  maxPixelsPerPage?: number;
  /** Maximum decoded width or height for one rendered page. Defaults to 8192 px. */
  maxImageDimension?: number;
}

/**
 * A host-provided PDF renderer. Keeping it injected lets the VS Code host use
 * its existing PDF.js instance without adding a native dependency here.
 */
export interface DeckFrameRasterizer {
  rasterize(
    pdfPath: string,
    options: {
      signal?: AbortSignal;
      maxPages: number;
      maxPngBytes: number;
      maxPixelsPerPage: number;
      maxImageDimension: number;
    },
  ): Promise<readonly FrameImage[]>;
}

export interface CompileDeckFramesDependencies {
  runner?: ProcessRunner;
  temporaryDirectory?: (prefix: string) => Promise<string>;
  rasterizer?: DeckFrameRasterizer;
}

interface MeasuredFrame {
  address: FrameAddress;
  span: { start: number; end: number };
  lines: SourceLineRange;
}

const FRAME_MARKER_PREFIX = "BEAMER_EDITOR_FRAME:";
const FRAME_MARKER_WIDTH = 6;

function markerForFrame(number: number): string {
  return `\\typeout{${FRAME_MARKER_PREFIX}${String(number).padStart(FRAME_MARKER_WIDTH, "0")}}`;
}

/**
 * Masks comments while retaining every original offset and line break. This is
 * deliberately a small scanner rather than the editor parser: compilation must
 * also cover RawFrame source the editor does not understand.
 */
function withoutComments(source: string): string {
  let value = "";
  let comment = false;
  let backslashes = 0;
  for (const character of source) {
    if (character === "\n" || character === "\r") {
      value += character;
      comment = false;
      backslashes = 0;
    } else if (comment) {
      value += " ".repeat(character.length);
    } else if (character === "%" && backslashes % 2 === 0) {
      value += " ";
      comment = true;
      backslashes = 0;
    } else {
      value += character;
      backslashes = character === "\\" ? backslashes + 1 : 0;
    }
  }
  return value;
}

function sourceLineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (source[index] === "\n") line += 1;
  return line;
}

function frameLabel(options: string | undefined): string | null {
  if (!options) return null;
  // A label option cannot use an unbraced comma in normal Beamer syntax. Keep
  // the original text otherwise, rather than attempting to interpret TeX.
  const match = /(?:^|,)\s*label\s*=\s*([^,\]]+)/.exec(options);
  return match?.[1]?.trim() || null;
}

/** Parse frame boundaries from source without changing any original offsets. */
export function findDeckFrames(source: string): readonly CompiledFrame[] {
  const masked = withoutComments(source);
  const begin = /\\begin\s*\{\s*frame\s*\}(?:<[^>\r\n]*>)?\s*(?:\[([^\]\r\n]*)\])?/g;
  const end = /\\end\s*\{\s*frame\s*\}/g;
  const frames: CompiledFrame[] = [];
  for (let match = begin.exec(masked); match; match = begin.exec(masked)) {
    end.lastIndex = begin.lastIndex;
    const closing = end.exec(masked);
    if (!closing) break;
    const number = frames.length + 1;
    frames.push({
      address: { number, label: frameLabel(match[1]) },
      span: { start: match.index, end: end.lastIndex },
      images: [],
    });
    begin.lastIndex = end.lastIndex;
  }
  return frames;
}

/** Add same-line markers so original source line numbers remain valid. */
export function injectFrameMarkers(
  source: string,
  frames: readonly Pick<CompiledFrame, "address" | "span">[] = findDeckFrames(source),
): string {
  let value = "";
  let cursor = 0;
  for (const frame of frames) {
    value += source.slice(cursor, frame.span.start);
    value += markerForFrame(frame.address.number);
    cursor = frame.span.start;
  }
  return value + source.slice(cursor);
}

function measuredFrames(source: string): readonly MeasuredFrame[] {
  return findDeckFrames(source).map((frame) => ({
    address: frame.address,
    span: frame.span,
    lines: {
      start: sourceLineAt(source, frame.span.start),
      end: sourceLineAt(source, frame.span.end),
    },
  }));
}

interface LogEvent {
  type: "marker" | "page";
  value: number;
}

function* logEvents(output: string): IterableIterator<LogEvent> {
  // Tectonic can put shipout resource chatter between the opening page number
  // and its closing bracket (`[1\n...\n]`). The opening bracket + positive
  // integer is the stable page-start signal; requiring `]` loses real pages.
  const expression = new RegExp(`${FRAME_MARKER_PREFIX}(\\d+)|\\[(\\d+)(?=\\s|\\])`, "g");
  for (let match = expression.exec(output); match; match = expression.exec(output)) {
    const value = Number(match[1] ?? match[2]);
    if (Number.isSafeInteger(value) && value > 0)
      yield { type: match[1] === undefined ? "page" : "marker", value };
  }
}

/**
 * Associate physical page numbers with logical frame numbers. Never guesses:
 * repeated/out-of-order markers or a page before the first marker are errors.
 */
export function groupFramePages(
  log: string,
  frames: readonly { address: FrameAddress }[],
  maxPages?: number,
): ReadonlyMap<number, readonly number[]> {
  const pages = new Map<number, number[]>();
  for (const frame of frames) pages.set(frame.address.number, []);
  let active: number | undefined;
  let expectedMarker = 1;
  let expectedPage = 1;
  let pageCount = 0;
  for (const event of logEvents(log)) {
    if (event.type === "marker") {
      if (event.value !== expectedMarker || !pages.has(event.value))
        throw new PdfExportError("E_COMPILE", "frame marker とソース frame の対応を確認できません");
      active = event.value;
      expectedMarker += 1;
    } else {
      if (event.value !== expectedPage || active === undefined)
        throw new PdfExportError("E_COMPILE", "PDF page と frame marker の対応を確認できません");
      pageCount += 1;
      if (maxPages !== undefined && pageCount > maxPages)
        throw new PdfExportError("E_LIMIT", `PDF page 数が上限 ${maxPages} を超えています`);
      pages.get(active)?.push(event.value);
      expectedPage += 1;
    }
  }
  if (expectedMarker !== frames.length + 1)
    throw new PdfExportError(
      "E_COMPILE",
      "すべての frame marker を Tectonic 出力から取得できません",
    );
  return pages;
}

function parseOverfullWarnings(
  log: string,
  frames: readonly MeasuredFrame[],
): readonly CompileWarning[] {
  const warnings: CompileWarning[] = [];
  const expression =
    /Overfull \\(hbox|vbox) \(([-+]?\d+(?:\.\d+)?)pt too (?:wide|high)\)(?:[^\n]*?\bat lines? (\d+)(?:--(\d+))?|[^\n]*?has occurred while \\output is active)?/g;
  for (let match = expression.exec(log); match; match = expression.exec(log)) {
    const start = match[3] === undefined ? undefined : Number(match[3]);
    const end = match[4] === undefined ? start : Number(match[4]);
    const owner =
      start === undefined
        ? undefined
        : frames.find((frame) => start >= frame.lines.start && start <= frame.lines.end);
    warnings.push({
      kind: match[1] === "hbox" ? "overfull-hbox" : "overfull-vbox",
      message: match[0],
      excessPt: Number(match[2]),
      frame: owner?.address ?? null,
      sourceLines: start === undefined || end === undefined ? null : { start, end },
    });
  }
  return warnings;
}

const CANVAS_EPSILON_PT = 0.01;
const MAX_CANVAS_LAYOUT_DIAGNOSTICS = 10_000;
const MAX_CANVAS_OVERLAP_COMPARISONS = 100_000;
// Tectonic physically folds long `\typeout` lines, including in the middle of
// a dimension token. Only a CRLF/LF is accepted inside a numeric token; plain
// spaces remain invalid so this does not broaden the managed-log grammar.
const LOG_FOLD = "(?:\\r?\\n)?";
const FOLDED_DIGITS = `\\d(?:${LOG_FOLD}\\d)*`;
const PT_NUMBER = `[-+]?(?:${FOLDED_DIGITS}(?:${LOG_FOLD}\\.${LOG_FOLD}${FOLDED_DIGITS})?|${LOG_FOLD}\\.${LOG_FOLD}${FOLDED_DIGITS})(?:[eE][-+]?${FOLDED_DIGITS})?`;
const PT_UNIT = `p${LOG_FOLD}t`;
// Each managed record is emitted by a separate \typeout, and therefore starts
// at a physical log-line boundary. Tectonic may fold a long record onto later
// physical lines, which LOG_FOLD continues to accept inside its fields.
const MANAGED_RECORD_BOUNDARY = "(?=\\r?\\n|$)";
const DECK_BODY_RECORD = new RegExp(
  `^DECKBODY\\s+left=(${PT_NUMBER})${LOG_FOLD}${PT_UNIT}\\s+top=(${PT_NUMBER})${LOG_FOLD}${PT_UNIT}\\s+width=(${PT_NUMBER})${LOG_FOLD}${PT_UNIT}\\s+height=(${PT_NUMBER})${LOG_FOLD}${PT_UNIT}${MANAGED_RECORD_BOUNDARY}`,
);
const DECK_GEOMETRY_RECORD = new RegExp(
  `^DECKGEOM\\s+frame=(\\d+)\\s+page=(\\d+)\\s+kind=(text|image)\\s+x=(${PT_NUMBER})${LOG_FOLD}${PT_UNIT}\\s+y=(${PT_NUMBER})${LOG_FOLD}${PT_UNIT}\\s+w=(${PT_NUMBER})${LOG_FOLD}${PT_UNIT}\\s+h=(${PT_NUMBER})${LOG_FOLD}${PT_UNIT}${MANAGED_RECORD_BOUNDARY}`,
);
const DECK_GEOMETRY_ERROR_RECORD = new RegExp(
  `^DECKGEOMERROR\\s+reason=unresolved${MANAGED_RECORD_BOUNDARY}`,
);

interface CanvasBody {
  left: number;
  top: number;
  width: number;
  height: number;
}

function canvasCompileError(message: string): PdfExportError {
  return new PdfExportError("E_COMPILE", `DECKBODY/DECKGEOM log が不正です: ${message}`);
}

function finitePt(
  value: string,
  name: string,
  constraint: "any" | "nonnegative" | "positive" = "any",
): number {
  const number = Number(value.replace(/\r?\n/g, ""));
  if (
    !Number.isFinite(number) ||
    (constraint === "positive" && number <= 0) ||
    (constraint === "nonnegative" && number < 0)
  )
    throw canvasCompileError(
      `${name} は${constraint === "positive" ? "正" : constraint === "nonnegative" ? "非負" : "有限"}の pt 値にしてください`,
    );
  return number;
}

function addCanvasDiagnostic(
  diagnostics: CanvasLayoutDiagnostic[],
  diagnostic: CanvasLayoutDiagnostic,
): void {
  if (diagnostics.length >= MAX_CANVAS_LAYOUT_DIAGNOSTICS)
    throw new PdfExportError(
      "E_LIMIT",
      `canvas layout 診断が上限 ${MAX_CANVAS_LAYOUT_DIAGNOSTICS} 件を超えています`,
    );
  diagnostics.push(diagnostic);
}

function consumeCanvasOverlapComparison(count: number): number {
  if (count >= MAX_CANVAS_OVERLAP_COMPARISONS)
    throw new PdfExportError(
      "E_LIMIT",
      `canvas overlap 比較が上限 ${MAX_CANVAS_OVERLAP_COMPARISONS} 回を超えています`,
    );
  return count + 1;
}

/**
 * Parse the tool-managed canvas log records and report measured layout issues.
 * A DECKGEOM's printed frame is retained as TeX-side metadata only: ownership
 * is always the source ordinal from the most recent injected frame marker.
 */
export function analyzeCanvasGeometry(
  log: string,
  frames: readonly { address: FrameAddress }[],
): readonly CanvasLayoutDiagnostic[] {
  let body: CanvasBody | undefined;
  let active: FrameAddress | undefined;
  let expectedMarker = 1;
  const geometries: CanvasGeometry[] = [];
  const records = /(?:^|\r?\n)(BEAMER_EDITOR_FRAME:(\d+)|DECKBODY\b|DECKGEOMERROR\b|DECKGEOM\b)/g;
  const invalidManagedPrefix = /(?:^|\r?\n)\S+(?:DECKBODY\b|DECKGEOMERROR\b|DECKGEOM\b)/.exec(log);
  if (invalidManagedPrefix) throw canvasCompileError("管理 record の先頭に不正な文字列があります");

  for (let marker = records.exec(log); marker; marker = records.exec(log)) {
    const recordName = marker[1] as string;
    if (marker[2] !== undefined) {
      const number = Number(marker[2]);
      if (number !== expectedMarker || frames[number - 1] === undefined)
        throw canvasCompileError("frame marker とソース frame の対応を確認できません");
      active = frames[number - 1]?.address;
      expectedMarker += 1;
      continue;
    }

    const record = log.slice(marker.index + marker[0].length - recordName.length);
    if (recordName === "DECKBODY") {
      const parsed = DECK_BODY_RECORD.exec(record);
      if (!parsed) throw canvasCompileError("DECKBODY のフィールド順または pt 値を読み取れません");
      if (body) throw canvasCompileError("DECKBODY は 1 回だけ出力してください");
      body = {
        left: finitePt(parsed[1] as string, "DECKBODY left"),
        top: finitePt(parsed[2] as string, "DECKBODY top"),
        width: finitePt(parsed[3] as string, "DECKBODY width", "positive"),
        height: finitePt(parsed[4] as string, "DECKBODY height", "positive"),
      };
      continue;
    }

    if (recordName === "DECKGEOMERROR") {
      if (!DECK_GEOMETRY_ERROR_RECORD.test(record))
        throw canvasCompileError("DECKGEOMERROR を読み取れません");
      throw canvasCompileError("canvas object の savepos が最終 pass で解決していません");
    }
    const parsed = DECK_GEOMETRY_RECORD.exec(record);
    if (!parsed) throw canvasCompileError("DECKGEOM のフィールド順または pt 値を読み取れません");
    if (!active) throw canvasCompileError("DECKGEOM の前に frame marker がありません");
    // Validate this field even though allocation intentionally uses `active`.
    if (!Number.isSafeInteger(Number(parsed[1])) || Number(parsed[1]) < 1)
      throw canvasCompileError("DECKGEOM frame が不正です");
    if (!Number.isSafeInteger(Number(parsed[2])) || Number(parsed[2]) < 1)
      throw canvasCompileError("DECKGEOM page が不正です");
    geometries.push({
      frame: active,
      page: Number(parsed[2]),
      kind: parsed[3] as CanvasGeometry["kind"],
      x: finitePt(parsed[4] as string, "DECKGEOM x"),
      y: finitePt(parsed[5] as string, "DECKGEOM y"),
      width: finitePt(parsed[6] as string, "DECKGEOM w", "nonnegative"),
      height: finitePt(parsed[7] as string, "DECKGEOM h", "nonnegative"),
    });
  }

  if (geometries.length === 0) return [];
  if (!body) throw canvasCompileError("DECKGEOM がある場合は DECKBODY がちょうど 1 回必要です");

  const diagnostics: CanvasLayoutDiagnostic[] = [];
  const byPage = new Map<string, Array<{ geometry: CanvasGeometry; index: number }>>();
  for (const [index, geometry] of geometries.entries()) {
    if (
      geometry.x < body.left - CANVAS_EPSILON_PT ||
      geometry.y < body.top - CANVAS_EPSILON_PT ||
      geometry.x + geometry.width > body.left + body.width + CANVAS_EPSILON_PT ||
      geometry.y + geometry.height > body.top + body.height + CANVAS_EPSILON_PT
    )
      addCanvasDiagnostic(diagnostics, {
        kind: "canvas-overflow",
        severity: "warning",
        frame: geometry.frame,
        geometry,
        message: "canvas object が本文領域からはみ出しています",
      });
    const key = `${geometry.frame.number}:${geometry.page}`;
    const values = byPage.get(key) ?? [];
    values.push({ geometry, index });
    byPage.set(key, values);
  }

  // Sweep on x. Active entries are discarded by right edge; therefore the
  // pair loop has a hard work limit as well as a diagnostic limit. This keeps
  // a stack of x-overlapping but y-disjoint objects from becoming O(n²).
  let overlapComparisons = 0;
  for (const entries of byPage.values()) {
    const ordered = [...entries].sort(
      (first, second) => first.geometry.x - second.geometry.x || first.index - second.index,
    );
    const activeEntries: Array<{ geometry: CanvasGeometry; index: number }> = [];
    for (const current of ordered) {
      const nextActive = activeEntries.filter((other) => {
        overlapComparisons = consumeCanvasOverlapComparison(overlapComparisons);
        return other.geometry.x + other.geometry.width > current.geometry.x + CANVAS_EPSILON_PT;
      });
      activeEntries.length = 0;
      activeEntries.push(...nextActive);
      for (const other of activeEntries) {
        overlapComparisons = consumeCanvasOverlapComparison(overlapComparisons);
        const top = Math.max(other.geometry.y, current.geometry.y);
        const bottom = Math.min(
          other.geometry.y + other.geometry.height,
          current.geometry.y + current.geometry.height,
        );
        if (bottom <= top + CANVAS_EPSILON_PT) continue;
        addCanvasDiagnostic(diagnostics, {
          kind: "canvas-overlap",
          severity: "info",
          frame: current.geometry.frame,
          geometry: other.geometry,
          overlappingGeometry: current.geometry,
          message: "canvas object 同士が重なっています",
        });
      }
      activeEntries.push(current);
    }
  }
  return diagnostics;
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new PdfExportError("E_INPUT", `${name} は 1 以上の整数にしてください`);
  return value;
}

function compiledLogName(inputPath: string): string {
  return `${basename(inputPath, extname(inputPath))}.log`;
}

async function readCompilationLog(path: string, maxBytes: number): Promise<string> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (error) {
    throw new PdfExportError("E_COMPILE", "Tectonic の最終 pass の log を読み込めません", error);
  }
  if (!info.isFile() || info.size === 0)
    throw new PdfExportError("E_COMPILE", "Tectonic の最終 pass の log がありません");
  if (info.size > maxBytes)
    throw new PdfExportError("E_LIMIT", `Tectonic log が上限 ${maxBytes} bytes を超えています`);
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new PdfExportError("E_COMPILE", "Tectonic の最終 pass の log を読み込めません", error);
  }
}

/**
 * Compile a complete deck once, then group its physical PDF pages by logical
 * frame. The original input is only read; a same-basename marked copy is kept
 * under an OS temporary directory and removed on every exit path.
 */
export async function compileDeckFrames(
  request: CompileDeckFramesRequest,
  dependencies: CompileDeckFramesDependencies = {},
): Promise<DeckFramesResult> {
  const runner = dependencies.runner ?? nodeProcessRunner;
  const includeImages = request.includeImages ?? true;
  const rasterizer = dependencies.rasterizer;
  if (includeImages && rasterizer === undefined)
    throw new PdfExportError("E_RASTERIZE", "frame PNG を生成する rasterizer が設定されていません");
  const signal = request.signal;
  throwIfCancelled(signal);
  const inputPath = resolve(request.inputPath);
  if (!(await regularFile(inputPath)))
    throw new PdfExportError("E_INPUT", `入力 TeX を読み込めません: ${request.inputPath}`);
  const maxPages = positiveLimit(request.maxPages, DEFAULT_DECK_PAGE_LIMIT, "maxPages");
  const maxPdfBytes = positiveLimit(
    request.maxPdfBytes,
    DEFAULT_DECK_PDF_BYTES_LIMIT,
    "maxPdfBytes",
  );
  const maxPngBytes = positiveLimit(
    request.maxPngBytes,
    DEFAULT_DECK_PNG_BYTES_LIMIT,
    "maxPngBytes",
  );
  const maxLogBytes = positiveLimit(
    request.maxLogBytes,
    DEFAULT_DECK_LOG_BYTES_LIMIT,
    "maxLogBytes",
  );
  const maxPixelsPerPage = positiveLimit(
    request.maxPixelsPerPage,
    DEFAULT_DECK_IMAGE_PIXELS_LIMIT,
    "maxPixelsPerPage",
  );
  const maxImageDimension = positiveLimit(
    request.maxImageDimension,
    DEFAULT_DECK_IMAGE_DIMENSION_LIMIT,
    "maxImageDimension",
  );
  const source = await readFile(inputPath, "utf8").catch((error: unknown) => {
    throw new PdfExportError("E_INPUT", `入力 TeX を読み込めません: ${request.inputPath}`, error);
  });
  const frames = measuredFrames(source);
  if (frames.length === 0)
    throw new PdfExportError("E_INPUT", "入力 TeX に frame 環境がありません");
  if (frames.length > 999_999)
    throw new PdfExportError("E_LIMIT", "frame 数が marker の上限を超えています");

  const tectonic = request.tectonicPath ?? "tectonic";
  let versionResult: ProcessResult;
  try {
    versionResult = await runner.run(
      tectonic,
      ["--version"],
      runnerOptions(dirname(inputPath), signal, VERSION_TIMEOUT_MS),
    );
  } catch (error) {
    if (isAbort(error, signal))
      throw new PdfExportError("E_CANCELLED", "コンパイルはキャンセルされました", error);
    if (error instanceof ProcessNotFoundError || isNotFound(error))
      throw new PdfExportError("E_TECTONIC_NOT_FOUND", errorMessage(error), error);
    throw new PdfExportError(
      "E_TECTONIC_VERSION",
      `Tectonic のバージョンを取得できません: ${String(error)}`,
      error,
    );
  }
  if (versionResult.cancelled || signal?.aborted)
    throw new PdfExportError("E_CANCELLED", "コンパイルはキャンセルされました");
  const engineVersion =
    versionResult.exitCode === 0
      ? versionFrom(`${versionResult.stdout}\n${versionResult.stderr}`)
      : undefined;
  if (!engineVersion)
    throw new PdfExportError(
      "E_TECTONIC_VERSION",
      `Tectonic のバージョンを確認できません${processDetail(versionResult)}`,
    );

  const makeTemp =
    dependencies.temporaryDirectory ?? ((prefix: string) => mkdtemp(join(tmpdir(), prefix)));
  let temporaryDirectory: string | undefined;
  try {
    temporaryDirectory = await makeTemp("beamer-editor-frames-");
    const measuredInput = join(temporaryDirectory, basename(inputPath));
    await writeFile(measuredInput, injectFrameMarkers(source, frames));
    throwIfCancelled(signal);
    let compileResult: ProcessResult;
    try {
      compileResult = await runner.run(
        tectonic,
        ["-X", "compile", "--keep-logs", "--outdir", temporaryDirectory, measuredInput],
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
        throw new PdfExportError("E_CANCELLED", "コンパイルはキャンセルされました", error);
      if (error instanceof ProcessNotFoundError || isNotFound(error))
        throw new PdfExportError("E_TECTONIC_NOT_FOUND", errorMessage(error), error);
      throw new PdfExportError(
        "E_COMPILE",
        `Tectonic の実行に失敗しました: ${String(error)}`,
        error,
      );
    }
    if (compileResult.cancelled || signal?.aborted)
      throw new PdfExportError("E_CANCELLED", "コンパイルはキャンセルされました");
    if (compileResult.timedOut)
      throw new PdfExportError(
        "E_COMPILE",
        `コンパイルがタイムアウトしました${processDetail(compileResult)}`,
      );
    const pdfPath = join(temporaryDirectory, compiledPdfName(inputPath));
    if (compileResult.exitCode !== 0 || !(await regularNonEmptyFile(pdfPath)))
      throw new PdfExportError(
        "E_COMPILE",
        `PDF のコンパイルに失敗しました${processDetail(compileResult)}`,
      );
    const pdfInfo = await stat(pdfPath);
    if (pdfInfo.size > maxPdfBytes)
      throw new PdfExportError("E_LIMIT", `PDF が上限 ${maxPdfBytes} bytes を超えています`);
    const log = await readCompilationLog(
      join(temporaryDirectory, compiledLogName(inputPath)),
      maxLogBytes,
    );
    const groups = groupFramePages(log, frames, maxPages);
    const warnings = parseOverfullWarnings(log, frames);
    const layoutDiagnostics = analyzeCanvasGeometry(log, frames);
    if (signal?.aborted)
      throw new PdfExportError("E_CANCELLED", "コンパイルはキャンセルされました");
    if (!includeImages) {
      return {
        engineVersion,
        frames: frames.map((frame) => ({
          address: frame.address,
          span: frame.span,
          images: [],
        })),
        warnings,
        layoutDiagnostics,
      };
    }
    // Kept as a local guard for TypeScript after the analysis-only early return.
    if (rasterizer === undefined)
      throw new PdfExportError(
        "E_RASTERIZE",
        "frame PNG を生成する rasterizer が設定されていません",
      );
    let images: readonly FrameImage[];
    try {
      images = await rasterizer.rasterize(
        pdfPath,
        signal === undefined
          ? { maxPages, maxPngBytes, maxPixelsPerPage, maxImageDimension }
          : { signal, maxPages, maxPngBytes, maxPixelsPerPage, maxImageDimension },
      );
    } catch (error) {
      if (error instanceof PdfExportError) throw error;
      if (isAbort(error, signal))
        throw new PdfExportError("E_CANCELLED", "コンパイルはキャンセルされました", error);
      throw new PdfExportError(
        "E_RASTERIZE",
        `PDF page の rasterize に失敗しました: ${String(error)}`,
        error,
      );
    }
    if (signal?.aborted)
      throw new PdfExportError("E_CANCELLED", "コンパイルはキャンセルされました");
    if (images.length > maxPages)
      throw new PdfExportError("E_LIMIT", `PDF page 数が上限 ${maxPages} を超えています`);
    const imageByPage = new Map<number, FrameImage>();
    let pngBytes = 0;
    for (const image of images) {
      if (!Number.isSafeInteger(image.page) || image.page < 1 || imageByPage.has(image.page))
        throw new PdfExportError("E_RASTERIZE", "rasterizer が不正な PDF page を返しました");
      if (
        !Number.isSafeInteger(image.width) ||
        !Number.isSafeInteger(image.height) ||
        image.width <= 0 ||
        image.height <= 0 ||
        image.width > maxImageDimension ||
        image.height > maxImageDimension ||
        image.width * image.height > maxPixelsPerPage
      )
        throw new PdfExportError(
          "E_LIMIT",
          "rasterizer が画像サイズ上限を超える page を返しました",
        );
      pngBytes += image.png.byteLength;
      if (pngBytes > maxPngBytes)
        throw new PdfExportError("E_LIMIT", `PNG 合計が上限 ${maxPngBytes} bytes を超えています`);
      imageByPage.set(image.page, image);
    }
    let expectedPageCount = 0;
    for (const pages of groups.values()) {
      expectedPageCount += pages.length;
      if (pages.some((page) => !imageByPage.has(page)))
        throw new PdfExportError(
          "E_RASTERIZE",
          "rasterizer の PDF page と Tectonic 出力が一致しません",
        );
    }
    if (images.length !== expectedPageCount)
      throw new PdfExportError(
        "E_RASTERIZE",
        "rasterizer の PDF page と Tectonic 出力が一致しません",
      );
    return {
      engineVersion,
      frames: frames.map((frame) => ({
        address: frame.address,
        span: frame.span,
        images:
          groups.get(frame.address.number)?.map((page) => imageByPage.get(page) as FrameImage) ??
          [],
      })),
      warnings,
      layoutDiagnostics,
    };
  } catch (error) {
    if (error instanceof PdfExportError) throw error;
    if (isAbort(error, signal))
      throw new PdfExportError("E_CANCELLED", "コンパイルはキャンセルされました", error);
    throw new PdfExportError("E_IO", `frame コンパイルに失敗しました: ${String(error)}`, error);
  } finally {
    if (temporaryDirectory)
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface FragmentCompileRequest {
  /** buildFragmentDocument で組み立てた standalone 文書の全文。 */
  document: string;
  tectonicPath?: string;
  /** \\includegraphics などの相対パスを解く作業ディレクトリ(デッキのディレクトリ)。無ければ一時ディレクトリ。 */
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 生成 PDF のバイト数の上限。超えたら読み込まずに E_COMPILE にする(巨大な出力でメモリを使い切らない)。 */
  maxOutputBytes?: number;
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
    const { size } = await stat(compiledPdf);
    if (request.maxOutputBytes !== undefined && size > request.maxOutputBytes)
      throw new PdfExportError(
        "E_COMPILE",
        `生成された PDF が大きすぎます(${size} バイト、上限 ${request.maxOutputBytes} バイト)`,
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

export {
  buildFragmentDocument,
  FRAGMENT_DOCUMENT_VERSION,
  fragmentDependencies,
  fragmentGraphicsPaths,
} from "./fragment.js";
