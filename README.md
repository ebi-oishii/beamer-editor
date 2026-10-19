# beamer-editor(仮称)

AI がスライドの叩き台を生成し、人間が微調整して完成させるワークフローのためのスライド作成環境。

人間と AI の「共通言語」として **Beamer のサブセット**をソース形式に採用する。ソースはそのまま正しい Beamer(LaTeX)としてコンパイルできるが、エディタはサブセットの範囲を構文として完全に理解し、**LaTeX コンパイルなしの即時 HTML プレビュー**と**限定的な GUI 操作**を提供する。

## 中核となる考え方

- **ソースファイルが唯一の真実。** AI・人間のテキスト編集・GUI 操作のすべてが同じソースを書き換える。
- **Beamer は「出力の体裁を保証する装置」。** プレビューは HTML による近似で、意味論の最終権威は常に TeX(書き出し PDF)にある。
- **段階的劣化。** サブセット外の LaTeX も書ける(壊れない)。ただしプレビューが部分コンパイル画像に、GUI 編集が「移動のみ」に劣化するだけで、最終 PDF の表現力は無制限。

## ドキュメント

| ファイル | 内容 |
|---|---|
| [docs/design.md](docs/design.md) | 全体設計・アーキテクチャ・技術選定と理由 |
| [docs/subset-spec.md](docs/subset-spec.md) | ソース形式(Beamer サブセット)の仕様 v1.1(キャンバス自由配置を含む) |
| [docs/ai-protocol.md](docs/ai-protocol.md) | AI 連携プロトコル(作業ループ・アドレッシング・微調整モード・SKILL.md 配布) |
| [docs/beamer-editor-additional-requirements.md](docs/beamer-editor-additional-requirements.md) | GUI・AI 連携・実行形態の追加設計判断(キャンバス前倒し・VS Code 1 本化・AgentAdapter) |
| [docs/theme-design.md](docs/theme-design.md) | スタイル設計(指定フォーマットへのその場対応・スタイル語彙・CJK フォント) |
| [docs/issues-to-resolve.md](docs/issues-to-resolve.md) | 要件レビューの指摘と解決状況 |
| [docs/development-plan.md](docs/development-plan.md) | 開発計画(マイルストーンとフェーズ、追加要件・レビュー統合の改訂版) |
| [docs/vscode-migration-plan.md](docs/vscode-migration-plan.md) | Phase 5のVS Code移植手順・責務分担・PR分割・GUI編集開始条件 |

## ステータス

実装中。**M1(読める)到達済み**。Phase 5 の VS Code 基盤は成立済みで、環境依存の項目は配布前スモークテストで確認する。進行中の作業は[GitHub の open pull requests](https://github.com/ebi-oishii/beamer-editor/pulls?q=is%3Apr+is%3Aopen)を参照。

- 実装済み: パーサ + AST(Phase 1)、キャンバス正規形フォーマッタ + lint 基盤 + canonical fixture property tests(Phase 2)、マクロ展開器(Phase 3)、HTML プレビュー + KaTeX(Phase 4)、スタイル語彙 v1(S1)、Noto Sans CJK 対応(S2)、VS Code 拡張スキャフォールド(VS-1)〜テーマ/a11y(VS-7)、CSP/Workspace Trust(VS-8)、テスト・`.vsix`生成・CI artifact(VS-9)、プレビュー上のキャンバス画像ドラッグ、CLI の `lint` / `format` / `outline` / `export` / `check`。
- `deck snapshot <file> -o <new-directory>` で実コンパイル結果をフレーム単位の PNG として確認できる(出力先は新規ディレクトリのみ。既存パスは `E_OUTPUT_EXISTS` で拒否する。詳細は [docs/ai-protocol.md](docs/ai-protocol.md) §4)。M2 実機確認は配布前のスモークテストとして継続する。

## 開発

```bash
pnpm install
pnpm test        # 全パッケージのテスト
pnpm lint        # biome
pnpm typecheck   # 全パッケージの tsc --noEmit
pnpm --dir apps/web dev       # renderer 動作確認用の dev ビューア
pnpm --dir apps/vscode build  # VS Code 拡張のバンドル(開発は F5)
```

### PDF 書き出し

ローカルに [Tectonic](https://tectonic-typesetting.github.io/) を用意すると、入力ソースを変更せずに PDF を書き出せる。

### HTML スナップショット

`deck export talk.slide.tex --format html` は `talk-html/index.html` に、現在のプレビュー相当の静的な HTML を書き出します。`file:` で直接開けますが、正式な TeX 出力ではありません。PDF 画像と raw TeX はプレビューと同じプレースホルダーになり、外部 URL の画像は閲覧時にネットワークを必要とします。複製するのはデッキ配下の PNG / JPEG だけで、それ以外の形式(PDF など)や見つからない画像をプレースホルダーにした場合(PDF の背景は描きません)は、該当する画像とフレーム番号を stderr に警告して終了コード 1 で終えます(`--json` では `placeholders` に列挙します)。正式な組版には PDF 書き出しを使ってください。

```bash
pnpm --dir packages/cli deck export talk.slide.tex --format pdf
# talk.slide.tex -> talk.pdf
```

`-o output.pdf` で出力先を指定できる。既存の PDF または HTML 出力ディレクトリを置き換える場合は明示的に
`--overwrite` を指定する。`--tectonic /path/to/tectonic` と `--json` も利用できる。

### 実コンパイル検査

`deck check` は入力を変更せず、静的 lint と Tectonic による実コンパイルを 1 回実行する。
Overfull とキャンバスの本文領域外・重なりをフレーム番号 / label 付きで報告する。

```bash
pnpm --dir packages/cli deck check talk.slide.tex
pnpm --dir packages/cli deck check talk.slide.tex --tectonic /path/to/tectonic --json
```

診断なし（または情報のみ）は終了コード 0、警告は 1、lint エラーは 2、Tectonic・入出力・
使用法などの操作失敗は 3 で終了する。`--json` の操作失敗は stderr に出力される。
TeX のコンパイルエラー(Tectonic が TeX のエラーで止まった `E_COMPILE`)で、デッキに lint エラーがあれば、
原因の手がかりとしてそれも添え(テキストではメッセージの後、`--json` では `error.diagnostics`)、失敗の原因は
デッキ側にあるかもしれないので終了コードを 3 ではなく 2 にする。`deck snapshot` と
`deck export --format pdf` も同じ。Tectonic の起動の失敗・タイムアウト・TeX パッケージの取得の失敗など
TeX のエラーでない `E_COMPILE` には添えず、3 のまま。終了コード 2 では通常 stdout に結果が出るが、この場合だけは
stdout が空で、エラーは stderr に出る(`--json` のときは `error.code` が `E_COMPILE`、lint エラーが
`error.diagnostics` の JSON)。`--json` では、stdout が空で stderr の JSON に `error` があるかで見分ける。

### デッキ編集スキルの生成

AI による通常のスライド作成・編集は、正本の `.tex` の作成・更新と必要な検証・報告で完了します。通常フローと canvas は依頼の意図と内容に応じて選び、既存フレームを触っただけで変換せず適切な構造を保ちます。HTML・PDF は、その形式の出力を明示的に依頼した場合だけ書き出します。`deck check` による実コンパイル検証や、必要な `deck snapshot` の画像確認は書き出しとは別に行います。

`pnpm build:skills` は仕様・AIプロトコル・実装のCLIヘルプから `skills/beamer-deck/` と、リポジトリ用の `.claude/skills/beamer-deck/`(Claude Code)・`.agents/skills/beamer-deck/`(Codex)を生成します。あわせて、`deck init` がデッキプロジェクトへ置くプロジェクト指示 `skills/deck-project/AGENTS.md` も生成します。`packages/core/resources` のツール管理プリアンブルを core へ埋め込む `packages/core/src/generated-managed-preamble.ts`(`deck init`・`--update-preamble`・L025 の Quick Fix が使う)も同じ生成物です。生成物は直接編集せず、元文書を更新して再生成します。`pnpm check:skills` は更新漏れを検出し、CIでも実行します。生成 SKILL の metadata には CLI 版と4生成物の SHA-256 fingerprint を記録します。`deck lint` / `deck check` は入力デッキからホームディレクトリまたはGitリポジトリ境界までにある最寄りの `.claude/skills/beamer-deck/` と `.agents/skills/beamer-deck/` を探し、それぞれの記録値と4生成物の内容ハッシュの両方をCLIの期待値と照合して、どちらかがずれていればL010で警告します。ホームディレクトリの候補は読まず、スキル未同梱の既存デッキは警告しません。L010 のメッセージには、スキルを見つけたプロジェクトディレクトリ(`.claude/` を含むディレクトリ)を入れた実行可能な `deck init <directory> --update-skill` が表示されます。このリポジトリでもルートを指定して実行でき、`pnpm build:skills` と同じ内容に更新されます。

### 新規デッキ

`pnpm --dir /path/to/beamer-editor --filter @beamer-editor/cli deck init /path/to/my-talk` で `main.slide.tex`、空の `assets/`、`.claude/skills/beamer-deck/`、`.agents/skills/beamer-deck/`、常に読まれるエージェント向け指示 `AGENTS.md` と、それを import する `CLAUDE.md` を生成します。CLI はまだ単独配布されていません。この起動方法では `packages/cli` が作業ディレクトリになるため、生成プロジェクトの入力・出力先は絶対パスで指定し、出力先を省略しないでください。新規生成は新規または空のディレクトリだけを受け付け、既存データは上書きしません。`deck init /absolute/path/to/project --update-skill` は既存ディレクトリの `.claude/skills/beamer-deck/` と `.agents/skills/beamer-deck/` を作成・更新し、L010 の fingerprint ずれを解消します。`AGENTS.md` / `CLAUDE.md` は存在しないときだけ作成し、既存のものは上書きしません。デッキのファイル名や位置は問わず(`main.slide.tex` は不要)、デッキやassetsには触れません。存在しないパスやディレクトリ以外は `E_OUTPUT_EXISTS` で拒否します。`--json` で生成ファイル一覧を取得できます。`deck init /absolute/path/to/main.slide.tex --update-preamble` は、デッキの `% ---- ツール管理プリアンブル` 〜 `% ---- ツール管理ここまで ----` の間だけを新規生成と同じ現行の内容に差し替え、版の行・ユーザー領域・本文には触れません。古いデッキで後から足したマクロ(`\deckbackground`)を使うと出る L025 を解消します。管理プリアンブルの範囲を特定できない(印が無い・終了印が最初のユーザー領域の印(コメントの中のものも数える)か `\begin{document}` より後ろにある・終了印が開始印より前にある・開始印が複数ある)デッキは、書き換えずに理由を添えて `E_INPUT` で失敗します。プリアンブルはデッキへ埋め込むためリポジトリのfixtureに依存せず、PDF出力にはTectonicが必要です。初期本文は英語の通常フロー `itemize` のままで、canvas には変換しません。日本語を使う場合は `deck fonts fetch` でフォントを用意し、style領域へ `\deckfont{main}{Noto Sans CJK JP}` を指定します。
