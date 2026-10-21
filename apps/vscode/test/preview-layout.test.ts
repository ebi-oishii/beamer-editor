import { describe, expect, it } from "vitest";
import { planPreviewLayoutRestore, sourceSideOfPreview } from "../src/preview-layout";

describe("sourceSideOfPreview", () => {
  it("source の列がすべてプレビューの左なら left、右なら right", () => {
    expect(sourceSideOfPreview(2, [1])).toBe("left");
    expect(sourceSideOfPreview(3, [1, 2])).toBe("left");
    expect(sourceSideOfPreview(1, [2])).toBe("right");
    expect(sourceSideOfPreview(1, [2, 3])).toBe("right");
  });

  it("同じグループ・左右混在・列不明・source なしは判定しない", () => {
    expect(sourceSideOfPreview(2, [2])).toBeUndefined();
    expect(sourceSideOfPreview(2, [1, 2])).toBeUndefined();
    expect(sourceSideOfPreview(2, [1, 3])).toBeUndefined();
    expect(sourceSideOfPreview(undefined, [1])).toBeUndefined();
    expect(sourceSideOfPreview(2, [])).toBeUndefined();
  });
});

describe("planPreviewLayoutRestore", () => {
  it("入れ替わって右に開いた source の右へプレビューを戻す", () => {
    // 閉じた source のグループが消え、プレビューが列 1、開き直した source が列 2 になった状態。
    expect(
      planPreviewLayoutRestore({ previewColumn: 1, sourceColumns: [2], sourceSide: "left" }),
    ).toBe(3);
  });

  it("プレビューと同じグループに開いた source の右へプレビューを移す", () => {
    expect(
      planPreviewLayoutRestore({ previewColumn: 1, sourceColumns: [1], sourceSide: "left" }),
    ).toBe(2);
  });

  it("source が既に左にあれば移さない", () => {
    expect(
      planPreviewLayoutRestore({ previewColumn: 2, sourceColumns: [1], sourceSide: "left" }),
    ).toBeUndefined();
    expect(
      planPreviewLayoutRestore({ previewColumn: 2, sourceColumns: [1, 3], sourceSide: "left" }),
    ).toBeUndefined();
  });

  it("source が右側だった配置と列不明は復元しない", () => {
    expect(
      planPreviewLayoutRestore({ previewColumn: 1, sourceColumns: [2], sourceSide: "right" }),
    ).toBeUndefined();
    expect(
      planPreviewLayoutRestore({ previewColumn: 1, sourceColumns: [1], sourceSide: "right" }),
    ).toBeUndefined();
    expect(
      planPreviewLayoutRestore({
        previewColumn: undefined,
        sourceColumns: [1],
        sourceSide: "left",
      }),
    ).toBeUndefined();
    expect(
      planPreviewLayoutRestore({ previewColumn: 1, sourceColumns: [], sourceSide: "left" }),
    ).toBeUndefined();
  });
});
