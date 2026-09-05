// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { applyRawImages, decodeBase64, RawImageStore } from "../src/preview/raw-images.js";

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

  it("decodeBase64 はバイト列を復元する", () => {
    const bytes = `${String.fromCharCode(0, 255)}%PDF`;
    expect(Array.from(decodeBase64(btoa(bytes)))).toEqual([0, 255, 37, 80, 68, 70]);
  });
});
