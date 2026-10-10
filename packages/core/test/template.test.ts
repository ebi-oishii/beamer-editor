import { describe, expect, it } from "vitest";
import { parseDeck } from "../src/parser.js";
import {
  extractPreviewStyle,
  mergePreviewStyles,
  parseLength,
  templateImagePaths,
  templateReferencesOf,
} from "../src/template.js";

const deckWithExtra = (extra: string) => `\\documentclass[aspectratio=169]{beamer}
%% preamble-extra:begin
${extra}
%% preamble-extra:end
\\begin{document}
\\begin{frame}{T}x\\end{frame}
\\end{document}
`;

describe("templateReferencesOf", () => {
  it("\\usetheme と \\usepackage を参照にし、同梱テーマとコメントは除く", () => {
    const source = deckWithExtra(`\\usetheme{corporate}
\\usetheme[hideothersubsections]{Berlin,acme}
% \\usetheme{commented}
\\usepackage[institute=Med]{templates/fau/beamerthemefau}
\\usepackage{tikz}`);
    const refs = templateReferencesOf(parseDeck(source));
    expect(refs.map((ref) => [ref.kind, ref.name, ref.file])).toEqual([
      ["theme", "corporate", "beamerthemecorporate.sty"],
      ["theme", "acme", "beamerthemeacme.sty"],
      ["package", "templates/fau/beamerthemefau", "templates/fau/beamerthemefau.sty"],
      ["package", "tikz", "tikz.sty"],
    ]);
    // span は元ソース上の \\usetheme{...} を指す。
    const first = refs[0];
    expect(source.slice(first?.span.start, first?.span.end)).toBe("\\usetheme{corporate}");
  });

  it("\\usetheme と \\usepackage が混在してもソース順で返す(後の指定が勝つ TeX の合成順に合わせる)", () => {
    const refs = templateReferencesOf(
      parseDeck(deckWithExtra("\\usepackage{templates/a/beamerthemea}\n\\usetheme{b}")),
    );
    expect(refs.map((ref) => ref.name)).toEqual(["templates/a/beamerthemea", "b"]);
  });

  it("preamble-extra が無ければ空", () => {
    const source = "\\documentclass{beamer}\n\\begin{document}\\end{document}\n";
    expect(templateReferencesOf(parseDeck(source))).toEqual([]);
  });
});

describe("extractPreviewStyle", () => {
  it("definecolor / setbeamercolor / フォント / logo / 背景 を標準記法から拾う", () => {
    const sty = `\\ProvidesPackage{beamerthemecorporate}
\\definecolor{corpblue}{HTML}{0f62fe}
\\definecolor{corpred}{RGB}{218,30,40}
\\definecolor{soft}{rgb}{0.5,0.5,1}
\\colorlet{accent}{corpred}
\\setbeamercolor{structure}{fg=corpblue}
\\setbeamercolor{alerted text}{fg=accent}
\\setbeamercolor*{normal text}{fg=black,bg=white}
\\setbeamercolor{background canvas}{bg=soft}
\\setbeamercolor{frametitle}{fg=corpblue} % 対応外の役割は無視
\\setsansfont[Scale=0.9]{Noto Sans CJK JP}
\\setmonofont{Source Han Code JP}
\\logo{\\includegraphics[height=0.6cm,width=0.08\\paperwidth]{templates/corporate/assets/logo.png}}
\\usebackgroundtemplate{\\includegraphics[width=\\paperwidth,height=\\paperheight]{templates/corporate/assets/background.png}}
`;
    expect(extractPreviewStyle(sty)).toEqual({
      colors: {
        structure: "0F62FE",
        alert: "DA1E28",
        text: "000000",
        background: "8080FF",
      },
      fonts: { main: "Noto Sans CJK JP", mono: "Source Han Code JP" },
      logo: {
        path: "templates/corporate/assets/logo.png",
        placement: { kind: "corner", width: { unit: "paperwidth", value: 0.08 } },
      },
      background: { path: "templates/corporate/assets/background.png" },
    });
  });

  it("pgfdeclareimage + pgfuseimage と setbeamertemplate{background canvas} も読む", () => {
    const sty = `\\pgfdeclareimage[width=1.2cm]{corplogo}{assets/logo}
\\logo{\\pgfuseimage{corplogo}}
\\setbeamertemplate{background canvas}{\\pgfuseimage{bg}}
\\pgfdeclareimage{bg}{assets/bg.png}
\\setbeamertemplate{footline}{\\insertframenumber}`;
    const style = extractPreviewStyle(sty);
    expect(style.logo).toEqual({
      path: "assets/logo",
      placement: { kind: "corner", width: { unit: "pt", value: 1.2 * 28.45 } },
    });
    expect(style.background).toEqual({ path: "assets/bg.png" });
  });

  it("ツールの語彙(\\deckcolor 等)が .sty にあれば読み、コメント行は無視する", () => {
    const sty = `\\deckcolor{structure}{112233}
% \\deckcolor{alert}{FFFFFF}
\\deckfont{main}{Hiragino Sans}
\\decklogo[x=0.900,y=0.020,w=0.080]{assets/logo.pdf}
\\deckfooter{ACME --- Confidential}`;
    expect(extractPreviewStyle(sty)).toEqual({
      colors: { structure: "112233" },
      fonts: { main: "Hiragino Sans" },
      logo: {
        path: "assets/logo.pdf",
        placement: { kind: "canvas", x: 0.9, y: 0.02, width: 0.08 },
      },
      footer: "ACME --- Confidential",
    });
  });

  it("解釈できない色式(補色・モデル指定・色の参照など)は落とし、他は保つ", () => {
    for (const expression of [
      "-red",
      "rgb:red,1;blue,2",
      "structure.fg!50",
      "red!abc!blue",
      "red!-20!blue",
      "red!50!nosuchcolor",
      "red!",
      "nosuchcolor",
    ]) {
      const style = extractPreviewStyle(
        `\\setbeamercolor{structure}{fg=${expression}}\\setbeamercolor{alerted text}{fg=red}`,
      );
      expect(style.colors, expression).toEqual({ alert: "FF0000" });
    }
  });
});

describe("xcolor の混色式", () => {
  /** \colorlet で色式を読み、structure に使って RRGGBB を取り出す。 */
  const mix = (expression: string, preamble = "") =>
    extractPreviewStyle(
      `${preamble}\\colorlet{probe}{${expression}}\\setbeamercolor{structure}{fg=probe}`,
    ).colors.structure;

  // 期待値は Tectonic(xcolor)で \extractcolorspecs した値を 255 倍して丸めたもの。
  it("a!p!b は p% の a と残りの b、a!p は残りを white で混ぜる", () => {
    expect(mix("red!75!black")).toBe("BF0000"); // rgb:0.75,0,0
    expect(mix("blue!6")).toBe("F0F0FF"); // rgb:0.94,0.94,1
    expect(mix("black!20")).toBe("CCCCCC"); // gray:0.8
    expect(mix("red!33.3!blue")).toBe("5500AA"); // rgb:0.333,0,0.667
  });

  it("連鎖は左から順に、途中の結果を次の a として混ぜる", () => {
    expect(mix("red!30!green!40!blue")).toBe("1F4799"); // rgb:0.12,0.28,0.6
    expect(mix("red!30!green!40")).toBe("B8E099"); // rgb:0.72,0.88,0.6
  });

  it("\\definecolor / \\colorlet の名前も混ぜられ、割合は 0〜100 に丸める", () => {
    expect(mix("corp!50!white", "\\definecolor{corp}{HTML}{0F62FE}")).toBe("87B1FF");
    expect(mix("mid!50", "\\colorlet{mid}{red!40!blue}")).toBe("B380CC");
    expect(mix("red!150!blue")).toBe("FF0000");
    expect(mix("red!0!blue")).toBe("0000FF");
  });

  it("\\setbeamercolor の値にも直接書ける", () => {
    expect(
      extractPreviewStyle("\\setbeamercolor{alerted text}{fg=red!75!black}").colors.alert,
    ).toBe("BF0000");
  });
});

describe("ブロックの配色と形", () => {
  const ISSUE_193 = `\\setbeamertemplate{blocks}[rounded][shadow=true]
\\setbeamercolor{block title}{bg=blue!75!black,fg=white}
\\setbeamercolor{block body}{bg=blue!6,fg=black}
\\setbeamercolor{block title alerted}{bg=red!75!black,fg=white}
\\setbeamercolor{block body alerted}{bg=red!6,fg=black}
\\setbeamercolor{block title example}{bg=green!50!black,fg=white}
\\setbeamercolor{block body example}{bg=green!6,fg=black}`;

  it("block title / block body(alerted / example 含む)と角丸・影を読む", () => {
    expect(extractPreviewStyle(ISSUE_193)).toEqual({
      colors: {},
      fonts: {},
      blocks: {
        colors: {
          normal: { titleBg: "0000BF", titleFg: "FFFFFF", bodyBg: "F0F0FF", bodyFg: "000000" },
          alerted: { titleBg: "BF0000", titleFg: "FFFFFF", bodyBg: "FFF0F0", bodyFg: "000000" },
          example: { titleBg: "008000", titleFg: "FFFFFF", bodyBg: "F0FFF0", bodyFg: "000000" },
        },
        shape: { rounded: true, shadow: true },
      },
    });
  });

  it("書かれた種類・部位だけを持ち、alerted / example へは継がせない(継承はプレビュー側)", () => {
    const style = extractPreviewStyle(
      "\\setbeamercolor{block title}{bg=blue}\\setbeamercolor{block body}{bg=white}",
    );
    expect(style.blocks).toEqual({ colors: { normal: { titleBg: "0000FF", bodyBg: "FFFFFF" } } });
  });

  it("後の指定がキーごとに勝ち、* 付き・空白の揺れも読み、use= / parent= と解釈できない色は無視する", () => {
    const style = extractPreviewStyle(`\\setbeamercolor{block title alerted}{bg=red,fg=white}
\\setbeamercolor*{block  title alerted}{use=structure,parent=alerted text,bg=red!75!black}
\\setbeamercolor{block body example}{fg=structure.fg,bg=-green}`);
    expect(style.blocks).toEqual({ colors: { alerted: { titleBg: "BF0000", titleFg: "FFFFFF" } } });
  });

  it("ブロックの指定が無ければ blocks を持たない", () => {
    expect(extractPreviewStyle("\\setbeamercolor{structure}{fg=red}").blocks).toBeUndefined();
  });

  it("形は \\setbeamertemplate{blocks} と \\useinnertheme{rounded} の記述順で後が勝つ", () => {
    const shape = (source: string) => extractPreviewStyle(source).blocks?.shape;
    expect(shape("\\setbeamertemplate{blocks}[rounded]")).toEqual({ rounded: true, shadow: false });
    expect(shape("\\setbeamertemplate{blocks}[rounded][shadow]")).toEqual({
      rounded: true,
      shadow: true,
    });
    expect(shape("\\setbeamertemplate{blocks}[rounded][shadow=false]")).toEqual({
      rounded: true,
      shadow: false,
    });
    expect(shape("\\useinnertheme[shadow]{rounded}")).toEqual({ rounded: true, shadow: true });
    expect(shape("\\useinnertheme[shadow=true]{rounded}")).toEqual({ rounded: true, shadow: true });
    expect(shape("\\useinnertheme{rounded}")).toEqual({ rounded: true, shadow: false });
    expect(shape("\\useinnertheme[shadow]{rounded}\n\\setbeamertemplate{blocks}[default]")).toEqual(
      { rounded: false, shadow: false },
    );
    expect(shape("\\setbeamertemplate{blocks}[default]\n\\useinnertheme{rounded}")).toEqual({
      rounded: true,
      shadow: false,
    });
    // 他の内側テーマ・コメントアウトは形を変えない。
    expect(
      shape("\\useinnertheme{circles}\n% \\setbeamertemplate{blocks}[rounded]"),
    ).toBeUndefined();
  });
});

describe("parseLength / mergePreviewStyles / templateImagePaths", () => {
  it("長さ指定を pt か係数に解釈する", () => {
    expect(parseLength("1cm")).toEqual({ unit: "pt", value: 28.45 });
    expect(parseLength(" 10 mm ")).toEqual({ unit: "pt", value: 28.45 });
    expect(parseLength("0.1\\paperwidth")).toEqual({ unit: "paperwidth", value: 0.1 });
    expect(parseLength("\\textwidth")).toEqual({ unit: "textwidth", value: 1 });
    expect(parseLength("2em")).toBeNull();
  });

  it("後のスタイルが前を上書きする", () => {
    const merged = mergePreviewStyles(
      { colors: { structure: "111111", alert: "222222" }, fonts: { main: "A" } },
      { colors: { structure: "333333" }, fonts: {}, footer: "f" },
    );
    expect(merged).toEqual({
      colors: { structure: "333333", alert: "222222" },
      fonts: { main: "A" },
      footer: "f",
    });
  });

  it("ブロックの配色は種類・キーごとに、形は丸ごと後のスタイルが上書きする", () => {
    const merged = mergePreviewStyles(
      {
        colors: {},
        fonts: {},
        blocks: {
          colors: {
            normal: { titleBg: "111111", bodyBg: "222222" },
            alerted: { titleBg: "333333" },
          },
          shape: { rounded: true, shadow: true },
        },
      },
      { colors: {}, fonts: {} },
      {
        colors: {},
        fonts: {},
        blocks: {
          colors: { normal: { titleBg: "444444" }, example: { bodyFg: "555555" } },
          shape: { rounded: false, shadow: false },
        },
      },
    );
    expect(merged.blocks).toEqual({
      colors: {
        normal: { titleBg: "444444", bodyBg: "222222" },
        alerted: { titleBg: "333333" },
        example: { bodyFg: "555555" },
      },
      shape: { rounded: false, shadow: false },
    });
    expect(mergePreviewStyles({ colors: {}, fonts: {} }).blocks).toBeUndefined();
    expect(
      mergePreviewStyles(
        { colors: {}, fonts: {}, blocks: { colors: {}, shape: { rounded: true, shadow: false } } },
        { colors: {}, fonts: {}, blocks: { colors: { normal: { titleFg: "FFFFFF" } } } },
      ).blocks,
    ).toEqual({
      colors: { normal: { titleFg: "FFFFFF" } },
      shape: { rounded: true, shadow: false },
    });
  });

  it(".sty が参照する画像パスを列挙する", () => {
    expect(
      templateImagePaths(
        "\\includegraphics[width=1cm]{a.png} % \\includegraphics{no.png}\n\\pgfdeclareimage{x}{b} \\includegraphics{a.png}",
      ),
    ).toEqual(["a.png", "b"]);
  });
});
