// @vitest-environment jsdom
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseDeck } from "@beamer-editor/core";
import { renderDeck } from "@beamer-editor/renderer";
import { beforeAll, describe, expect, it } from "vitest";
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

const chromeBin = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((candidate): candidate is string => candidate !== undefined && existsSync(candidate));

interface HfillLayout {
  itemTop: number;
  itemHeight: number;
  itemLineHeight: number;
  itemFillTop: number;
  paragraphLeft: number;
  lineFillTop: number;
  lineFillRight: number;
  paragraphRight: number;
  nextLeft: number;
  nextTop: number;
}

const execFileAsync = promisify(execFile);

const hfillCases = [
  ["通常の改行", String.raw`Left \hfill Right \\ Next line`],
  ["入れ子の書式内の改行", String.raw`Left \hfill \textbf{Right \\ Next line}`],
] as const;

/**
 * Chrome の実レイアウトで hfill の行境界を確認する。jsdom には行ボックスの計算が無いため。
 * CI では headless Chrome の起動・終了がまれにハングするので、全ケースを1ページに並べて
 * 1回の起動で測り、非同期に呼んでタイムアウト時は確実に kill する。
 */
async function measureHfillLayouts(paragraphs: readonly string[]): Promise<HfillLayout[]> {
  if (!chromeBin) throw new Error("Chrome executable not found");
  const cases = paragraphs.map((paragraph) => {
    const source = String.raw`\begin{frame}{T}
\begin{itemize}
\item Name \hfill 2024
\end{itemize}

${paragraph}
\end{frame}`;
    const html = renderDeck(parseDeck(source)).frames[0]?.html;
    if (!html) throw new Error("expected rendered frame");
    return `<section class="hfill-case">${html}</section>`;
  });
  const dir = mkdtempSync(join(tmpdir(), "beamer-hfill-layout-"));
  const input = join(dir, "layout.html");
  const profile = join(dir, "profile");
  try {
    writeFileSync(
      input,
      `<!doctype html><style>${PREVIEW_CSS}</style>${cases.join("")}<pre id="result"></pre><script>
const rect = (element) => element.getBoundingClientRect();
const results = [...document.querySelectorAll('.hfill-case')].map((section) => {
  const fill = section.querySelectorAll('.hfill-line');
  const item = section.querySelector('li');
  const paragraph = section.querySelector('p');
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  let next; while (walker.nextNode()) { if (walker.currentNode.textContent.includes('Next line')) { next = walker.currentNode; break; } }
  const range = document.createRange(); range.selectNode(next);
  const itemRect = rect(item), itemFill = rect(fill[0]), paragraphRect = rect(paragraph), lineFill = rect(fill[1]), nextRect = range.getBoundingClientRect();
  return {
    itemTop: itemRect.top, itemHeight: itemRect.height, itemLineHeight: parseFloat(getComputedStyle(item).lineHeight), itemFillTop: itemFill.top,
    paragraphLeft: paragraphRect.left, lineFillTop: lineFill.top, lineFillRight: lineFill.right, paragraphRight: paragraphRect.right,
    nextLeft: nextRect.left, nextTop: nextRect.top
  };
});
document.querySelector('#result').textContent = JSON.stringify(results);
</script>`,
    );
    // 失敗時の execFile のエラーメッセージには Chrome の stderr が含まれる。
    const { stdout } = await execFileAsync(
      chromeBin,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-dev-shm-usage",
        ...(process.env.CI ? ["--no-sandbox"] : []),
        `--user-data-dir=${profile}`,
        "--dump-dom",
        input,
      ],
      { timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 10_000_000 },
    );
    const json = /<pre id="result">([^<]+)<\/pre>/.exec(stdout)?.[1];
    if (!json) throw new Error("Chrome did not return layout measurements");
    return JSON.parse(json) as HfillLayout[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("PREVIEW_CSS: キャンバス幾何の契約", () => {
  describe.skipIf(!chromeBin)("Chrome の実レイアウト", () => {
    let layouts: HfillLayout[] = [];
    beforeAll(async () => {
      layouts = await measureHfillLayouts(hfillCases.map(([, paragraph]) => paragraph));
    }, 90_000);

    it.each(
      hfillCases.map(([label], index) => [label, index] as const),
    )("hfill は箇条書きのマーカーと同じ行にあり、%s の後へ続かない", (_label, index) => {
      const measured = layouts[index];
      if (!measured) throw new Error("Chrome did not measure this case");
      expect(measured.itemFillTop).toBeCloseTo(measured.itemTop, 1);
      expect(measured.itemHeight).toBeLessThan(measured.itemLineHeight * 1.5);
      expect(measured.lineFillRight).toBeCloseTo(measured.paragraphRight, 1);
      expect(measured.nextTop).toBeGreaterThan(measured.lineFillTop);
      expect(measured.nextLeft).toBeCloseTo(measured.paragraphLeft, 1);
    });
  });

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
        if (/\.alert(?![\w-])/.test(part) && !part.includes(".block-title")) {
          expect(part, `${part} は .beamer-block を除外する`).toContain(":not(.beamer-block)");
        }
      }
    }
  });

  it("block の種類別タイトル色は直下の .block-title だけに当てる(入れ子の block へ漏らさない)", () => {
    const sheet = injectPreviewCss();
    for (const rule of styleRules(sheet)) {
      for (const part of rule.selectorText.split(",").map((p) => p.trim())) {
        if (/\.beamer-block\.[\w-]+/.test(part) && part.includes(".block-title")) {
          expect(part, `${part} は .block-title を > で繋ぐ`).toMatch(
            /\.beamer-block\.[\w-]+\s*>\s*\.block-title/,
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

  it("center の中の箇条書き・段組み・block は左揃えに戻り、リスト自身の \\centering は効く", () => {
    injectPreviewCss();
    const src = String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}{A}
\begin{center}
\begin{itemize}\item a\end{itemize}
\begin{block}{B}x\end{block}
\begin{columns}\begin{column}{0.5\textwidth}c\end{column}\end{columns}
\begin{enumerate}\centering\item b\end{enumerate}
\end{center}
\end{frame}
\end{document}
`;
    const html = renderDeck(parseDeck(src)).frames[0]?.html ?? "";
    document.body.innerHTML = `<div class="beamer-preview"><div class="slide">${html}</div></div>`;
    const align = (selector: string) => {
      const element = document.querySelector<HTMLElement>(`.center ${selector}`);
      if (!element) throw new Error(`${selector} was not rendered`);
      return getComputedStyle(element).textAlign;
    };
    expect(align("ul")).toBe("left");
    expect(align(".beamer-block")).toBe("left");
    expect(align(".columns")).toBe("left");
    expect(align("ol")).toBe("center");
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
