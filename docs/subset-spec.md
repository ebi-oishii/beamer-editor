# Beamer サブセット仕様 v1.1

ステータス: draft / 最終更新: 2026-07-10

このファイルは、人間と AI の共通言語となるソース形式(Beamer サブセット)の仕様。ツール(パーサ・フォーマッタ・リンター・プレビュー)が構文として理解する範囲を定義する。

改訂履歴: v1.1 で自由配置(キャンバス)語彙を将来候補から本文(§2.8)へ昇格し、リント規則 L011〜L019 を追加した([beamer-editor-additional-requirements.md](beamer-editor-additional-requirements.md) と [issues-to-resolve.md](issues-to-resolve.md) の反映)。

大原則: **ここに書かれていない構文を書いてもエラーにはならない。** ツールはそれを「生ブロック」として扱い、プレビューは部分コンパイル画像に、GUI 編集は移動のみに劣化する。最終 PDF は常に完全な Beamer としてコンパイルされる。

## 1. ファイル構造

1 デッキ = 1 ファイル(`.tex`)。ソースはそのまま `tectonic` でコンパイル可能な完全な Beamer 文書である。

```latex
\documentclass[aspectratio=169]{beamer}
%% deck-source-version: 1
% ツール管理プリアンブル(テーマ・共通パッケージ・deck* マクロ)がここに入る

%% macros:begin
\newcommand{\R}{\mathbb{R}}
\newcommand{\code}[1]{\texttt{#1}}
%% macros:end

%% preamble-extra:begin
% ツールが解釈しない自由領域(コンパイルには含まれる)
%% preamble-extra:end

\title{タイトル}
\author{著者}
\date{2026-07-10}

\begin{document}

\begin{frame}
  \titlepage
\end{frame}

\begin{frame}{フレームタイトル}
  ...
\end{frame}

\end{document}
```

### 1.1 プリアンブル

プリアンブルは**ツールが所有**する。ユーザー(人間・AI)が編集してよいのは次の 3 箇所のみ。

| 領域 | 内容 |
|---|---|
| `\documentclass` オプション | `aspectratio=169` / `aspectratio=43` のみ |
| `%% macros:begin` 〜 `%% macros:end` | マクロ定義(§4 の規則に従う) |
| `%% preamble-extra:begin` 〜 `%% preamble-extra:end` | 生の自由領域。ツールは素通しし、解釈しない |

テーマ選択とパッケージはツール管理領域に入る。v1 のテーマは `default` の 1 種類から開始する(2 テーマ目は HTML/PDF の座標差を fixture で評価してから追加。`metropolis` は将来候補)。共通パッケージ(`graphicx`, `amsmath`, `amssymb`, `booktabs`, `hyperref` 等)と、キャンバス用の `deckcanvas` / `decktext` / `deckimage`(§2.8)の定義はツールが自動注入する。

- ツール管理領域は `%% deck-source-version: 1` でソース形式の版を記録する。構文の版が上がるときは、フォーマッタが黙って破壊的変換せず、明示的な migration コマンドを通す(欠落・不一致は L017)。
- `deck` で始まるコマンド・環境名はツールの予約名前空間であり、`%% macros` 領域での再定義は不可(L016)。
- GUI キャンバスの正式サポートは 16:9(`aspectratio=169`)のみ。4:3 デッキでの `deckcanvas` 使用は警告する(L018)。

メタデータ: `\title{}` `\author{}` `\date{}` `\institute{}` `\subtitle{}` を解釈する。

### 1.2 正規形

フォーマッタが一意に定める形。主な規則:

- インデントは半角スペース 2。環境のネストごとに 1 段。
- `\item` は 1 行 1 個。
- `\begin{frame}` の前に空行 1。フレーム内のブロック要素(環境)の間に空行は入れない。
- 行末スペースなし、ファイル末尾は改行 1。
- `%` コメントは直近のノードに付随して位置を保持する(消えない)。

## 2. 本文の語彙

「Beamer 構文」列が受理する形、「プレビュー」列が HTML 描画の対応。

### 2.1 文書構造

| 要素 | Beamer 構文 | プレビュー |
|---|---|---|
| フレーム | `\begin{frame}[opts]{タイトル}` … `\end{frame}` | 1 スライド |
| フレームオプション | `fragile`, `plain`, `allowframebreaks`, `label=名前` のみ | `label` はフレームの永続アドレス([ai-protocol.md](ai-protocol.md) §3)としても使う |
| タイトルページ | `\titlepage` | メタデータから描画 |
| 目次 | `\tableofcontents` | section 一覧から描画 |
| セクション | `\section{…}`, `\subsection{…}` | 一覧ペインの区切り・目次 |

### 2.2 リスト

| 要素 | Beamer 構文 | 備考 |
|---|---|---|
| 箇条書き | `\begin{itemize}` / `\item …` | ネスト 3 段まで |
| 番号付き | `\begin{enumerate}` / `\item …` | 同上 |
| オーバーレイ付き項目 | `\item<2->`, `\item<2-4>`, `\item<2,4>` | §2.6 |

### 2.3 レイアウト・ブロック

| 要素 | Beamer 構文 | 備考 |
|---|---|---|
| 段組 | `\begin{columns}[T]` / `\begin{column}{0.5\textwidth}` | 幅は `\textwidth`(または `\linewidth`)の係数のみ |
| ブロック | `\begin{block}{見出し}` ほか `alertblock`, `exampleblock` | オーバーレイ指定 `<n->` 可 |
| 中央寄せ | `\begin{center}` | |

### 2.4 画像・表

| 要素 | Beamer 構文 | 備考 |
|---|---|---|
| 画像 | `\includegraphics[width=0.8\textwidth]{path}` | オプションは `width` / `height` のみ、値は `\textwidth`・`\linewidth` の係数のみ。パスは相対パス |
| 表 | `\begin{tabular}{lcr}` + `booktabs`(`\toprule` `\midrule` `\bottomrule`)+ `&` `\\` | 列指定は `l` `c` `r` と `|` なしの基本形のみ。`multicolumn` 等は生ブロックへ |

### 2.5 インライン要素

| 要素 | 構文 |
|---|---|
| 強調 | `\textbf{}`, `\emph{}`, `\textit{}`, `\texttt{}`, `\alert{}` |
| 色 | `\textcolor{名前付き色}{…}`(定義済み色名のみ) |
| リンク | `\url{}`, `\href{}{}` |
| 改行 | `\\` |
| 特殊文字 | `\%`, `\&`, `\_`, `\#`, `\{`, `\}`, `~`, `---`, `--` |

### 2.6 数式(KaTeX で描画)

| 要素 | 構文 |
|---|---|
| インライン | `$…$`, `\(…\)` |
| ディスプレイ | `\[…\]`, `\begin{equation*}`, `\begin{align*}`(番号付き `equation` / `align` も受理) |

数式内部の語彙は KaTeX がサポートする範囲を「描画可能」とする。KaTeX が描画できないコマンドを含む数式は、その数式単位で生ブロック(部分コンパイル)に落とす。

### 2.7 オーバーレイ

| 要素 | 構文 | プレビュー |
|---|---|---|
| ポーズ | `\pause` | ステップスライダーで段階表示 |
| 指定 | `<n>`, `<n->`, `<n-m>`, `<n,m>`(`\item`、block 系環境に付与) | 同上 |

`\only` `\uncover` `\visible` `\alt` は v1 対象外(生ブロックへ)。

### 2.8 キャンバス(自由配置)

GUI で扱う自由配置は、通常の Beamer フロー配置と混在させず、キャンバスモードとして分離する。フレーム本文に `deckcanvas` がある場合、そのフレームはキャンバスフレームである。

- 通常フレーム: 既存の `columns`、`itemize`、`block` などで構成する
- キャンバスフレーム: `deckcanvas` の直下に位置指定オブジェクトだけを並べる(通常フロー要素との混在は不可 → L014)
- フレームタイトルは固定領域であり、GUI で移動しない
- キャンバスフレームには一意な `label` を付ける(L011。AI 依頼・競合検査の永続アドレスに使う)

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

`deckcanvas` / `decktext` / `deckimage` はツール管理プリアンブルが本物の LaTeX として定義する。内部実装は textpos 等の絶対配置パッケージを利用してよいが、ソースの公開契約には含めない(実装は将来交換できる)。

#### 公認オブジェクト

| オブジェクト | 内容 | GUI 操作 |
|---|---|---|
| `decktext` | テキスト・インライン要素・単純な箇条書き | 移動、幅変更、文字サイズ変更 |
| `deckimage` | PNG / JPEG / PDF 画像 | 移動、縦横比を保った拡大縮小 |

TikZ・複雑な表・生 LaTeX ブロック・動画・SVG はキャンバス GUI の対象外。必要な場合は生ブロック、または事前に PDF / PNG へ変換した画像として扱う。

#### `decktext` 内部の許容語彙

- 可: インライン要素(§2.5)、数式(§2.6)、改行 `\\`、`itemize` / `enumerate`(ネスト 1 段まで)
- 不可: block 系環境、`columns`、`center`、`tabular`、`\includegraphics`(画像は `deckimage` を使う)、ネスト 2 段以上のリスト → L014

#### 座標系と正規形

| 項目 | 決定 |
|---|---|
| 原点 | フレーム本文領域の左上(下記「本文領域の定義」) |
| `x`, `y`, `w` | 本文領域に対する 0.000〜1.000 の正規化値 |
| y 軸 | 下向きを正 |
| 画像の高さ | 元画像の縦横比から自動算出 |
| テキストの高さ | 内容と幅から自動算出 |
| z-order | ソース出現順(後に書かれたものが前面) |
| 座標・画像幅の保存精度 | 小数 3 桁 |
| 文字サイズ | `tiny`, `scriptsize`, `footnotesize`, `small`, `normal`, `large`, `Large` の離散値(L013) |

#### 本文領域の定義

タイトル領域を **1 行相当の固定高**と定義し、本文領域は「タイトル帯の直下から下マージンまで・左右マージンの内側」の固定矩形とする。タイトルが 2 行以上になると固定タイトル帯を超えて本文領域に重なるため、キャンバスフレームでは lint 警告とする(L019)。

default テーマ・16:9 の実測値(2026-07-10、tectonic 0.16.9 / zref-savepos):

| 項目 | 実測 |
|---|---|
| スライド実寸 | 160mm × 90mm(455.24pt × 256.07pt) |
| 左右マージン | 各 1cm(28.45pt)→ 本文幅 140mm(398.34pt) |
| 本文先頭ベースライン(タイトル 1 行) | 上端から 28.58pt |
| 本文先頭ベースライン(タイトルなし) | 上端から 5.69pt |
| タイトル 1 行追加ごとのずれ | +18.0pt |

本文領域の境界定数(上端・下端の確定値)は Phase 0.5 で `deckcanvas` の TeX 実装と同時に savepos 実測で最終確定し、fixture として固定する。

#### オーバーレイ

v1 ではキャンバスオブジェクトへのオーバーレイ指定(`\pause`、`<n->`)は対象外。付与された場合、そのオブジェクトは生ブロックに落ち、L014 で通知される。

#### 画像

- v1 対象は PNG / JPEG / PDF。SVG は GUI へ直接入れず、PDF または PNG へ変換する(L015)
- 参照は相対パス。将来 GUI から追加する場合は `assets/` へコピーし、ファイル名衝突を解決する
- 高さ自動算出・縦横比保持・L015 の検査に必要な画像寸法(PNG/JPEG ヘッダ、PDF の MediaBox)は、L004 と同じ注入パターンで core へ渡す「寸法プローブ」が取得する(core 自体はファイルシステムに依存しない)

#### `deck check` によるキャンバス検証

textpos 系の絶対配置は縦にはみ出しても Overfull 警告が出ない。そのためキャンバスフレームでは `deck check` が `zref-savepos` で各オブジェクトの実測位置・寸法を aux に出力させ、機械検出する(L012 の実装方式)。

- 本文領域外へのはみ出し: warning
- オブジェクト同士の重なり: info(意図的な場合があるため、静的 lint では扱わず check の実測レポートのみ)

## 3. 生ブロック

パーサが未知の構文に遭遇したときのフォールバック。粒度の細かい順に適用する。

1. **未知コマンド**: コマンドとそれに続く引数グループ(`[...]`・`{...}` の並び)までをインライン生ブロックにする。
2. **未知環境**: `\begin{X}` から対応する `\end{X}` まで(ネストを考慮。`verbatim` 系は中身を解釈しない)をブロック生ブロックにする。
3. **解釈不能フレーム**: フレーム構造自体が読めない場合、フレーム全体を生フレームにする(一覧・並べ替えは可能)。

生ブロックの性質:

- 書き出し時はソースのまま TeX に渡る(表現力は失われない)。
- プレビューでは standalone 部分コンパイル画像(キャッシュ付き)、未コンパイル時はプレースホルダ。
- GUI では不透明な塊として選択・移動・削除のみ可能。

## 4. マクロ

- 定義場所は `%% macros:begin` 〜 `%% macros:end` のみ。それ以外の場所の定義は lint 警告とし、展開対象にしない。
- 展開対象: `\newcommand` / `\renewcommand` / `\newenvironment` のうち、本体が単純なテキスト置換(引数 `#1`〜`#9`、省略可能引数のデフォルト値 1 個まで)であるもの。
- 展開対象外(`\def` の区切り付き引数、`\expandafter`、`\ifx` 等の条件分岐、再帰): 定義はエラーにせず、その**呼び出し箇所**を生ブロックにする。
- 展開はプレビュー専用の近似。書き出しは展開前ソースをコンパイルするため、展開器の挙動差は最終出力に影響しない。
- 展開結果がサブセット内に落ちれば構造描画され、落ちなければ生ブロックになる(マクロは「透過」)。

## 5. リント規則(v1)

| ID | 内容 | 深刻度 |
|---|---|---|
| L001 | サブセット外構文(生ブロック化された箇所)の通知 | info |
| L002 | 展開不能なマクロ定義 | warning |
| L003 | マクロ定義が公認領域の外にある | warning |
| L004 | `\includegraphics` の参照先ファイルが存在しない | error |
| L005 | オーバーレイ番号の不整合(到達しないステップ等) | warning |
| L006 | プリアンブルのツール管理領域への手編集 | error |
| L007 | frame 内に verbatim 系があるのに `fragile` がない | error |
| L008 | 正規形との不一致(`--fix` で自動整形) | info |
| L009 | frame の `label` が重複している | warning |
| L010 | 同梱スキル(SKILL.md)の版が CLI の版と一致しない | warning |
| L011 | `deckcanvas` を持つ frame に一意な `label` がない | warning |
| L012 | `x`, `y`, `w` が範囲外、またはオブジェクトが本文領域外へ出る(静的には宣言値で検査。`deck check` は savepos 実測で検査する。§2.8) | warning |
| L013 | 許可されていない文字サイズ値 | error |
| L014 | `deckcanvas` 直下または `decktext` 内部に許容外の要素がある(オーバーレイ指定を含む) | warning |
| L015 | `deckimage` の形式が v1 対象外、またはファイルを読めない | error |
| L016 | `deck*` 予約名前空間の再定義 | error |
| L017 | `%% deck-source-version` の欠落、またはツールの版との不一致 | warning |
| L018 | 4:3(`aspectratio=43`)デッキでの `deckcanvas` 使用 | warning |
| L019 | キャンバスフレームのタイトルが 2 行以上(固定タイトル帯を超えて本文領域に重なる) | warning |

オブジェクト同士の重なりは意図的な場合があるため lint 対象にしない(`deck check` の実測レポートで info 表示のみ。§2.8)。

リンターとフォーマッタは CLI から実行でき、AI の生成 → lint → 修正ループを支える。

## 6. 将来拡張の候補(v1 スコープ外)

- `description` 環境、`\footnote`
- `\only` / `\uncover` 系オーバーレイ
- 発表者ノート `\note{}` と handout モード
- キャンバスオブジェクトへのオーバーレイ指定(自由配置そのものは v1.1 で §2.8 に本文化済み)
- `figure` + `\caption`
- テーマの追加(`metropolis` 等)とカスタムカラーパレット
