// @vitest-environment jsdom
import { extractPreviewStyle, parseDeck } from "@beamer-editor/core";
import { renderDeck } from "@beamer-editor/renderer";
import { describe, expect, it } from "vitest";
import { PREVIEW_CSS } from "../src/preview/styles.js";

/**
 * キャンバス幾何の CSS 契約を固定する回帰テスト(PR #67)。
 *
 * .frametitle / .slide-body に position を与えると、絶対配置の .canvas の包含ブロックが
 * .slide から高さ数 px の .slide-body に変わり、renderer が .slide 基準で出している
 * top / height % が潰れる(ドラッグ結果として y=25.077 をソースへ書き込む回帰があった)。
 * jsdom は実寸の包含ブロック計算まではしないので、原因となる宣言の有無と、
 * ロゴ・フッターを本文の下・背景の上に置く重なり順の宣言を CSSOM と computed style で確認する。
 */

function injectPreviewCss(): CSSStyleSheet {
  const style = document.createElement("style");
  style.textContent = PREVIEW_CSS;
  document.head.append(style);
  const sheet = style.sheet;
  if (!sheet) throw new Error("stylesheet was not parsed");
  return sheet;
}

function styleRules(sheet: CSSStyleSheet): CSSStyleRule[] {
  return [...sheet.cssRules].filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule);
}

/** selectorText に含まれる個々のセレクタが `selector` を含む規則の宣言を集める。 */
function declarationsFor(sheet: CSSStyleSheet, selector: string): CSSStyleDeclaration[] {
  return styleRules(sheet)
    .filter((rule) => rule.selectorText.split(",").some((part) => part.trim().includes(selector)))
    .map((rule) => rule.style);
}

describe("PREVIEW_CSS: キャンバス幾何の契約", () => {
  it("文字サイズ select より幅変更ハンドルを前面に置く", () => {
    const sheet = injectPreviewCss();
    const select = declarationsFor(sheet, ".canvas-font-size")[0];
    const handle = declarationsFor(sheet, ".canvas-resize-handle")[0];
    expect(Number(select?.getPropertyValue("z-index"))).toBeLessThan(
      Number(handle?.getPropertyValue("z-index")),
    );
    expect(handle?.getPropertyValue("pointer-events")).not.toBe("none");
  });

  it("step 操作はプレビュー下部の overlay で、スクロール領域の高さを変えない", () => {
    const sheet = injectPreviewCss();
    const preview = declarationsFor(sheet, ".beamer-preview")[0];
    const stepControl = declarationsFor(sheet, ".step-control")[0];
    expect(preview?.getPropertyValue("position")).toBe("relative");
    expect(stepControl?.getPropertyValue("position")).toBe("absolute");
    expect(stepControl?.getPropertyValue("bottom")).toBe("8px");
    expect(stepControl?.getPropertyValue("left")).toBe("50%");
    expect(stepControl?.getPropertyValue("transform")).toBe("translateX(-50%)");
    expect(stepControl?.getPropertyValue("margin")).toBe("");
  });

  it(".frametitle / .slide-body は positioned element にしない(.canvas の包含ブロックを .slide に保つ)", () => {
    const sheet = injectPreviewCss();
    for (const selector of [".frametitle", ".slide-body"]) {
      for (const declaration of declarationsFor(sheet, selector)) {
        const position = declaration.getPropertyValue("position");
        expect(
          position === "" || position === "static",
          `${selector} { position: ${position} }`,
        ).toBe(true);
      }
    }

    // renderer の出力形に沿った最小 DOM で computed style も確認する。
    document.body.innerHTML =
      '<div class="beamer-preview"><div class="slide"><div class="frametitle">t</div><div class="slide-body"><div class="canvas"></div></div></div></div>';
    const slide = document.querySelector<HTMLElement>(".slide");
    const body = document.querySelector<HTMLElement>(".slide-body");
    const title = document.querySelector<HTMLElement>(".frametitle");
    if (!slide || !body || !title) throw new Error("fixture missing");
    // jsdom は未宣言のプロパティを "" で返すため、static と同一視する。
    expect(getComputedStyle(slide).position).toBe("relative");
    expect(["", "static"]).toContain(getComputedStyle(body).position);
    expect(["", "static"]).toContain(getComputedStyle(title).position);
  });

  it("ロゴ・フッターは .slide の stacking context 内で z-index: -1(背景の上・本文の下)", () => {
    const sheet = injectPreviewCss();
    const slide = declarationsFor(sheet, ".slide").find(
      (declaration) => declaration.getPropertyValue("isolation") !== "",
    );
    expect(slide?.getPropertyValue("isolation")).toBe("isolate");
    for (const selector of [".deck-logo", ".deck-footer"]) {
      const declarations = declarationsFor(sheet, selector);
      expect(declarations.length, selector).toBeGreaterThan(0);
      const zIndexes = declarations
        .map((declaration) => declaration.getPropertyValue("z-index"))
        .filter((value) => value !== "");
      expect(zIndexes, selector).toEqual(["-1"]);
      expect(
        declarations.some((declaration) => declaration.getPropertyValue("position") === "absolute"),
        selector,
      ).toBe(true);
    }
  });

  it("インライン alert の色は alertblock の容器(本文)へ掛けない", () => {
    const sheet = injectPreviewCss();
    for (const rule of styleRules(sheet)) {
      for (const part of rule.selectorText.split(",").map((p) => p.trim())) {
        if (
          /\.alert(?![\w-])/.test(part) &&
          !part.includes(".block-title") &&
          !part.includes(".beamer-block")
        ) {
          expect(part, `${part} は .beamer-block を除外する`).toContain(":not(.beamer-block)");
        }
      }
    }
  });

  it("block の種類別タイトル色は直下の .block-title だけに当てる(入れ子の block へ漏らさない)", () => {
    const sheet = injectPreviewCss();
    for (const rule of styleRules(sheet)) {
      for (const part of rule.selectorText.split(",").map((p) => p.trim())) {
        if (/\.beamer-block\.[\w-]+/.test(part) && /\.block-title(?![-\w])/.test(part)) {
          expect(part, `${part} は .block-title を > で繋ぐ`).toMatch(
            /\.beamer-block(?:\.[\w-]+)+\s*>\s*\.block-title/,
          );
        }
      }
    }
  });

  it.each([
    ["alertblock", "--deck-alert"],
    ["exampleblock", "--deck-example"],
  ])("%s の中に入れ子にした block のタイトルは structure 色のまま", (env, outerVar) => {
    injectPreviewCss();
    const src = String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}{A}
\begin{${env}}{Outer}\begin{block}{Inner}x\end{block}\end{${env}}
\end{frame}
\end{document}
`;
    const html = renderDeck(parseDeck(src)).frames[0]?.html ?? "";
    document.body.innerHTML = `<div class="beamer-preview"><div class="slide">${html}</div></div>`;
    const titles = [...document.querySelectorAll<HTMLElement>(".block-title")];
    expect(titles.map((title) => title.textContent)).toEqual(["Outer", "Inner"]);
    const [outer, inner] = titles.map((title) => getComputedStyle(title).color);
    expect(outer).toContain(outerVar);
    expect(inner).toContain("--deck-structure");
  });

  it("等幅スタックは総称 monospace の前に Windows の Latin 等幅を挟む", () => {
    const stacks = PREVIEW_CSS.match(/font-family:[^;]*monospace/g) ?? [];
    expect(stacks.length).toBeGreaterThan(0);
    for (const stack of stacks) {
      expect(stack).toMatch(/(?:Consolas|"Cascadia Mono"), monospace$/);
      expect(stack).not.toContain("Courier New");
    }
  });
});

describe("PREVIEW_CSS: ブロックの配色と形", () => {
  const GATES = ["block-title-filled", "block-body-filled", "block-rounded", "block-shadow"];

  it("帯・箱・角丸・影の宣言は renderer が付けるクラスの下にだけある(指定が無ければ見た目は従来どおり)", () => {
    const sheet = injectPreviewCss();
    const shaping = ["background", "padding", "border-radius", "box-shadow", "display"];
    const blockRules = styleRules(sheet).filter((rule) =>
      rule.selectorText.includes("beamer-block"),
    );
    for (const rule of blockRules) {
      for (const selector of rule.selectorText.split(",")) {
        const gated = GATES.some((gate) => selector.includes(gate));
        for (const property of shaping) {
          if (gated) continue;
          expect(rule.style.getPropertyValue(property), `${selector} { ${property} }`).toBe("");
        }
      }
    }
    for (const gate of GATES) {
      expect(
        blockRules.some((rule) => rule.selectorText.includes(gate)),
        gate,
      ).toBe(true);
    }
    // 上の検査が空振りしないよう、ゲート下の宣言が CSSOM に読めていることも確かめる。
    const band = blockRules.find(
      (rule) => rule.selectorText === ".slide .beamer-block.block-title-filled > .block-title",
    );
    expect(band?.style.getPropertyValue("background")).toBe("var(--block-title-bg)");
    expect(band?.style.getPropertyValue("padding")).toBe("2pt 4pt 1.5pt");
  });

  it("title の文字色は deck.css の変数が無ければ種類の文字色へ戻る", () => {
    const sheet = injectPreviewCss();
    const color = (selector: string) =>
      styleRules(sheet)
        .find((rule) => rule.selectorText === selector)
        ?.style.getPropertyValue("color");
    expect(color(".slide .beamer-block > .block-title")).toBe(
      "var(--deck-block-title-fg, var(--deck-structure, #3333b3))",
    );
    expect(color(".slide .beamer-block.alert > .block-title")).toBe(
      "var(--deck-block-alerted-title-fg, var(--deck-alert, #c0392b))",
    );
    expect(color(".slide .beamer-block.example > .block-title")).toBe(
      "var(--deck-block-example-title-fg, var(--deck-example, #1e8449))",
    );
  });

  it("未対応 bg と一緒の白い fg は、生成 HTML で既定の非白色タイトルとして計算される", () => {
    injectPreviewCss();
    const source = String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}{A}\begin{block}{Readable}text\end{block}\end{frame}
\end{document}`;
    const baseStyle = extractPreviewStyle(
      String.raw`\setbeamercolor{block title}{use=structure,fg=white,bg=structure.fg!75!black}`,
    );
    const deck = renderDeck(parseDeck(source), undefined, { baseStyle });
    document.body.innerHTML = `<style>${deck.css}</style><div class="beamer-preview"><div class="slide">${deck.frames[0]?.html}</div></div>`;
    const title = document.querySelector<HTMLElement>(".block-title");
    if (!title) throw new Error("fixture missing title");
    expect(title.parentElement?.className).not.toContain("block-title-filled");
    // jsdom retains var() in computed CSS, while browsers resolve it to the same
    // structure fallback.  Either representation proves this path is not white.
    expect(getComputedStyle(title).color).not.toMatch(/(?:255|fff|white)/i);
    expect(getComputedStyle(title).color).toContain("--deck-structure");
  });
});
