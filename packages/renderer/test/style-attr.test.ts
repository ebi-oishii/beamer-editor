// @vitest-environment jsdom
import { parseDeck } from "@beamer-editor/core";
import { describe, expect, it } from "vitest";
import { renderDeck } from "../src/render.js";

const deck = (body: string) =>
  `\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}[label=f0]{T}\n${body}\n\\end{frame}\n\\end{document}\n`;

/** 描いた HTML を DOM として読み直す。属性が途中で切れていれば、ここで値が欠ける。 */
function dom(body: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderDeck(parseDeck(deck(body))).frames[0]?.html ?? "";
  return root;
}

/** 書体・色・サイズがすべて style に残っていること。 */
function expectFullStyle(element: Element | null | undefined, family: string): void {
  const style = element?.getAttribute("style") ?? "";
  expect(style).toContain(`font-family:var(--deck-font-${family}, `);
  expect(style).toMatch(/"(Helvetica Neue|SF Mono)"/);
  expect(style).toContain("color:#e74c3c");
  expect(style).toMatch(/font-size:\d+(\.\d+)?pt/);
}

describe("renderDeck: style 属性のエスケープ", () => {
  it("段落をまたぐ宣言の div は、書体のフォント名の引用符で style が切れない", () => {
    const root = dom("\\sffamily\\color{red}\\Large First\n\nNext");
    const declared = [...root.querySelectorAll("div.declared")];
    expect(declared).toHaveLength(1);
    expectFullStyle(declared[0], "main");
    expect(declared[0]?.textContent).toContain("Next");
  });

  it("行内の宣言の span と \\textsf も、style が切れない", () => {
    const root = dom("\\ttfamily\\color{red}\\Large A \\textsf{B}");
    // 行内の宣言は 1 つずつ span で包む。A を包む span の style を合わせて、3 つとも残っていること。
    const textA = [...root.querySelectorAll("span")].find(
      (span) =>
        span.firstChild?.nodeType === Node.TEXT_NODE && span.firstChild.textContent === " A ",
    );
    const styles: string[] = [];
    for (
      let element: Element | null | undefined = textA;
      element && element !== root;
      element = element.parentElement
    )
      styles.push(element.getAttribute("style") ?? "");
    expect(styles.join(";")).toContain("color:#e74c3c");
    expect(styles.join(";")).toMatch(/font-size:\d+(\.\d+)?pt/);
    expect(styles).toContain(
      'font-family:var(--deck-font-mono, "SF Mono", ui-monospace, Menlo, monospace)',
    );
    const textsf = [...root.querySelectorAll("span[style]")].find(
      (span) => span.textContent === "B",
    );
    expect(textsf?.getAttribute("style")).toBe(
      'font-family:var(--deck-font-main, -apple-system, "Helvetica Neue", Arial, sans-serif)',
    );
  });
});
