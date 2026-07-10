# GUI・AI 連携・実行形態に関する追加要件

ステータス: proposed decision / 作成日: 2026-07-10

本書は、既存の `design.md`、`subset-spec.md`、`ai-protocol.md`、`development-plan.md` に対する追加の設計判断である。特に、次の論点を実装前に固定する。

- GUI でどこまでスライド要素を操作可能にするか
- GUI 操作をどの Beamer ソース表現へ変換するか
- Claude / Codex を編集中に呼び出す方法
- VS Code 拡張、独立デスクトップ、Web の優先順位
- AI と人間が同じデッキを扱う場合の競合・undo・認証・安全性

## 1. 結論

### 1.1 採用する方針

1. **GUI の細かな見た目は今決め切らないが、GUI 操作の意味とソース表現は Phase 1 より前に固定する。**
2. **自由配置を v1 に前倒しする。** ただし PowerPoint 型の汎用描画機能にはせず、位置指定されたテキストと画像だけに限定する。
3. **GUI はレイアウト操作に集中する。** 一般テキストの入力・校正はソースまたは AI に任せ、最初の GUI では移動、幅変更、画像拡大縮小、文字サイズ変更だけを保証する。
4. **最初の実用シェルは VS Code 拡張 1 本に絞る。** VS Code 拡張と Electron の同時開発は行わない。
5. **独立アプリが必要になった場合は Electron を第 2 シェルとする。** フル機能の Web 版は後回しにする。
6. **MVP の AI 連携は、Claude Code / Codex を VS Code 内で横に開いてファイル経由で使う方式で成立させる。**
7. **アプリ内の「AI に依頼」は後続フェーズで provider-neutral なアダプタとして実装する。** Claude と Codex のどちらか一方に中核設計を依存させない。
8. **1 デッキに対する書き込み可能な AI 実行は同時に 1 本だけとする。** 人間との真の同時編集は、スナップショットと競合検査を通じて安全に扱う。

### 1.2 明示的に採らないもの

v1 では次を実装しない。

- 回転、反転、クロップ、透過度調整
- 図形描画、線、矢印、コネクタ
- グループ化、複数選択、整列、均等配置
- ガイド、ルーラー、スマートスナップ
- 任意フォント、文字間隔、段落設定の GUI
- アニメーションを GUI で構築する機能
- PowerPoint ファイルの読み書き
- 複数ユーザーのリアルタイム共同編集
- Claude と Codex が同じデッキへ同時に書き込む機能

## 2. 現行仕様とのギャップ

現行の `design.md` では GUI の最小セットが、スライド一覧、タイトル・箇条書き編集、画像差し替えに限られている。一方、`subset-spec.md` では自由配置が将来候補になっている。

今回の最低要件は「テキストボックスや図を移動し、文字や図を拡大縮小するとコードへ反映されること」であるため、次の変更が必要になる。

- 自由配置用の AST ノードを Phase 1 から持つ
- 自由配置用の Beamer サブセット構文を v1 に追加する
- renderer が座標とサイズを解釈する
- GUI は AST 変換として座標・幅・文字サイズを更新する
- formatter が座標値を正規化し、ドラッグ操作による diff のノイズを抑える

これを Phase 7 まで未決定にすると、パーサ、AST、フォーマッタ、renderer を後から変更することになる。したがって、**操作の見た目は後回しでよいが、ソース表現と操作セマンティクスは着手前に決めるべきである。**

## 3. GUI の最低要件

### 3.1 レイアウトモード

通常の Beamer フロー配置と、GUI で扱う自由配置を混在させない。フレーム本文に `deckcanvas` がある場合、そのフレームはキャンバスモードとする。

- 通常フレーム: 既存の `columns`、`itemize`、`block` などで構成する
- キャンバスフレーム: `deckcanvas` の直下に位置指定オブジェクトを並べる
- フレームタイトルは v1 では固定領域であり、GUI で移動しない
- キャンバス内で通常フロー要素と絶対配置要素を混在させない

この分離により、通常の Beamer レイアウトを壊さず、GUI 側にも PowerPoint 相当の汎用レイアウトエンジンを要求しない。

### 3.2 公認オブジェクト

キャンバスモードで GUI が理解するオブジェクトは 2 種類だけとする。

| オブジェクト | 内容 | GUI 操作 |
|---|---|---|
| `decktext` | テキスト、インライン要素、単純な箇条書き | 移動、幅変更、文字サイズ変更 |
| `deckimage` | PNG / JPEG / PDF 画像 | 移動、縦横比を保った拡大縮小 |

`TikZ`、複雑な表、生 LaTeX ブロック、動画、SVG はキャンバス GUI の対象外とする。必要な場合は生ブロックまたは事前変換した画像として扱う。

### 3.3 提案するソース表現

公開するサブセット構文は、`textpos` などのパッケージ固有構文を直接露出せず、ツール管理マクロで包む。

```latex
\begin{frame}[label=results]{実験結果}
  \begin{deckcanvas}
    \begin{decktext}[x=0.050,y=0.100,w=0.420,size=normal]
      精度はベースラインより \textbf{8.4ポイント} 改善した。
    \end{decktext}
    \deckimage[x=0.520,y=0.140,w=0.400]{assets/result.pdf}
  \end{deckcanvas}
\end{frame}
```

ツール管理プリアンブルが `deckcanvas`、`decktext`、`deckimage` を本物の LaTeX として定義する。内部実装は absolute positioning 用パッケージを利用してよいが、ソースの公開契約には含めない。

この方式には次の利点がある。

- ソースはそのまま正しい Beamer 文書である
- AI が読み書きしやすい
- パッケージ実装を将来交換できる
- formatter が key の順序と数値精度を固定できる
- GUI 操作の差分が 1〜2 個の属性変更に収まる

### 3.4 座標系と正規形

| 項目 | 決定 |
|---|---|
| 原点 | フレーム本文領域の左上 |
| `x`, `y`, `w` | 本文領域に対する 0.000〜1.000 の正規化値 |
| y 軸 | 下向きを正とする |
| 画像の高さ | 元画像の縦横比から自動算出 |
| テキストの高さ | 内容と幅から自動算出 |
| z-order | ソース出現順。後ろに書かれたものが前面 |
| 座標の保存精度 | 小数 3 桁 |
| 画像幅の保存精度 | 小数 3 桁 |
| 文字サイズ | `tiny`, `scriptsize`, `footnotesize`, `small`, `normal`, `large`, `Large` の離散値 |

文字サイズを連続値にしないのは、ドラッグのたびに細かな値が生成されること、HTML と TeX の差が増えること、ユーザーが PowerPoint 型の無限な微調整へ入りやすいことを避けるためである。

### 3.5 操作セマンティクス

1. オブジェクトは単一選択のみ。
2. 本体ドラッグで `x`, `y` を変更する。
3. テキスト右辺のハンドルで `w` を変更し、内容をリフローする。
4. テキストサイズは `A-` / `A+` または簡単な選択 UI で離散値を変更する。
5. 画像のコーナーハンドルで `w` を変更し、縦横比を保持する。
6. ドラッグ中は UI の一時状態だけを更新する。
7. ポインタを離した時点で AST 変換と formatter を 1 回実行し、ソースへ反映する。
8. 1 回のドラッグまたはサイズ変更は undo 履歴の 1 ステップにする。
9. ソース側で座標を変更した場合も GUI は即時追従する。
10. オブジェクトが本文領域を越えた場合は保存を禁止せず、lint 警告を出す。

「自動的にコードへ反映」は、マウス移動イベントごとにファイルを書き換えることではなく、**操作完了直後に 1 回の意味ある編集として反映すること**と定義する。

### 3.6 GUI MVP に含めない編集

最初の GUI では、`decktext` の本文編集や新規オブジェクト作成を必須にしない。これらはソースまたは AI から追加できるため、最初の縦断実装は fixture に既存オブジェクトを用意すれば成立する。

優先順位は次のとおりとする。

1. 選択
2. 移動
3. 画像拡大縮小
4. テキスト幅変更
5. 文字サイズ変更
6. undo / redo
7. 必要性が確認できた後に、オブジェクト追加とインライン本文編集

### 3.7 追加 lint 規則

| ID | 内容 | 深刻度 |
|---|---|---|
| L011 | `deckcanvas` を持つ frame に一意な `label` がない | warning |
| L012 | `x`, `y`, `w` が範囲外、またはオブジェクトが本文領域外へ出る | warning |
| L013 | 許可されていない文字サイズ値 | error |
| L014 | `deckcanvas` 直下に未対応要素がある | warning |
| L015 | `deckimage` の形式が v1 対象外、またはファイルを読めない | error |

重なりは意図的な場合があるため lint 対象にしない。

### 3.8 GUI の受け入れ条件

- テキストをドラッグした結果、対象フレーム内の `x` / `y` だけが変わる
- 画像を拡大した結果、`w` だけが変わり、縦横比が維持される
- 文字サイズ変更で `size` が許可値の間だけを遷移する
- 操作完了から 100 ms 程度以内にソースペインへ反映される
- 1 操作を 1 回の undo で戻せる
- 保存・再読込後に同じレイアウトへ戻る
- formatter を 2 回実行しても結果が変わらない
- HTML プレビューと PDF で位置の大きな逆転や領域外配置がない

## 4. Claude / Codex を編集中に呼び出すことは可能か

### 4.1 結論

可能である。ただし、次の 2 段階を分ける。

- **MVP:** VS Code 内で本プロジェクトの拡張と、Claude Code または Codex の公式拡張を横に置いて使う
- **後続:** 本アプリ自身の依頼ボックスから公式 Agent SDK / Codex SDK を呼ぶ

VS Code では Claude Code と Codex の双方が IDE サイドパネルを提供しており、選択範囲や開いているファイルを文脈として利用できる。したがって、最初から独自チャット UI を作らなくても、既存の「AI がファイルを編集し、エディタが追従する」ループは成立する。

### 4.2 他拡張の UI を直接制御しない

本拡張から Claude Code / Codex の公式拡張を内部 API で自動操作する設計は採らない。

- 公開されていない拡張 API への依存は壊れやすい
- サインイン、承認、会話履歴の扱いが相手拡張の実装に依存する
- VS Code 以外の Electron シェルへ移植できない

MVP では「対象フレームのアドレスをコピー」「選択ソースをコピー」「公式 AI パネルを開く」までを補助できればよい。アプリ内の自動ディスパッチは独自の `AgentAdapter` を通す。

### 4.3 provider-neutral なインターフェース

```ts
interface AgentAdapter {
  readonly provider: "claude" | "codex";
  startOrResumeSession(input: SessionInput): Promise<AgentSession>;
  runAdjustment(input: AdjustmentRequest): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
  dispose(): Promise<void>;
}
```

最低限のイベントは次とする。

- `status`: 読み込み、編集中、検証中など
- `message`: エージェントの短い応答
- `approval-required`: 書き込みやコマンド実行の承認
- `patch-ready`: 適用可能な差分
- `completed`: lint / check 結果を含む完了
- `failed`: エラー

セッション ID はリポジトリへコミットせず、アプリのローカルストレージに「canonical project path + provider」で保存する。

### 4.4 Claude の実装候補

Claude Agent SDK は TypeScript / Python からファイル読み取り、編集、コマンド実行、権限、セッション再開を扱えるため、アプリ内統合に適する。

ただし、配布アプリで Claude のサブスクリプションログインをそのまま提供できるとは限らない。公式ドキュメントでは、事前承認がない第三者製品は claude.ai ログインではなく API キー等を使うよう求めている。このため、v1 の内蔵 Claude 連携は次のどちらかに限定する。

- ユーザー自身の API キーを OS の安全な資格情報ストアへ保存する
- 組織の Bedrock / Vertex AI / Azure 等の認証を利用する

内部ドッグフーディングだけなら外部 Claude Code CLI を併用してもよいが、製品の正式な認証方式としては SDK の契約に合わせる。

### 4.5 Codex の実装候補

Codex SDK は Node.js のアプリケーションからローカル Codex スレッドを開始・継続・再開できるため、Electron または VS Code extension host から利用できる。

Codex app-server は、認証、会話履歴、承認、ストリーミングイベントを含むリッチクライアント向けの公式インターフェースである。ただし 2026-07-10 時点の CLI リファレンスでは `app-server` が Experimental とされているため、v1 の必須依存にはしない。

推奨順序は次のとおり。

1. Codex SDK で 1 スレッドの開始・継続・キャンセルを実装
2. 必要なイベントが SDK だけで不足する場合に app-server を試験導入
3. app-server の安定性が確認できてから承認 UI や履歴 UI を深く統合

### 4.6 AI と人間の同時編集

「AI を呼び出しながら編集できる」は実現するが、同じソースへ無制御に同時書き込みさせない。

内蔵 AI の書き込みフローは次とする。

1. 依頼時に現在のバッファを保存し、対象 frame の label と内容ハッシュを記録する
2. エージェントは一時スナップショットまたは一時 worktree を編集する
3. `deck format`、`deck lint`、必要に応じて `deck check` を一時側で実行する
4. 完了時に対象 frame の差分を生成する
5. 現在の対象 frame ハッシュが依頼時と同じなら自動適用する
6. 人間が同じ frame を変更していた場合は自動適用せず、差分レビューへ送る
7. 適用は `ShellHost` 経由で 1 undo ステップとして行う

この方式なら、AI 実行中も人間は別の frame を編集できる。同じ frame を同時に編集した場合だけ明示的な競合になる。

外部 CLI がライブファイルを直接編集する M2 段階では、次の簡易ルールを採る。

- AI 依頼前に保存する
- dirty buffer がある場合は警告する
- 外部変更は 1 undo ステップとして取り込む
- 競合時は黙って上書きせず diff を表示する

### 4.7 AI 安全要件

- 1 デッキにつき書き込み可能な run は 1 本
- 作業ディレクトリをプロジェクト内に限定
- デフォルトはネットワークアクセス禁止
- `deck` CLI と明示的に許可したコマンドだけを自動承認
- API キーを `.tex`、設定ファイル、ログ、git 管理下へ書かない
- AI が生成した変更は適用前または適用直後に diff で確認可能にする
- cancel を必須にする
- AI の変更は必ず lint を通す
- レイアウトを変えた場合は check を通す
- 対象外 frame の変更は自動適用しない

## 5. デスクトップと Web の比較

### 5.1 比較結果

| 方式 | プレビューだけ | ローカルファイル編集 | tectonic / CLI | Claude / Codex 内蔵 | undo・diff | フル要件の実装難度 |
|---|---:|---:|---:|---:|---:|---:|
| ブラウザ Web | 容易 | 権限・互換性対応が必要 | サーバーまたは別プロセスが必要 | 原則サーバー側が必要 | 自前実装 | 高い |
| Electron | 容易 | 容易 | Node から実行可能 | SDK / CLI をローカル実行可能 | 自前実装 | 中程度 |
| VS Code 拡張 | 容易 | 標準機能を利用 | extension host から実行可能 | 公式拡張との併用または SDK | 標準機能を利用 | 最も低い |

Web は parser と renderer の試験場としては最も簡単である。しかし、今回必要なローカルファイル監視、Tectonic、AI エージェント、秘密情報管理、undo、外部変更の競合まで含めると、バックエンドまたはローカルヘルパーが必要になり、全体としては最も複雑になる。

Electron は Node.js を利用できるため、ファイル、子プロセス、SDK、Tectonic を 1 アプリ内で扱える。独立製品に限定すれば Web より簡単である。ただし、ソースエディタ、undo、diff、競合、診断、秘密情報管理、更新、署名を自前で用意する必要がある。

VS Code 拡張は、標準テキストエディタ、WorkspaceEdit、undo、診断、diff、ファイル監視、SecretStorage、ターミナルを利用できるため、現在の開発者向けワークフローに対して最短である。

### 5.2 推奨する実装順

1. `apps/web` は renderer の開発用ビューアとして維持する
2. M2 の正式シェルは `apps/vscode` だけにする
3. GUI と AI 連携の有用性が確認できた後に `apps/desktop` を追加する
4. Web の正式製品化は「ブラウザだけで使いたい」という明確な需要が出た時点で判断する

したがって、質問を「独立デスクトップか Web か」の二択に限るなら、**フル要件では Electron の方が実装しやすい。** ただし、このプロジェクト全体で最も簡単なのは **VS Code 拡張を最初の製品形態にすること**である。

## 6. 開発計画の修正案

### Phase 0.5: GUI ソース契約の固定

Phase 1 の前に次を fixture とテストで固定する。

- `deckcanvas` / `decktext` / `deckimage` の構文
- 座標系、数値精度、文字サイズ enum
- キャンバス frame の正規形
- 16:9 のキャンバス fixture 3 枚
- HTML と PDF の比較用画像
- lint L011〜L015

### Phase 1: AST へキャンバスを含める

最低限、次の型を持つ。

```ts
type CanvasNode = {
  type: "canvas";
  items: Array<CanvasTextNode | CanvasImageNode>;
};

type CanvasPosition = {
  x: number;
  y: number;
  width: number;
};

type CanvasTextNode = {
  type: "canvasText";
  position: CanvasPosition;
  size: "tiny" | "scriptsize" | "footnotesize" | "small" | "normal" | "large" | "Large";
  children: BlockNode[];
};

type CanvasImageNode = {
  type: "canvasImage";
  position: CanvasPosition;
  path: string;
};
```

### Phase 4: renderer

- キャンバス本文領域を固定サイズで描画
- `x`, `y`, `w` を CSS の absolute position へ変換
- テキストサイズ enum をテーマ CSS へ変換
- PDF 画像を扱う場合は pdf.js で表示

### Phase 5: シェル

- 5a `ui` と `ShellHost`
- 5b VS Code 拡張
- Electron の 5c は削除せず、M4 後へ移動
- Claude Code / Codex の公式 VS Code 拡張との併用をドッグフーディングする

### Phase 7: GUI

実装順を次へ変更する。

1. キャンバス要素の選択
2. 移動
3. 画像拡大縮小
4. テキスト幅変更
5. 文字サイズ変更
6. undo / redo
7. スライド一覧の並べ替え
8. 必要性が確認できた場合だけインライン本文編集・オブジェクト挿入

### Phase 9: AI 依頼

- `AgentAdapter` を導入
- Claude / Codex を別アダプタにする
- 一時スナップショット編集と frame 単位の競合検査を実装
- provider ごとのセッション ID をローカル保存
- 1 デッキ 1 write run を強制

### 後続: Electron

VS Code 版で次が安定してから Electron を開始する。

- AST と formatter の正規形
- キャンバス GUI の操作セマンティクス
- AI patch の適用・競合・undo
- Tectonic 配布方式

これにより、Electron 側は ShellHost と AgentAdapter の別実装に集中できる。

## 7. この時点で固定する追加要件

### 7.1 製品前提

- v1 は単一ユーザー、ローカルファイル、開発者・研究者向け
- リアルタイム共同編集は対象外
- 外部 SaaS へのデッキ自動アップロードはしない
- AI を使わない場合も全機能が壊れない
- AI provider は任意機能として扱う

### 7.2 テーマと画面比

- GUI キャンバス MVP は 16:9 のみを正式サポート
- テーマは `default` 1 種類から開始
- 4:3 と `metropolis` は TeX 書き出し自体を禁止しないが、GUI の受け入れ対象外
- 2 テーマ目を増やす前に HTML/PDF の座標差を fixture で評価する

### 7.3 画像

- v1 対象は PNG、JPEG、PDF
- SVG は GUI へ直接入れず、PDF または PNG へ変換する
- 画像は相対パスで参照する
- 将来 GUI から追加する場合は `assets/` へコピーし、ファイル名衝突を解決する

### 7.4 ソース互換性

ツール管理領域にソース形式の版を記録する。

```latex
%% deck-source-version: 1
```

構文変更時は formatter が黙って破壊的変換せず、明示的な migration コマンドを通す。

### 7.5 自動保存と競合

- 通常編集の autosave は任意
- AI 依頼時は必ず保存済みスナップショットを作る
- 外部変更を検知した際、dirty buffer へ無条件上書きしない
- built-in AI はライブファイルを直接編集せず、一時側の patch を適用する
- GUI 操作、テキスト編集、AI patch は同じ undo スタックへ統合する

### 7.6 性能目標

- ドラッグ中のプレビューは 60 fps を目標にし、ソース再出力は pointer-up 時だけ行う
- 1 frame の AST 変換・整形・再描画は通常 50 ms 未満を目標とする
- AI 実行や TeX コンパイルは UI スレッドを塞がない
- 1000 行程度のデッキでフレーム選択・移動操作が体感遅延なく動く

### 7.7 配布優先度

1. 開発用 VS Code 拡張 `.vsix`
2. チーム内配布
3. 必要になれば Marketplace
4. Electron インストーラ
5. Web 正式版

## 8. 最終的な判断

このプロジェクトは、PowerPoint の代替を目指すべきではない。価値は「AI、人間、GUI が同じ可読なソースを編集できること」にある。

そのため、GUI は次の一文で説明できる範囲に保つ。

> 位置指定されたテキストと画像を選び、動かし、大きさを変えると、正規化された Beamer ソースへ 1 操作 1 差分で反映される。

この契約を今固定し、細かなハンドルの形、スナップ、ガイド、装飾機能は実際のドッグフーディングで必要性が確認されるまで追加しない。

AI 連携も同様に、最初は公式 VS Code 拡張との同居で十分である。アプリ内統合は技術的に可能だが、認証、権限、競合、undo を含むため、GUI と CLI が安定してから provider-neutral なアダプタとして追加するのが安全である。

## 9. 参考資料

参照日: 2026-07-10

- Claude Code Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Claude Code for VS Code: https://code.claude.com/docs/en/vs-code
- OpenAI Codex IDE extension: https://developers.openai.com/codex/ide
- OpenAI Codex SDK: https://developers.openai.com/codex/sdk
- OpenAI Codex app-server: https://developers.openai.com/codex/app-server
- OpenAI Codex CLI reference: https://developers.openai.com/codex/cli/reference
- VS Code Custom Editor API: https://code.visualstudio.com/api/extension-guides/custom-editors
- VS Code Webview API: https://code.visualstudio.com/api/extension-guides/webview
- Electron process model: https://www.electronjs.org/docs/latest/tutorial/process-model
- File System API: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API
- CTAN textpos: https://ctan.org/pkg/textpos
