/**
 * 開発用簡易ビューア（Phase 4 の先行 apps/web）。
 *
 * VS-2 以降、プレビュー描画・フレーム移動・ステップ表示は packages/ui（React）へ移した。
 * apps/web は fixture 選択 / ファイルを開く / ドラッグ&ドロップ / textarea 編集という
 * 開発用 chrome を残し、LocalShellHost 経由で ui へレンダリング済み deck を流し込む。
 */

import { parseDeck } from "@beamer-editor/core";
import { type RenderedDeck, renderDeck } from "@beamer-editor/renderer";
import { mountPreview, type ShellHost } from "@beamer-editor/ui";
import "katex/dist/katex.min.css";
import { sourceJumpTarget } from "./editor-navigation.js";
import "./style.css";

const FIXTURES = ["basic.tex", "macros.tex", "kitchen-sink.tex", "canvas.tex", "styled.tex"];

const app = document.getElementById("app") as HTMLDivElement;
app.innerHTML = `
  <header>
    <strong>beamer-editor</strong><span class="tagline">dev viewer（M1 縦断スライス）</span>
    <span id="fixtures"></span>
    <label class="open-btn">ファイルを開く<input type="file" id="file-input" accept=".tex" hidden></label>
    <span id="doc-title"></span>
  </header>
  <main>
    <div id="preview-host"></div>
    <section id="editor-pane">
      <div class="pane-title">ソース（編集すると即時反映）</div>
      <textarea id="source" spellcheck="false"></textarea>
    </section>
  </main>
`;

const $ = <T extends HTMLElement>(sel: string) => app.querySelector(sel) as T;
const sourceArea = $<HTMLTextAreaElement>("#source");
const docTitleEl = $<HTMLElement>("#doc-title");
const previewHost = $<HTMLDivElement>("#preview-host");

let latestDeck: RenderedDeck = { title: "", frames: [], css: "" };
let jumpHighlightTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * ui とローカルに通信する ShellHost。textarea 由来の deck を push で listener へ流す。
 * source jump は frameIndex を最新 deck の sourceSpan へ引き当て、対象行の選択・
 * 中央スクロール・短時間ハイライトを行う（PR #14 の挙動を VS-2 構成へ移植）。
 */
class LocalShellHost implements ShellHost {
  private readonly listeners = new Set<(deck: RenderedDeck, version: number) => void>();

  subscribe(listener: (deck: RenderedDeck, version: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  jumpToSource(frameIndex: number): void {
    const frame = latestDeck.frames[frameIndex];
    if (!frame) return;
    const lineHeight = Number.parseFloat(getComputedStyle(sourceArea).lineHeight) || 18;
    const target = sourceJumpTarget(
      sourceArea.value,
      frame.sourceSpan.start,
      lineHeight,
      sourceArea.clientHeight,
    );

    sourceArea.focus({ preventScroll: true });
    sourceArea.setSelectionRange(target.selectionStart, target.selectionEnd);
    sourceArea.scrollTop = target.scrollTop;

    clearTimeout(jumpHighlightTimer);
    sourceArea.classList.remove("jump-target");
    void sourceArea.offsetWidth;
    sourceArea.classList.add("jump-target");
    jumpHighlightTimer = setTimeout(() => sourceArea.classList.remove("jump-target"), 500);
  }

  notifyActiveFrame(_frameIndex: number): void {
    // apps/web では追従先が無いので no-op。
  }

  push(deck: RenderedDeck, version: number): void {
    latestDeck = deck;
    for (const listener of this.listeners) listener(deck, version);
  }
}

const host = new LocalShellHost();
mountPreview(previewHost, host);

let version = 0;

function reparse(source: string): void {
  try {
    const deck = renderDeck(parseDeck(source));
    docTitleEl.textContent = deck.title;
    host.push(deck, ++version);
  } catch (err) {
    docTitleEl.textContent = `パースエラー: ${String(err)}`;
  }
}

async function loadFixture(name: string): Promise<void> {
  const res = await fetch(`/${name}`);
  const text = await res.text();
  sourceArea.value = text;
  reparse(text);
}

// fixture ボタン
const fixturesBox = $<HTMLElement>("#fixtures");
for (const name of FIXTURES) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = name.replace(".tex", "");
  btn.addEventListener("click", () => void loadFixture(name));
  fixturesBox.append(btn);
}

// ファイルを開く / ドラッグ&ドロップ
$<HTMLInputElement>("#file-input").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  sourceArea.value = await file.text();
  reparse(sourceArea.value);
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  sourceArea.value = await file.text();
  reparse(sourceArea.value);
});

// ソース編集 → 即時反映（打鍵ごと、軽いデバウンス）
let timer: ReturnType<typeof setTimeout> | undefined;
sourceArea.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(() => reparse(sourceArea.value), 120);
});

void loadFixture("basic.tex");
