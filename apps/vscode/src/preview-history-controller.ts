/** VS Code の標準履歴へ、現在のプレビューに対応するソースから橋渡しする。 */
export interface PreviewHistoryHost<Panel, Uri, Document> {
  activePreview(): { panel: Panel; sourceUri: Uri } | undefined;
  openTextDocument(uri: Uri): PromiseLike<Document>;
  showTextDocument(document: Document): PromiseLike<unknown>;
  executeStandardCommand(command: "undo" | "redo"): PromiseLike<unknown>;
  isPreviewAlive(panel: Panel): boolean;
  revealPreview(panel: Panel, preserveFocus: false): void;
}

/**
 * 各押下時点の panel / URI を固定してから、履歴操作を 1 本のキューで直列化する。
 * これにより source を表示する非同期処理の間に別 panel へ操作対象が移ることを防ぐ。
 */
export class PreviewHistoryController<Panel, Uri, Document> {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly host: PreviewHistoryHost<Panel, Uri, Document>) {}

  undo(): Promise<void> {
    return this.run("undo");
  }

  redo(): Promise<void> {
    return this.run("redo");
  }

  private run(command: "undo" | "redo"): Promise<void> {
    const target = this.host.activePreview();
    if (!target) return Promise.resolve();

    const operation = this.queue.then(async () => {
      try {
        const document = await this.host.openTextDocument(target.sourceUri);
        await this.host.showTextDocument(document);
        await this.host.executeStandardCommand(command);
      } finally {
        if (this.host.isPreviewAlive(target.panel)) this.host.revealPreview(target.panel, false);
      }
    });
    // 失敗した操作が後続の入力を止めないよう、内部キューだけは常に回復させる。
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
