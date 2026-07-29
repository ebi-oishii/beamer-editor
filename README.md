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

実装中。**M1(読める)到達済み**、現在 **Phase 5(VS Code シェル)** を進行中(開発順序は開発計画を参照)。

- 実装済み: パーサ + AST(Phase 1)、キャンバス正規形フォーマッタ + リンター基盤 L009/L011/L017/L018/L020(Phase 2 の一部)、マクロ展開器(Phase 3)、HTML プレビュー + KaTeX(Phase 4)、スタイル語彙 v1(S1)、Noto Sans CJK 対応(S2)、VS Code 拡張スキャフォールド(VS-1)+ 共有プレビュー UI `packages/ui`(VS-2)+ 編集追従プレビュー(VS-3)+ ソースジャンプ(VS-4)+ lint 診断(VS-5)+ 外部編集の統合テスト(VS-6)
- 次: VS-7(テーマ・アクセシビリティ・CSP)以降([vscode-migration-plan.md](docs/vscode-migration-plan.md))、Phase 2 の残り(正規形の全域化・残りリント規則)

## 開発

```bash
pnpm install
pnpm test        # 全パッケージのテスト
pnpm lint        # biome
pnpm typecheck   # 全パッケージの tsc --noEmit
pnpm --dir apps/web dev       # renderer 動作確認用の dev ビューア
pnpm --dir apps/vscode build  # VS Code 拡張のバンドル(開発は F5)
```
