# デッキプロジェクト

このディレクトリは Beamer サブセット形式のスライドデッキ(`*.slide.tex`)のプロジェクト。
スライドの作成・編集・書き出しは beamer-deck スキル(`.claude/skills/beamer-deck/`、
`.agents/skills/beamer-deck/`)の手順に従う。

- スライドの正本は .tex。「GUI で操作」「プレビューで動かせるように」は VS Code 拡張の
  プレビューで編集できる状態を指し、pptx に置き換えない
- 新しく書く本文と、依頼で触るフレームの本文は `deckcanvas` の `decktext` / `deckimage`
  で書く。依頼で触らない既存フレームは変換しない
- キャンバスを書いたら `deck check` まで実行し、lint の L011・L012・L014・L018・
  L019 と check の `canvas-overflow` が残っている間は完了にしない
- PDF は `deck export <file> --format pdf -o <pdf>`(どちらも絶対パス)で書き出し、
  PDF のパスを報告する
- pptx / PowerPoint は、ユーザーが形式を明示したときだけ .tex を残したまま別に作る
