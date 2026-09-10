/**
 * 同梱する Tectonic の公式バイナリを取得して apps/vscode/bin/ に置く(#130)。
 *
 *   node scripts/fetch-tectonic.mjs [--target <vscode target>] [--out <dir>]
 *
 * 版・対象・アーカイブ名・sha256 は tectonic.json に固定してある。アーカイブは .tectonic-cache/ に置いて
 * 再利用し、sha256 が合わなければ失敗する。対象を省くと今の環境(process.platform / arch)向け。
 * 展開には tar(.tar.gz)と unzip(.zip)を使う。Windows の ZIP は標準の tar で展開する。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

export const MANIFEST = JSON.parse(readFileSync(join(root, "tectonic.json"), "utf8"));

/** Node の platform / arch を VS Code の拡張ターゲット名にする。対応が無ければ null。 */
export function targetForPlatform(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const map = {
    "darwin-arm64": "darwin-arm64",
    "darwin-x64": "darwin-x64",
    "linux-x64": "linux-x64",
    "linux-arm64": "linux-arm64",
    "win32-x64": "win32-x64",
  };
  return map[key] ?? null;
}

export function assetUrl(target, manifest = MANIFEST) {
  const entry = manifest.targets[target];
  if (!entry) throw new Error(`tectonic.json に対象 ${target} が無い`);
  return manifest.releaseUrl.replace("{version}", manifest.version).replace("{asset}", entry.asset);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`ダウンロードに失敗: ${url} (${response.status})`);
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

/** 対象のアーカイブをキャッシュに取得し(sha256 で検証)、バイナリを outDir に置いてそのパスを返す。 */
export async function fetchTectonic(target, outDir = join(root, "bin"), manifest = MANIFEST) {
  const entry = manifest.targets[target];
  if (!entry)
    throw new Error(
      `tectonic.json に対象 ${target} が無い(対応: ${Object.keys(manifest.targets).join(", ")})`,
    );
  const cacheDir = join(root, ".tectonic-cache");
  mkdirSync(cacheDir, { recursive: true });
  const archive = join(cacheDir, entry.asset);
  if (!existsSync(archive) || sha256(archive) !== entry.sha256) {
    console.log(`fetch ${assetUrl(target, manifest)}`);
    await download(assetUrl(target, manifest), archive);
  }
  const actual = sha256(archive);
  if (actual !== entry.sha256) {
    rmSync(archive, { force: true });
    throw new Error(`${entry.asset} の sha256 が一致しない: ${actual} (期待 ${entry.sha256})`);
  }
  const work = mkdtempSync(join(tmpdir(), "beamer-editor-tectonic-"));
  try {
    if (entry.asset.endsWith(".zip")) {
      if (process.platform === "win32")
        execFileSync("tar", ["-xf", archive, "-C", work, entry.binary]);
      else execFileSync("unzip", ["-oq", archive, entry.binary, "-d", work]);
    } else execFileSync("tar", ["-xzf", archive, "-C", work, entry.binary]);
    const extracted = join(work, entry.binary);
    if (!existsSync(extracted)) throw new Error(`${entry.asset} に ${entry.binary} が無い`);
    mkdirSync(outDir, { recursive: true });
    const destination = join(outDir, entry.binary);
    rmSync(destination, { force: true });
    // OS の一時ディレクトリと出力先が別ファイルシステムでも配置できるようコピーする。
    copyFileSync(extracted, destination);
    if (!entry.binary.endsWith(".exe")) chmodSync(destination, 0o755);
    return destination;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const target = options.target ?? targetForPlatform();
  if (!target) {
    console.error(
      `この環境(${process.platform}-${process.arch})向けの Tectonic は同梱対象外。--target で指定するか、PATH の tectonic を使う`,
    );
    process.exit(2);
  }
  fetchTectonic(target, options.out ? resolve(options.out) : undefined)
    .then((path) => console.log(`tectonic ${MANIFEST.version} (${target}) -> ${path}`))
    .catch((error) => {
      console.error(String(error instanceof Error ? error.message : error));
      process.exit(1);
    });
}
