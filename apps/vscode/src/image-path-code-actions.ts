import type { LintDiagnostic } from "@beamer-editor/core";
import * as vscode from "vscode";

/**
 * L004(画像が無い)のうち、TeX なら拾うファイルが見つかったものに出す Quick Fix。
 * 置換範囲は core が診断に付ける `fix`(パスだけを指す)で、VS Code の Diagnostic には
 * 追加データを載せられないため、最後の lint 結果を文書ごとに覚えて診断の範囲で引き当てる。
 * 記録したオフセットは lint した版の本文のものなので、版が進んだ文書には出さない
 * (編集後のずれたオフセットで別の箇所を書き換えない。次の lint で記録し直される)。
 */
export class ImagePathCodeActionProvider implements vscode.CodeActionProvider {
  private readonly fixes = new Map<string, { version: number; diagnostics: LintDiagnostic[] }>();

  /** 文書の最新の lint 結果を記録する(fix 付きの L004 だけ残す)。lint と同期に呼ぶこと。 */
  record(document: vscode.TextDocument, diagnostics: readonly LintDiagnostic[]): void {
    const withFix = diagnostics.filter((entry) => entry.code === "L004" && entry.fix !== undefined);
    if (withFix.length === 0) this.fixes.delete(document.uri.toString());
    else
      this.fixes.set(document.uri.toString(), { version: document.version, diagnostics: withFix });
  }

  forget(document: vscode.TextDocument): void {
    this.fixes.delete(document.uri.toString());
  }

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
    _token: vscode.CancellationToken,
  ): vscode.CodeAction[] {
    if (document.uri.scheme !== "file") return [];
    const entry = this.fixes.get(document.uri.toString());
    if (entry === undefined || entry.version !== document.version) return [];
    const recorded = entry.diagnostics;
    return context.diagnostics.flatMap((diagnostic) => {
      if (
        diagnostic.source !== "beamer-editor" ||
        diagnostic.code !== "L004" ||
        !range.intersection(diagnostic.range)
      )
        return [];
      const start = document.offsetAt(diagnostic.range.start);
      const end = document.offsetAt(diagnostic.range.end);
      const fix = recorded.find(
        (entry) => entry.span.start === start && entry.span.end === end,
      )?.fix;
      if (fix === undefined) return [];
      const target = new vscode.Range(
        document.positionAt(fix.span.start),
        document.positionAt(fix.span.end),
      );
      const action = new vscode.CodeAction(
        `画像パスを ${fix.replacement} に直す`,
        vscode.CodeActionKind.QuickFix,
      );
      action.diagnostics = [diagnostic];
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, target, fix.replacement);
      action.edit = edit;
      return [action];
    });
  }
}
