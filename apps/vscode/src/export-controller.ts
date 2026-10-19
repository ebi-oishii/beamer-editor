import {
  defaultPdfOutputPath,
  exportPdf,
  PdfExportError,
  type PdfExportErrorCode,
  type PdfExportProgress,
  type PdfExportResult,
} from "@beamer-editor/compiler";
import { type LintOptions, sourceLocation } from "@beamer-editor/core";
import {
  defaultHtmlOutputPath,
  exportHtml,
  HtmlExportError,
  type HtmlExportRequest,
  type HtmlExportResult,
} from "@beamer-editor/html-export";
import { lintDocumentText } from "./diagnostics";

export interface ExportUri {
  readonly scheme: string;
  readonly fsPath: string;
  toString(): string;
}

export interface ExportDocument {
  readonly uri: ExportUri;
  readonly isDirty: boolean;
  save(): Thenable<boolean>;
  getText(): string;
  /** 0 始まりの行と、行頭からの UTF-16 コードユニット数(vscode.TextDocument.positionAt)。 */
  positionAt(offset: number): { readonly line: number; readonly character: number };
}

export interface ExportCancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface ExportHost {
  readonly isWorkspaceTrusted: boolean;
  chooseFormat(): Thenable<"pdf" | "html" | undefined>;
  chooseOutput(defaultUri: ExportUri, format: "pdf" | "html"): Thenable<ExportUri | undefined>;
  outputExists(uri: ExportUri): Thenable<boolean>;
  /** `report` は進捗通知の本文を差し替える(VS Code の `progress.report({ message })`)。 */
  withProgress<T>(
    task: (token: ExportCancellationToken, report: (message: string) => void) => Thenable<T>,
  ): Thenable<T>;
  showInformation(message: string, ...actions: string[]): Thenable<string | undefined>;
  showError(message: string, ...actions: string[]): Thenable<string | undefined>;
  showWarning(message: string, ...actions: string[]): Thenable<string | undefined>;
  openPdf(uri: ExportUri): Thenable<unknown>;
  openHtml(uri: ExportUri): Thenable<unknown>;
  revealInFileManager(uri: ExportUri): Thenable<unknown>;
  openTectonicSettings(): Thenable<unknown>;
  showExportDetails(detail: string): void;
  /** Problems パネルを開く(コンパイル失敗に lint の error が伴うときの操作)。 */
  showProblems(): Thenable<unknown>;
  /** Problems パネルにこの文書の診断が出るか(managed file か)。出ない文書には「問題を表示」を出さない。 */
  showsProblems(document: ExportDocument): boolean;
  /** Problems パネルと同じ lint オプション(画像の存在・`text` から解決したテンプレート参照)。 */
  lintOptions(document: ExportDocument, text: string): LintOptions;
  uriForFile(path: string): ExportUri;
  tectonicPath(document: ExportDocument): string | undefined;
  timeoutMs(document: ExportDocument): number;
}

export interface ExportControllerDependencies {
  exportPdf?: (request: {
    inputPath: string;
    outputPath: string;
    overwrite: boolean;
    tectonicPath?: string;
    timeoutMs?: number;
    signal: AbortSignal;
    onProgress?: (progress: PdfExportProgress) => void;
  }) => Promise<PdfExportResult>;
  exportHtml?: (request: HtmlExportRequest) => Promise<HtmlExportResult>;
  htmlKatexAssetsPath?: string;
}

/** Command の対象は明示 URI、押下された preview、アクティブ editor の順に決める。 */
export function resolveExportDocument<T>(
  explicit: T | undefined,
  previews: Iterable<{ active: boolean; document: T }>,
  activeEditor: T | undefined,
): T | undefined {
  if (explicit) return explicit;
  for (const preview of previews) if (preview.active) return preview.document;
  return activeEditor;
}

/** VS Code configuration は外部入力なので、compiler に渡す前に文字列へ限定する。 */
export function normalizeTectonicPath(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const ERROR_MESSAGES: Record<Exclude<PdfExportErrorCode, "E_CANCELLED">, string> = {
  E_INPUT: "入力 TeX を読み込めませんでした。",
  E_OUTPUT_EXISTS: "出力先の PDF は既に存在します。",
  E_TECTONIC_NOT_FOUND: "Tectonic が見つかりません。",
  E_TECTONIC_VERSION: "Tectonic のバージョンを確認できませんでした。",
  E_COMPILE: "PDF のコンパイルに失敗しました。",
  E_RASTERIZE: "PDF ページ画像の生成に失敗しました。",
  E_LIMIT: "PDF の処理上限を超えました。",
  E_IO: "PDF の書き出し中に入出力エラーが発生しました。",
};

const DETAIL_LIMIT = 64 * 1024;
const PROGRESS_INTERVAL_MS = 250;

/**
 * 初回の TeX パッケージ取得は数百件続くため、通知の更新を間引く。間引いて保留中の最後の値は、
 * 成功時に `flush()` で同期的に出し、キャンセル・破棄時は `dispose()` で捨てる。
 */
function throttledReporter(report: (message: string) => void) {
  let lastReported = Number.NEGATIVE_INFINITY;
  let latest: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    latest = undefined;
  };
  const flush = () => {
    const message = latest;
    dispose();
    if (message === undefined) return;
    lastReported = Date.now();
    report(message);
  };
  return {
    report(message: string) {
      latest = message;
      if (timer) return;
      const wait = lastReported + PROGRESS_INTERVAL_MS - Date.now();
      if (wait <= 0) flush();
      else timer = setTimeout(flush, wait);
    },
    /** 保留中の値があれば今すぐ出す。 */
    flush,
    /** 保留中の値を出さずに捨てる。以降のタイマー通知も出ない。 */
    dispose,
  };
}

function downloadProgressMessage(progress: PdfExportProgress): string {
  return `TeX パッケージを取得中（初回のみ）: ${progress.count} 件 — ${progress.file}`;
}

function stripAnsi(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) !== 27) {
      result += value[index];
      continue;
    }
    if (value[index + 1] !== "[") {
      index++;
      continue;
    }
    index += 2;
    while (index < value.length) {
      const code = value.charCodeAt(index);
      if (code >= 64 && code <= 126) break;
      index++;
    }
  }
  return result;
}

function stripControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 10 || (code >= 32 && code !== 127);
    })
    .join("");
}

/** Output Channel に載せる compiler 詳細だけを安全な長さと文字種へ整える。 */
export function exportErrorDetail(error: PdfExportError): string {
  const detail = stripControlCharacters(
    stripAnsi(`[${error.code}] ${error.message}`).replace(/\r\n?/g, "\n"),
  );
  if (detail.length <= DETAIL_LIMIT) return detail;
  return `${detail.slice(0, DETAIL_LIMIT)}\n…（詳細を切り詰めました）`;
}

interface CompileLintError {
  line: number;
  column: number;
  code: string;
  message: string;
}

/**
 * コンパイルに失敗した文書の lint error。古い管理プリアンブル(L025)のように lint が原因を
 * 先に検出できる失敗を、TeX の出力だけで終わらせないために添える。lint するのはコンパイルに
 * 渡した本文(`compiled`)で、コンパイル中に編集されても今の文書は使わない。lint が例外を
 * 投げたら何も添えない(元の失敗の報告を妨げない)。
 */
function compileLintErrors(
  document: ExportDocument,
  compiled: string,
  options: (text: string) => LintOptions,
): { errors: CompileLintError[]; unchanged: boolean } {
  try {
    // 位置は Problems パネルと同じ positionAt で出す。今の文書が変わっていれば、その位置は
    // コンパイルした本文とずれるので、取っておいた本文から数える。
    const unchanged = document.getText() === compiled;
    const errors = lintDocumentText(compiled, options(compiled))
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => {
        const position = unchanged ? document.positionAt(diagnostic.span.start) : undefined;
        const { line, column } =
          position === undefined
            ? sourceLocation(compiled, diagnostic.span.start)
            : { line: position.line + 1, column: position.character + 1 };
        return { line, column, code: diagnostic.code, message: diagnostic.message };
      });
    return { errors, unchanged };
  } catch {
    return { errors: [], unchanged: false };
  }
}

/** Extension Host のみで PDF export の UI と compiler 呼び出しを調停する。 */
export class ExportController {
  private readonly activeUris = new Set<string>();
  private readonly activeAbortControllers = new Set<AbortController>();
  private readonly compile: NonNullable<ExportControllerDependencies["exportPdf"]>;
  private readonly html: NonNullable<ExportControllerDependencies["exportHtml"]>;
  private readonly htmlKatexAssetsPath: string | undefined;
  private disposed = false;

  constructor(
    private readonly host: ExportHost,
    dependencies: ExportControllerDependencies = {},
  ) {
    this.compile = dependencies.exportPdf ?? exportPdf;
    this.html = dependencies.exportHtml ?? exportHtml;
    this.htmlKatexAssetsPath = dependencies.htmlKatexAssetsPath;
  }

  async export(document: ExportDocument | undefined): Promise<void> {
    if (this.disposed) return;
    if (document?.uri.scheme !== "file" || !document.uri.fsPath.endsWith(".tex")) {
      await this.host.showError("書き出す .tex ファイルを開いてください。");
      return;
    }
    const key = document.uri.toString();
    if (this.activeUris.has(key)) {
      await this.host.showWarning("この文書は既に書き出しています。");
      return;
    }
    this.activeUris.add(key);
    try {
      await this.run(document);
    } finally {
      this.activeUris.delete(key);
    }
  }

  private async run(document: ExportDocument): Promise<void> {
    // The picker deliberately exposes only formats that have an implementation.
    const format = await this.host.chooseFormat();
    if (!format || this.disposed) return;
    if (format === "pdf" && !this.host.isWorkspaceTrusted) {
      await this.host.showWarning("PDF 書き出しは、信頼されたワークスペースでのみ実行できます。");
      return;
    }
    const output = await this.host.chooseOutput(
      this.host.uriForFile(
        format === "pdf"
          ? defaultPdfOutputPath(document.uri.fsPath)
          : defaultHtmlOutputPath(document.uri.fsPath),
      ),
      format,
    );
    if (!output || this.disposed) return;
    let overwrite = await this.host.outputExists(output);
    if (this.disposed) return;
    if (format === "html" && overwrite) {
      const action = await this.host.showWarning("既存の HTML 出力を上書きしますか？", "上書き");
      if (action !== "上書き") return;
      overwrite = true;
    }
    if (document.isDirty && !(await document.save())) {
      await this.host.showWarning("編集中のファイルを保存できなかったため、書き出しませんでした。");
      return;
    }
    if (this.disposed) return;
    // 保存直後の本文 = コンパイルする本文。失敗の報告ではこれを lint する(コンパイル中の編集を混ぜない)。
    let compiled: string | undefined;
    try {
      compiled = document.getText();
    } catch {
      compiled = undefined;
    }

    try {
      const result = await this.host.withProgress(async (token, report) => {
        const abort = new AbortController();
        const progress = throttledReporter(report);
        this.activeAbortControllers.add(abort);
        const subscription = token.onCancellationRequested(() => abort.abort());
        try {
          if (token.isCancellationRequested) abort.abort();
          if (this.disposed || abort.signal.aborted) return undefined;
          if (format === "html")
            return await this.html({
              inputPath: document.uri.fsPath,
              outputPath: output.fsPath,
              overwrite,
              signal: abort.signal,
              ...(this.htmlKatexAssetsPath === undefined
                ? {}
                : { katexAssetsPath: this.htmlKatexAssetsPath }),
            });
          const tectonicPath = this.host.tectonicPath(document);
          const timeoutMs = this.host.timeoutMs(document);
          const request = {
            inputPath: document.uri.fsPath,
            outputPath: output.fsPath,
            overwrite,
            timeoutMs,
            signal: abort.signal,
            onProgress: (value: PdfExportProgress) => {
              if (!this.disposed && !abort.signal.aborted)
                progress.report(downloadProgressMessage(value));
            },
            ...(tectonicPath === undefined ? {} : { tectonicPath }),
          };
          // Cancel and controller dispose both abort; the compile may take a
          // while to settle after that, so drop the pending update right away.
          abort.signal.addEventListener("abort", () => progress.dispose(), { once: true });
          const compiled = await this.compile(request);
          if (!this.disposed && !abort.signal.aborted) progress.flush();
          return compiled;
        } finally {
          progress.dispose();
          subscription.dispose();
          this.activeAbortControllers.delete(abort);
        }
      });
      if (!result || this.disposed) return;
      const isHtml = result.format === "html";
      const action = await this.host.showInformation(
        `${isHtml ? "HTML" : "PDF"} を書き出しました: ${result.outputPath}`,
        isHtml ? "HTMLを開く" : "PDFを開く",
        "フォルダーで表示",
      );
      try {
        if (action === "PDFを開く") await this.host.openPdf(output);
        else if (action === "HTMLを開く")
          await this.host.openHtml(this.host.uriForFile((result as HtmlExportResult).indexPath));
        else if (action === "フォルダーで表示") await this.host.revealInFileManager(output);
      } catch {
        await this.host.showWarning("書き出しは完了しましたが、表示操作に失敗しました。");
      }
    } catch (error) {
      await this.reportError(error, document, compiled);
    }
  }

  private async reportError(
    error: unknown,
    document: ExportDocument,
    compiled: string | undefined,
  ): Promise<void> {
    if (error instanceof HtmlExportError) {
      if (error.code !== "E_CANCELLED")
        await this.host.showError(`HTML の書き出しに失敗しました: ${error.message}`);
      return;
    }
    if (!(error instanceof PdfExportError)) {
      await this.host.showError("書き出しに失敗しました。");
      return;
    }
    if (error.code === "E_CANCELLED") return;
    const { errors: lintErrors, unchanged } =
      // TeX が非 0 で終わったときだけ(起動の失敗・タイムアウトなどにデッキ側の原因は添えない)。
      error.texFailed && compiled !== undefined
        ? compileLintErrors(document, compiled, (text) => this.host.lintOptions(document, text))
        : { errors: [], unchanged: false };
    const [first] = lintErrors;
    const message =
      first === undefined
        ? ERROR_MESSAGES[error.code]
        : `${ERROR_MESSAGES[error.code]} lint のエラーが ${lintErrors.length} 件あります(先頭: ${first.code}: ${first.message})`;
    const actions = [
      "詳細を表示",
      ...(error.code === "E_TECTONIC_NOT_FOUND" ? ["設定を開く"] : []),
      // 管理対象外の .tex は Problems パネルに診断が出ないので、通知と詳細に入れるだけにする。
      // コンパイル中に文書が変わったときも出さない(Problems パネルは今の本文の診断で、通知と合わない)。
      ...(first === undefined || !unchanged || !this.host.showsProblems(document)
        ? []
        : ["問題を表示"]),
    ];
    const action = await this.host.showError(message, ...actions);
    if (action === "詳細を表示") {
      const detail = exportErrorDetail(error);
      this.host.showExportDetails(
        first === undefined
          ? detail
          : [
              "lint のエラー(コンパイル失敗の原因かもしれません):",
              ...lintErrors.map(
                (entry) => `${entry.line}:${entry.column} ${entry.code} ${entry.message}`,
              ),
              "",
              detail,
            ].join("\n"),
      );
    }
    if (action === "問題を表示") await this.host.showProblems();
    if (error.code === "E_TECTONIC_NOT_FOUND") {
      if (action === "設定を開く") await this.host.openTectonicSettings();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.activeAbortControllers) controller.abort();
  }
}
