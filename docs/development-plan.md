# 開発計画

ステータス: 改訂版(追加要件・レビュー統合)/ 最終更新: 2026-07-10

[beamer-editor-additional-requirements.md](beamer-editor-additional-requirements.md)(キャンバス前倒し・VS Code 1 本化・AgentAdapter)と [issues-to-resolve.md](issues-to-resolve.md)(A/B/C 指摘)を初版計画に統合した改訂版。

## 方針

1. **最短でドッグフーディングに到達する。** 「AI がファイルを書き、人間がエディタでプレビューを見る」ループ(M2)が成立した時点で、このツール自体の開発資料をこのツールで作り始める。
2. **依存の根本から作る。** すべてのコンポーネントが AST に依存するため、パーサと AST 設計が最初。ただしキャンバス(自由配置)のソース契約はパーサ・AST・フォーマッタ・renderer に波及するため、**Phase 1 より前(Phase 0.5)に固定する**。
3. **ゴールデンサンプル駆動。** 実際の発表を模したサンプルデッキを最初に手書きし、全フェーズのテストデータ兼受け入れ基準にする(canvas を含む 4 本)。
4. **シェルは VS Code 拡張 1 本で開始する。** UI は共有パッケージ `ui` + ShellHost 契約で一度だけ書き、Electron は第 2 シェルとして M4 後に判断する。Web は renderer 開発用ビューアに留める。

## マイルストーン

| M | 状態 | 到達点 |
|---|---|---|
| M1 | 読める | サンプルデッキ(canvas 含む)がブラウザでスライドとして表示される |
| M2 | 書ける | VS Code 拡張で編集 + 即時プレビューが成立し、外部の AI がファイルを書くと即時反映される(ドッグフーディング開始) |
| M3 | 出せる | PDF 書き出しと部分コンパイルが動き、キメラプレビューが完成する。canvas のはみ出しを check が機械検出する |
| M4 | 触れる | キャンバス GUI 操作・CLI・エディタからの AI 微調整依頼(AgentAdapter)が揃う |
| M5 | 配れる | VS Code 拡張の配布(.vsix → 必要なら Marketplace)。Electron / Web 正式版はこの後に判断 |

## Stage A: 実装前の設計確定(状況)

コード着手前に必要だった設計判断とその状況。

| 項目 | 状況 |
|---|---|
| C-1: 本文領域の定義 | **決定済み(2026-07-10)**。案①(タイトル帯 1 行固定高、2 行以上は L019 警告)を採用。default テーマ 16:9 の実測値は [subset-spec.md](subset-spec.md) §2.8 に記録(スライド 160×90mm、左右マージン各 1cm、タイトル 1 行時の本文先頭ベースライン 28.58pt、タイトル 1 行追加ごと +18.0pt)。境界定数の最終確定は Phase 0.5 |
| C-2〜C-8: 設計の穴 | 仕様へ反映済み(savepos 検証 = L012 実装方式、decktext 内語彙、canvas オーバーレイ対象外、寸法プローブ注入、L016〜L019、adjust 時の label 自動付与)。[issues-to-resolve.md](issues-to-resolve.md) の解決状況を参照 |
| A-1〜A-6: 文書リコンサイル | 反映済み(subset-spec v1.1、design.md、ai-protocol.md §7、本書) |
| AST 型ドラフト | **未了**。着手チェックリスト 1 を参照 |

## フェーズ詳細

規模感は 1 人で集中した場合の相対値: S = 〜2 日 / M = 〜1 週 / L = 1 週超。

### Phase 0: リポジトリ基盤とゴールデンサンプル(S)

- pnpm workspace モノレポ、TypeScript、vitest、Biome(lint + format)。
- `fixtures/` にゴールデンサンプルデッキを 4 本手書きする:
  1. `basic.tex` — サブセット語彙だけの標準的なデッキ(15 フレーム程度)
  2. `macros.tex` — マクロ定義と呼び出しを多用したデッキ
  3. `kitchen-sink.tex` — サブセット外(TikZ、`\only`、凝ったマクロ)を意図的に混ぜたデッキ
  4. `canvas.tex` — キャンバスフレーム(`decktext` / `deckimage`)のデッキ。書いてみて窮屈な箇所は仕様へフィードバックする
- サンプルは tectonic でコンパイルが通ることを確認しておく(`canvas.tex` は Phase 0.5 のマクロ実装後に通す)。
- 完了条件: `pnpm test` が空のテストで通り、サンプル 1〜3 が PDF になる。

### Phase 0.5: GUI ソース契約の固定(S〜M)

キャンバスの「ソース表現と操作セマンティクス」を実装前に固定する。**TeX 側マクロは textpos 統合・minipage 幅・fontsize 切替・縦横比保持を含む本物の TeX エンジニアリングであり、独立した工数として計上する**(レビュー B-2)。

- `deckcanvas` / `decktext` / `deckimage` の TeX 実装(ツール管理プリアンブルに入る本物の LaTeX 定義)。
- 本文領域の境界定数を savepos 実測で最終確定し、fixture として固定(C-1 の続き。計測デッキは `fixtures/measure-body-area.tex` を出発点にする)。
- `zref-savepos` によるはみ出し・重なり計測のプロトタイプ(Phase 6 の check 統合の土台。C-2)。
- 座標系・数値精度・文字サイズ enum・キャンバス frame の正規形を fixture とテストで固定。
- `canvas.tex` の PDF 期待画像を生成し、受け入れ基準にする。
- lint L011〜L019 の仕様確定(実装は Phase 2)。
- 完了条件: `canvas.tex` が tectonic でコンパイルでき、PDF 期待画像がレビューで合意される。**HTML との一致検証はここでは行わない**(HTML レンダラは Phase 4 で誕生するため、比較は Phase 4 の受け入れ条件へ。レビュー B-1)。

### Phase 1: core — トークナイザ + パーサ + AST(L)【最重要】

- LaTeX トークナイザ(バックスラッシュ命令、`{}`、`[]`、`%`、数式区切り、verbatim 例外)。
- フレーム分割とフレーム単位の再パース。
- サブセット仕様 v1.1 の再帰下降パース。**未知 → 生ブロック**の 3 段フォールバック(コマンド / 環境 / フレーム)。
- **キャンバスノードを AST に含める**(`CanvasNode` / `CanvasTextNode` / `CanvasImageNode`。追加要件 §6 の型に decktext 内語彙制約・source span・コメント保持を加える)。
- コメントと source span の保持。
- テスト: スナップショットテストを大量に。`kitchen-sink.tex` で生ブロック境界が仕様どおりに切れることを確認。
- 完了条件: サンプル 4 本がパースでき、AST から素朴に再出力したテキストが再パースで同一 AST になる(ラウンドトリップ)。

### Phase 2: core — フォーマッタ + リンター(M)

- 正規形の実装(キャンバスの座標 3 桁固定・key 順序の正規化を含む)。冪等性テスト(`format(format(x)) == format(x)`)、コメント保持テスト。
- リント規則 L001〜L019。L004 / L015 は環境非依存にするため、ファイルアクセスと画像寸法プローブ(PNG/JPEG ヘッダ・PDF MediaBox)を注入可能にする(C-5)。
- 完了条件: サンプル 4 本の正規形がレビューで合意され、fixture として固定される。

### Phase 3: core — マクロ展開器(M)

- 定義のパース(展開可能性の判定)、単純置換の展開、ソースマップ。
- 展開不能な呼び出しの生ブロック化。
- Phase 2 と並行可能(どちらも Phase 1 の AST にのみ依存)。
- 完了条件: `macros.tex` の展開結果が期待スナップショットと一致し、任意の展開後位置から元ソース位置を引ける。

### Phase 4: renderer — HTML プレビュー(M)

- AST → HTML。論理サイズ固定 + CSS transform スケール。KaTeX 統合。
- テーマ CSS は `default` の 1 本。
- キャンバス描画: 本文領域を固定矩形で描画し、`x` / `y` / `w` を CSS 絶対配置へ、文字サイズ enum をテーマ CSS へ変換。PDF 画像は pdf.js で表示。
- オーバーレイのステップ表示。生ブロックはこの段階ではプレースホルダ表示。
- 開発用に `apps/web` を簡易ビューア(ファイルドロップ → 表示)として先行させ、動作確認の場にする。
- Phase 2/3 と並行可能。
- 完了条件(= M1): `basic.tex` と `canvas.tex` がブラウザでスライドとして閲覧でき、数式・段組・ブロック・オーバーレイ・キャンバス配置が表示される。**HTML と PDF 期待画像(Phase 0.5)の比較で、位置の大きな逆転や領域外配置がないこと**(レビュー B-1 の移動先)。

### Phase 5: 共有 UI + VS Code シェル

**5a. packages/ui — 共有 UI と ShellHost 契約(S)**

- ShellHost インターフェースの定義: 編集の適用 / 変更の購読 / ファイルダイアログ / コンパイル呼び出し / AI 依頼の送信。シェル差はここに閉じ込め、シェル固有 API を `ui` へ持ち込まない。
- プレビュー表示(renderer の出力のホスト、フレーム選択、ステップスライダー)を React で実装。

**5b. apps/vscode — VS Code 拡張シェル(S)**

- プレビュー WebviewPanel(`ui` をホスト)。ドキュメント変更イベント → 再パース → 更新。
- lint は DiagnosticCollection(Problems パネル・波線)で表示。
- ステータスバーに現在フレームのアドレス(序数 / label)、クリックでコピー([ai-protocol.md](ai-protocol.md) §3)。
- 外部(AI)編集: バッファ未編集時の再読込は標準機能。開いているドキュメントへは WorkspaceEdit として適用し undo 統合する。
- エディタ・保存・競合処理・git diff はプラットフォーム標準をそのまま使う(実装しない)。

Electron(旧 5c)はここでは作らない(「後続」参照)。

完了条件(= M2): VS Code 拡張で `basic.tex` を編集しながらプレビューが追従し、別プロセス(Claude Code / Codex の公式拡張、または CLI)の書き込みが即時反映される。**ここからドッグフーディング開始**(公式 AI 拡張との併用を運用検証する)。

### Phase 6: compiler — 書き出しと部分コンパイル(M)

- tectonic 呼び出し(まず開発機のバイナリをパス指定。配布方式はこのフェーズで決定)。
- PDF 書き出し(展開前ソースをそのままコンパイル)+ 書き出し PDF のプレビューペイン表示切り替え。
- 生ブロックの standalone 部分コンパイル → pdf.js ラスタライズ → コンテンツハッシュキャッシュ → プレビューに差し込み。
- フレーム単位の画像出力と、コンパイルログの Overfull 警告をフレームアドレスへ割り付ける機構(Phase 8 の `deck snapshot` / `deck check` の土台)。
- キャンバスフレームの savepos 実測を check 相当の検査に統合: 本文領域外へのはみ出し(warning)・オブジェクト重なり(info)をフレームアドレス付きで報告(C-2 / L012)。
- 完了条件(= M3): `kitchen-sink.tex` の TikZ が(初回コンパイル後)プレビューに画像として表示され、PDF 書き出しが 1 クリックで動き、`canvas.tex` の意図的なはみ出しが検出される。

### Phase 7: GUI 操作(M)

実装順(追加要件 §3.6):

1. キャンバス要素の選択(単一選択のみ)
2. 移動(`x` / `y`)
3. 画像拡大縮小(縦横比保持、`w` のみ変更)
4. テキスト幅変更(リフロー)
5. 文字サイズ変更(離散値)
6. undo / redo
7. スライド一覧(サムネイル)の並べ替え・複製・削除・挿入
8. 必要性が確認できた場合のみ: インライン本文編集・オブジェクト挿入

- ドラッグ中は UI 一時状態のみ更新(60fps 目標)、pointer-up で AST 変換 + 正規形再出力を 1 回実行(1 操作 = 1 差分 = 1 undo ステップ)。
- 実装は `ui` に 1 回だけ書き、編集適用は ShellHost 経由(vscode は WorkspaceEdit)。
- 完了条件(追加要件 §3.8): テキストのドラッグで対象フレームの `x` / `y` だけが変わる。画像の拡大で `w` だけが変わり縦横比が維持される。文字サイズが許可値の間だけを遷移する。操作完了から 100ms 程度以内にソースペインへ反映される。1 操作を 1 回の undo で戻せる。保存・再読込後に同じレイアウトへ戻る。フォーマッタを 2 回実行しても結果が変わらない。

### Phase 8: cli — CLI と AI プロトコル整備(M)

[ai-protocol.md](ai-protocol.md) の実装フェーズ。Phase 7 とは独立。

- CLI の完全なセット: `deck outline` / `deck lint` / `deck format` / `deck check` / `deck snapshot` / `deck export` / `deck init`(各 `--json` 対応。check / snapshot は Phase 6 の機構を使う)。
- SKILL.md と `references/subset-cheatsheet.md` を `docs/subset-spec.md` から**ビルドで生成**する仕組み。`deck init` が新規デッキプロジェクトに `.claude/skills/beamer-deck/` として同梱する(版ずれは L010 で警告)。
- 指示パターン集(examples/prompts.md)。このリポジトリ自身にもスキルを配置し、資料作成で運用検証する。
- 完了条件: AI に「アウトライン提案 → 合意 → 生成 → lint/check 通過」の流れで新規デッキを作らせ、人間がエディタで微調整して PDF 書き出しまでの一連が実演できる。

### Phase 9: エディタからの微調整依頼(M)

[ai-protocol.md](ai-protocol.md) §7 のエディタ統合。Phase 5 と Phase 8 に依存する(Phase 7 の GUI とは独立)。

- **provider-neutral な `AgentAdapter`** を導入し、Claude(Agent SDK)/ Codex(Codex SDK)を別アダプタとして実装する。中核設計をどちらか一方に依存させない(追加要件 §4.3〜4.5)。
- プレビュー・スライド一覧・ソースの選択から「AI に依頼」→ 依頼ボックス → `[adjust]` 合成(対象 frame に label がなければ自動付与)。依頼ボックスは `ui` に実装し、セッションの起動・維持は ShellHost アダプタが担う。
- **一時スナップショット(worktree)編集 + frame ハッシュの競合検査 + ShellHost 経由の patch 適用**(1 undo ステップ)。人間が同じ frame を編集していた場合は差分レビューへ(追加要件 §4.6)。
- デッキごとに 1 本の永続セッション(「もう少し」が通じる文脈を維持)。セッション ID はコミットせずローカル保存。1 デッキにつき書き込み可能な実行は同時に 1 本。
- 認証: ユーザー自身の API キーを OS の資格情報ストア(SecretStorage)へ、または組織の Bedrock / Vertex 等。キーを `.tex`・設定・ログ・git へ書かない(追加要件 §4.7)。
- 完了条件(= M4): プレビューで表を選択して「窮屈なので詰めて」と依頼すると、snapshot/check 検証つきの修正が patch として適用され、Cmd+Z で戻せる。人間が同じ frame を編集していた場合は差分レビューに回る。

### Phase 10: 配布(M)

- VS Code 拡張のパッケージング(.vsix)→ チーム内配布 → 必要なら Marketplace 公開。
- tectonic の配布方式(同梱 or 初回ダウンロード)を確定(Phase 6 の決定を製品化)。
- 完了条件(= M5): チームメンバーが .vsix から導入して使える。

### 後続(M5 後に判断): Electron 第 2 シェルと Web 正式版

Electron は次が VS Code 版で安定してから着手する(追加要件 §6):

- AST とフォーマッタの正規形
- キャンバス GUI の操作セマンティクス
- AI patch の適用・競合・undo
- tectonic 配布方式

これにより Electron 側は ShellHost と AgentAdapter の別実装に集中できる。Web の正式製品化(劣化モード提供、コンパイル API サーバー)は「ブラウザだけで使いたい」という明確な需要が出た時点で判断する。

## 並行作業の目安

クリティカルパスは Phase 0 → 0.5 → 1 → (2 | 3 | 4 並行) → 5a → 5b → 6。

- Phase 0.5 の TeX 実装は Phase 0 のモノレポ整備と部分的に並行できる(TeX 側は Node に依存しない)。
- Phase 1 完了後: フォーマッタ / マクロ展開 / レンダラの 3 本は独立に進められる(AST の型だけ合意すればよい)。
- Phase 7(GUI)と Phase 8(CLI)は独立。Phase 9(微調整依頼)は Phase 5 と 8 の完了後に着手できる。
- テーマ CSS の作り込みとサンプルデッキの拡充は、どのフェーズとも並行できる。

## テスト戦略

- core はスナップショット中心(パース結果・整形結果・展開結果)。冪等性とラウンドトリップは property 的に全 fixture へ一括適用する。
- キャンバスは追加で: 座標の保存精度・key 順序の正規形テスト、GUI 操作相当の AST 変換が 1〜2 属性だけの diff になることのテスト、Phase 4 以降は HTML と PDF 期待画像の座標比較。
- renderer は fixture ごとの HTML スナップショット + 主要スライドの目視確認ページ。
- `ui` は ShellHost をモックしたコンポーネントテスト(GUI 操作が正しい編集適用の呼び出しに変換されるかを検証)。
- compiler は tectonic 依存のため CI ではキャッシュ・キュー・ハッシュ・savepos ログ解析のロジックのみ単体テストし、実コンパイルはローカルの統合テストとする。
- 「AI が書いたデッキが lint を通る率」を M4 以降の品質指標として fixture に蓄積する。

## 最初の一歩(着手チェックリスト)

1. AST の型定義ドラフト(`packages/core/src/ast.ts`)をレビューして合意(キャンバスノード・decktext 内語彙制約・source span・コメント保持を含む)
2. Phase 0 のモノレポ雛形(git リポジトリは docs 先行で初期化済み)
3. ゴールデンサンプル 4 本の執筆(サブセット仕様の妥当性検証を兼ねる — 書いてみて窮屈な箇所は仕様へフィードバック)
4. Phase 0.5: `deck*` マクロの TeX 実装と本文領域定数の最終確定(`fixtures/measure-body-area.tex` を出発点にする)
5. Phase 1 のトークナイザから実装開始
