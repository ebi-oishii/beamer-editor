# CLAUDE.md

AI がスライドの叩き台を生成し、人間が微調整して完成させるための Beamer サブセットベースのスライド作成環境。設計・仕様・計画の正典は `docs/` にある。着手前に [docs/development-plan.md](docs/development-plan.md)(フェーズと現在地)と、Phase 5 作業なら [docs/vscode-migration-plan.md](docs/vscode-migration-plan.md) を読むこと。

## コマンド

```bash
pnpm install                  # packageManager で pnpm を固定
pnpm test / lint / typecheck  # 全ワークスペース(CI と同じ)
pnpm --dir packages/core test # 単一パッケージ
pnpm --dir apps/web dev       # renderer 動作確認用 dev ビューア
pnpm --dir apps/vscode build  # 拡張バンドル。開発は VS Code で F5
pnpm --dir apps/vscode test:integration  # 実 VS Code での統合テスト(ローカルのみ、CI 対象外)
```

## 構成と依存方向

- `packages/core` — トークナイザ / パーサ / AST / マクロ展開 / フォーマッタ / リンター(環境非依存)
- `packages/renderer` — AST → HTML(KaTeX 同期描画)
- `packages/ui` — 共有プレビュー UI(React + ShellHost 契約)
- `packages/cli` — `deck` CLI(現状は fonts サブコマンドのみ)
- `apps/web` — 開発用ビューア。製品 UI ではない(VS Code 移植計画 §3)
- `apps/vscode` — VS Code 拡張(Extension Host + Webview)
- `fixtures/` — ゴールデンサンプル。全フェーズのテストデータ兼受け入れ基準

依存方向は `ui → renderer → core` の一方向に固定。`core` / `renderer` / `ui` に `vscode` API を import しない。シェル固有 API を知るのは `apps/*` だけ。

## PR・ブランチ運用

- **PR の base は必ず `main`。** 親ブランチへ子 PR をマージすると成果が main に届かない(VS-1/VS-2 で実際に起きた事故。2026-07-29 に統合で回収)
- PR を積み上げた場合、親がマージされたら子の base を main へ付け替えてからマージする
- push / PR 操作は個人アカウントで行う: `gh auth switch --user ebi-oishii`(会社の EMU アカウントは拒否される)
- コミットメッセージは日本語の Conventional Commits 風(`feat(core): ...` / `fix(web): ...` / `docs: ...`)

## テスト方針

スナップショット中心(パース・整形・展開)。冪等性(`format(format(x)) == format(x)`)とラウンドトリップ(再出力 → 再パースで同一 AST)は全 fixture へ一括適用する。詳細は development-plan.md の「テスト戦略」。
