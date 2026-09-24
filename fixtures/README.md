# Fixtures

デッキの fixture は `*.slide.tex` で置く(拡張の `beamerEditor.managedFiles` 既定 `**/*.slide.tex` に一致し、
VS Code でそのまま Beamer Editor が扱える)。`fixtures/*.slide.tex` は自動的に canonical な fixture
プロパティのベースラインへ登録される。ヘルパー fixture は予約プレフィックス `lint-` と `measure-`
だけで除外する。

`deck-*-preamble.tex` は canonical な `packages/core/resources/` の管理プリアンブルを fixture から
読む互換ラッパーである。生成デッキは canonical resource の内容をインライン展開する。
