/**
 * AST → HTML プレビュー(Phase 4)。
 *
 * - スライドは論理サイズ固定(455.24pt × 256.07pt = 160mm × 90mm)。
 *   ホスト側が CSS transform でスケールする(design.md §4.4)。
 * - 数式は KaTeX(同期描画)。描画失敗は KaTeX のエラー表示に任せる(throwOnError: false)。
 * - オーバーレイは data-min / data-max 属性で表現し、ビューアがステップに応じて表示を切り替える。
 * - 生ブロックはプレースホルダ表示(部分コンパイル画像は Phase 6)。
 * - キャンバスの本文領域と文字サイズ実寸は Theme(theme.ts)から取る。
 *   幾何はテーマパックの実測 metrics と一致させる(docs/theme-design.md)。
 */

import type {
  BlockNode,
  DeckDocument,
  FrameNode,
  InlineNode,
  ListItemNode,
  RawFrameNode,
} from "@beamer-editor/core";
import { framesOf } from "@beamer-editor/core";
import katex from "katex";
import { DEFAULT_THEME, type Theme } from "./theme.js";

export interface RenderedFrame {
  index: number;
  label: string | null;
  titleText: string;
  html: string;
  /** オーバーレイの総ステップ数(1 なら段階表示なし)。 */
  stepCount: number;
  isRaw: boolean;
}

export interface RenderedDeck {
  title: string;
  frames: RenderedFrame[];
}

const escapeHtml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const NAMED_COLORS: Record<string, string> = {
  red: "#e74c3c",
  green: "#27ae60",
  blue: "#2e5cb8",
  cyan: "#00bcd4",
  magenta: "#d81b60",
  yellow: "#f1c40f",
  orange: "#e67e22",
  purple: "#8e44ad",
  violet: "#7c4dff",
  teal: "#00897b",
  olive: "#808000",
  brown: "#795548",
  pink: "#ec407a",
  lime: "#cddc39",
  gray: "#757575",
  darkgray: "#424242",
  lightgray: "#bdbdbd",
  black: "#000000",
  white: "#ffffff",
};

function math(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: false, output: "html" });
  } catch {
    return `<code class="math-error">${escapeHtml(tex)}</code>`;
  }
}

class FrameRenderer {
  /** 現在の \pause 通過数。要素の data-min に反映する。 */
  private pauseCount = 0;
  /** フレーム内で観測したオーバーレイの最大ステップ。 */
  private maxStep = 1;

  constructor(
    private readonly doc: DeckDocument,
    private readonly theme: Theme,
  ) {}

  private overlayAttrs(overlay: ListItemNode["overlay"]): string {
    let attrs = "";
    if (this.pauseCount > 0) attrs += ` data-min="${this.pauseCount + 1}"`;
    if (overlay) {
      const parts = overlay.ranges.map((r) => `${r.from}-${r.to === null ? "" : r.to}`);
      attrs += ` data-overlay="${parts.join(",")}"`;
      for (const r of overlay.ranges) {
        this.maxStep = Math.max(this.maxStep, r.from, r.to ?? r.from);
      }
    }
    return attrs;
  }

  renderInlines(nodes: InlineNode[]): string {
    let out = "";
    for (const node of nodes) {
      switch (node.type) {
        case "text":
          out += escapeHtml(node.value);
          break;
        case "styled": {
          const inner = this.renderInlines(node.children);
          if (node.style === "textbf") out += `<strong>${inner}</strong>`;
          else if (node.style === "emph") out += `<em>${inner}</em>`;
          else if (node.style === "textit") out += `<span class="it">${inner}</span>`;
          else if (node.style === "texttt") out += `<code>${inner}</code>`;
          else out += `<span class="alert">${inner}</span>`;
          break;
        }
        case "colorText": {
          const color = NAMED_COLORS[node.color] ?? node.color;
          out += `<span style="color:${escapeHtml(color)}">${this.renderInlines(node.children)}</span>`;
          break;
        }
        case "url":
          out += `<a class="url" href="${escapeHtml(node.url)}">${escapeHtml(node.url)}</a>`;
          break;
        case "href":
          out += `<a class="url" href="${escapeHtml(node.url)}">${this.renderInlines(node.children)}</a>`;
          break;
        case "lineBreak":
          out += "<br>";
          break;
        case "inlineMath":
          out += math(node.tex, false);
          break;
        case "rawInline":
          out += `<span class="raw-inline" title="サブセット外(生ブロック)">${escapeHtml(node.tex)}</span>`;
          break;
      }
    }
    return out;
  }

  renderBlocks(blocks: BlockNode[]): string {
    let out = "";
    for (const block of blocks) out += this.renderBlock(block);
    return out;
  }

  /**
   * \item の中身。段落を <p>(ブロック)にするとリストマーカーと本文が
   * 別の行に分かれてしまうため、段落はインラインの span として描画する。
   */
  private renderListItemChildren(blocks: BlockNode[]): string {
    let out = "";
    let prevParagraph = false;
    for (const block of blocks) {
      if (block.type === "paragraph") {
        out += `${prevParagraph ? "<br>" : ""}<span${this.overlayAttrs(null)}>${this.renderInlines(block.children)}</span>`;
        prevParagraph = true;
      } else {
        out += this.renderBlock(block);
        prevParagraph = false;
      }
    }
    return out;
  }

  private renderBlock(block: BlockNode): string {
    switch (block.type) {
      case "paragraph":
        return `<p${this.overlayAttrs(null)}>${this.renderInlines(block.children)}</p>`;
      case "list": {
        const tag = block.kind === "itemize" ? "ul" : "ol";
        const items = block.items
          .map(
            (item) =>
              `<li${this.overlayAttrs(item.overlay)}>${this.renderListItemChildren(item.children)}</li>`,
          )
          .join("");
        return `<${tag}>${items}</${tag}>`;
      }
      case "columns": {
        const cols = block.columns
          .map(
            (c) =>
              `<div class="col" style="width:${(c.width.factor * 100).toFixed(1)}%">${this.renderBlocks(c.children)}</div>`,
          )
          .join("");
        return `<div class="columns${block.topAligned ? " top" : ""}">${cols}</div>`;
      }
      case "blockEnv": {
        const kindClass =
          block.kind === "alertblock"
            ? "beamer-block alert"
            : block.kind === "exampleblock"
              ? "beamer-block example"
              : "beamer-block";
        return (
          `<div class="${kindClass}"${this.overlayAttrs(block.overlay)}>` +
          `<div class="block-title">${this.renderInlines(block.title)}</div>` +
          `<div class="block-body">${this.renderBlocks(block.children)}</div></div>`
        );
      }
      case "center":
        return `<div class="center">${this.renderBlocks(block.children)}</div>`;
      case "table": {
        const rules = block.rows.filter((r) => r.type === "tableRule").length;
        let html = `<table class="tabular${rules > 0 ? " booktabs" : ""}">`;
        for (const row of block.rows) {
          if (row.type === "tableRule") {
            html += `<tr class="rule ${row.rule}"><td colspan="${block.columns.length}"></td></tr>`;
          } else {
            html += "<tr>";
            row.cells.forEach((cell, i) => {
              const align =
                block.columns[i] === "r" ? "right" : block.columns[i] === "c" ? "center" : "left";
              html += `<td style="text-align:${align}">${this.renderInlines(cell)}</td>`;
            });
            html += "</tr>";
          }
        }
        return `${html}</table>`;
      }
      case "image": {
        const width = block.width ? `width:${(block.width.factor * 100).toFixed(1)}%` : "";
        if (block.path.toLowerCase().endsWith(".pdf")) {
          return `<div class="image-placeholder" style="${width}"${this.overlayAttrs(null)}>PDF 画像(部分コンパイルは Phase 6): ${escapeHtml(block.path)}</div>`;
        }
        return `<img src="${escapeHtml(block.path)}" style="${width}"${this.overlayAttrs(null)}>`;
      }
      case "displayMath": {
        // align 系は KaTeX では aligned 環境として描画する(& と \\ を解釈させる)
        const tex =
          block.kind === "align" || block.kind === "align*"
            ? `\\begin{aligned}${block.tex}\\end{aligned}`
            : block.tex;
        return `<div class="display-math"${this.overlayAttrs(null)}>${math(tex, true)}</div>`;
      }
      case "pause":
        this.pauseCount++;
        this.maxStep = Math.max(this.maxStep, this.pauseCount + 1);
        return "";
      case "titlePage":
        return this.renderTitlePage();
      case "tableOfContents":
        return this.renderToc();
      case "canvas": {
        const { slideWidthPt, slideHeightPt, bodyAreaPt: body } = this.theme.metrics;
        const left = (body.left / slideWidthPt) * 100;
        const top = (body.top / slideHeightPt) * 100;
        const width = (body.width / slideWidthPt) * 100;
        const height = (body.height / slideHeightPt) * 100;
        let html = `<div class="canvas" style="left:${left.toFixed(3)}%;top:${top.toFixed(3)}%;width:${width.toFixed(3)}%;height:${height.toFixed(3)}%">`;
        for (const item of block.items) {
          const posStyle = (x: number, y: number, w: number) =>
            `left:${(x * 100).toFixed(2)}%;top:${(y * 100).toFixed(2)}%;width:${(w * 100).toFixed(2)}%`;
          if (item.type === "canvasText") {
            html += `<div class="canvas-item canvas-text" style="${posStyle(item.position.x, item.position.y, item.position.width)};font-size:${this.theme.fontSizesPt[item.size]}pt">${this.renderBlocks(item.children)}</div>`;
          } else if (item.type === "canvasImage") {
            if (item.path.toLowerCase().endsWith(".pdf")) {
              html += `<div class="canvas-item image-placeholder" style="${posStyle(item.position.x, item.position.y, item.position.width)}">PDF 画像: ${escapeHtml(item.path)}</div>`;
            } else {
              html += `<img class="canvas-item" src="${escapeHtml(item.path)}" style="${posStyle(item.position.x, item.position.y, item.position.width)}">`;
            }
          } else {
            html += `<div class="canvas-item raw-block"><pre>${escapeHtml(item.tex)}</pre></div>`;
          }
        }
        return `${html}</div>`;
      }
      case "rawBlock":
        return (
          `<div class="raw-block"${this.overlayAttrs(null)}><div class="raw-badge">サブセット外${block.environment ? `: ${escapeHtml(block.environment)}` : ""}(プレビューは Phase 6 で部分コンパイル画像に)</div>` +
          `<pre>${escapeHtml(block.tex)}</pre></div>`
        );
    }
  }

  private metaText(field: { value: InlineNode[] } | undefined): string {
    return field ? this.renderInlines(field.value) : "";
  }

  private renderTitlePage(): string {
    const m = this.doc.metadata;
    return (
      '<div class="titlepage">' +
      `<div class="tp-title">${this.metaText(m.title)}</div>` +
      (m.subtitle ? `<div class="tp-subtitle">${this.metaText(m.subtitle)}</div>` : "") +
      (m.author ? `<div class="tp-author">${this.metaText(m.author)}</div>` : "") +
      (m.institute ? `<div class="tp-institute">${this.metaText(m.institute)}</div>` : "") +
      (m.date ? `<div class="tp-date">${this.metaText(m.date)}</div>` : "") +
      "</div>"
    );
  }

  private renderToc(): string {
    const items = this.doc.body
      .filter((el) => el.type === "section")
      .map((s) => `<li class="${s.level}">${this.renderInlines(s.title)}</li>`)
      .join("");
    return `<ol class="toc">${items}</ol>`;
  }

  renderFrame(frame: FrameNode): { html: string; stepCount: number } {
    this.pauseCount = 0;
    this.maxStep = 1;
    const body = this.renderBlocks(frame.body);
    const title =
      frame.title && frame.title.length > 0
        ? `<div class="frametitle">${this.renderInlines(frame.title)}</div>`
        : "";
    return {
      html: `<div class="slide${frame.options.plain ? " plain" : ""}">${title}<div class="slide-body">${body}</div></div>`,
      stepCount: this.maxStep,
    };
  }

  renderRawFrame(frame: RawFrameNode): string {
    return (
      '<div class="slide raw-frame">' +
      `<div class="frametitle">${escapeHtml(frame.title ?? "(生フレーム)")}</div>` +
      '<div class="slide-body"><div class="raw-block"><div class="raw-badge">解釈不能フレーム(一覧・並べ替えのみ可能。プレビューは Phase 6 で画像に)</div>' +
      `<pre>${escapeHtml(frame.tex)}</pre></div></div></div>`
    );
  }
}

function inlineToPlain(nodes: InlineNode[]): string {
  let out = "";
  for (const n of nodes) {
    switch (n.type) {
      case "text":
        out += n.value;
        break;
      case "styled":
      case "colorText":
      case "href":
        out += inlineToPlain(n.children);
        break;
      case "url":
        out += n.url;
        break;
      case "inlineMath":
        out += `$${n.tex}$`;
        break;
      case "rawInline":
        out += n.tex;
        break;
      case "lineBreak":
        out += " ";
        break;
    }
  }
  return out;
}

/** デッキ全体を描画する。 */
export function renderDeck(doc: DeckDocument, theme: Theme = DEFAULT_THEME): RenderedDeck {
  const renderer = new FrameRenderer(doc, theme);
  const frames: RenderedFrame[] = framesOf(doc).map((frame, i) => {
    if (frame.type === "rawFrame") {
      return {
        index: i + 1,
        label: frame.label,
        titleText: frame.title ?? `frame ${i + 1}`,
        html: renderer.renderRawFrame(frame),
        stepCount: 1,
        isRaw: true,
      };
    }
    const { html, stepCount } = renderer.renderFrame(frame);
    const titleText =
      frame.title && frame.title.length > 0 ? inlineToPlain(frame.title) : `frame ${i + 1}`;
    return {
      index: i + 1,
      label: frame.options.label,
      titleText,
      html,
      stepCount,
      isRaw: false,
    };
  });
  return {
    title: doc.metadata.title ? inlineToPlain(doc.metadata.title.value) : "(無題のデッキ)",
    frames,
  };
}
