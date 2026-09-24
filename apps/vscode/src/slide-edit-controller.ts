import { editSlide, type SlideEditAction, type SlideSourceEdit } from "@beamer-editor/core";
import type { SlideOutlineDocument, SlideOutlineEntry, SlideOutlineState } from "./slide-outline";

export interface SlideEditHost<Document extends SlideOutlineDocument> {
  isEditable(document: Document): boolean;
  apply(document: Document, edits: readonly SlideSourceEdit[]): Promise<boolean>;
  changed(document: Document): void;
  warn(message: string): void;
}

/** One invocation owns one WorkspaceEdit. Never apply stale tree items or overlap pending edits. */
export class SlideEditController<Document extends SlideOutlineDocument> {
  private readonly pending = new Set<Document>();
  constructor(
    private readonly state: SlideOutlineState<Document>,
    private readonly host: SlideEditHost<Document>,
  ) {}

  async execute(action: SlideEditAction, entry?: SlideOutlineEntry<Document>): Promise<boolean> {
    const document = entry?.document ?? this.state.getDocument();
    if (!document || !this.host.isEditable(document)) return false;
    if ((entry && !this.state.isCurrent(entry)) || !this.state.hasDocument(document)) {
      this.host.warn("スライド一覧が更新されています。選び直してください。");
      return false;
    }
    if (this.pending.has(document)) return false;
    const version = document.version;
    const result = editSlide(document.getText(), action, entry?.start);
    if (!result.ok) {
      this.host.warn(result.reason);
      return false;
    }
    if (result.edits.length === 0) {
      this.host.warn(
        action === "moveUp"
          ? "先頭のスライドはこれ以上上へ移動できません。"
          : action === "moveDown"
            ? "末尾のスライドはこれ以上下へ移動できません。"
            : "スライドに変更はありません。",
      );
      return false;
    }
    if (document.version !== version) return false;
    this.pending.add(document);
    try {
      // No await between the last version check and WorkspaceEdit submission.
      const applied = await this.host.apply(document, result.edits);
      if (!applied)
        this.host.warn("スライドを変更できませんでした。文書の状態を確認してください。");
      if (applied) this.host.changed(document);
      return applied;
    } catch {
      this.host.warn("スライドを変更できませんでした。文書の状態を確認してください。");
      return false;
    } finally {
      this.pending.delete(document);
    }
  }
}

export type SlideCommandTarget<Document extends SlideOutlineDocument> =
  | { kind: "run"; entry: SlideOutlineEntry<Document> | undefined }
  | { kind: "cancel" };

/**
 * Resolve the slide a command acts on. Tree items are used as-is; from the command palette
 * the user picks a slide. `insert` picks the slide to insert after (an empty deck appends).
 */
export async function resolveSlideCommandTarget<Document extends SlideOutlineDocument>(
  action: SlideEditAction,
  item: SlideOutlineEntry<Document> | undefined | "other",
  entries: readonly SlideOutlineEntry<Document>[],
  pick: (
    entries: readonly SlideOutlineEntry<Document>[],
    placeHolder: string,
  ) => Promise<SlideOutlineEntry<Document> | undefined>,
): Promise<SlideCommandTarget<Document>> {
  if (item === "other") return { kind: "cancel" };
  if (item) return { kind: "run", entry: item };
  if (action === "insert" && entries.length === 0) return { kind: "run", entry: undefined };
  const entry = await pick(
    entries,
    action === "insert"
      ? "新しいスライドを挿入する位置(このスライドの後)を選択"
      : "操作するスライドを選択",
  );
  return entry ? { kind: "run", entry } : { kind: "cancel" };
}
