/**
 * 生ブロックを standalone 文書として組み立てる(#81)。TeX 文字列の生成だけで、プロセスは起動しない。
 */

/** beamer 専用で standalone では未定義になる前置き(テーマ・色・テンプレート・ロゴ)。行単位で落とす。 */
const BEAMER_ONLY_LINE =
  /^\s*\\(usetheme|usecolortheme|usefonttheme|useinnertheme|useoutertheme|setbeamercolor\*?|setbeamerfont\*?|setbeamertemplate|setbeamercovered|setbeamersize|logo|usebackgroundtemplate|titlegraphic|institute|beamertemplatenavigationsymbolsempty)\b/;

/**
 * standalone(preview)の文書。beamer が暗黙に読み込むパッケージのうち生ブロックが頼りがちなもの
 * (amsmath / amssymb / graphicx / xcolor)と、beamer 既定のサンセリフ本文を前置し、
 * その後に preamble-extra とマクロ定義(beamer 専用の行は除く)、最後に生ブロック本文を置く。
 */
export function buildFragmentDocument(body: string, preamble: string): string {
  const kept = preamble
    .split(/\r?\n/)
    .filter((line) => !BEAMER_ONLY_LINE.test(line))
    .join("\n")
    .trim();
  return [
    "\\documentclass[preview,border=2pt]{standalone}",
    "\\usepackage{amsmath,amssymb,graphicx,xcolor}",
    "\\renewcommand{\\familydefault}{\\sfdefault}",
    kept,
    "\\begin{document}",
    body.trim(),
    "\\end{document}",
    "",
  ]
    .filter((line, index, all) => line !== "" || index === all.length - 1)
    .join("\n");
}
