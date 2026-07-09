# Beamer サブセット仕様 v1

ステータス: draft / 最終更新: 2026-07-10

このファイルは、人間と AI の共通言語となるソース形式(Beamer サブセット)の仕様。ツール(パーサ・フォーマッタ・リンター・プレビュー)が構文として理解する範囲を定義する。

大原則: **ここに書かれていない構文を書いてもエラーにはならない。** ツールはそれを「生ブロック」として扱い、プレビューは部分コンパイル画像に、GUI 編集は移動のみに劣化する。最終 PDF は常に完全な Beamer としてコンパイルされる。

## 1. ファイル構造

1 デッキ = 1 ファイル(`.tex`)。ソースはそのまま `tectonic` でコンパイル可能な完全な Beamer 文書である。

```latex
\documentclass[aspectratio=169]{beamer}
% ツール管理プリアンブル(テーマ・共通パッケージ)がここに入る

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

テーマ選択とパッケージはツール管理領域に入る。v1 のテーマは `default` と `metropolis` の 2 択。共通パッケージ(`graphicx`, `amsmath`, `amssymb`, `booktabs`, `hyperref` 等)はツールが自動注入する。

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

リンターとフォーマッタは CLI から実行でき、AI の生成 → lint → 修正ループを支える。

## 6. 将来拡張の候補(v1 スコープ外)

- `description` 環境、`\footnote`
- `\only` / `\uncover` 系オーバーレイ
- 発表者ノート `\note{}` と handout モード
- 自由配置(textpos 系を公認語彙として 1 方式だけ導入し、GUI ドラッグと対応付ける)
- `figure` + `\caption`
- テーマの追加とカスタムカラーパレット
