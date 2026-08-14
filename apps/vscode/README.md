# Beamer Editor for VS Code

Beamer サブセットの `.tex` を編集しながら、LaTeX コンパイルなしの即時 HTML プレビューを表示する拡張。[beamer-editor](https://github.com/ebi-oishii/beamer-editor) プロジェクトの VS Code シェル(Phase 5 / M2)です。

## 使い方

1. `.tex` ファイルを開く
2. コマンドパレットから **Beamer Editor: Open Preview**(またはエディタタイトルのボタン)
3. 編集すると保存しなくてもプレビューが追従します

- サムネイルのダブルクリックで対応するソース行へジャンプ
- lint 結果は Problems パネルとエディタの波線に表示(規則番号付き)
- ←/→ キーでフレーム移動、スライダーでオーバーレイの step 表示
- 縮小・拡大・フィット・100%表示で、プレビューのスライド倍率を調整

## 開発版のインストール

```bash
pnpm --dir apps/vscode package   # beamer-editor.vsix を生成
code --install-extension apps/vscode/beamer-editor.vsix
```

外部プロセス(AI エージェントや CLI)がファイルを書き換えた場合、未編集のバッファは自動で追従します。編集中(dirty)のバッファは上書きされず、競合の扱いは VS Code 標準に従います。

PDF 書き出し(tectonic)は Phase 6 で追加予定です。

このリポジトリで LaTeX Workshop を併用する場合の、混在 workspace と専用 workspace の設定方針は[エディタセットアップ](https://github.com/ebi-oishii/beamer-editor/blob/main/docs/editor-setup.md)を参照してください。
