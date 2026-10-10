import {
  editSlide,
  framesOf,
  parseDeck,
  type SlideEditAction,
  type SlideSourceEdit,
} from "@beamer-editor/core";
import {
  explicitFrameStarts,
  type SlideOutlineDocument,
  type SlideOutlineEntry,
  type SlideOutlineState,
} from "./slide-outline";

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
    return this.run(action, document, entry?.start);
  }

  /** 照合済みの document に 1 回の WorkspaceEdit を適用する。重なる編集は拒否する。 */
  private async run(action: SlideEditAction, document: Document, start?: number): Promise<boolean> {
    if (this.pending.has(document)) return false;
    const version = document.version;
    const result = editSlide(document.getText(), action, start);
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

  /**
   * プレビューから移動できる frame か。編集可能な(管理対象・閉じていない・書き込み可の)文書で、
   * 描画時の version のまま、start がその文書自身の明示 frame の開始位置であること。
   * プレビューのメニューを出す判定と、実行時の照合の両方がこれを使う。
   */
  canMoveAt(document: Document, version: number, start: number): boolean {
    return (
      document.version === version &&
      this.host.isEditable(document) &&
      explicitFrameStarts(document).has(start)
    );
  }

  /**
   * Webview からの操作用。描画時の version と source offset を、その document 自身の明示 frame
   * に照合してから既存の一回だけの WorkspaceEdit 経路へ流す。スライド一覧(Explorer)が別の文書を
   * 表示していても、プレビューの文書を動かせるようにする。
   */
  async executeAt(
    action: Extract<SlideEditAction, "moveUp" | "moveDown">,
    document: Document,
    version: number,
    start: number,
  ): Promise<{ applied: boolean; newFrameStart?: number }> {
    if (!this.canMoveAt(document, version, start)) return { applied: false };
    const source = document.getText();
    const result = editSlide(source, action, start);
    if (!result.ok) {
      // 閉じていない frame など、Explorer からの操作と同じ理由を出す。
      this.host.warn(result.reason);
      return { applied: false };
    }
    if (result.edits.length === 0) return { applied: false };
    let next = source;
    for (const edit of [...result.edits].sort((a, b) => b.span.start - a.span.start))
      next = next.slice(0, edit.span.start) + edit.text + next.slice(edit.span.end);
    // 同じ内容の frame 同士の入れ替えは本文が変わらず version も上がらない。適用すると、
    // 新しい version の描画を待つプレビューの編集がそのまま止まるので、適用しない。
    if (next === source) return { applied: false };
    const oldIndex = framesOf(parseDeck(source)).findIndex((frame) => frame.span.start === start);
    const nextFrame = framesOf(parseDeck(next))[oldIndex + (action === "moveUp" ? -1 : 1)];
    if (oldIndex < 0 || !nextFrame) return { applied: false };
    return {
      applied: await this.run(action, document, start),
      newFrameStart: nextFrame.span.start,
    };
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
