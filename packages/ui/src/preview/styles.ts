/**
 * プレビュー描画に必要な CSS を文字列で保持する。
 *
 * apps/web/style.css からスライド・縦一列表示・step 操作・オーバーレイの
 * 描画に必要な部分だけを抜き出し、id セレクタを ui のクラス名へ置き換えたもの。
 * header / textarea / 左右ペインなど apps/web 固有の chrome は含めない。
 * vite / esbuild の css-loader 差を避けるため CSS は文字列で持ち、mountPreview が注入する。
 * KaTeX の CSS はホスト側が読み込む（ui は持たない）。
 */

export const PREVIEW_CSS = `
.beamer-preview {
  display: flex;
  flex-direction: column;
  flex: 1;
  /* ホスト(#app / #preview-host)は横方向 flex。min-width: auto のままだとカード幅に
     引っ張られて広がり、幅合わせの倍率が膨らみ続けるので 0 にする。 */
  min-width: 0;
  min-height: 0;
  height: 100%;
  box-sizing: border-box;
  font-family: var(--vscode-font-family, -apple-system, "Helvetica Neue", Arial, sans-serif);
  color: var(--vscode-foreground, #333);
}
.beamer-preview :focus-visible {
  outline: 2px solid var(--vscode-focusBorder, #3344b3);
  outline-offset: -2px;
}
.beamer-preview * {
  box-sizing: border-box;
}

/* 全フレームを縦一列に並べるスクロール領域(Marp のプレビューと同じ読み方)。
   padding は SlideScroll.tsx の SCROLL_PADDING と揃える。下端の余白は末尾フレームも
   上端まで送れるよう SlideScroll が inline style で伸ばす。 */
.slide-scroll {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  background: var(--vscode-editor-background, #e9e9ee);
}
.slide-card {
  width: fit-content;
  margin: 0 auto 16px;
  padding: 4px;
  border-radius: 6px;
  outline: 2px solid transparent;
  cursor: pointer;
}
.slide-card.active {
  outline-color: var(--vscode-focusBorder, #3344b3);
  background: var(--vscode-list-activeSelectionBackground, #e8eaf9);
}
/* 外側は見た目の scaled size、内側(.slide-scale)は論理サイズのまま transform する。
   transform のはみ出しは外側で閉じ、影も外側に持たせる(#58 の移植)。 */
.slide-layout {
  overflow: hidden;
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.25);
}
.slide-scale {
  transform-origin: top left;
}
.slide-layout .slide {
  box-shadow: none;
}
/* キャプションはスライド幅に収めて省略する(幅 0 + min-width でカード幅を広げない)。 */
.slide-caption {
  width: 0;
  min-width: 100%;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #444);
  padding: 4px 2px 0;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 現在フレームの step 操作だけをスクロール領域の直下にコンパクトに置く。 */
.step-control {
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  justify-content: center;
  margin: 8px;
  padding: 4px 8px;
  border: 1px solid var(--vscode-panel-border, #ddd);
  border-radius: 4px;
  background: var(--vscode-editorWidget-background, #fafafa);
  font-size: 13px;
}
.step-control label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.step-indicator {
  font-variant-numeric: tabular-nums;
}
.empty {
  color: var(--vscode-descriptionForeground, #999);
  padding: 40px;
}

/* 「自由配置にする」の候補をブラウザの dev tools 風に示す強調。
   メニュー項目のホバー / フォーカスに合わせて移る。 */
.slide .flow-target {
  outline: 2px solid var(--vscode-focusBorder, #3344b3);
  outline-offset: 1pt;
  background: rgba(51, 68, 179, 0.12);
}
.context-menu {
  position: fixed;
  z-index: 10;
  min-width: 220px;
  padding: 4px 0;
  background: var(--vscode-menu-background, #fff);
  color: var(--vscode-menu-foreground, #333);
  border: 1px solid var(--vscode-menu-border, #ccc);
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  font-size: 13px;
}
.context-menu button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 5px 12px;
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.context-menu button:hover,
.context-menu button:focus {
  background: var(--vscode-menu-selectionBackground, #e8eaf9);
  color: var(--vscode-menu-selectionForeground, inherit);
}

/* オーバーレイ: 非表示ステップは場所を保ったまま隠す（beamer の covered 相当） */
.covered {
  visibility: hidden;
}

/* ---- スライド（beamer default テーマの近似） ---- */
/* 論理サイズは実寸どおり pt で持ち、transform でスケールする（design.md §4.4） */
.slide {
  position: relative;
  /* 自前の stacking context にして、ロゴ・フッター(z-index: -1)を背景の上・本文の下に置く。 */
  isolation: isolate;
  width: 455.24pt;
  height: 256.07pt;
  background: var(--deck-background, #fff);
  color: var(--deck-text, #000);
  font-family: var(--deck-font-main, -apple-system, "Helvetica Neue", Arial, sans-serif);
  font-size: 11pt;
  line-height: 1.24;
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.25);
  overflow: hidden;
  flex-shrink: 0;
}
.slide .frametitle {
  color: var(--deck-structure, #3333b3);
  font-size: 14.4pt;
  padding: 5.5pt 8.6pt 0;
  min-height: 19.06pt;
}
.slide .slide-body {
  padding: 4pt 28.45pt 0;
}
.slide.plain .slide-body {
  padding-top: 12pt;
}

.slide p {
  margin: 0 0 6pt;
}
.slide li {
  margin-bottom: 2.5pt;
}
.slide img {
  max-width: 100%;
}
.slide .it {
  font-style: italic;
}
.slide code {
  font-family: var(--deck-font-mono, "SF Mono", ui-monospace, Menlo, monospace);
  font-size: 0.92em;
}
.slide .alert {
  color: var(--deck-alert, #c0392b);
}
.slide a.url {
  color: #2e5cb8;
  text-decoration: none;
}

.slide ul,
.slide ol {
  margin: 0 0 6pt;
  padding-left: 16pt;
}
.slide ul {
  list-style: none;
}
.slide ul > li::before {
  content: "\\25b8";
  color: var(--deck-structure, #3333b3);
  display: inline-block;
  width: 10pt;
  margin-left: -10pt;
}
.slide ol {
  counter-reset: enum;
  list-style: none;
}
.slide ol > li {
  counter-increment: enum;
}
.slide ol > li::before {
  content: counter(enum) ".";
  color: var(--deck-structure, #3333b3);
  display: inline-block;
  width: 12pt;
  margin-left: -12pt;
}
.slide .columns {
  display: flex;
  gap: 4%;
  align-items: center;
}
.slide .columns.top {
  align-items: flex-start;
}

.slide .beamer-block {
  margin-bottom: 7pt;
}
.slide .beamer-block .block-title {
  color: var(--deck-structure, #3333b3);
  font-weight: 600;
}
.slide .beamer-block.alert .block-title {
  color: var(--deck-alert, #c0392b);
}
.slide .beamer-block.example .block-title {
  color: var(--deck-example, #1e8449);
}
.slide .beamer-block .block-body {
  margin-top: 1pt;
}

.slide .center {
  text-align: center;
}
.slide .center img {
  display: inline-block;
}

.slide table.tabular {
  border-collapse: collapse;
  margin: 0 auto;
  font-size: inherit;
}
.slide table.tabular td {
  padding: 2pt 6pt;
}
.slide tr.rule td {
  padding: 0;
  height: 0;
}
.slide tr.rule.toprule td,
.slide tr.rule.bottomrule td {
  border-top: 1pt solid #000;
}
.slide tr.rule.midrule td {
  border-top: 0.5pt solid #000;
}

.slide .display-math {
  text-align: center;
  margin: 4pt 0 8pt;
}

.slide .titlepage {
  text-align: center;
  padding-top: 40pt;
}
.slide .tp-title {
  color: var(--deck-structure, #3333b3);
  font-size: 16pt;
  margin-bottom: 6pt;
}
.slide .tp-subtitle {
  color: var(--deck-structure, #3333b3);
  font-size: 11pt;
  margin-bottom: 18pt;
}
.slide .tp-author {
  font-size: 11pt;
  margin-bottom: 12pt;
}
.slide .tp-institute {
  font-size: 9pt;
  color: #444;
  margin-bottom: 12pt;
}
.slide .tp-date {
  font-size: 10pt;
}

.slide ol.toc {
  padding-left: 24pt;
}
.slide ol.toc li.subsection {
  padding-left: 14pt;
  font-size: 0.9em;
}

/* ---- 生ブロックのプレースホルダ ---- */
.slide .raw-block {
  border: 1.2pt dashed #b58900;
  background: #fdf6e3;
  border-radius: 3pt;
  margin: 3pt 0;
  max-width: 100%;
  overflow: hidden;
}
.slide .raw-badge {
  font-size: 6.5pt;
  color: #8a6d00;
  background: #f5e9c8;
  padding: 1.5pt 5pt;
}
.slide .raw-block pre {
  margin: 0;
  padding: 3pt 5pt;
  font-size: 7pt;
  line-height: 1.35;
  font-family: "SF Mono", ui-monospace, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 130pt;
  overflow: hidden;
}
.slide .raw-inline {
  background: #fdf6e3;
  outline: 0.6pt dashed #b58900;
  border-radius: 2pt;
  font-family: "SF Mono", ui-monospace, Menlo, monospace;
  font-size: 0.85em;
  padding: 0 2pt;
}
.slide .image-placeholder {
  border: 1.2pt dashed #7f8c8d;
  background: #eceff1;
  color: #546e7a;
  font-size: 7.5pt;
  padding: 8pt 6pt;
  text-align: center;
  border-radius: 3pt;
}

/* ---- キャンバス（subset-spec §2.8）---- */
.slide .canvas {
  position: absolute;
}
.slide .canvas-item {
  position: absolute;
  margin: 0;
}
/* テキスト箱はドラッグ移動の対象なので、ドラッグ開始が文字選択に化けないようにする。 */
.slide .canvas-editable { cursor: grab; touch-action: none; user-select: none; }
.slide .canvas-editable.canvas-selected { outline: 2px solid #2e5cb8; outline-offset: 2px; }
.slide .canvas-editable.canvas-dragging { cursor: grabbing; }
.slide .canvas-text p {
  margin: 0;
}
.slide .canvas-text ul,
.slide .canvas-text ol {
  margin: 0;
}
.slide img.canvas-item {
  max-width: none;
}

/* ---- スタイル語彙のロゴ・フッター（theme-design.md §2）----
   本文(.frametitle / .slide-body)は position を持たせない。.slide-body を包含ブロックに
   すると、絶対配置の .canvas の top / height % が .slide ではなく高さ数 px の
   .slide-body 基準で解決され、キャンバス要素の縦位置が潰れる。 */
.slide .deck-logo {
  position: absolute;
  z-index: -1;
}
.slide .deck-footer {
  position: absolute;
  z-index: -1;
  left: 6.25%;
  right: 6.25%;
  bottom: 2pt;
  display: flex;
  justify-content: space-between;
  font-size: 6pt;
  color: #808080;
}
`;
