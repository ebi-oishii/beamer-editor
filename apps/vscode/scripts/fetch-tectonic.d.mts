/** fetch-tectonic.mjs の型(テストと package.mjs から使う)。 */
export interface TectonicManifestEntry {
  asset: string;
  sha256: string;
  binary: string;
}
export interface TectonicManifest {
  version: string;
  releaseUrl: string;
  targets: Record<string, TectonicManifestEntry>;
}
export const MANIFEST: TectonicManifest;
export function targetForPlatform(
  platform?: NodeJS.Platform | string,
  arch?: string,
): string | null;
export function assetUrl(target: string, manifest?: TectonicManifest): string;
export function fetchTectonic(
  target: string,
  outDir?: string,
  manifest?: TectonicManifest,
): Promise<string>;
