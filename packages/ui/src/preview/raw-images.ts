/**
 * 生ブロックの部分コンパイル画像(#81)。ホストから届いた PDF をラスタライズして保持し、
 * renderer のプレースホルダ(data-raw-key)にはめ込む。DOM は renderer の HTML を書き換えるだけで、
 * React の状態には持ち込まない(HTML が差し替わるたびに apply し直す)。
 */

import type { RasterImage, RawBlockImageResult } from "../shell-host.js";

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

  constructor(
    private readonly rasterize: ((pdf: Uint8Array) => Promise<RasterImage>) | undefined,
  ) {}

  get(key: string): RawImageState | undefined {
    return this.states.get(key);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** ホストからの結果を受け取る。PDF はラスタライズが終わってから ready になる。 */
  receive(key: string, result: RawBlockImageResult): void {
    if ("error" in result) {
      this.set(key, { status: "failed", message: result.error });
      return;
    }
    if (!this.rasterize) {
      this.set(key, { status: "failed", message: "このホストでは PDF を画像にできません" });
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
    this.rasterize(pdf).then(
      (image) => this.set(key, { status: "ready", image }),
      (error: unknown) =>
        this.set(key, { status: "failed", message: `PDF を画像にできません: ${String(error)}` }),
    );
  }

  private set(key: string, state: RawImageState): void {
    this.states.set(key, state);
    for (const listener of this.listeners) listener();
  }
}

/**
 * root 配下のプレースホルダに、ストアにある画像をはめ込む。ready なら中身を <img> にし、
 * failed なら箱を残して失敗の印とメッセージ(title)を付ける。何度呼んでも同じ結果になる。
 */
export function applyRawImages(root: ParentNode, store: RawImageStore): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-raw-key]")) {
    const key = element.dataset.rawKey;
    if (!key) continue;
    const state = store.get(key);
    if (!state || state.status === "pending") continue;
    if (state.status === "ready") {
      if (element.dataset.rawStatus === "ready") continue;
      const label = element.querySelector(".placeholder-label")?.textContent ?? "";
      const img = element.ownerDocument.createElement("img");
      img.className = "raw-image";
      img.src = state.image.dataUrl;
      img.alt = label;
      element.style.aspectRatio = `${state.image.width} / ${state.image.height}`;
      element.replaceChildren(img);
      element.classList.remove("failed");
      element.classList.add("compiled");
      element.dataset.rawStatus = "ready";
    } else if (element.dataset.rawStatus !== "failed") {
      element.classList.add("failed");
      element.dataset.rawStatus = "failed";
      element.dataset.rawError = state.message;
      element.title = `コンパイルに失敗しました: ${state.message}\n\n${element.title}`;
    }
  }
}
