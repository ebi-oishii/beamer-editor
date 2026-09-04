# Beamer Editor for VS Code

Beamer サブセットの `.tex` を編集しながら、LaTeX コンパイルなしの即時 HTML プレビューを表示する拡張。[beamer-editor](https://github.com/ebi-oishii/beamer-editor) プロジェクトの VS Code シェル(Phase 5 / M2)です。

## 使い方

`*.slide.tex` は Beamer Editor が管理するスライドの命名規約です。管理対象を開くか active にすると HTML プレビューを自動で開き、編集すると保存しなくても追従します。同じ文書のプレビューは一つだけです。

通常の `.tex` は管理対象ではないため、lint と自動プレビューは動きません。必要なときはコマンドパレットから **Beamer Editor: Open Preview**(またはエディタタイトルのボタン)を実行してください。手動プレビューは任意のローカル `.tex` で利用でき、未保存の編集にも追従します。

- 全フレームを縦に並べて表示し、スクロールで見る(Marp のプレビューと同じ)。スライドのダブルクリックで対応するソース行へジャンプ
- managed slide の lint 結果は Problems パネルとエディタの波線に表示(規則番号付き)
- ←/→ キーでフレーム移動、スライダーでオーバーレイの step 表示
- 縮小・拡大・フィット・100%表示で、プレビューのスライド倍率を調整
- Explorer の **Beamer Slides** には、現在の managed slide のフレーム一覧を表示。項目を選ぶと対応するソースへ移動する。View は VS Code の標準機能で Side Bar、Secondary Side Bar、Panel の任意の場所へ移動できる

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

PDF 書き出し(tectonic)は Phase 6 で追加予定です。

このリポジトリで LaTeX Workshop を併用する場合の、混在 workspace と専用 workspace の設定方針は[エディタセットアップ](https://github.com/ebi-oishii/beamer-editor/blob/main/docs/editor-setup.md)を参照してください。
