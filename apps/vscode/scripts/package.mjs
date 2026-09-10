/**
 * .vsix を作る。既定は今の環境向けのプラットフォーム別 VSIX(Tectonic 同梱)。
 *
 *   node scripts/package.mjs [--target <vscode target>|universal] [--out <file>]
 *
 * --target universal は Tectonic を同梱しない汎用 VSIX(対象外の環境向け。PATH の tectonic を使う)。
 * 事前に pnpm build 済みであること(package スクリプトが面倒を見る)。
 */

import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchTectonic, targetForPlatform } from "./fetch-tectonic.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const binDir = join(root, "bin");

function parseArgs(argv) {
  const options = { target: undefined, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") continue; // pnpm run が透過させる区切り
    if (argv[i] === "--target") options.target = argv[++i];
    else if (argv[i] === "--out") options.out = argv[++i];
    else throw new Error(`不明な引数: ${argv[i]}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const target = options.target ?? targetForPlatform() ?? "universal";
const out = options.out ?? "beamer-editor.vsix";

// 前のターゲットのバイナリが残っていると別環境のものを積むので、毎回作り直す。
rmSync(binDir, { recursive: true, force: true });
if (target !== "universal") await fetchTectonic(target, binDir);
else console.log("universal: Tectonic は同梱しない(PATH の tectonic を使う)");

const args = ["package", "--no-dependencies", "-o", out];
if (target !== "universal") args.push("--target", target);
// .cmd シムやシェルを介さず、Windows でも空白・特殊文字を含む引数をそのまま渡す。
const vsce = fileURLToPath(import.meta.resolve("@vscode/vsce/vsce"));
execFileSync(process.execPath, [vsce, ...args], { cwd: root, stdio: "inherit" });
if (!existsSync(resolve(root, out))) throw new Error(`${out} が作られていない`);
console.log(`${out} (${target})`);
