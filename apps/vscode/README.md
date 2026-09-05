# Beamer Editor for VS Code

Beamer サブセットの `.tex` を編集しながら、LaTeX コンパイルなしの即時 HTML プレビューを表示する拡張。[beamer-editor](https://github.com/ebi-oishii/beamer-editor) プロジェクトの VS Code シェル(Phase 5 / M2)です。

## 使い方

`*.slide.tex` は Beamer Editor が管理するスライドの命名規約です。管理対象を開くか active にすると HTML プレビューを自動で開き、編集すると保存しなくても追従します。同じ文書のプレビューは一つだけです。

通常の `.tex` は管理対象ではないため、lint と自動プレビューは動きません。必要なときはコマンドパレットから **Beamer Editor: Open Preview**(またはエディタタイトルのボタン)を実行してください。手動プレビューは任意のローカル `.tex` で利用でき、未保存の編集にも追従します。

- 全フレームを縦に並べて表示し、スクロールで見る(Marp のプレビューと同じ)。スライドのダブルクリックで対応するソース行へジャンプ
- managed slide の lint 結果は Problems パネルとエディタの波線に表示(規則番号付き)
- Webview にフォーカスしているとき、←/→ キーでフレーム移動。step のあるフレームでは、プレビューに重なるスライダーでオーバーレイ表示を切替
- Ctrl/Cmd+ホイール、Ctrl/Cmd+`+`/`=`・`-` で倍率を調整。Ctrl/Cmd+`0` で幅にフィット
- ソースからスライドへ: 各 `\begin{frame}` の上の CodeLens「プレビューで表示」、または `Cmd/Ctrl+K V`(Beamer Editor: Reveal Current Slide in Preview)でカーソルのあるフレームを表示。ソースのカーソル移動にプレビューを追従させる設定(`beamerEditor.preview.followCursor`、既定 ON)はプレビュータブのボタンで切り替え
- Explorer の **Beamer Slides** には、現在の managed slide のフレーム一覧を表示。項目を選ぶと対応するソースへ移動する。View は VS Code の標準機能で Side Bar、Secondary Side Bar、Panel の任意の場所へ移動できる
- プレビューのエディタグループは、プレビューが初めてフォーカスされたときにロックされ、他のファイルはソース側のグループに開きます(`beamerEditor.preview.lockGroup` で無効化可)

## 開発版のインストール

```bash
pnpm --dir apps/vscode package   # beamer-editor.vsix を生成
code --install-extension apps/vscode/beamer-editor.vsix
```

外部プロセス(AI エージェントや CLI)がファイルを書き換えた場合、未編集のバッファは自動で追従します。編集中(dirty)のバッファは上書きされず、競合の扱いは VS Code 標準に従います。

## Managed files と LaTeX Workshop

既定の managed pattern は `beamerEditor.managedFiles` の `**/*.slide.tex` です。pattern は文書が属する workspace folder からの相対パスとして解釈される VS Code glob なので、brace や character class なども VS Code の glob 規則に従います。たとえば `slides/**/*.tex` を管理したい場合は、VS Code の resource settings で次のように変更できます。

```json
{
  "beamerEditor.managedFiles": ["slides/**/*.tex"]
}
```

managed 文書をアクティブなエディタで開くと、自動プレビューと lint を行います。通常のローカル `.tex` は自動処理の対象外ですが、**Open Preview** コマンドで手動プレビューできます。プレビューは URI ごとに最大一つで、別の managed 文書は同時に表示できます。

LaTeX Workshop が入っている環境で managed file を初めて開くと、Beamer Editor は自動監視と保存時自動ビルドの ignore リストへ managed patterns を追加するか確認します。書込先は managedFiles と各 Workshop 設定のうち、より具体的な scope (Workspace Folder / Workspace / Global) です。明示的に確認した場合だけ追加され、通常の `.tex` の既定自動ビルド設定は変わりません。「今後表示しない」は同じ workspace scope と managed pattern の組合せに対して永続化されます。managed `.slide.tex` でも language id は `latex` のままなので、LaTeX Workshop の手動 **Build LaTeX project** による PDF build は引き続き利用できます。

## テンプレート(.sty と画像)

会社・組織の Beamer テーマは、そのままデッキのディレクトリ配下に置いて読めます。デッキと同じディレクトリに `beamertheme<Name>.sty` と画像を置いて `%% preamble-extra` に `\usetheme{Name}` を書くか、`templates/<name>/` に一式を置いて `\usepackage{templates/<name>/beamertheme<name>}` を書きます。`.sty` 内の画像パスはデッキのディレクトリ基準です(`templates/<name>/assets/logo.png` など)。

プレビューには `.sty` の `\definecolor` / `\setbeamercolor`(structure・alerted text・example text・normal text・background canvas)、`\setsansfont` / `\setmonofont`、`\logo`、`\usebackgroundtemplate` から取れる色・フォント・ロゴ・背景だけが近似で反映されます。それ以外の様式は PDF にだけ効きます。`.sty` や画像を変更するとプレビューと診断は自動で更新されます。参照先の `.sty` や画像が無い場合は Problems パネルに L022 / L023 が出ます。見本は `fixtures/templates/corporate/` と `fixtures/templated.tex` です。

## 生ブロックの部分コンパイル

TikZ などサブセット外のブロックは、プレビューではまず環境名だけの箱(プレースホルダ)で場所を確保し、裏で Tectonic により standalone 文書としてコンパイルして、できた画像を箱に差し込みます。結果は内容とプリアンブル(preamble-extra とマクロ定義)のハッシュでキャッシュされるので、変えていないブロックは再コンパイルされません。失敗したブロックは赤い枠の箱として残り、ホバーで Tectonic のエラーを確認できます。Tectonic の場所は `beamerEditor.tectonicPath`、無効にするには `beamerEditor.preview.compileRawBlocks` を false にします。Restricted Mode では動きません。

## PDF 書き出し

コマンドパレット、`.tex` エディター、または対応するプレビューのタイトルから **Beamer Editor: Export...** を実行すると、保存先を選んで PDF を書き出せます。実行には [Tectonic](https://tectonic-typesetting.github.io/) が必要です。PATH にない場合は `beamerEditor.tectonicPath` で実行ファイルを指定してください。

編集中の内容は先に保存され、コンパイルは既定で300秒後に停止します（`beamerEditor.pdfExport.timeoutSeconds` で5〜1800秒に変更可）。失敗時は通知の「詳細を表示」からTectonicのエラーを確認できます。既存PDFはコンパイルが成功するまで置換されません。外部プログラムを起動するため、Restricted Modeではコマンドとボタンが無効になります。

このリポジトリで LaTeX Workshop を併用する場合の、混在 workspace と専用 workspace の設定方針は[エディタセットアップ](https://github.com/ebi-oishii/beamer-editor/blob/main/docs/editor-setup.md)を参照してください。
