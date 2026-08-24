import * as vscode from "vscode";

const YEN_ONLY = /^[¥￥]+$/u;

/** L021 だけを安全に U+005C へ置き換える最小の Quick Fix provider。 */
export class YenBackslashCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
    _token: vscode.CancellationToken,
  ): vscode.CodeAction[] {
    if (document.uri.scheme !== "file") return [];
    return context.diagnostics.flatMap((diagnostic) => {
      if (
        diagnostic.source !== "beamer-editor" ||
        diagnostic.code !== "L021" ||
        !range.intersection(diagnostic.range)
      )
        return [];
      const original = document.getText(diagnostic.range);
      if (!YEN_ONLY.test(original)) return [];
      const action = new vscode.CodeAction(
        "円記号をバックスラッシュに置換",
        vscode.CodeActionKind.QuickFix,
      );
      action.diagnostics = [diagnostic];
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, diagnostic.range, original.replace(/[¥￥]/gu, "\\"));
      action.edit = edit;
      return [action];
    });
  }
}
