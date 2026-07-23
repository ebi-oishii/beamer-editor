/**
 * 開発用簡易ビューア(Phase 4 の先行 apps/web)。
 * fixture の読み込み / ファイルを開く / ソース編集の即時反映 / スライド一覧 /
 * オーバーレイのステップスライダーを提供する。
 */

import { parseDeck } from "@beamer-editor/core";
import { type RenderedDeck, renderDeck } from "@beamer-editor/renderer";
import "katex/dist/katex.min.css";
import { sourceJumpTarget } from "./editor-navigation.js";
import "./style.css";

const FIXTURES = ["basic.tex", "macros.tex", "kitchen-sink.tex", "canvas.tex", "styled.tex"];

// %% style 領域から生成された CSS(deck.css)の注入先
const deckStyleEl = document.createElement("style");
document.head.append(deckStyleEl);

const app = document.getElementById("app") as HTMLDivElement;
app.innerHTML = `
  <header>
    <strong>beamer-editor</strong><span class="tagline">dev viewer(M1 縦断スライス)</span>
    <span id="fixtures"></span>
    <label class="open-btn">ファイルを開く<input type="file" id="file-input" accept=".tex" hidden></label>
    <span id="doc-title"></span>
  </header>
  <main>
    <aside id="slide-list"></aside>
    <section id="stage">
      <div id="slide-holder"></div>
      <div id="controls">
        <button id="prev">◀</button>
        <span id="frame-indicator"></span>
        <button id="next">▶</button>
        <span id="step-box" hidden>
          <label>step <input type="range" id="step" min="1" max="1" value="1"></label>
          <span id="step-indicator"></span>
        </span>
      </div>
    </section>
    <section id="editor-pane">
      <div class="pane-title">ソース(編集すると即時反映)</div>
      <textarea id="source" spellcheck="false"></textarea>
    </section>
  </main>
`;

const $ = <T extends HTMLElement>(sel: string) => app.querySelector(sel) as T;
const sourceArea = $<HTMLTextAreaElement>("#source");
const slideList = $<HTMLElement>("#slide-list");
const slideHolder = $<HTMLDivElement>("#slide-holder");
const stepInput = $<HTMLInputElement>("#step");

let deck: RenderedDeck = { title: "", frames: [], css: "" };
let current = 0;
let step = 1;
let jumpHighlightTimer: ReturnType<typeof setTimeout> | undefined;

function applyOverlay(root: HTMLElement, currentStep: number): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-min]")) {
    const min = Number(el.dataset.min);
    el.classList.toggle("covered", currentStep < min);
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-overlay]")) {
    const visible = (el.dataset.overlay as string).split(",").some((part) => {
      const [from, to] = part.split("-");
      const f = Number(from);
      const t = to === "" || to === undefined ? Number.POSITIVE_INFINITY : Number(to);
      return currentStep >= f && currentStep <= t;
    });
    el.classList.toggle("covered", !visible);
  }
}

function showFrame(index: number, keepStep = false): void {
  current = Math.max(0, Math.min(index, deck.frames.length - 1));
  const frame = deck.frames[current];
  if (!frame) {
    slideHolder.innerHTML = '<div class="empty">フレームがありません</div>';
    return;
  }
  if (!keepStep) step = 1;
  slideHolder.innerHTML = `<div class="slide-scale">${frame.html}</div>`;
  fitSlide();
  applyOverlay(slideHolder, step);

  $<HTMLElement>("#frame-indicator").textContent =
    `${frame.index} / ${deck.frames.length}${frame.label ? `(label=${frame.label})` : ""}`;
  const stepBox = $<HTMLElement>("#step-box");
  stepBox.hidden = frame.stepCount <= 1;
  stepInput.max = String(frame.stepCount);
  stepInput.value = String(step);
  $<HTMLElement>("#step-indicator").textContent = `${step}/${frame.stepCount}`;
  for (const el of slideList.querySelectorAll(".thumb")) {
    el.classList.toggle("active", Number((el as HTMLElement).dataset.index) === current);
  }
}

function jumpToCurrentFrameSource(): void {
  const frame = deck.frames[current];
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
  jumpHighlightTimer = setTimeout(() => sourceArea.classList.remove("jump-target"), 900);
}

function fitSlide(): void {
  const scaleBox = slideHolder.querySelector<HTMLElement>(".slide-scale");
  if (!scaleBox) return;
  const slide = scaleBox.querySelector<HTMLElement>(".slide");
  const slideW = slide?.offsetWidth ?? 607;
  const slideH = slide?.offsetHeight ?? 341;
  const availW = slideHolder.clientWidth - 24;
  const availH = slideHolder.clientHeight - 24;
  const scale = Math.min(availW / slideW, availH / slideH, 1.6);
  scaleBox.style.transform = `scale(${scale})`;
  // transform はレイアウト寸法を変えないため、見た目サイズを明示して中央寄せとはみ出しを正す
  scaleBox.style.width = `${slideW * scale}px`;
  scaleBox.style.height = `${slideH * scale}px`;
}

function rebuildList(): void {
  slideList.innerHTML = "";
  deck.frames.forEach((frame, i) => {
    const item = document.createElement("div");
    item.className = "thumb";
    item.dataset.index = String(i);
    item.innerHTML = `<div class="thumb-scale">${frame.html}</div><div class="thumb-label">${frame.index}. ${
      frame.titleText
    }${frame.isRaw ? " ⚠" : ""}</div>`;
    item.addEventListener("click", () => showFrame(i));
    slideList.append(item);
    applyOverlay(item, 99); // 一覧は全ステップ表示
  });
}

function reparse(source: string, resetTo = 0): void {
  try {
    deck = renderDeck(parseDeck(source));
    deckStyleEl.textContent = deck.css;
    $<HTMLElement>("#doc-title").textContent = deck.title;
    rebuildList();
    showFrame(resetTo, resetTo === current);
  } catch (err) {
    slideHolder.innerHTML = `<div class="empty">パースエラー: ${String(err)}</div>`;
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

// ソース編集 → 即時反映(打鍵ごと、軽いデバウンス)
let timer: ReturnType<typeof setTimeout> | undefined;
sourceArea.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(() => reparse(sourceArea.value, current), 120);
});

// ナビゲーション
$<HTMLButtonElement>("#prev").addEventListener("click", () => showFrame(current - 1));
$<HTMLButtonElement>("#next").addEventListener("click", () => showFrame(current + 1));
stepInput.addEventListener("input", () => {
  step = Number(stepInput.value);
  const frame = deck.frames[current];
  $<HTMLElement>("#step-indicator").textContent = `${step}/${frame?.stepCount ?? 1}`;
  applyOverlay(slideHolder, step);
});
slideHolder.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || event.detail !== 2) return;
  event.preventDefault();
  jumpToCurrentFrameSource();
});
document.addEventListener("keydown", (e) => {
  if (e.target === sourceArea) return;
  if (e.key === "ArrowLeft") showFrame(current - 1);
  if (e.key === "ArrowRight") showFrame(current + 1);
});
window.addEventListener("resize", fitSlide);

void loadFixture("basic.tex");
