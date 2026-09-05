# Fixtures

デッキの fixture は `*.slide.tex` で置く(拡張の `beamerEditor.managedFiles` 既定 `**/*.slide.tex` に一致し、
VS Code でそのまま Beamer Editor が扱える)。`fixtures/*.slide.tex` は自動的に canonical な fixture
プロパティのベースラインへ登録される。ヘルパー fixture は予約プレフィックス `lint-` と `measure-`
だけで除外する。

`deck-*-preamble.tex` はデッキではなくデッキから `\input{deck-canvas-preamble}` で読み込む TeX 側の
プリアンブル実装なので、`.tex` のまま置く(`\input` は `.tex` を補うため改名できない)。
