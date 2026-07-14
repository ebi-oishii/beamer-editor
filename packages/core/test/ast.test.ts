import { describe, expect, it } from "vitest";
import {
  type CanvasNode,
  type DeckDocument,
  type FrameNode,
  framesOf,
  isCanvasFrame,
} from "../src/ast.js";

const span = (start: number, end: number) => ({ start, end });

function makeFrame(body: FrameNode["body"]): FrameNode {
  return {
    type: "frame",
    span: span(0, 1),
    options: { fragile: false, plain: false, allowframebreaks: false, label: null, span: null },
    title: null,
    body,
  };
}

describe("ast smoke", () => {
  it("キャンバスフレームを判定できる", () => {
    const canvas: CanvasNode = {
      type: "canvas",
      span: span(0, 1),
      items: [
        {
          type: "canvasText",
          span: span(0, 1),
          position: { x: 0.05, y: 0.1, width: 0.42, span: span(0, 1) },
          size: "normal",
          children: [],
        },
        {
          type: "canvasImage",
          span: span(0, 1),
          position: { x: 0.52, y: 0.14, width: 0.4, span: span(0, 1) },
          path: "assets/result-chart.pdf",
        },
      ],
    };
    expect(isCanvasFrame(makeFrame([canvas]))).toBe(true);
    expect(isCanvasFrame(makeFrame([]))).toBe(false);
  });

  it("フレームを出現順に列挙できる(序数アドレスの基盤)", () => {
    const doc: DeckDocument = {
      type: "document",
      span: span(0, 100),
      sourceVersion: 1,
      aspectRatio: "169",
      metadata: { type: "metadata", span: span(0, 1) },
      macros: { type: "macroSection", span: span(0, 1), entries: [] },
      preambleExtra: { type: "rawRegion", span: span(0, 1), tex: "" },
      managedPreamble: { type: "rawRegion", span: span(0, 1), tex: "" },
      body: [
        { type: "section", span: span(0, 1), level: "section", title: [] },
        makeFrame([]),
        { type: "rawFrame", span: span(0, 1), tex: "", title: "Raw", label: null },
      ],
    };
    expect(framesOf(doc)).toHaveLength(2);
  });
});
