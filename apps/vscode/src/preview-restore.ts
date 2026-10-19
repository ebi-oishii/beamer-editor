/**
 * VS Code の再起動・再読み込みでプレビューを復元する(#199)ための、Webview state の中身。
 * Webview は自分の元ソースを state に残し、拡張の WebviewPanelSerializer がそれを読んで
 * 同じパネルをつなぎ直す。拡張側と Webview 側の両方から使うので vscode に依存しない。
 */

/** WebviewPanel の viewType。シリアライザの登録とタブの判定に使う。 */
export const PREVIEW_VIEW_TYPE = "beamerEditor.preview";

/** state に残す元ソース。automatic は managed file の自動プレビューか。 */
export interface PreviewRestoreState {
  uri: string;
  automatic: boolean;
}

/** Webview state から元ソースを取り出す。無い・壊れているなら null。 */
export function parsePreviewRestoreState(state: unknown): PreviewRestoreState | null {
  if (typeof state !== "object" || state === null) return null;
  const restore = (state as Record<string, unknown>).restore;
  if (typeof restore !== "object" || restore === null) return null;
  const { uri, automatic } = restore as Record<string, unknown>;
  if (typeof uri !== "string" || uri === "" || typeof automatic !== "boolean") return null;
  return { uri, automatic };
}

/** Webview state の保存先(acquireVsCodeApi の戻り値が満たす)。 */
interface StateStore {
  getState(): unknown;
  setState(state: unknown): void;
}

/**
 * state に元ソースを足して保存する保存先。ui のナビ状態の保存は state を丸ごと置き換えるので、
 * 保存のたびに元ソースを足し直す。作った時点でも 1 度保存し、ナビを一度も動かさなくても復元できるようにする。
 */
export function withPreviewRestoreState(
  store: StateStore,
  restore: PreviewRestoreState,
): StateStore {
  const save = (state: unknown) => {
    const base = typeof state === "object" && state !== null ? state : {};
    store.setState({ ...base, restore });
  };
  save(store.getState());
  return { getState: () => store.getState(), setState: save };
}

/** 復元できるプレビューのタブ名。拡張がパネルに付ける title と同じ。 */
export function previewTitle(fileName: string): string {
  return `Beamer Preview: ${fileName.split(/[\\/]/).pop()}`;
}
