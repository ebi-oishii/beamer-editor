/** fetch-tectonic.mjs の型(テストと package.mjs から使う)。 */
export interface TectonicManifestEntry {
  asset: string;
  sha256: string;
  binary: string;
}
export interface TectonicManifestLicense {
  sourceUrl: string;
  sha256: string;
  file: string;
}
export interface TectonicManifest {
  version: string;
  releaseUrl: string;
  license: TectonicManifestLicense;
  targets: Record<string, TectonicManifestEntry>;
}
export const MANIFEST: TectonicManifest;
export const NOTICE_FILE: string;
export function targetForPlatform(
  platform?: NodeJS.Platform | string,
  arch?: string,
): string | null;
export function assetUrl(target: string, manifest?: TectonicManifest): string;
export function licenseUrl(manifest?: TectonicManifest): string;
export function noticeText(target: string, manifest?: TectonicManifest): string;
export function fetchTectonicNotices(
  target: string,
  outDir: string,
  manifest?: TectonicManifest,
): Promise<void>;
export function fetchTectonic(
  target: string,
  outDir?: string,
  manifest?: TectonicManifest,
): Promise<string>;
