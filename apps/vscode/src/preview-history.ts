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

/** 1 回の undo / redo を実行するための、文書とエディタへの操作。 */
export interface HistoryCommandHost {
  /** 対象の文書を表示し、エディタグループへキーボードフォーカスを移す。 */
  focusEditor(): Promise<void>;
  /** undo / redo コマンドを実行する。 */
  execute(kind: HistoryKind): Promise<void>;
  /** 文書の version。内容が変わるたびに増える。 */
  version(): number;
  /** 文書の変更イベントを購読する。 */
  onDidChange(listener: () => void): { dispose(): void };
}

export interface HistoryCommandOptions {
  /** コマンドを試す回数。 */
  attempts: number;
  /** 効かなかったと判断するまでに変更を待つ時間(ms)。 */
  retryDelayMs: number;
}

/**
 * フォーカスを移して undo / redo を 1 回実行する。効かなければ短く待ってやり直す。
 *
 * undo / redo はキーボードフォーカスのあるエディタに効く。Webview からフォーカスを戻した直後は、
 * エディタが表示されていてもフォーカスがまだ移っていないことがある(Linux の CI で再現)。一方、
 * コマンドの完了より文書の version の更新が遅れて見えることもあるので、await の境目ごとに version
 * を確かめ、変更を観測したらそれ以後はコマンドを実行しない(1 回の操作で履歴を 2 件消費しない)。
 * 取り消すものが無いときは attempts 回試し、短い待ちの後に終わる。
 */
export async function executeHistoryCommand(
  kind: HistoryKind,
  host: HistoryCommandHost,
  options: HistoryCommandOptions,
): Promise<void> {
  const before = host.version();
  const changed = () => host.version() !== before;
  let wake: (() => void) | undefined;
  const subscription = host.onDidChange(() => wake?.());
  // 変更イベントで待ちを打ち切る。version が変わらないイベント(dirty 状態の変化など)では起きない。
  const waitForChange = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.retryDelayMs);
      wake = () => {
        if (!changed()) return;
        clearTimeout(timer);
        resolve();
      };
    }).finally(() => {
      wake = undefined;
    });
  try {
    for (let attempt = 0; attempt < options.attempts; attempt++) {
      await host.focusEditor();
      // 表示とフォーカスを待つ間に前回のコマンドの変更が届いていたら、ここで終える。
      if (changed()) return;
      await host.execute(kind);
      if (changed()) return;
      await waitForChange();
      if (changed()) return;
    }
  } finally {
    subscription.dispose();
  }
}
