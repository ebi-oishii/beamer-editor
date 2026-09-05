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

  it("解釈できない色式(混色など)は落とし、他は保つ", () => {
    const style = extractPreviewStyle(
      "\\setbeamercolor{structure}{fg=blue!50!black}\\setbeamercolor{alerted text}{fg=red}",
    );
    expect(style.colors).toEqual({ alert: "FF0000" });
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

  it(".sty が参照する画像パスを列挙する", () => {
    expect(
      templateImagePaths(
        "\\includegraphics[width=1cm]{a.png} % \\includegraphics{no.png}\n\\pgfdeclareimage{x}{b} \\includegraphics{a.png}",
      ),
    ).toEqual(["a.png", "b"]);
  });
});
