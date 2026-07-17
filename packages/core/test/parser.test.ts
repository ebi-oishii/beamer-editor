import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { framesOf, isCanvasFrame } from "../src/ast.js";
import { parseDeck } from "../src/parser.js";

const fixture = (name: string) => readFileSync(join(__dirname, "../../../fixtures", name), "utf8");

describe("parseDeck: basic.tex", () => {
  const doc = parseDeck(fixture("basic.tex"));

  it("メタデータと文書属性を読む", () => {
    expect(doc.aspectRatio).toBe("169");
    expect(doc.sourceVersion).toBe(1);
    expect(doc.metadata.title?.value[0]).toMatchObject({ type: "text" });
  });

  it("15 フレームすべてが構造化フレームとして読める", () => {
    const frames = framesOf(doc);
    expect(frames).toHaveLength(15);
    expect(frames.every((f) => f.type === "frame")).toBe(true);
  });

  it("セクション構造を読む", () => {
    const sections = doc.body.filter((el) => el.type === "section");
    expect(sections).toHaveLength(4); // section x3 + subsection x1
  });

  it("label 付きフレームを読む", () => {
    const frames = framesOf(doc);
    const labeled = frames.find((f) => f.type === "frame" && f.options.label === "results");
    expect(labeled).toBeDefined();
  });

  it("オーバーレイ付き enumerate を読む", () => {
    const frames = framesOf(doc);
    const steps = frames[3];
    expect(steps?.type).toBe("frame");
    if (steps?.type !== "frame") return;
    const list = steps.body.find((b) => b.type === "list");
    expect(list?.type).toBe("list");
    if (list?.type !== "list") return;
    expect(list.kind).toBe("enumerate");
    expect(list.items[0]?.overlay?.ranges).toEqual([{ from: 1, to: null }]);
    expect(list.items[2]?.overlay?.ranges).toEqual([{ from: 3, to: 3 }]);
    expect(list.items[3]?.overlay?.ranges).toEqual([
      { from: 2, to: 2 },
      { from: 4, to: 4 },
    ]);
  });

  it("表を booktabs ルール込みで読む", () => {
    const frames = framesOf(doc);
    const tableFrame = frames[8];
    if (tableFrame?.type !== "frame") throw new Error("expected frame");
    const center = tableFrame.body.find((b) => b.type === "center");
    if (center?.type !== "center") throw new Error("expected center");
    const table = center.children.find((b) => b.type === "table");
    if (table?.type !== "table") throw new Error("expected table");
    expect(table.columns).toEqual(["l", "c", "r"]);
    expect(table.rows.filter((r) => r.type === "tableRule")).toHaveLength(3);
    expect(table.rows.filter((r) => r.type === "tableCells")).toHaveLength(3);
  });
});

describe("parseDeck: kitchen-sink.tex", () => {
  const doc = parseDeck(fixture("kitchen-sink.tex"));
  const frames = framesOf(doc);

  it("全フレームが列挙できる(生フレーム込み)", () => {
    expect(frames).toHaveLength(10);
  });

  it("TikZ は生ブロックに落ちる", () => {
    const tikzFrame = frames[2];
    if (tikzFrame?.type !== "frame") throw new Error("expected frame");
    const findRaw = (blocks: typeof tikzFrame.body): boolean =>
      blocks.some(
        (b) =>
          (b.type === "rawBlock" && b.environment === "tikzpicture") ||
          (b.type === "center" && findRaw(b.children)),
      );
    expect(findRaw(tikzFrame.body)).toBe(true);
  });

  it("未知オプションのフレームは生フレームに落ちる", () => {
    const raw = frames.filter((f) => f.type === "rawFrame");
    expect(raw).toHaveLength(1);
    expect(raw[0]?.tex).toContain("shrink=5");
  });

  it("verbatim は fragile フレームの生ブロックになる", () => {
    const vf = frames[4];
    if (vf?.type !== "frame") throw new Error("expected frame");
    expect(vf.options.fragile).toBe(true);
    expect(vf.body.some((b) => b.type === "rawBlock" && b.environment === "verbatim")).toBe(true);
  });

  it("縦罫線付き tabular は生ブロックに落ちる", () => {
    const tf = frames[5];
    if (tf?.type !== "frame") throw new Error("expected frame");
    const findRaw = (blocks: typeof tf.body): boolean =>
      blocks.some(
        (b) =>
          (b.type === "rawBlock" && b.environment === "tabular") ||
          (b.type === "center" && findRaw(b.children)),
      );
    expect(findRaw(tf.body)).toBe(true);
  });
});

describe("parseDeck: canvas.tex", () => {
  const doc = parseDeck(fixture("canvas.tex"));
  const frames = framesOf(doc);

  it("キャンバスフレームを判定できる", () => {
    const canvasFrames = frames.filter((f) => f.type === "frame" && isCanvasFrame(f));
    expect(canvasFrames).toHaveLength(4);
  });

  it("decktext の座標・サイズを読む", () => {
    const results = frames[1];
    if (results?.type !== "frame") throw new Error("expected frame");
    expect(results.options.label).toBe("canvas-results");
    const canvas = results.body.find((b) => b.type === "canvas");
    if (canvas?.type !== "canvas") throw new Error("expected canvas");
    expect(canvas.items).toHaveLength(2);
    const [text, image] = canvas.items;
    if (text?.type !== "canvasText") throw new Error("expected canvasText");
    expect(text.position).toMatchObject({ x: 0.05, y: 0.1, width: 0.42 });
    expect(text.size).toBe("normal");
    if (image?.type !== "canvasImage") throw new Error("expected canvasImage");
    expect(image.path).toBe("assets/result-chart.pdf");
  });

  it("decktext 内の箇条書きを読む", () => {
    const sizes = frames[2];
    if (sizes?.type !== "frame") throw new Error("expected frame");
    const canvas = sizes.body.find((b) => b.type === "canvas");
    if (canvas?.type !== "canvas") throw new Error("expected canvas");
    const withList = canvas.items.find(
      (item) => item.type === "canvasText" && item.children.some((c) => c.type === "list"),
    );
    expect(withList).toBeDefined();
  });
});

describe("parseDeck: macros.tex", () => {
  const doc = parseDeck(fixture("macros.tex"));

  it("マクロ定義を読む(展開可能性の判定込み)", () => {
    const defs = doc.macros.entries.filter((e) => e.type === "macroDefinition");
    expect(defs.map((d) => d.name)).toContain("R");
    expect(defs.map((d) => d.name)).toContain("code");
    const greet = defs.find((d) => d.name === "greet");
    expect(greet?.optionalDefault).toBe("world");
    const maybe = defs.find((d) => d.name === "maybe");
    expect(maybe?.expandable).toBe(false);
    const code = defs.find((d) => d.name === "code");
    expect(code?.expandable).toBe(true);
    expect(code?.paramCount).toBe(1);
  });

  it("\\def は生ブロックとして保持する", () => {
    const raws = doc.macros.entries.filter((e) => e.type === "rawBlock");
    expect(raws.length).toBeGreaterThanOrEqual(1);
    expect(raws.some((r) => r.tex.includes("\\def\\swap"))).toBe(true);
  });

  it("全 8 フレームが読める", () => {
    expect(framesOf(doc)).toHaveLength(8);
  });
});

describe("parseDeck: includegraphics", () => {
  it("width オプション付き画像を読む", () => {
    const doc = parseDeck(fixture("basic.tex"));
    const frames = framesOf(doc);
    const imgFrame = frames[7];
    if (imgFrame?.type !== "frame") throw new Error("expected frame");
    const center = imgFrame.body.find((b) => b.type === "center");
    if (center?.type !== "center") throw new Error("expected center");
    const img = center.children.find((b) => b.type === "image");
    if (img?.type !== "image") throw new Error("expected image");
    expect(img.path).toBe("assets/logo.png");
    expect(img.width).toMatchObject({ factor: 0.4, unit: "textwidth" });
  });
});

describe("parseDeck: styled.tex(%% style 領域)", () => {
  const doc = parseDeck(fixture("styled.tex"));

  it("スタイル語彙を読む", () => {
    const colors = doc.style.entries.filter((e) => e.type === "styleColor");
    expect(colors).toHaveLength(3);
    expect(colors[0]).toMatchObject({ role: "structure", hex: "0F62FE" });
    const font = doc.style.entries.find((e) => e.type === "styleFont");
    expect(font).toMatchObject({ slot: "main", family: "Noto Sans CJK JP" });
    const logo = doc.style.entries.find((e) => e.type === "styleLogo");
    if (logo?.type !== "styleLogo") throw new Error("expected styleLogo");
    expect(logo.position).toMatchObject({ x: 0.945, y: 0, width: 0.055 });
    expect(logo.path).toBe("assets/logo.png");
    const footer = doc.style.entries.find((e) => e.type === "styleFooter");
    expect(footer).toBeDefined();
  });

  it("語彙外の記述は unknown-style の生ブロックになる", () => {
    const broken = parseDeck(
      fixture("styled.tex").replace(
        "\\deckcolor{structure}{0F62FE}",
        "\\deckcolor{structure}{bad}\n\\setbeamercolor{title}{fg=red}",
      ),
    );
    const raws = broken.style.entries.filter((e) => e.type === "rawBlock");
    expect(raws).toHaveLength(2);
    expect(raws.every((r) => r.reason === "unknown-style")).toBe(true);
  });

  it("style 領域が無いデッキでは空になる", () => {
    const doc2 = parseDeck(fixture("basic.tex"));
    expect(doc2.style.entries).toHaveLength(0);
  });
});
