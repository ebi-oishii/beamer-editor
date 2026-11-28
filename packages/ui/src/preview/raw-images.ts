/**
 * 生ブロックの部分コンパイル画像(#81)。ホストから届いた PDF をラスタライズして保持し、
 * renderer のプレースホルダ(data-raw-key)にはめ込む。DOM は renderer の HTML を書き換えるだけで、
 * React の状態には持ち込まない(HTML が差し替わるたびに apply し直す)。
 */

import type { RasterImage, RawBlockImageResult } from "../shell-host.js";

/** 受け取る PDF の上限(バイト)。これを超えるものは復号・ラスタライズせず失敗として箱を残す。 */
export const MAX_RAW_PDF_BYTES = 8 * 1024 * 1024;
/** PDF.js viewport は bp(72/in)、プレビューの論理 CSS は TeX pt(72.27/in)。 */
const PDF_BP_TO_TEX_PT = 72.27 / 72;

export type RawImageState =
  | { status: "pending" }
  | { status: "ready"; image: RasterImage }
  | { status: "failed"; message: string };

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class RawImageStore {
  private readonly states = new Map<string, RawImageState>();
  private readonly listeners = new Set<() => void>();
  /** key ごとの受信トークン。削除後の同じ key への再受信でも古い非同期結果を無効にする。 */
  private readonly generations = new Map<string, object>();

  constructor(
    private readonly rasterize: ((pdf: Uint8Array) => Promise<RasterImage>) | undefined,
  ) {}

  get(key: string): RawImageState | undefined {
    return this.states.get(key);
  }

  /** 今の描画に含まれない key の画像を捨てる(中間 key の data URL が溜まり続けない)。 */
  retain(keys: ReadonlySet<string>): void {
    for (const key of this.states.keys()) {
      if (keys.has(key)) continue;
      this.states.delete(key);
      this.generations.delete(key);
    }
  }

  /** 部分コンパイルを切ったときなど、差し込み済みの画像を全部捨てる。 */
  clear(): void {
    if (this.states.size === 0 && this.generations.size === 0) return;
    this.states.clear();
    this.generations.clear();
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** ホストからの結果を受け取る。PDF はラスタライズが終わってから ready になる。 */
  receive(key: string, result: RawBlockImageResult): void {
    const generation = {};
    this.generations.set(key, generation);
    const latest = () => this.generations.get(key) === generation;
    if ("error" in result) {
      this.set(key, { status: "failed", message: result.error });
      return;
    }
    if (!this.rasterize) {
      this.set(key, { status: "failed", message: "このホストでは PDF を画像にできません" });
      return;
    }
    // base64 は 3 バイトを 4 文字にするので、復号せずに大きさを判定できる。
    if (result.pdfBase64.length > Math.ceil(MAX_RAW_PDF_BYTES / 3) * 4) {
      this.set(key, {
        status: "failed",
        message: `PDF が大きすぎます(上限 ${MAX_RAW_PDF_BYTES / 1024 / 1024} MB)`,
      });
      return;
    }
    this.set(key, { status: "pending" });
    let pdf: Uint8Array;
    try {
      pdf = decodeBase64(result.pdfBase64);
    } catch (error) {
      this.set(key, { status: "failed", message: `PDF を読めません: ${String(error)}` });
      return;
    }
    // ラスタライズの完了順は届いた順と逆になりうる。古い結果で新しい結果を上書きしない。
    this.rasterize(pdf).then(
      (image) => {
        if (latest()) this.set(key, { status: "ready", image });
      },
      (error: unknown) => {
        if (latest())
          this.set(key, { status: "failed", message: `PDF を画像にできません: ${String(error)}` });
      },
    );
  }

  private set(key: string, state: RawImageState): void {
    this.states.set(key, state);
    for (const listener of this.listeners) listener();
  }
}

const originals = new WeakMap<
  HTMLElement,
  { html: string; aspect: string; width: string; title: string }
>();
const pdfOpeners = new WeakMap<HTMLElement, ((frameIndex: number) => void) | undefined>();

function rememberPlaceholder(element: HTMLElement): void {
  originals.set(element, {
    html: element.innerHTML,
    aspect: element.style.aspectRatio,
    width: element.style.width,
    title: element.title,
  });
}

/** Restore the renderer's own fallback, including inline KaTeX and figure dimensions. */
function restorePlaceholder(element: HTMLElement): void {
  const original = originals.get(element);
  pdfOpeners.delete(element);
  if (original) {
    element.innerHTML = original.html;
    element.style.aspectRatio = original.aspect;
    if (element.dataset.rawNaturalWidth === "true") element.style.width = original.width;
    element.title = original.title;
    originals.delete(element);
  }
  element.classList.remove("compiled", "failed");
  delete element.dataset.rawStatus;
  delete element.dataset.rawError;
}

function markFragment(
  element: HTMLElement,
  status: "ready" | "failed" | "context",
  message: string,
  openPdf?: (frameIndex: number) => void,
): void {
  element.dataset.rawStatus = status;
  element.title = `${message}\n\n${originals.get(element)?.title ?? ""}`;
  if (status === "ready") return;
  element.dataset.rawError = message;
  if (!openPdf) return;
  pdfOpeners.set(element, openPdf);
  if (!element.closest(".slide-card[data-index]")) return;
  if (element.querySelector(".raw-pdf")) return;
  const button = element.ownerDocument.createElement("button");
  button.type = "button";
  button.className = "raw-pdf";
  button.textContent = "PDF確認";
  button.title = message;
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const frameIndex = Number(element.closest<HTMLElement>(".slide-card")?.dataset.index);
    if (Number.isSafeInteger(frameIndex)) pdfOpeners.get(element)?.(frameIndex);
  });
  element.append(button);
}

/**
 * root 配下のプレースホルダに、ストアにある画像をはめ込む。ready なら中身を <img> にし、
 * failed なら箱を残して失敗の印とメッセージ(title)を付ける。状態が無ければ差し込みを戻す。
 * 何度呼んでも同じ結果になる。
 */
export function applyRawImages(
  root: ParentNode,
  store: RawImageStore,
  openPdf?: (frameIndex: number) => void,
): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-raw-key], [data-raw-context]")) {
    const key = element.dataset.rawKey;
    const context = element.dataset.rawContext === "true";
    const state = key ? store.get(key) : undefined;
    if (context) {
      if (element.dataset.rawStatus !== "context") {
        rememberPlaceholder(element);
        markFragment(element, "context", "文書全体の組版が必要です。", openPdf);
      } else if (openPdf) pdfOpeners.set(element, openPdf);
      continue;
    }
    if (!state || state.status === "pending") {
      restorePlaceholder(element);
      continue;
    }
    const inline = element.dataset.rawInline === "true";
    const math = element.classList.contains("math-fragment");
    const inlineBox = state.status === "ready" ? state.image.mathBox : undefined;
    const failure =
      state.status === "failed"
        ? state.message
        : inline && !inlineBox
          ? "インライン数式の寸法とベースラインを取得できませんでした。"
          : undefined;
    const status = failure === undefined ? "ready" : "failed";
    if (element.dataset.rawStatus === status && element.dataset.rawError === failure) {
      if (openPdf) pdfOpeners.set(element, openPdf);
      continue;
    }
    restorePlaceholder(element);
    rememberPlaceholder(element);
    if (failure !== undefined) {
      element.classList.add("failed");
      markFragment(element, "failed", failure, openPdf);
      continue;
    }
    if (state.status === "ready") {
      const label =
        element.querySelector(".placeholder-label")?.textContent ?? element.textContent ?? "";
      const img = element.ownerDocument.createElement("img");
      img.className = "raw-image";
      img.src = state.image.dataUrl;
      img.alt = label;
      if (inline && inlineBox) {
        // The fragment was measured at 10pt; em scales with the local text size.
        img.style.width = `${inlineBox.width / 10}em`;
        img.style.height = `${(inlineBox.height + inlineBox.depth) / 10}em`;
        img.style.verticalAlign = `${-inlineBox.depth / 10}em`;
      } else if (math && state.image.widthPt !== undefined) {
        img.style.width = `${state.image.widthPt * PDF_BP_TO_TEX_PT}pt`;
      } else {
        element.style.aspectRatio = `${state.image.width} / ${state.image.height}`;
      }
      if (element.dataset.rawNaturalWidth === "true") {
        const natural = state.image.widthPt;
        const body = Number(element.dataset.rawBodyWidthPt);
        if (
          typeof natural === "number" &&
          Number.isFinite(natural) &&
          natural > 0 &&
          Number.isFinite(body) &&
          body > 0
        ) {
          element.style.width = `${Math.min(natural * PDF_BP_TO_TEX_PT, body)}pt`;
        }
      }
      element.replaceChildren(img);
      element.classList.remove("failed");
      element.classList.add("compiled");
      markFragment(element, "ready", "部分コンパイルで表示しています。");
    }
  }
}
