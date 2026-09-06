/**
 * プレビューからの undo / redo(#103)を、拡張全体で 1 本の列に直列化する。
 *
 * undo / redo はフォーカスのあるエディタに効くコマンドなので、対象のソースを表示してから実行する。
 * 2 つの要求が並行すると、どちらも最後に表示された文書へ効いてしまう(別の文書のプレビューから
 * 近接して押した場合)し、同じプレビューでの undo→redo の順序も保証されない。そこで要求ごとに
 * 押下時点の対象(panel と文書)を固定し、前の要求が終わってから次を実行する。
 * 失敗しても後続の要求を止めず、処理中に閉じられた panel には reveal しない。
 */

export type HistoryKind = "undo" | "redo";

export interface PreviewHistoryHost<Target extends { panel: unknown }> {
  /** 対象の文書を表示してコマンドを実行する。 */
  apply(kind: HistoryKind, target: Target): Promise<void>;
  /** panel がまだ開いている(登録されている)か。 */
  isOpen(panel: Target["panel"]): boolean;
  /** 対象の panel へフォーカスを戻す。 */
  reveal(panel: Target["panel"]): void;
  onError(error: unknown, kind: HistoryKind): void;
}

export class PreviewHistory<Target extends { panel: unknown }> {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly host: PreviewHistoryHost<Target>) {}

  /** 要求を列の末尾に足す。返る Promise はその要求の完了を表し、失敗しても reject しない。 */
  request(kind: HistoryKind, target: Target): Promise<void> {
    const operation = this.queue.then(async () => {
      try {
        await this.host.apply(kind, target);
      } catch (error) {
        this.host.onError(error, kind);
      }
      try {
        if (this.host.isOpen(target.panel)) this.host.reveal(target.panel);
      } catch (error) {
        this.host.onError(error, kind);
      }
    });
    // onError まで失敗しても列だけは常に回復させる。
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
