/**
 * core の lintDeck を VS Code Diagnostics へ橋渡しする(移植計画 VS-5)。
 *
 * ここは `vscode` API に依存しない。DiagnosticCollection の生成と
 * LintDiagnostic → vscode.Diagnostic の変換(positionAt / Range / severity)は
 * extension.ts が担い、本モジュールは「どの文書を・いつ lint し、結果をどこへ
 * 流すか」だけを持つ。lint は元ソースの parse 結果に対して行うため、span は
 * 常に元ソース座標になる(プレビューのマクロ展開とは独立)。
 */

import { type LintDiagnostic, lintDeck, parseDeck } from "@beamer-editor/core";

/** lint 対象文書の最小面(vscode.TextDocument が満たす)。 */
export interface LintableDocument {
  readonly uri: { toString(): string; readonly scheme: string };
  readonly fileName: string;
  getText(): string;
}

/** 文書イベントの購読口(vscode.workspace が満たす)。テストではフェイクを注入する。 */
export interface LintEvents<TDoc extends LintableDocument> {
  onDidOpenTextDocument(listener: (document: TDoc) => void): { dispose(): void };
  onDidChangeTextDocument(
    listener: (event: { document: TDoc; contentChanges: readonly unknown[] }) => void,
  ): { dispose(): void };
  onDidCloseTextDocument(listener: (document: TDoc) => void): { dispose(): void };
}

/** 診断の出力先。実体は DiagnosticCollection への変換付き set / delete。 */
export interface DiagnosticsSink<TDoc extends LintableDocument> {
  set(document: TDoc, diagnostics: LintDiagnostic[]): void;
  delete(document: TDoc): void;
}

/** 連続入力を 1 回の lint へまとめる待ち時間(プレビュー更新と同じ帯)。 */
export const LINT_DEBOUNCE_MS = 120;

/** 全文を parse して lint する。span は元ソースの UTF-16 オフセット。 */
export function lintDocumentText(text: string): LintDiagnostic[] {
  return lintDeck(parseDeck(text));
}

/**
 * 開いている `.tex` 文書ごとに lint を実行し、Diagnostics を最新に保つ。
 * 文書は uri 単位で独立に管理するため、複数の `.tex` を開いても診断は混ざらない。
 */
export class LintController<TDoc extends LintableDocument> {
  private readonly disposables: { dispose(): void }[];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(
    events: LintEvents<TDoc>,
    private readonly sink: DiagnosticsSink<TDoc>,
    initialDocuments: readonly TDoc[] = [],
    private readonly isTargetDocument: (document: TDoc) => boolean = (document) =>
      document.uri.scheme === "file" && document.fileName.endsWith(".tex"),
  ) {
    this.disposables = [
      events.onDidOpenTextDocument((document) => this.lintNow(document)),
      events.onDidChangeTextDocument((event) =>
        this.scheduleLint(event.document, event.contentChanges),
      ),
      events.onDidCloseTextDocument((document) => this.drop(document)),
    ];
    for (const document of initialDocuments) {
      this.lintNow(document);
    }
  }

  /** ローカルの .tex 本体だけを対象にする(git diff ビュー等の scheme は除外)。 */
  private isTarget(document: TDoc): boolean {
    return this.isTargetDocument(document);
  }

  /** 設定変更後、開いている文書の診断を再評価する。 */
  refresh(documents: readonly TDoc[]): void {
    if (this.disposed) return;
    for (const document of documents) {
      if (this.isTarget(document)) {
        this.lintNow(document);
      } else {
        this.drop(document, true);
      }
    }
  }

  private lintNow(document: TDoc): void {
    if (this.disposed || !this.isTarget(document)) return;
    try {
      this.sink.set(document, lintDocumentText(document.getText()));
    } catch (err) {
      // パースは Raw 劣化で例外を出さない設計。予期しない例外時は
      // 直前の診断を保持する(消すと「直った」と誤解させるため)。
      console.error(`beamer-editor: lint に失敗しました (${document.fileName})`, err);
    }
  }

  private scheduleLint(document: TDoc, contentChanges: readonly unknown[]): void {
    if (this.disposed || !this.isTarget(document)) return;
    // 保存などで contentChanges が空のイベントは更新の条件にしない。
    if (contentChanges.length === 0) return;
    const key = document.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.lintNow(document);
      }, LINT_DEBOUNCE_MS),
    );
  }

  private drop(document: TDoc, force = false): void {
    if (this.disposed || (!force && !this.isTarget(document))) return;
    const key = document.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.sink.delete(document);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}
