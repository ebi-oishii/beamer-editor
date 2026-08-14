/**
 * プレビュー描画に必要な CSS を文字列で保持する。
 *
 * apps/web/style.css からスライド・サムネイル・ステージ・コントロール・オーバーレイの
 * 描画に必要な部分だけを抜き出し、id セレクタを ui のクラス名へ置き換えたもの。
 * header / textarea / 左右ペインなど apps/web 固有の chrome は含めない。
 * vite / esbuild の css-loader 差を避けるため CSS は文字列で持ち、mountPreview が注入する。
 * KaTeX の CSS はホスト側が読み込む（ui は持たない）。
 */

export const PREVIEW_CSS = `
.beamer-preview {
  display: flex;
  flex: 1;
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

.slide-list {
  width: 190px;
  overflow-y: auto;
  border-right: 1px solid var(--vscode-panel-border, #ddd);
  padding: 8px;
  background: var(--vscode-sideBar-background, #f4f4f6);
}
.thumb {
  cursor: pointer;
  margin-bottom: 10px;
  border-radius: 4px;
  padding: 3px;
}
.thumb.active {
  outline: 2px solid var(--vscode-focusBorder, #3344b3);
  background: var(--vscode-list-activeSelectionBackground, #e8eaf9);
}
.thumb-scale {
  width: 160px;
  height: 90px;
  overflow: hidden;
  position: relative;
  border: 1px solid var(--vscode-panel-border, #ccc);
  background: #fff;
}
.thumb-label {
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #444);
  padding: 2px 2px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stage {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--vscode-editor-background, #e9e9ee);
}
.slide-holder {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 12px;
  display: flex;
  align-items: flex-start;
}
.slide-layout {
  margin-left: auto;
  margin-right: auto;
  flex: 0 0 auto;
}
.slide-scale {
  transform-origin: top left;
}
.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  justify-content: center;
  padding: 8px;
  border-top: 1px solid var(--vscode-panel-border, #ddd);
  background: var(--vscode-editorWidget-background, #fafafa);
  font-size: 13px;
}
.zoom-box,
.step-box {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.zoom-indicator {
  min-width: 72px;
  text-align: center;
}
.controls button {
  border: 1px solid var(--vscode-button-border, #bbb);
  background: var(--vscode-button-secondaryBackground, #fff);
  color: var(--vscode-button-secondaryForeground, inherit);
  border-radius: 4px;
  padding: 2px 12px;
  cursor: pointer;
}
.controls button:hover {
  background: var(--vscode-button-secondaryHoverBackground, #eef);
}
.empty {
  color: var(--vscode-descriptionForeground, #999);
  padding: 40px;
}

/* オーバーレイ: 非表示ステップは場所を保ったまま隠す（beamer の covered 相当） */
.covered {
  visibility: hidden;
}

/* ---- スライド（beamer default テーマの近似） ---- */
/* 論理サイズは実寸どおり pt で持ち、transform でスケールする（design.md §4.4） */
.slide {
  position: relative;
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
.thumb-scale .slide {
  transform: scale(0.264);
  transform-origin: top left;
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
.slide .canvas-editable { cursor: grab; touch-action: none; }
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

/* ---- スタイル語彙のロゴ・フッター（theme-design.md §2）---- */
.slide .frametitle,
.slide .slide-body {
  position: relative;
  z-index: 1;
}
.slide .deck-logo {
  position: absolute;
  z-index: 0;
}
.slide .deck-footer {
  position: absolute;
  z-index: 0;
  left: 6.25%;
  right: 6.25%;
  bottom: 2pt;
  display: flex;
  justify-content: space-between;
  font-size: 6pt;
  color: #808080;
}
`;
