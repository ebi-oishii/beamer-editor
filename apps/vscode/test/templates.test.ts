import { parseDeck } from "@beamer-editor/core";
import { describe, expect, it } from "vitest";
import {
  baseStyleOf,
  imageExists,
  resolveTemplate,
  type TemplateFileSystem,
  templateStatuses,
} from "../src/templates";

/** 相対パス → 内容 のフェイク fs。templates/ 配下のディレクトリ名は登録パスから導く。 */
function fakeFs(files: Record<string, string>): TemplateFileSystem {
  return {
    isFile: (relativePath) => Object.hasOwn(files, relativePath),
    readFile: (relativePath) => files[relativePath] ?? null,
    templateDirs: () =>
      [
        ...new Set(
          Object.keys(files)
            .filter((key) => key.startsWith("templates/"))
            .map((key) => key.split("/")[1] as string),
        ),
      ].sort(),
  };
}

const deckWithExtra = (extra: string) => `\\documentclass[aspectratio=169]{beamer}
%% preamble-extra:begin
${extra}
%% preamble-extra:end
%% style:begin
\\deckcolor{alert}{AA0000}
%% style:end
\\begin{document}
\\begin{frame}{T}x\\end{frame}
\\end{document}
`;

const CORPORATE_STY = `\\definecolor{corpblue}{HTML}{0F62FE}
\\setbeamercolor{structure}{fg=corpblue}
\\logo{\\includegraphics[width=0.08\\paperwidth]{templates/corporate/assets/logo.png}}
\\usebackgroundtemplate{\\includegraphics{templates/corporate/assets/background}}
`;

describe("resolveTemplate / templateStatuses", () => {
  it("\\usetheme はデッキ直下、無ければ templates/*/ から beamertheme<X>.sty を探す", () => {
    const doc = parseDeck(deckWithExtra("\\usetheme{corporate}\\usetheme{acme}"));
    const fs = fakeFs({
      "templates/corporate/beamerthemecorporate.sty": CORPORATE_STY,
      "beamerthemeacme.sty": "\\setbeamercolor{structure}{fg=red}",
    });
    const statuses = templateStatuses(doc, fs);
    expect(statuses.map((s) => [s.reference.name, s.resolvedPath])).toEqual([
      ["corporate", "templates/corporate/beamerthemecorporate.sty"],
      ["acme", "beamerthemeacme.sty"],
    ]);
  });

  it("\\usepackage はパスどおりに探し、見つからなければ null", () => {
    const doc = parseDeck(
      deckWithExtra("\\usepackage{templates/fau/beamerthemefau}\\usepackage{tikz}"),
    );
    const fs = fakeFs({ "templates/fau/beamerthemefau.sty": "" });
    const statuses = templateStatuses(doc, fs);
    expect(statuses.map((s) => s.resolvedPath)).toEqual(["templates/fau/beamerthemefau.sty", null]);
    const first = statuses[0]?.reference;
    if (!first) throw new Error("ref missing");
    expect(resolveTemplate(first, fakeFs({}))).toBeNull();
  });

  it("画像は拡張子なしの参照も TeX と同じ順で探し、欠損だけを報告する", () => {
    const fs = fakeFs({
      "templates/corporate/beamerthemecorporate.sty": CORPORATE_STY,
      "templates/corporate/assets/logo.png": "",
      "templates/corporate/assets/background.png": "",
    });
    expect(imageExists("templates/corporate/assets/background", fs)).toBe(true);
    expect(imageExists("templates/corporate/assets/missing", fs)).toBe(false);
    const doc = parseDeck(deckWithExtra("\\usetheme{corporate}"));
    expect(templateStatuses(doc, fs)[0]?.missingImages).toEqual([]);
    const without = fakeFs({ "templates/corporate/beamerthemecorporate.sty": CORPORATE_STY });
    expect(templateStatuses(doc, without)[0]?.missingImages).toEqual([
      "templates/corporate/assets/logo.png",
      "templates/corporate/assets/background",
    ]);
  });
});

describe("baseStyleOf", () => {
  it("テンプレート → preamble-extra の順で重ね、%% style は renderer 側で上書きする前提", () => {
    const doc = parseDeck(
      deckWithExtra("\\usetheme{corporate}\n\\setbeamercolor{structure}{fg=black}"),
    );
    const fs = fakeFs({ "templates/corporate/beamerthemecorporate.sty": CORPORATE_STY });
    const style = baseStyleOf(doc, fs);
    // preamble-extra の \\setbeamercolor がテンプレートの structure を上書きする。
    expect(style.colors).toEqual({ structure: "000000" });
    expect(style.logo?.path).toBe("templates/corporate/assets/logo.png");
    expect(style.background).toEqual({ path: "templates/corporate/assets/background" });
    // %% style(alert)はここには含まれない。
    expect(style.colors.alert).toBeUndefined();
  });

  it("テンプレートが無くても preamble-extra の標準記法だけで土台を作る", () => {
    const doc = parseDeck(deckWithExtra("\\setbeamercolor{alerted text}{fg=red}"));
    expect(baseStyleOf(doc, fakeFs({})).colors).toEqual({ alert: "FF0000" });
  });
});
