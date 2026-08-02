# VS Code エディタセットアップ

更新日: 2026-08-02

## 結論

Beamer Editor の `.tex` は、VS Code に組み込まれた LaTeX 言語サポートだけで基本的な
構文強調を利用できる。プロジェクト固有の highlighter は実装しない。

[LaTeX Workshop](https://marketplace.visualstudio.com/items?itemName=James-Yu.latex-workshop)
は、補完、アウトライン、参照移動などの編集支援が必要な場合の推奨オプションとする。
ただし、Beamer Editor 以外のビルドが意図せず起動しないよう、自動ビルドを無効にする。

## 最小セットアップ

1. `.tex` ファイルを開く。
2. ステータスバーの言語モードが `LaTeX` になっていることを確認する。
3. `Plain Text` などになっている場合は、`Change Language Mode` から `LaTeX` を選ぶ。

この状態で、次の要素が構文強調される。

- `%` と `%% deck-source-version` などのコメント
- `\documentclass`、`\frametitle` などのコマンド
- `\begin{frame}` / `\end{frame}` などの環境
- `$...$` などの数式
- `deckcanvas`、`decktext`、`deckimage` などの独自環境

独自環境は一般的な LaTeX 環境として強調される。Beamer Editor 固有の意味に応じた色分けは
行わず、誤りや未対応構文は Beamer Editor の Diagnostics で示す。

## 推奨セットアップ: LaTeX Workshop

このリポジトリをVS Codeで開くと、`.vscode/extensions.json` により LaTeX Workshop が
推奨される。インストールは任意であり、基本的な構文強調だけなら不要である。

LaTeX Workshopを使う場合は、ユーザー設定またはワークスペース設定に次を追加する。

```json
{
  "latex-workshop.latex.autoBuild.run": "never"
}
```

LaTeX Workshop 10.16.1では、この設定の既定値は `onFileChange` であり、ファイル変更を
検知してLaTeXのビルドを開始する。Beamer Editorが提供するプレビューと診断だけを使う
場合は `never` とし、PDFが必要なときはBeamer Editor側の書き出し機能または明示的な
ビルド操作を使う。

## 候補比較

2026-08-02に、VS Code 1.131.0上で `fixtures/basic.tex` と `fixtures/canvas.tex` の
代表構文をTextMate grammarで検証した。

| 候補 | 基本LaTeX | `%% deck` | `deckcanvas` / `decktext` | 判断 |
|---|---|---|---|---|
| VS Code組み込みのLaTeXサポート | 対応 | コメントとして対応 | 一般環境として対応 | 必須基盤。追加インストール不要 |
| LaTeX Workshop 10.16.1 | 対応 | コメントとして対応 | 一般環境として対応 | 編集支援が必要な場合に推奨。自動ビルドは無効化 |
| `mathematic.vscode-latex` 2.0.0 | 対応 | コメントとして対応 | 一般環境として対応 | grammar、lint、formatが既存機能と重複するため非推奨 |

3候補とも、コメント、コマンド、環境、数式とプロジェクト独自環境を正しくscopeへ分類した。
構文強調だけを目的に外部拡張を必須化する利点は確認できなかった。

`mathematic.vscode-latex` はLaTeX Workshop由来のgrammarに加えて独自のlinterとformatterを
有効にする。Beamer EditorのDiagnosticsや `deck lint` / `deck format` と責務が重なるため、
本プロジェクトの推奨には含めない。

## 参考資料

- [VS Code: Syntax Highlight Guide](https://code.visualstudio.com/api/language-extensions/syntax-highlight-guide)
- [VS Code組み込みLaTeX拡張のmanifest](https://github.com/microsoft/vscode/blob/main/extensions/latex/package.json)
- [LaTeX Workshop: Installation and basic settings](https://github.com/James-Yu/LaTeX-Workshop/wiki/Install)
- [LaTeX Workshop: Auto build](https://github.com/James-Yu/LaTeX-Workshop/wiki/Compile#auto-build-latex)
- [`mathematic.vscode-latex` Marketplace](https://marketplace.visualstudio.com/items?itemName=mathematic.vscode-latex)
