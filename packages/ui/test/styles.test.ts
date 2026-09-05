// @vitest-environment jsdom
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
});
