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
    if (result.edits.length === 0) return false;
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
