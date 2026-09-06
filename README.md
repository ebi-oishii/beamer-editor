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
- `deck snapshot <file> -o <directory>` で実コンパイル結果をフレーム単位の PNG として確認できる。M2 実機確認は配布前のスモークテストとして継続する。

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

```bash
pnpm --dir packages/cli deck export talk.slide.tex --format pdf
# talk.slide.tex -> talk.pdf
```

`-o output.pdf` で出力先を指定できる。既存ファイルを置き換える場合は明示的に
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
