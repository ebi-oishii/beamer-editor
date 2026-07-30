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

/** 既存の ignore 配列を壊さず managed patterns を重複なく加える。 */
export function appendUniqueIgnorePatterns(
  existing: readonly string[] | undefined,
  patterns: readonly string[],
): string[] {
  return [...new Set([...(existing ?? []), ...patterns])];
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
  return !(
    managedPatterns.every((pattern) => watchIgnore?.includes(pattern)) &&
    managedPatterns.every((pattern) => autoBuildIgnore?.includes(pattern))
  );
}
