# VS Code 移植計画

更新日: 2026-08-14<br>
対象: Phase 5（共有 UI + VS Code シェル）<br>
目的: Phase 7 の GUI 編集へ進む前に、VS Code 上で編集・プレビュー・診断の基盤を成立させる

## 1. 結論

`.tex` の編集には **VS Code 標準テキストエディタ**を使い、Beamer のプレビューだけを
**WebviewPanel**として隣に表示する。

現在の `apps/web` は renderer の動作確認用として残すが、製品 UI としてそのまま
VS Code の Webview へ埋め込まない。特に `textarea` ベースのソースエディタは移植しない。

この方針により、次の機能は VS Code または既存の LaTeX 言語サポートへ委ねられる。

- テキスト入力、Tab、改行時インデント
- 選択、検索、複数カーソル
- undo / redo、保存、dirty buffer
- エディタグループの幅変更、折り畳み、配置の復元
- git diff
- 基本的な LaTeX の構文強調

beamer-editor が実装するのは次の範囲である。

- `.tex` の変更を読み取り、パース・展開・HTML レンダリングする
- プレビューを WebviewPanel に表示する
- プレビューとソース位置を相互に対応付ける
- core の lint 結果を VS Code Diagnostics へ変換する
- 将来の GUI 操作を `WorkspaceEdit` としてソースへ適用する

VS Code 公式も、標準 API で足りない表示だけに Webview を使うことを推奨している。
本プロジェクトではスライドプレビューが Webview を必要とする表示であり、ソース編集は
標準 API で足りる、という境界にする。

## 2. Phase 5 の到達点

Phase 5 の完了条件は、開発計画の M2（書ける）を満たすこととする。

1. VS Code 標準エディタで `fixtures/basic.tex` を開ける。
2. コマンドからプレビューをエディタ横に開ける。
3. ソース変更後、保存を待たずにプレビューが追従する。
4. プレビュー上のフレーム操作から対応するソース位置へ移動できる。
5. lint 結果が Problems パネルとエディタ上の波線に出る。
6. Claude Code、Codex、CLI など別プロセスによるファイル変更がプレビューへ反映される。
7. 未保存変更との競合を黙って上書きしない。
8. 開発用 `.vsix` をチームメンバーがインストールして試せる。

ここまで通過してから、Phase 7 のドラッグ移動・画像拡縮・表編集など「ソースを書き換える
GUI 編集」へ進む。

### 2.1 反映済み範囲と継続作業

Phase 5 のPRチェーン #27〜#34 はマージ済みで、VS-1〜VS-9（`.vsix`生成とCI artifactを含む）が反映されている。その後、ソースペインを維持するpreview jump、preview zoom、キャンバス画像ドラッグも追加された。

継続中の変更は[GitHub の open pull requests](https://github.com/ebi-oishii/beamer-editor/pulls?q=is%3Apr+is%3Aopen)で確認する。Phase 5 の完了は本書 §2 と §9 の受け入れ項目で判断し、実機確認が終わるまで恒久状態を更新しない。

## 3. 移植するもの・しないもの

| 現在の要素 | Phase 5 での扱い |
|---|---|
| `packages/core` の parser / AST / expander / linter | そのまま再利用する |
| `packages/renderer` の AST → HTML | そのまま再利用する |
| `apps/web` のプレビュー表示・フレーム移動・ステップ表示 | `packages/ui` へ抽出して再実装する |
| `apps/web` のソース位置ジャンプ計算 | source span の考え方を再利用し、VS Code API へ置き換える |
| `apps/web` の `textarea` | 移植しない |
| Web 独自の Tab・自動インデント・構文強調 | 実装しない |
| Web 独自のペイン幅保存・折り畳み | 実装しない。VS Code のエディタグループで検証する |
| WYSIWYG 表編集、キャンバスのドラッグ編集 | Phase 7 まで保留する |
| アプリ内 AI チャット | Phase 9 まで保留する |
| tectonic 実行・PDF 書き出し | Phase 6 で追加する |
| Electron / 正式 Web 版 | M4 後まで保留する |

`apps/web` は削除しない。renderer の高速な目視確認、Webview を起動しない UI 単体確認、
不具合の切り分けに使う。

## 4. 目標アーキテクチャ

```text
┌──────────────── VS Code ────────────────┐
│                                         │
│  標準 TextEditor                        │
│  ┌──────────────┐                       │
│  │ deck.tex     │                       │
│  └──────┬───────┘                       │
│         │ onDidChangeTextDocument       │
│         ▼                               │
│  apps/vscode（Extension Host / Node）   │
│  ┌───────────────────────────────────┐  │
│  │ document controller               │  │
│  │  ├─ core: parse / expand / lint   │  │
│  │  ├─ renderer: AST → HTML model    │  │
│  │  ├─ DiagnosticCollection          │  │
│  │  └─ source navigation             │  │
│  └──────────────┬────────────────────┘  │
│                 │ typed message         │
│                 ▼                       │
│  WebviewPanel（Browser context）        │
│  ┌───────────────────────────────────┐  │
│  │ packages/ui                       │  │
│  │  ├─ slide preview                 │  │
│  │  ├─ frame navigation              │  │
│  │  └─ overlay step                  │  │
│  └──────────────┬────────────────────┘  │
│                 │ jumpToSource(span)    │
│                 └──────────► TextEditor │
└─────────────────────────────────────────┘
```

### 4.1 実行コンテキストを分ける

VS Code 拡張は二つの異なるコンテキストで動く。

- **Extension Host**: `vscode` APIを利用できる Node.js 側
- **Webview**: ブラウザ相当の隔離された画面側。`vscode` APIを直接利用できない

両者は JSON シリアライズ可能なメッセージだけで通信する。公式 Webview API でも、
Extension → Webview は `webview.postMessage()`、Webview → Extension は
`acquireVsCodeApi().postMessage()` を使う。

### 4.2 依存方向

依存方向は次の一方向に固定する。

```text
packages/ui ──► packages/renderer ──► packages/core
     ▲
     │ message / ShellHost contract
apps/vscode
```

- `core` と `renderer` に `vscode` を import しない。
- `ui` に `vscode` を import しない。
- `apps/vscode` だけが `vscode` APIを知る。
- VS Code 固有型を共有メッセージへ漏らさず、source span や文字列など環境非依存の値を使う。

これにより、将来 Electron を追加しても `ui` を再利用できる。

## 5. 予定するディレクトリ構成

```text
packages/
├── core/
├── renderer/
└── ui/
    ├── src/
    │   ├── preview/
    │   ├── messages.ts
    │   └── shell-host.ts
    ├── test/
    └── package.json

apps/
├── web/
└── vscode/
    ├── src/
    │   ├── extension.ts
    │   ├── preview-controller.ts
    │   ├── document-controller.ts
    │   ├── diagnostics.ts
    │   └── source-navigation.ts
    ├── test/
    ├── media/               # build 済み Webview JS / CSS
    ├── package.json         # Extension Manifest を兼ねる
    ├── tsconfig.json
    ├── esbuild.mjs
    └── .vscodeignore
```

名前やファイル分割は実装時に微調整してよいが、`ui` と `apps/vscode` の責務境界は変えない。

## 6. Extension / Webview 間の契約

メッセージは文字列の `type` を持つ tagged union とし、受信側で必ず検証する。

概念上は次のメッセージが必要になる。

### Extension → Webview

- `deckUpdated`: レンダリング済みデッキ、現在フレーム、文書バージョン
- `activeFrameChanged`: ソース側のカーソルに対応するフレーム
- `error`: パース不能ではなく、拡張内部エラーなど操作を継続できない問題

### Webview → Extension

- `ready`: Webview の初期化完了
- `jumpToSource`: 対象フレームの source span
- `activeFrameChanged`: プレビューで選ばれたフレーム
- 将来の `applyEdits`: Phase 7 で追加。Phase 5 では実装しない

各 `deckUpdated` には VS Code の `TextDocument.version` を付ける。Webview は現在値より古い
更新を捨て、非同期処理の完了順が入れ替わって古いプレビューへ戻ることを防ぐ。

## 7. 実装プロセス

### VS-0: 着手条件を揃える

実装前に次を確定する。

- 拡張ID（`publisher.name`）
- 対応する最小 VS Code バージョン（`engines.vscode`）
- 開発時に使う pnpm バージョンをルート `package.json` の `packageManager` で固定する
- 最初はデスクトップ版 VS Code の Node Extension Hostだけを対象にする
- プレビューは「コマンドで開いた `.tex` 一つに紐づく単一パネル」とする

VS Code for the Web対応は、tectonicなどNode側機能との分離方針が固まるまで対象外とする。

### VS-1: 拡張の最小スキャフォールド

`apps/vscode` を追加し、まずプレビュー内容を持たない最小拡張を起動する。

- Extension Manifest
- `activate` / `deactivate`
- `beamerEditor.openPreview` コマンド
- TypeScript build / watch
- F5 で Extension Development Host を起動する設定
- Extension Host用のesbuild bundle
- Webview用の別bundle

完了条件:

- F5で開発用VS Codeが起動する。
- `.tex` を開いてコマンドを実行すると空のプレビューが横に開く。
- パネルを閉じるとlistenerやtimerが破棄される。

### VS-2: 共有プレビュー UI を抽出する

`apps/web` から次を `packages/ui` へ移す。

- フレーム表示
- 前後移動
- オーバーレイのステップ移動
- 現在フレーム番号
- プレビューからのsource jump通知

移さないもの:

- fixture選択
- `textarea`
- Web用のファイル読み込み
- Web独自の編集キーハンドラ
- Web独自の左右ペインレイアウト

`packages/ui` は React で実装し、`ShellHost`またはtyped message adapter経由で外部と通信する。
`apps/web` も同じ `packages/ui` をホストし、共有化による退行を検出できる状態を目指す。

完了条件:

- 同じfixtureを `apps/web` とWebviewの双方で表示できる。
- `packages/ui` のテストでフレーム移動とステップ移動を確認できる。
- `packages/ui` から `vscode` APIが参照されていない。

### VS-3: TextDocument とプレビューを同期する

拡張は対象の `TextDocument` を保持し、`document.getText()` を唯一の入力にする。

1. プレビューを開いた時点で全文をparse / expand / renderする。
2. `workspace.onDidChangeTextDocument` を購読する。
3. 対象文書の内容変更だけを100〜150ms程度debounceする。
4. 最新の `TextDocument.version` とレンダリング結果をWebviewへ送る。
5. 保存イベントはプレビュー更新の条件にしない。

パースは原則として例外で停止せずRaw nodeへ劣化する。予期しない例外だけをエラー表示し、
最後に成功したプレビューを残す。

完了条件:

- 保存せずに編集してもプレビューが更新される。
- 連続入力中に古いレンダリング結果へ巻き戻らない。
- 別ファイルの変更ではプレビューを再計算しない。
- パネルを閉じた後に更新処理が走らない。

### VS-4: プレビューからソースへ移動する

Web版のtextarea操作をVS Code APIへ置き換える。

1. Webviewが対象フレームの `sourceSpan` を送る。
2. Extension Hostが `TextDocument.positionAt(sourceSpan.start)` で開始位置を得る。
3. `window.showTextDocument` で対象文書を表示する。
4. `TextDocument.lineAt(position.line).range` で開始位置を含む行だけを得る。
5. `TextEditor.selection` へその行の範囲を設定する。
6. `TextEditor.revealRange` で中央付近へ表示する。
7. 必要なら該当行だけ一時decorationする。エディタ全体は発光させない。

ASTのsource spanはJavaScript文字列と同じUTF-16 offsetなので、VS Codeの
`TextDocument.positionAt`を境界変換に使い、独自の行・列計算を持たない。

完了条件:

- 日本語を含む文書でも正しい行へ移動する。
- 2回目のクリック後、体感上待たずに移動する。
- 移動先の該当行だけが短時間明確になる。
- プレビューが古い文書バージョンを参照していた場合は移動せず、再描画を要求する。

### VS-5: lintをDiagnosticsへ接続する

coreの `lintDeck` が返す診断を次へ変換する。

- source span → `vscode.Range`
- `info` / `warning` / `error` → `DiagnosticSeverity`
- L009などの規則番号 → `Diagnostic.code`
- 診断元 → `Diagnostic.source = "beamer-editor"`

`languages.createDiagnosticCollection("beamer-editor")` で文書ごとの診断を管理する。
文書変更時に更新し、文書を閉じた時または拡張をdisposeした時に削除する。

Phase 5ではProblems表示と波線までを対象にする。Quick Fixはcore側の安全なTextEdit表現と
VS Code側のCodeAction設計が揃ってから追加する。

完了条件:

- lint対象fixtureでProblemsパネルに規則番号・メッセージ・位置が出る。
- 修正すると診断が消える。
- 複数の`.tex`を開いても診断が混ざらない。

### VS-6: 外部編集と競合を確認する

Claude Code、Codex、CLIなどがディスク上の`.tex`を書き換えるケースを実機で検証する。

- bufferがcleanなら、VS Codeが取り込んだ変更を `onDidChangeTextDocument` 経由で追従する。
- bufferがdirtyなら、拡張がファイルを強制再読込・上書きしない。
- 競合の通知、比較、保存判断はVS Code標準挙動を優先する。
- 拡張独自のfile watcherは、VS Code標準イベントで不足が確認されるまで追加しない。

将来GUI編集を行う場合は `WorkspaceEdit` で反映し、1操作を1undo単位にする。

完了条件:

- clean bufferへの外部変更がプレビューへ反映される。
- dirty bufferと外部変更が競合しても入力内容が失われない。
- 外部変更後もsource jumpの位置が最新文書と一致する。

### VS-7: 状態・テーマ・アクセシビリティ

- 現在フレーム・overlay step・スライド zoomだけを `getState` / `setState` で保存する。
- ソース本文やASTをWebview stateへ複製保存しない。
- `retainContextWhenHidden` は原則使わない。
- VS Codeのtheme CSS variablesを使う。
- light / dark / high contrastで確認する。
- キーボード操作、focus順、ARIA labelを確認する。

エディタグループの幅・配置はVS Codeへ任せる。Issue #9の要件は、実際の
WebviewPanel配置で不足があるかをこの段階で確認する。

### VS-8: セキュリティとWorkspace Trust

Webviewは次を必須にする。

- Content Security Policyを設定し、原則 `default-src 'none'`
- scriptへnonceを付ける
- `localResourceRoots`を拡張のmediaと必要なworkspace範囲へ限定する
- ローカルファイルは `webview.asWebviewUri` でURLへ変換する
- ソース由来テキストをHTMLへ挿入する前にescapeする
- Extension / Webview双方でmessageを検証する
- `acquireVsCodeApi()`の戻り値をglobalへ公開しない

Phase 5のparse / render / lintは任意コードを実行しないためRestricted Modeでも利用可能にする。
Phase 6のtectonic実行はWorkspace Trustがない場合に無効化する。

### VS-9: テストと開発用配布

テストを三層に分ける。

1. **core / renderer単体テスト**  
   既存のVitestを継続する。
2. **ui / message単体テスト**  
   ShellHost mock、message validation、document versionの新旧判定を確認する。
3. **VS Code統合テスト**  
   `@vscode/test-cli` + `@vscode/test-electron` でExtension Development Hostを起動し、
   コマンド登録、文書変更、Diagnostics、source navigationを確認する。

最初の配布はMarketplaceではなく、`@vscode/vsce`で生成した`.vsix`をチーム内共有する。

完了条件:

- unit / integration testがCIで実行できる。
- `vsce package`で`.vsix`を生成できる。
- 別環境へ`.vsix`を入れて `basic.tex` の編集・プレビューを実演できる。

## 8. 推奨するPR分割

| PR | 内容 | 依存 |
|---|---|---|
| VS-1 | `apps/vscode`の最小スキャフォールド、build、F5起動 | main |
| VS-2 | `packages/ui`とtyped message契約、Web / Webview共通プレビュー | VS-1 |
| VS-3 | TextDocument変更のparse / render / Webview同期 | VS-2 |
| VS-4 | プレビュー → ソースジャンプ、文書version検査 | VS-3、source span |
| VS-5 | `lintDeck` → DiagnosticCollection | VS-3、core linter |
| VS-6 | 外部編集・dirty buffer・dispose・状態復元の統合テスト | VS-3〜5 |
| VS-7 | theme / accessibility | VS-2〜6 |
| VS-8 | CSP / Workspace Trust | VS-2〜7 |
| VS-9 | 統合テスト、`.vsix`生成とチーム内ドッグフーディング | VS-1〜8 |

PRを積み上げる場合でも、各PRは単独でbuild・typecheckできる状態にする。未マージの
formatterやlinterへ依存するPRはbase branchを明記し、無関係な差分を混ぜない。

## 9. GUI編集へ進むためのゲート

次のチェックは実装有無の一覧ではなく、Phase 7へ進むために実機で確認する受け入れゲートである。実装済み項目も、実機受け入れが終わるまで未チェックとして残す。

- [ ] VS Code標準エディタとWebviewプレビューの分離が安定している
- [ ] `basic.tex` / `canvas.tex` / `japanese.tex` がライブ更新できる
- [ ] preview → source jumpが日本語を含め正しい
- [ ] lint diagnosticsが正しい位置へ表示される
- [ ] clean bufferへの外部編集が反映される
- [ ] dirty bufferとの競合でデータを失わない
- [ ] Webviewを閉じた後にlistener・timer・診断が残らない
- [ ] light / dark / high contrastで操作できる
- [ ] Restricted Modeでparse / render / lintだけが安全に動く
- [ ] `.vsix`を別環境へインストールして再現できる

Phase 7開始時には、これに加えて次が必要になる。

- formatterの正規形と冪等性が合意済み
- `ShellHost.applyEdits`の契約が確定済み
- `WorkspaceEdit`による1操作 = 1undoステップの統合テスト
- source document versionまたはframe hashによる古い編集の拒否

## 10. 既存Issueの扱い

| Issue | Phase 5で行うこと |
|---|---|
| #6 editor内でTabが効かない | VS Code標準エディタで期待どおりか確認する。Web独自実装はしない |
| #8 円記号とbackslash | core lint / Quick Fix候補として別途扱う |
| #9 編集画面幅などの調整 | エディタグループとWebviewPanelで満たせるか実機確認する |
| #10 syntax highlight | 使用するLaTeX言語サポートで確認する。Phase 5では独自highlighterを作らない |
| #12 表のWYSIWYG編集 | Phase 7以降 |
| #13 フォント管理 | 既存CLIとrendererを利用し、任意フォント管理GUIは作らない |

注意: LaTeXの構文強調が対象環境で標準提供されるか、チームが既存のLaTeX拡張を
利用するかは実機で確認する。未確認のまま「VS Codeが必ず提供する」とは扱わない。

## 11. 実装前に決める未決事項

推奨初期値を併記する。

| 項目 | 推奨初期値 |
|---|---|
| 最小VS Codeバージョン | 実装開始時のチーム最古環境を確認して固定 |
| previewの数 | 1 documentにつき1 panelではなく、最初は1つのpanelを1 documentへ固定 |
| previewを開くタイミング | 自動ではなくCommand Paletteから明示的に開く |
| previewの位置 | `ViewColumn.Beside`を初期値にし、以後の配置はユーザーに任せる |
| LaTeX language support | チーム環境を確認し、必要なら推奨拡張を文書化する |
| formatter未完時のGUI編集 | 実装しない |
| Workspace Trust | parse / render / lintは対応、外部プロセス実行は無効 |
| Marketplace公開 | M2では行わず`.vsix`共有 |

## 12. 公式資料

- [Extension Anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy)
  - Extension Manifest、activation、contribution、`activate`の基本
- [Webview API](https://code.visualstudio.com/api/extension-guides/webview)
  - WebviewPanel、message passing、state、resource制限、CSP
- [VS Code API Reference](https://code.visualstudio.com/api/references/vscode-api)
  - `onDidChangeTextDocument`、`showTextDocument`、`revealRange`、`WorkspaceEdit`、
    `DiagnosticCollection`
- [Programmatic Language Features](https://code.visualstudio.com/api/language-extensions/programmatic-language-features)
  - Diagnosticsと各language featureの対応
- [Testing Extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
  - `@vscode/test-cli`と`@vscode/test-electron`
- [Bundling Extensions](https://code.visualstudio.com/api/working-with-extensions/bundling-extension)
  - Extension Host bundle、test codeの分離、`.vscodeignore`
- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
  - `vsce package`と`.vsix`の配布
- [Workspace Trust Extension Guide](https://code.visualstudio.com/api/extension-guides/workspace-trust)
  - Restricted Modeと外部コード実行の制御
