/**
 * 生ブロックの部分コンパイル画像(#81)。ホストから届いた PDF をラスタライズして保持し、
 * renderer のプレースホルダ(data-raw-key)にはめ込む。DOM は renderer の HTML を書き換えるだけで、
 * React の状態には持ち込まない(HTML が差し替わるたびに apply し直す)。
 */

import type { RasterImage, RawBlockImageResult } from "../shell-host.js";

/** 受け取る PDF の上限(バイト)。これを超えるものは復号・ラスタライズせず失敗として箱を残す。 */
export const MAX_RAW_PDF_BYTES = 8 * 1024 * 1024;

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
  /** key ごとの受信世代。依存の更新や再試行で同じ key に複数の PDF が届くので、最新の結果だけを反映する。 */
  private readonly generations = new Map<string, number>();

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
    const generation = (this.generations.get(key) ?? 0) + 1;
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
