// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  applyRawImages,
  decodeBase64,
  MAX_RAW_PDF_BYTES,
  RawImageStore,
} from "../src/preview/raw-images.js";

const PDF_B64 = btoa("%PDF-1.7 fake");

function placeholderRoot(key: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `<div class="raw-block placeholder" data-raw-key="${key}" style="width:60.0%;aspect-ratio:4 / 3" title="\\begin{tikzpicture}"><span class="placeholder-label">tikzpicture</span></div>`;
  return root;
}

describe("RawImageStore / applyRawImages", () => {
  it("PDF を受け取るとラスタライズして ready になり、箱の中身が画像になる", async () => {
    const rasterize = vi.fn(async (pdf: Uint8Array) => {
      expect(Array.from(pdf)).toEqual(Array.from(new TextEncoder().encode("%PDF-1.7 fake")));
      return { dataUrl: "data:image/png;base64,AAAA", width: 400, height: 300 };
    });
    const store = new RawImageStore(rasterize);
    const changed = vi.fn();
    store.subscribe(changed);
    store.receive("k1", { pdfBase64: PDF_B64 });
    expect(store.get("k1")).toEqual({ status: "pending" });
    await vi.waitFor(() => expect(store.get("k1")?.status).toBe("ready"));
    expect(changed).toHaveBeenCalledTimes(2);

    const root = placeholderRoot("k1");
    applyRawImages(root, store);
    const box = root.querySelector<HTMLElement>("[data-raw-key]");
    expect(box?.classList.contains("compiled")).toBe(true);
    expect(box?.style.aspectRatio).toBe("400 / 300");
    const img = box?.querySelector("img");
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(img?.getAttribute("alt")).toBe("tikzpicture");
    // 何度呼んでも画像は 1 枚のまま。
    applyRawImages(root, store);
    expect(box?.querySelectorAll("img")).toHaveLength(1);
  });

  it("失敗は箱を残して印とメッセージを付け、ラスタライズできないホストでも失敗として扱う", () => {
    const store = new RawImageStore(undefined);
    store.receive("bad", { error: "! Undefined control sequence." });
    store.receive("nohost", { pdfBase64: PDF_B64 });
    const root = document.createElement("div");
    root.append(placeholderRoot("bad").firstElementChild as HTMLElement);
    root.append(placeholderRoot("nohost").firstElementChild as HTMLElement);
    root.append(placeholderRoot("unknown").firstElementChild as HTMLElement);
    applyRawImages(root, store);
    const boxes = [...root.querySelectorAll<HTMLElement>("[data-raw-key]")];
    expect(boxes[0]?.classList.contains("failed")).toBe(true);
    expect(boxes[0]?.title).toContain("Undefined control sequence");
    expect(boxes[0]?.title).toContain("\\begin{tikzpicture}");
    expect(boxes[0]?.querySelector(".placeholder-label")?.textContent).toBe("tikzpicture");
    expect(boxes[1]?.dataset.rawError).toContain("画像にできません");
    // 結果が無い箱はそのまま。
    expect(boxes[2]?.dataset.rawStatus).toBeUndefined();
  });

  it("同じ key に複数の PDF が届いて完了順が逆になっても、最後に届いた結果だけを反映する", async () => {
    const pending = new Map<
      string,
      (image: { dataUrl: string; width: number; height: number }) => void
    >();
    const rasterize = vi.fn(
      (pdf: Uint8Array) =>
        new Promise<{ dataUrl: string; width: number; height: number }>((resolve) => {
          pending.set(new TextDecoder().decode(pdf), resolve);
        }),
    );
    const store = new RawImageStore(rasterize);
    store.receive("k", { pdfBase64: btoa("first") });
    store.receive("k", { pdfBase64: btoa("second") });
    expect(rasterize).toHaveBeenCalledTimes(2);
    // 後から届いた方が先に終わる。
    pending.get("second")?.({ dataUrl: "data:second", width: 2, height: 2 });
    await vi.waitFor(() => expect(store.get("k")?.status).toBe("ready"));
    pending.get("first")?.({ dataUrl: "data:first", width: 1, height: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.get("k")).toEqual({
      status: "ready",
      image: { dataUrl: "data:second", width: 2, height: 2 },
    });
    // 古い方が失敗しても、新しい結果を失敗で上書きしない。
    const failing = new RawImageStore(
      vi.fn((pdf: Uint8Array) =>
        new TextDecoder().decode(pdf) === "old"
          ? new Promise<never>((_, reject) => setTimeout(() => reject(new Error("late")), 0))
          : Promise.resolve({ dataUrl: "data:new", width: 1, height: 1 }),
      ),
    );
    failing.receive("k", { pdfBase64: btoa("old") });
    failing.receive("k", { pdfBase64: btoa("new") });
    await vi.waitFor(() => expect(failing.get("k")?.status).toBe("ready"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(failing.get("k")?.status).toBe("ready");
  });

  it("retain または clear 後に同じ key を受信すると、古い pending の完了を無効にする", async () => {
    const pending = new Map<
      string,
      (image: { dataUrl: string; width: number; height: number }) => void
    >();
    const store = new RawImageStore(
      (pdf) =>
        new Promise((resolve) => {
          pending.set(new TextDecoder().decode(pdf), resolve);
        }),
    );
    store.receive("k", { pdfBase64: btoa("retain-old") });
    store.retain(new Set());
    store.receive("k", { pdfBase64: btoa("retain-new") });
    pending.get("retain-new")?.({ dataUrl: "data:retain-new", width: 2, height: 2 });
    await vi.waitFor(() => expect(store.get("k")?.status).toBe("ready"));
    pending.get("retain-old")?.({ dataUrl: "data:retain-old", width: 1, height: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.get("k")).toEqual({
      status: "ready",
      image: { dataUrl: "data:retain-new", width: 2, height: 2 },
    });

    store.receive("k", { pdfBase64: btoa("clear-old") });
    store.clear();
    store.receive("k", { pdfBase64: btoa("clear-new") });
    pending.get("clear-new")?.({ dataUrl: "data:clear-new", width: 4, height: 4 });
    await vi.waitFor(() => expect(store.get("k")?.status).toBe("ready"));
    pending.get("clear-old")?.({ dataUrl: "data:clear-old", width: 3, height: 3 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.get("k")).toEqual({
      status: "ready",
      image: { dataUrl: "data:clear-new", width: 4, height: 4 },
    });
  });

  it("上限を超える PDF は復号もラスタライズもせずに失敗にする", () => {
    const rasterize = vi.fn();
    const store = new RawImageStore(rasterize);
    const tooLong = "A".repeat(Math.ceil(MAX_RAW_PDF_BYTES / 3) * 4 + 4);
    store.receive("huge", { pdfBase64: tooLong });
    expect(store.get("huge")).toEqual({
      status: "failed",
      message: "PDF が大きすぎます(上限 8 MB)",
    });
    expect(rasterize).not.toHaveBeenCalled();
  });

  it("ready から failed へ戻すときは画像を外してプレースホルダのラベルを戻す", async () => {
    const store = new RawImageStore(async () => ({
      dataUrl: "data:image/png;base64,AAAA",
      width: 400,
      height: 300,
    }));
    store.receive("k1", { pdfBase64: PDF_B64 });
    await vi.waitFor(() => expect(store.get("k1")?.status).toBe("ready"));
    const root = placeholderRoot("k1");
    applyRawImages(root, store);
    expect(root.querySelector("img")).not.toBeNull();
    store.receive("k1", { error: "missing figure.png" });
    applyRawImages(root, store);
    const box = root.querySelector<HTMLElement>("[data-raw-key]");
    expect(box?.querySelector("img")).toBeNull();
    expect(box?.classList.contains("compiled")).toBe(false);
    expect(box?.classList.contains("failed")).toBe(true);
    expect(box?.querySelector(".placeholder-label")?.textContent).toBe("tikzpicture");
    expect(box?.title).toContain("missing figure.png");
    expect(box?.title).toContain("\\begin{tikzpicture}");
  });

  it("retain は指定した key 以外の状態を捨て、clear は全部捨てる", async () => {
    const store = new RawImageStore(async () => ({
      dataUrl: "data:image/png;base64,AAAA",
      width: 1,
      height: 1,
    }));
    store.receive("keep", { pdfBase64: PDF_B64 });
    store.receive("drop", { pdfBase64: PDF_B64 });
    await vi.waitFor(() => expect(store.get("keep")?.status).toBe("ready"));
    store.retain(new Set(["keep"]));
    expect(store.get("keep")?.status).toBe("ready");
    expect(store.get("drop")).toBeUndefined();
    const root = placeholderRoot("keep");
    applyRawImages(root, store);
    expect(root.querySelector("img")).not.toBeNull();
    store.clear();
    expect(store.get("keep")).toBeUndefined();
    applyRawImages(root, store);
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector(".placeholder-label")?.textContent).toBe("tikzpicture");
    expect(root.querySelector<HTMLElement>("[data-raw-key]")?.classList.contains("compiled")).toBe(
      false,
    );
  });

  it("decodeBase64 はバイト列を復元する", () => {
    const bytes = `${String.fromCharCode(0, 255)}%PDF`;
    expect(Array.from(decodeBase64(btoa(bytes)))).toEqual([0, 255, 37, 80, 68, 70]);
  });
});
