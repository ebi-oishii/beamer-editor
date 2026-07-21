/**
 * `deck` コマンドライン本体(スタイルトラック S2。theme-design.md §4)。
 *
 * 現状のサブコマンドはフォント解決のみ:
 *   deck fonts status [--json]        全 family の解決状態(installed/cached/missing/unknown-family)
 *   deck fonts fetch [family] [--json]  family(既定 "Noto Sans CJK JP")を取得・配置
 *
 * 引数パースは自前の純関数 parseArgs に閉じ込め、依存を足さずに単体テストできるようにする。
 * --json は機械可読(ai-protocol の流儀)。人間向けは 1 行ずつの簡潔なテキスト。
 * エラーは終了コード非 0 + 人間可読メッセージ(stderr)。
 */

import { pathToFileURL } from "node:url";
import {
  defaultFontPaths,
  type FetchResult,
  FONT_CATALOG,
  type FontResolution,
  fetchFont,
  nodeFontIO,
  resolveFont,
} from "./fonts.ts";

/** 既定で取得する標準フォント(theme-design.md §4)。 */
const DEFAULT_FAMILY = "Noto Sans CJK JP";

export interface ParsedArgs {
  /** トップコマンド(例 "fonts")。省略時は undefined。 */
  command: string | undefined;
  /** サブコマンド(例 "status" / "fetch")。省略時は undefined。 */
  sub: string | undefined;
  /** 位置引数の family(fetch の対象)。省略時は undefined。 */
  family: string | undefined;
  /** --json フラグ。 */
  json: boolean;
}

/**
 * argv(process.argv.slice(2) 相当)を解析する純関数。
 * --json はどこに来ても拾う。フラグ以外の非フラグ語を command / sub / family の順に割り当てる。
 * family は空白を含みうるので、複数語の非フラグ引数は 3 つ目以降も連結して 1 つの family とする。
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
    } else {
      positional.push(arg);
    }
  }
  const [command, sub, ...rest] = positional;
  const family = rest.length > 0 ? rest.join(" ") : undefined;
  return { command, sub, family, json };
}

/** status の 1 family 分を JSON 向けの素な形へ落とす。 */
function resolutionToJson(r: FontResolution) {
  return {
    family: r.family,
    status: r.status,
    license: r.license,
    files: r.files.map((f) => ({
      fileName: f.fileName,
      inUserDir: f.inUserDir,
      inCache: f.inCache,
    })),
  };
}

/** 状態の 1 行テキスト表現。 */
function statusLine(r: FontResolution): string {
  const detail =
    r.status === "unknown-family"
      ? "(名前参照のみ・各自インストール)"
      : `${r.files.length} ファイル / ${r.license ?? "-"}`;
  return `  [${r.status.padEnd(14)}] ${r.family}  ${detail}`;
}

async function runFontsStatus(json: boolean): Promise<number> {
  const paths = defaultFontPaths();
  const resolutions: FontResolution[] = [];
  for (const entry of FONT_CATALOG) {
    resolutions.push(await resolveFont(entry.family, paths, nodeFontIO));
  }
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          cacheDir: paths.cacheDir,
          userFontDir: paths.userFontDir,
          fonts: resolutions.map(resolutionToJson),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  process.stdout.write(`フォント解決状態(cache: ${paths.cacheDir})\n`);
  if (resolutions.length === 0) {
    process.stdout.write("  (カタログが空です)\n");
  }
  for (const r of resolutions) {
    process.stdout.write(`${statusLine(r)}\n`);
  }
  return 0;
}

async function runFontsFetch(family: string, json: boolean): Promise<number> {
  const paths = defaultFontPaths();
  const before = await resolveFont(family, paths, nodeFontIO);
  if (before.status === "unknown-family") {
    // カタログ外は取得できない。名前参照のみとして案内し、非 0 で終える。
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ family, status: "unknown-family", fetched: [], installed: [] }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(
        `未知のフォント family: ${family}\n` +
          "  カタログに無いフォントは名前参照のみです。各自でインストールしてください。\n",
      );
    }
    return 1;
  }
  const result: FetchResult = await fetchFont(family, paths, nodeFontIO);
  if (json) {
    process.stdout.write(`${JSON.stringify({ family, status: "ok", ...result }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`フォント取得: ${family}\n`);
  process.stdout.write(
    `  取得 ${result.fetched.length} / スキップ ${result.skipped.length} / 配置 ${result.installed.length}\n`,
  );
  for (const f of result.fetched) process.stdout.write(`  取得: ${f}\n`);
  for (const f of result.skipped) process.stdout.write(`  スキップ(キャッシュ済み): ${f}\n`);
  for (const f of result.installed) process.stdout.write(`  配置: ${f}\n`);
  if (paths.userFontDir === null) {
    process.stdout.write("  (userFontDir 不明のため配置はスキップ・キャッシュのみ)\n");
  }
  return 0;
}

const USAGE = `使い方: deck <command> ...

  deck fonts status [--json]         フォントカタログ全 family の解決状態
  deck fonts fetch [family] [--json]  family(既定 "${DEFAULT_FAMILY}")を取得・配置
`;

/** サブコマンドのディスパッチ。終了コードを返す(副作用は stdout/stderr のみ)。 */
export async function run(argv: readonly string[]): Promise<number> {
  const { command, sub, family, json } = parseArgs(argv);
  if (command === "fonts") {
    if (sub === "status") return runFontsStatus(json);
    if (sub === "fetch") return runFontsFetch(family ?? DEFAULT_FAMILY, json);
    process.stderr.write(`不明なサブコマンド: fonts ${sub ?? ""}\n${USAGE}`);
    return 2;
  }
  process.stderr.write(command ? `不明なコマンド: ${command}\n${USAGE}` : USAGE);
  return command ? 2 : 0;
}

// エントリポイント(import されたときは実行しない)。
// Windows のパス形式でも一致するよう pathToFileURL で比較する(Node 標準イディオム)。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`エラー: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
