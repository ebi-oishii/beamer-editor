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
 * extension.ts の panel 作成・dispose イベントを結ぶ managed preview の状態機械。
 * controller 自体は host 側で作るため、ここは URI ownership と dismissal だけを持つ。
 */
export class ManagedPreviewLifecycle<TController, TDocument> {
  readonly registry = new PreviewRegistry<TController, TDocument>();
  readonly dismissals = new AutoPreviewDismissals();

  prepareOpen(
    uri: { toString(): string },
    automatic: boolean,
  ): { kind: "create" } | { kind: "existing"; controller: TController } | { kind: "dismissed" } {
    const existing = this.registry.get(uri);
    if (existing) {
      if (!automatic) this.registry.promoteManual(uri);
      return { kind: "existing", controller: existing.controller };
    }
    return automatic && this.dismissals.has(uri) ? { kind: "dismissed" } : { kind: "create" };
  }

  register(
    uri: { toString(): string },
    controller: TController,
    document: TDocument,
    automatic: boolean,
  ): void {
    this.registry.add(uri, { controller, document, automatic });
  }

  panelDisposed(uri: { toString(): string }, controller: TController): boolean {
    const owner = this.registry.get(uri);
    if (owner?.controller !== controller) return false;
    this.registry.delete(uri);
    this.dismissals.dismiss(uri, true);
    return true;
  }

  sourceClosed(uri: { toString(): string }): TController | undefined {
    const owner = this.registry.get(uri);
    if (owner) this.registry.delete(uri);
    this.dismissals.clear(uri);
    return owner?.controller;
  }

  managedFilesChanged(isManaged: (document: TDocument) => boolean): TController[] {
    this.dismissals.clearAll();
    const closed: TController[] = [];
    for (const owner of this.registry.automaticEntries()) {
      if (!isManaged(owner.document)) {
        for (const [uri, candidate] of this.registry.entries()) {
          if (candidate === owner) {
            this.registry.delete({ toString: () => uri });
            break;
          }
        }
        closed.push(owner.controller);
      }
    }
    return closed;
  }

  deactivate(): TController[] {
    const controllers: TController[] = [];
    for (const [uri, owner] of [...this.registry.entries()]) {
      this.registry.delete({ toString: () => uri });
      controllers.push(owner.controller);
    }
    this.dismissals.clearAll();
    return controllers;
  }
}

/**
 * LaTeX Workshop 用の glob は workspace-relative な managed glob と意味域が違う。
 * relative glob を全 workspace から一致する形へそろえるが、absolute glob はそのまま残す。
 */
export function normalizeLatexWorkshopIgnorePatterns(patterns: readonly string[]): string[] {
  return [
    ...new Set(
      patterns
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern.length > 0)
        .map((pattern) => {
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

/** 永続的な prompt refusal を、文書ではなく設定が共有される scope に紐づける。 */
export function latexWorkshopPromptSignature(scope: string, patterns: readonly string[]): string {
  return `${scope}\u0000${normalizeLatexWorkshopIgnorePatterns(patterns).sort().join("\u0000")}`;
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

export type ConfigurationScope = "default" | "global" | "workspace" | "workspaceFolder";

export interface InspectedArray {
  defaultValue?: readonly string[];
  globalValue?: readonly string[];
  workspaceValue?: readonly string[];
  workspaceFolderValue?: readonly string[];
}

/** VS Code の resource 設定と同じ優先順位で実効値を取得する。 */
export function effectiveArray(inspected: InspectedArray | undefined): readonly string[] {
  return (
    inspected?.workspaceFolderValue ??
    inspected?.workspaceValue ??
    inspected?.globalValue ??
    inspected?.defaultValue ??
    []
  );
}

export function explicitScope(inspected: InspectedArray | undefined): ConfigurationScope {
  if (inspected?.workspaceFolderValue !== undefined) return "workspaceFolder";
  if (inspected?.workspaceValue !== undefined) return "workspace";
  if (inspected?.globalValue !== undefined) return "global";
  return "default";
}

/** managedFiles と対象 Workshop key の、より具体的な明示 scope に書き込む。 */
export function chooseLatexWorkshopTarget(
  managed: InspectedArray | undefined,
  workshop: InspectedArray | undefined,
  workspaceDocument: boolean,
): ConfigurationScope {
  const rank: Record<ConfigurationScope, number> = {
    default: 0,
    global: 1,
    workspace: 2,
    workspaceFolder: 3,
  };
  const target =
    rank[explicitScope(managed)] >= rank[explicitScope(workshop)]
      ? explicitScope(managed)
      : explicitScope(workshop);
  return target === "default" ? (workspaceDocument ? "workspace" : "global") : target;
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
