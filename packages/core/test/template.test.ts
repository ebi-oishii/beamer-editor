import { describe, expect, it } from "vitest";
import { parseDeck } from "../src/parser.js";
import {
  extractPreviewStyle,
  graphicsPathsOf,
  joinImageSearchPath,
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

describe("背景・ロゴ抽出の書き方の揺れ(#192)", () => {
  const bg = (source: string) => extractPreviewStyle(source).background?.path;

  it("コマンド名と引数の間の空白・改行・コメントを許す", () => {
    expect(bg("\\usebackgroundtemplate {\\includegraphics{a.png}}")).toBe("a.png");
    expect(bg("\\usebackgroundtemplate\n  {\\includegraphics{a.png}}")).toBe("a.png");
    expect(bg("\\setbeamertemplate{background}%\n{\\includegraphics{b.png}}")).toBe("b.png");
    expect(
      bg("\\setbeamertemplate {background canvas} % 説明\n % 続き\n {\\includegraphics{c.png}}"),
    ).toBe("c.png");
    expect(bg("\\usebackgroundtemplate{\\includegraphics [width=\\paperwidth] {d.png}}")).toBe(
      "d.png",
    );
  });

  it("空行(\\par)は越えて引数を探さない", () => {
    expect(bg("\\usebackgroundtemplate\n\n{\\includegraphics{a.png}}")).toBeUndefined();
    expect(bg("\\setbeamertemplate{background}\n\n{\\includegraphics{a.png}}")).toBeUndefined();
    // コメントだけの行は空行ではない。
    expect(bg("\\usebackgroundtemplate\n%\n{\\includegraphics{a.png}}")).toBe("a.png");
  });

  it("\\addtobeamertemplate{background} の前・後どちらの画像も背景になる", () => {
    expect(bg("\\addtobeamertemplate{background}{\\includegraphics{pre.png}}{}")).toBe("pre.png");
    expect(bg("\\addtobeamertemplate{background canvas}{}{\\includegraphics{post.png}}")).toBe(
      "post.png",
    );
    expect(bg("\\addtobeamertemplate{headline}{}{\\includegraphics{no.png}}")).toBeUndefined();
  });

  it("背景のコマンドはコマンドの種類をまたいでソース順に最後が勝つ", () => {
    expect(
      bg(
        "\\addtobeamertemplate{background}{}{\\includegraphics{first.png}}\n\\usebackgroundtemplate{\\includegraphics{last.png}}",
      ),
    ).toBe("last.png");
  });

  it("\\newcommand / \\def で単純な文字列に定義された画像パスを展開する", () => {
    const use = "\\usebackgroundtemplate{\\includegraphics{\\bgimage}}";
    expect(bg(`\\newcommand{\\bgimage}{images/bg.png}\n${use}`)).toBe("images/bg.png");
    expect(bg(`\\newcommand\\bgimage{images/bg.png}\n${use}`)).toBe("images/bg.png");
    expect(bg(`\\renewcommand{\\bgimage}{x.png}\n\\renewcommand{\\bgimage}{y.png}\n${use}`)).toBe(
      "y.png",
    );
    expect(bg(`\\def\\bgimage{images/bg.png}\n${use}`)).toBe("images/bg.png");
    // 本文がマクロを含む・未定義のときは展開しない。
    expect(bg(`\\newcommand{\\bgimage}{\\dir/bg.png}\n${use}`)).toBe("\\bgimage");
    expect(bg(use)).toBe("\\bgimage");
    // コメントの中の定義は見ない。
    expect(bg(`% \\newcommand{\\bgimage}{no.png}\n${use}`)).toBe("\\bgimage");
  });

  it("展開は .sty の画像一覧(L023 用)にも効く", () => {
    expect(templateImagePaths("\\newcommand{\\img}{a.png}\n\\includegraphics{\\img}")).toEqual([
      "a.png",
    ]);
  });
});

describe("graphicsPathsOf / imageSearchPaths", () => {
  it("\\graphicspath の探索ディレクトリを出現順に拾い、コメントの中は見ない", () => {
    expect(
      graphicsPathsOf(
        "% \\graphicspath{{old/}}\n\\graphicspath{ {images/} {figs/} }\n\\graphicspath{{images/}{../shared/}}",
      ),
    ).toEqual(["images/", "figs/", "../shared/"]);
    expect(graphicsPathsOf("\\includegraphics{a.png}")).toEqual([]);
  });

  it("extractPreviewStyle が探索ディレクトリを載せ、mergePreviewStyles は連結して重複を除く", () => {
    const a = extractPreviewStyle(
      "\\graphicspath{{images/}}\n\\usebackgroundtemplate{\\includegraphics{bg.png}}",
    );
    expect(a.imageSearchPaths).toEqual(["images/"]);
    expect(a.background).toEqual({ path: "bg.png" });
    expect(extractPreviewStyle("\\setsansfont{X}").imageSearchPaths).toBeUndefined();
    const merged = mergePreviewStyles(a, {
      colors: {},
      fonts: {},
      imageSearchPaths: ["figs/", "images/"],
    });
    expect(merged.imageSearchPaths).toEqual(["images/", "figs/"]);
    expect(mergePreviewStyles(a, { colors: {}, fonts: {} }).imageSearchPaths).toEqual(["images/"]);
  });

  it("joinImageSearchPath は ./ と末尾の / を整える", () => {
    expect(joinImageSearchPath("images/", "bg.png")).toBe("images/bg.png");
    expect(joinImageSearchPath("./images", "bg.png")).toBe("images/bg.png");
    expect(joinImageSearchPath("./", "bg.png")).toBe("bg.png");
    expect(joinImageSearchPath("../x/", "bg.png")).toBe("../x/bg.png");
  });
});

describe("\\deckbackground を .sty で読む", () => {
  it("無印は全スライドの背景、[title] は土台では無視する", () => {
    expect(extractPreviewStyle("\\deckbackground{a.png}").background).toEqual({ path: "a.png" });
    expect(extractPreviewStyle("\\deckbackground[title]{t.png}").background).toBeUndefined();
  });
});

describe("本文の左右の余白(\\setbeamersize。#159)", () => {
  it("text margin left / right を pt で読み、空白や単位の揺れを吸収する", () => {
    expect(
      extractPreviewStyle("\\setbeamersize{text margin left=5mm,text margin right=0.5cm}")
        .textMargins,
    ).toEqual({ left: 14.225, right: 14.225 });
    expect(
      extractPreviewStyle("\\setbeamersize{ text  margin left = 10pt }\n").textMargins,
    ).toEqual({ left: 10 });
  });

  it("絶対単位でない長さや、他のキーは読まない", () => {
    expect(
      extractPreviewStyle("\\setbeamersize{text margin left=0.05\\paperwidth}").textMargins,
    ).toBeUndefined();
    expect(
      extractPreviewStyle("\\setbeamersize{sidebar width left=2cm}").textMargins,
    ).toBeUndefined();
    expect(
      extractPreviewStyle("% \\setbeamersize{text margin left=5mm}").textMargins,
    ).toBeUndefined();
  });

  it("mergePreviewStyles は側ごとに後の指定で上書きする", () => {
    const merged = mergePreviewStyles(
      { colors: {}, fonts: {}, textMargins: { left: 10, right: 20 } },
      { colors: {}, fonts: {}, textMargins: { right: 5 } },
    );
    expect(merged.textMargins).toEqual({ left: 10, right: 5 });
  });
});
