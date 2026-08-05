/** `beamerEditor.managedFiles` の既定値。 */
export const DEFAULT_MANAGED_FILE_PATTERNS = ["**/*.slide.tex"] as const;

/** ローカルファイルかつ managed glob のいずれかに一致する文書だけを扱う。 */
export interface ManagedDocument {
  readonly uri: { readonly scheme: string };
  readonly fileName: string;
}

/** Glob の解釈は host (VS Code) に委譲し、ここでは判定の合成だけを扱う。 */
export type ManagedGlobMatcher<TDocument extends ManagedDocument> = (
  document: TDocument,
  pattern: string,
) => boolean;

export function isManagedDocument<TDocument extends ManagedDocument>(
  document: TDocument,
  patterns: readonly string[],
  matchesGlob: ManagedGlobMatcher<TDocument>,
): boolean {
  return (
    document.uri.scheme === "file" &&
    patterns.some((pattern) => pattern.length > 0 && matchesGlob(document, pattern))
  );
}

export interface PreviewOwner<TController, TDocument> {
  controller: TController;
  document: TDocument;
  automatic: boolean;
}

/** URI ごとの preview ownership。automatic は手動操作でのみ manual に昇格する。 */
export class PreviewRegistry<TController, TDocument> {
  private readonly entriesByUri = new Map<string, PreviewOwner<TController, TDocument>>();

  has(uri: { toString(): string }): boolean {
    return this.entriesByUri.has(uri.toString());
  }

  get(uri: { toString(): string }): PreviewOwner<TController, TDocument> | undefined {
    return this.entriesByUri.get(uri.toString());
  }

  add(uri: { toString(): string }, owner: PreviewOwner<TController, TDocument>): void {
    this.entriesByUri.set(uri.toString(), owner);
  }

  promoteManual(uri: { toString(): string }): void {
    const owner = this.get(uri);
    if (owner) owner.automatic = false;
  }

  delete(uri: { toString(): string }): void {
    this.entriesByUri.delete(uri.toString());
  }

  entries(): IterableIterator<[string, PreviewOwner<TController, TDocument>]> {
    return this.entriesByUri.entries();
  }

  automaticEntries(): PreviewOwner<TController, TDocument>[] {
    return [...this.entriesByUri.values()].filter((owner) => owner.automatic);
  }
}

/**
 * User が閉じた automatic preview は、その文書を閉じるまでだけ再オープンを抑制する。
 * document close 後に遅れて panel dispose が来ても登録し直さないよう、open 状態を
 * 呼び出し側から明示的に渡す。
 */
export class AutoPreviewDismissals {
  private readonly dismissedUris = new Set<string>();

  has(uri: { toString(): string }): boolean {
    return this.dismissedUris.has(uri.toString());
  }

  dismiss(uri: { toString(): string }, documentIsOpen: boolean): void {
    if (documentIsOpen) this.dismissedUris.add(uri.toString());
  }

  clear(uri: { toString(): string }): void {
    this.dismissedUris.delete(uri.toString());
  }

  clearAll(): void {
    this.dismissedUris.clear();
  }
}

/**
 * LaTeX Workshop 用の glob は workspace-relative な managed glob と意味域が違う。
 * relative glob を全 workspace から一致する形へそろえるが、absolute glob はそのまま残す。
 */
export function normalizeLatexWorkshopIgnorePatterns(patterns: readonly string[]): string[] {
  return [
    ...new Set(
      patterns.map((pattern) => {
        const normalized = pattern.replace(/^\.\/+/, "");
        if (
          normalized.startsWith("**/") ||
          /^(?:[A-Za-z]:[\\/]|\/|[A-Za-z][A-Za-z\d+.-]*:\/\/)/.test(normalized)
        ) {
          return normalized;
        }
        return `**/${normalized}`;
      }),
    ),
  ];
}

/** 既存の ignore 配列を壊さず managed patterns を正規化して重複なく加える。 */
export function appendUniqueIgnorePatterns(
  existing: readonly string[] | undefined,
  patterns: readonly string[],
): string[] {
  const result = [...(existing ?? [])];
  const normalizedExisting = new Set(normalizeLatexWorkshopIgnorePatterns(result));
  for (const pattern of normalizeLatexWorkshopIgnorePatterns(patterns)) {
    if (!normalizedExisting.has(pattern)) {
      result.push(pattern);
      normalizedExisting.add(pattern);
    }
  }
  return result;
}

/** Global user settings の値を優先し、未設定なら extension/default 値だけを基底にする。 */
export function globalOrDefaultArray(
  inspected:
    | {
        defaultValue?: readonly string[];
        globalValue?: readonly string[];
        workspaceValue?: readonly string[];
        workspaceFolderValue?: readonly string[];
      }
    | undefined,
): readonly string[] {
  return inspected?.globalValue ?? inspected?.defaultValue ?? [];
}

/** 両方の ignore 設定が managed patterns の全要素を含むときだけ確認不要。 */
export function needsLatexWorkshopIgnorePrompt(
  watchIgnore: readonly string[] | undefined,
  autoBuildIgnore: readonly string[] | undefined,
  managedPatterns: readonly string[],
): boolean {
  const normalizedWatchIgnore = normalizeLatexWorkshopIgnorePatterns(watchIgnore ?? []);
  const normalizedAutoBuildIgnore = normalizeLatexWorkshopIgnorePatterns(autoBuildIgnore ?? []);
  const normalizedManagedPatterns = normalizeLatexWorkshopIgnorePatterns(managedPatterns);
  return !(
    normalizedManagedPatterns.every((pattern) => normalizedWatchIgnore.includes(pattern)) &&
    normalizedManagedPatterns.every((pattern) => normalizedAutoBuildIgnore.includes(pattern))
  );
}
