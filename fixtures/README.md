# Fixtures

デッキの fixture は `*.slide.tex` で置く(拡張の `beamerEditor.managedFiles` 既定 `**/*.slide.tex` に一致し、
VS Code でそのまま Beamer Editor が扱える)。`fixtures/*.slide.tex` は自動的に canonical な fixture
プロパティのベースラインへ登録される。ヘルパー fixture は予約プレフィックス `lint-` と `measure-`
だけで除外する。

`deck-*-preamble.tex` は canonical な `packages/core/resources/` の管理プリアンブルを fixture から
読む互換ラッパーである。生成デッキは canonical resource の内容をインライン展開する。

## 編集プレビューと PDF 確認

- `preview-phase3/pages.slide.tex` はオーバーレイが物理ページ 1・2、自動改ページが 4–6、最後のフレームが 8 に対応する。3・7 はテーマやマクロが生成したページで、`hidden` フレームは組版時に除外される。
- `preview-phase3/fragments.slide.tex` は部分組版できるインライン・別行数式と TikZ、移動と幅変更ができる `deckfigure`、フレーム内の定義が必要な数式と TikZ を含む。
- `preview-phase3/layout.slide.tex` の `clean`、`damaged`、`overflow` は、正常な画像、実在するが復号できない画像、キャンバスからのはみ出しを再現する。
