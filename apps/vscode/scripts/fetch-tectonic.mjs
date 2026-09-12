/**
 * 同梱する Tectonic の公式バイナリを取得して apps/vscode/bin/ に置く(#130)。
 *
 *   node scripts/fetch-tectonic.mjs [--target <vscode target>] [--out <dir>]
 *
 * 版・対象・アーカイブ名・sha256 は tectonic.json に固定してある。アーカイブは .tectonic-cache/ に置いて
 * 再利用し、sha256 が合わなければ失敗する。対象を省くと今の環境(process.platform / arch)向け。
 * 展開には tar(.tar.gz)と unzip(.zip)を使う。Windows の ZIP は標準の tar で展開する。
 *
 * 公式アーカイブはバイナリしか入っていないので、再配布に必要な Tectonic の LICENSE(MIT)を同じ版の
 * 上流から取って並べ、何をどこから同梱したかを書いた NOTICE も置く(#131 のレビュー指摘)。
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

/** 同梱物と並べる NOTICE のファイル名。中身は同梱した版・対象・取得元から作る。 */
export const NOTICE_FILE = "tectonic-NOTICE.md";

export function assetUrl(target, manifest = MANIFEST) {
  const entry = manifest.targets[target];
  if (!entry) throw new Error(`tectonic.json に対象 ${target} が無い`);
  return manifest.releaseUrl.replace("{version}", manifest.version).replace("{asset}", entry.asset);
}

/** 再配布する LICENSE の取得元。版は tectonic.json に固定した版で埋める。 */
export function licenseUrl(manifest = MANIFEST) {
  if (!manifest.license) throw new Error("tectonic.json に license が無い");
  return manifest.license.sourceUrl.replace("{version}", manifest.version);
}

/** 同梱物の出所を書いた NOTICE の本文。VSIX を受け取った人がここだけ読めば分かるようにする。 */
export function noticeText(target, manifest = MANIFEST) {
  const entry = manifest.targets[target];
  if (!entry) throw new Error(`tectonic.json に対象 ${target} が無い`);
  return `# 同梱している Tectonic について

この VSIX には Tectonic の公式リリースバイナリをそのまま同梱しています(ビルドし直してはいません)。

- 版: ${manifest.version}
- 対象: ${target}
- 取得元: ${assetUrl(target, manifest)}
- アーカイブの sha256: ${entry.sha256}
- 実行ファイル: ${entry.binary}

Tectonic は MIT ライセンスで配布されています。
全文は同じディレクトリの ${manifest.license.file} にあります(取得元: ${licenseUrl(manifest)})。

その冒頭が断っているとおり、Tectonic が由来とする各部分は非常に多様なオープンソースライセンスの下にあります。
個別の原典・通知は上流を参照してください: https://github.com/tectonic-typesetting/tectonic
`;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`ダウンロードに失敗: ${url} (${response.status})`);
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

/** キャッシュ経由で取得し、sha256 が manifest と一致することを確かめたファイルのパスを返す。 */
async function cached(cacheDir, name, url, expected) {
  const path = join(cacheDir, name);
  if (!existsSync(path) || sha256(path) !== expected) {
    console.log(`fetch ${url}`);
    await download(url, path);
  }
  const actual = sha256(path);
  if (actual !== expected) {
    rmSync(path, { force: true });
    throw new Error(`${name} の sha256 が一致しない: ${actual} (期待 ${expected})`);
  }
  return path;
}

/**
 * 再配布に必要な Tectonic の LICENSE を取得して outDir に置き、同梱物を説明する NOTICE も書く。
 * 公式アーカイブには LICENSE が入っていないので、同じ版のタグから取る。
 */
export async function fetchTectonicNotices(target, outDir, manifest = MANIFEST) {
  if (!manifest.license) throw new Error("tectonic.json に license が無い");
  const cacheDir = join(root, ".tectonic-cache");
  mkdirSync(cacheDir, { recursive: true });
  const license = await cached(
    cacheDir,
    manifest.license.file,
    licenseUrl(manifest),
    manifest.license.sha256,
  );
  mkdirSync(outDir, { recursive: true });
  copyFileSync(license, join(outDir, manifest.license.file));
  writeFileSync(join(outDir, NOTICE_FILE), noticeText(target, manifest));
}

/**
 * 対象のアーカイブをキャッシュに取得し(sha256 で検証)、バイナリと LICENSE / NOTICE を outDir に置いて
 * バイナリのパスを返す。
 */
export async function fetchTectonic(target, outDir = join(root, "bin"), manifest = MANIFEST) {
  const entry = manifest.targets[target];
  if (!entry)
    throw new Error(
      `tectonic.json に対象 ${target} が無い(対応: ${Object.keys(manifest.targets).join(", ")})`,
    );
  const cacheDir = join(root, ".tectonic-cache");
  mkdirSync(cacheDir, { recursive: true });
  const archive = await cached(cacheDir, entry.asset, assetUrl(target, manifest), entry.sha256);
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
    await fetchTectonicNotices(target, outDir, manifest);
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
