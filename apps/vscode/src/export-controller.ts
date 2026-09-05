import {
  defaultPdfOutputPath,
  exportPdf,
  PdfExportError,
  type PdfExportErrorCode,
  type PdfExportResult,
} from "@beamer-editor/compiler";

export interface ExportUri {
  readonly fsPath: string;
  toString(): string;
}

export interface ExportDocument {
  readonly uri: ExportUri;
  readonly isDirty: boolean;
  save(): Thenable<boolean>;
}

export interface ExportCancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface ExportHost {
  readonly isWorkspaceTrusted: boolean;
  chooseFormat(): Thenable<"pdf" | undefined>;
  chooseOutput(defaultUri: ExportUri): Thenable<ExportUri | undefined>;
  outputExists(uri: ExportUri): Thenable<boolean>;
  confirmOverwrite(uri: ExportUri): Thenable<boolean>;
  withProgress<T>(task: (token: ExportCancellationToken) => Thenable<T>): Thenable<T>;
  showInformation(message: string, ...actions: string[]): Thenable<string | undefined>;
  showError(message: string, ...actions: string[]): Thenable<string | undefined>;
  showWarning(message: string): Thenable<unknown>;
  openPdf(uri: ExportUri): Thenable<unknown>;
  revealInFileManager(uri: ExportUri): Thenable<unknown>;
  openTectonicSettings(): Thenable<unknown>;
  uriForFile(path: string): ExportUri;
  tectonicPath(document: ExportDocument): string | undefined;
}

export interface ExportControllerDependencies {
  exportPdf?: (request: {
    inputPath: string;
    outputPath: string;
    overwrite: boolean;
    tectonicPath?: string;
    signal: AbortSignal;
  }) => Promise<PdfExportResult>;
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

const ERROR_MESSAGES: Record<Exclude<PdfExportErrorCode, "E_CANCELLED">, string> = {
  E_INPUT: "入力 TeX を読み込めませんでした。",
  E_OUTPUT_EXISTS: "出力先の PDF は既に存在します。",
  E_TECTONIC_NOT_FOUND: "Tectonic が見つかりません。",
  E_TECTONIC_VERSION: "Tectonic のバージョンを確認できませんでした。",
  E_COMPILE: "PDF のコンパイルに失敗しました。",
  E_IO: "PDF の書き出し中に入出力エラーが発生しました。",
};

/** Extension Host のみで PDF export の UI と compiler 呼び出しを調停する。 */
export class ExportController {
  private readonly activeUris = new Set<string>();
  private readonly compile: NonNullable<ExportControllerDependencies["exportPdf"]>;

  constructor(
    private readonly host: ExportHost,
    dependencies: ExportControllerDependencies = {},
  ) {
    this.compile = dependencies.exportPdf ?? exportPdf;
  }

  async export(document: ExportDocument | undefined): Promise<void> {
    if (!this.host.isWorkspaceTrusted) {
      await this.host.showWarning("PDF 書き出しは、信頼されたワークスペースでのみ実行できます。");
      return;
    }
    if (!document?.uri.fsPath.endsWith(".tex")) {
      await this.host.showError("PDF を書き出す .tex ファイルを開いてください。");
      return;
    }
    const key = document.uri.toString();
    if (this.activeUris.has(key)) {
      await this.host.showWarning("この文書は既に PDF を書き出しています。");
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
    if ((await this.host.chooseFormat()) !== "pdf") return;
    const output = await this.host.chooseOutput(
      this.host.uriForFile(defaultPdfOutputPath(document.uri.fsPath)),
    );
    if (!output) return;
    const overwrite = await this.host.outputExists(output);
    if (overwrite && !(await this.host.confirmOverwrite(output))) return;
    if (document.isDirty && !(await document.save())) return;

    try {
      const result = await this.host.withProgress(async (token) => {
        const abort = new AbortController();
        const subscription = token.onCancellationRequested(() => abort.abort());
        if (token.isCancellationRequested) abort.abort();
        const tectonicPath = this.host.tectonicPath(document);
        try {
          const request = {
            inputPath: document.uri.fsPath,
            outputPath: output.fsPath,
            overwrite,
            signal: abort.signal,
            ...(tectonicPath === undefined ? {} : { tectonicPath }),
          };
          return await this.compile(request);
        } finally {
          subscription.dispose();
        }
      });
      const action = await this.host.showInformation(
        `PDF を書き出しました: ${result.outputPath}`,
        "PDFを開く",
        "Finderで表示",
      );
      if (action === "PDFを開く") await this.host.openPdf(output);
      else if (action === "Finderで表示") await this.host.revealInFileManager(output);
    } catch (error) {
      await this.reportError(error);
    }
  }

  private async reportError(error: unknown): Promise<void> {
    if (!(error instanceof PdfExportError)) {
      await this.host.showError("PDF の書き出しに失敗しました。");
      return;
    }
    if (error.code === "E_CANCELLED") return;
    const message = ERROR_MESSAGES[error.code];
    if (error.code === "E_TECTONIC_NOT_FOUND") {
      const action = await this.host.showError(message, "設定を開く");
      if (action === "設定を開く") await this.host.openTectonicSettings();
      return;
    }
    await this.host.showError(message);
  }
}
