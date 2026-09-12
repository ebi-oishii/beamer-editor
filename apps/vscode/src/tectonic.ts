/**
 * 実行に使う Tectonic の場所(#130)。設定 > 同梱 > PATH の順に決める。
 *
 * プラットフォーム別 VSIX には拡張ディレクトリの bin/ に公式バイナリを同梱している(scripts/fetch-tectonic.mjs)。
 * 同梱の無い環境(汎用 VSIX、対象外のプラットフォーム)では従来どおり PATH の `tectonic` に任せる。
 */

import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { join } from "node:path";
import { normalizeTectonicPath } from "./export-controller";

export interface BundledTectonicHost {
  platform: NodeJS.Platform;
  existsSync(path: string): boolean;
  accessSync(path: string, mode: number): void;
  chmodSync(path: string, mode: number): void;
}

const nodeHost: BundledTectonicHost = {
  platform: process.platform,
  existsSync,
  accessSync,
  chmodSync,
};

/** 同梱バイナリの置き場。Windows だけ拡張子が付く。 */
export function bundledTectonicPath(extensionPath: string, platform: NodeJS.Platform): string {
  return join(extensionPath, "bin", platform === "win32" ? "tectonic.exe" : "tectonic");
}

/**
 * 同梱バイナリがあればその絶対パスを返し、無ければ undefined。VSIX の展開で実行権限が落ちることがあるので、
 * 実行できなければ 0o755 を付け直す(付け直せなくても、あるものとして返し、実行時の失敗は既存の
 * E_TECTONIC_NOT_FOUND / E_TECTONIC_VERSION の経路で知らせる)。
 */
export function detectBundledTectonic(
  extensionPath: string,
  host: BundledTectonicHost = nodeHost,
): string | undefined {
  const path = bundledTectonicPath(extensionPath, host.platform);
  if (!host.existsSync(path)) return undefined;
  if (host.platform !== "win32") {
    try {
      host.accessSync(path, constants.X_OK);
    } catch {
      try {
        host.chmodSync(path, 0o755);
      } catch {
        // 読み取り専用の場所など。実行時のエラーに任せる。
      }
    }
  }
  return path;
}

/** 設定で指定があればそれ、無ければ同梱、それも無ければ undefined(PATH の tectonic)。 */
export function resolveTectonicPath(
  configured: string | undefined,
  bundled: string | undefined,
): string | undefined {
  return configured ?? bundled;
}

/**
 * VS Code の設定値(生)から実行に使う Tectonic を決める。PDF 書き出しも生ブロックの部分コンパイル(#112)も
 * 必ずここを通し、「設定 > 同梱 > PATH」を両方で揃える。
 */
export function tectonicPathFromConfig(
  value: unknown,
  bundled: string | undefined,
): string | undefined {
  return resolveTectonicPath(normalizeTectonicPath(value), bundled);
}
