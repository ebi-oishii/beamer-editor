# VS Code エディタセットアップ

更新日: 2026-08-05

## 結論

Beamer Editor の `.tex` は、VS Code に組み込まれた LaTeX 言語サポートだけで基本的な
構文強調を利用できる。これを必須の文法基盤とし、プロジェクト固有の highlighter は実装しない。

[LaTeX Workshop](https://marketplace.visualstudio.com/items?itemName=James-Yu.latex-workshop)
は、補完、アウトライン、参照移動などの編集支援が必要な場合の任意の追加機能とする。

## 最小セットアップ

1. `.tex` ファイルを開く。
2. ステータスバーの言語モードが `LaTeX` になっていることを確認する。
3. `Plain Text` などになっている場合は、`Change Language Mode` から `LaTeX` を選ぶ。

この状態で、次の要素が構文強調される。

- `%` と `%% deck-source-version` などのコメント
- `\documentclass`、`\frametitle` などのコマンド
- `\begin{frame}` / `\end{frame}` などの環境
- `$...$` などの数式
- `deckcanvas`、`decktext` などの独自環境と、`\deckimage` などの独自コマンド

独自環境と独自コマンドは一般的な LaTeX 構文として強調される。Beamer Editor 固有の意味に応じた色分けは
行わず、誤りや未対応構文は Beamer Editor の Diagnostics で示す。

## 任意の編集支援: LaTeX Workshop

このリポジトリをVS Codeで開くと、`.vscode/extensions.json` により LaTeX Workshop が
推奨される。インストールは任意であり、基本的な構文強調だけなら不要である。

通常の `.tex` と Beamer Editor の managed slide が混在する workspace では、LaTeX Workshop
の自動ビルドを有効に保つのが推奨である。managed slide を初めてアクティブにすると、Beamer
Editor 拡張が確認を表示し、監視・保存時自動ビルドの ignore へ managed pattern を追加できる。
書込先は `beamerEditor.managedFiles` と各 LaTeX Workshop 設定のうち、より具体的な resource
scope (Workspace Folder / Workspace / Global) になる。これは managed slide にだけ適用され、
通常の `.tex` と手動の **Build LaTeX project** は引き続き利用できる。

workspace 全体が Beamer Editor 専用で、LaTeX Workshop による自動ビルドを一切使わない場合に
限り、利用者自身の workspace settings で `"latex-workshop.latex.autoBuild.run": "never"` を
選んでもよい。混在 workspace や、このリポジトリの共有設定には加えない。

このリポジトリにコミットする ignore は、テスト fixture への対象限定設定だけである。
`.vscode/settings.json` の `**/fixtures/**/*.tex` は絶対パスの workspace でも一致し、fixture
の監視・保存時自動ビルドだけを除外する。LaTeX Workshop 10.16.1 の各 ignore 設定の既定値も
保持したうえで追加している。managed slide の設定をワークスペース設定へ固定したり、すべての
LaTeX 自動ビルドを止めたりしない。

PDF が必要な場合は、現時点では LaTeX Workshop の **Build LaTeX project** を明示的に実行するか、
利用中の LaTeX compiler を直接実行する。Beamer Editor 自身の PDF export は Phase 6 で予定している。

## 候補比較

2026-08-02に、VS Code 1.131.0上で `fixtures/basic.tex` と `fixtures/canvas.tex` の
代表構文をTextMate grammarで検証した。

| 候補 | 基本LaTeX | `%% deck` | `deckcanvas` / `decktext` | 判断 |
|---|---|---|---|---|
| VS Code組み込みのLaTeXサポート | 対応 | コメントとして対応 | 一般環境として対応 | 必須基盤。追加インストール不要 |
| LaTeX Workshop 10.16.1 | 対応 | コメントとして対応 | 一般環境として対応 | 編集支援が必要な場合に任意で利用。混在 workspace では通常の `.tex` 自動ビルドを維持し、managed slide/fixture だけを scoped ignore |
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
