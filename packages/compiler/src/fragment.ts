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

/**
 * standalone 文書の組み立て方の版。buildFragmentDocument の前置きを変えたら上げる。
 * 画像キャッシュの置き場に入り、古い組み立て方で作った PDF を使い続けない。
 */
export const FRAGMENT_DOCUMENT_VERSION = 1;

const FILE_ARGUMENT =
  /\\(?:includegraphics|includepdf|includesvg|includestandalone|input|include|InputIfFileExists|lstinputlisting|verbatiminput|pgfplotstableread)\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g;
const PLOT_TABLE = /\\addplot\s*(?:\[[^\]]*\])?\s*table\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g;
const PACKAGES = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g;

/**
 * 生ブロック(と前置き)が参照する外部ファイルの候補(原文のまま、出現順、重複なし)。
 * 画像・入力ファイル・データ表・ローカルの .sty を拾う。実在するか・拡張子の補完は呼び出し側が決める。
 * コメントの中は見ない。中身がファイル名に見えないもの(改行や `\\` を含む、`\\addplot table {…}` の
 * インラインデータなど)は拾わない。
 */
export function fragmentDependencies(tex: string): string[] {
  const code = tex.replace(/(^|[^\\])%[^\n]*/g, "$1");
  const hits: { index: number; name: string }[] = [];
  const collect = (pattern: RegExp, expand: (value: string) => string[]) => {
    for (const match of code.matchAll(pattern)) {
      for (const name of expand(match[1] ?? "")) hits.push({ index: match.index ?? 0, name });
    }
  };
  collect(FILE_ARGUMENT, (value) => [value.trim()]);
  collect(PLOT_TABLE, (value) => [value.trim()]);
  collect(PACKAGES, (value) =>
    value
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "")
      .map((name) => `${name}.sty`),
  );
  hits.sort((a, b) => a.index - b.index);
  const found = new Set<string>();
  for (const { name } of hits) if (name !== "" && !/[\\\n%]/.test(name)) found.add(name);
  return [...found];
}
