import { describe, expect, it, vi } from "vitest";
import {
  executeHistoryCommand,
  type HistoryCommandHost,
  type HistoryKind,
  PreviewHistory,
  type PreviewHistoryHost,
} from "../src/preview-history";

type Panel = { id: string };
type Target = { panel: Panel; uri: string };

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeHost(open: Set<Panel>) {
  const applied: [HistoryKind, Target][] = [];
  const pending: ReturnType<typeof deferred>[] = [];
  const host: PreviewHistoryHost<Target> = {
    apply: vi.fn(async (kind: HistoryKind, target: Target) => {
      applied.push([kind, target]);
      const gate = deferred();
      pending.push(gate);
      await gate.promise;
    }),
    isOpen: (panel) => open.has(panel),
    reveal: vi.fn(),
    onError: vi.fn(),
  };
  return { host, applied, pending };
}

describe("PreviewHistory", () => {
  const a: Target = { panel: { id: "a" }, uri: "file:///a.slide.tex" };
  const b: Target = { panel: { id: "b" }, uri: "file:///b.slide.tex" };

  it("要求は前の要求が終わるまで始まらず、それぞれ押下時点の対象に対して実行される", async () => {
    const open = new Set([a.panel, b.panel]);
    const { host, applied, pending } = makeHost(open);
    const history = new PreviewHistory(host);

    const first = history.request("undo", a);
    const second = history.request("redo", b);
    await Promise.resolve();
    // 1 件目が終わるまで 2 件目の apply は呼ばれない。
    expect(applied).toEqual([["undo", a]]);
    expect(host.reveal).not.toHaveBeenCalled();

    pending[0]?.resolve();
    await first;
    expect(host.reveal).toHaveBeenLastCalledWith(a.panel);
    await vi.waitFor(() =>
      expect(applied).toEqual([
        ["undo", a],
        ["redo", b],
      ]),
    );

    pending[1]?.resolve();
    await second;
    expect(host.reveal).toHaveBeenLastCalledWith(b.panel);
    expect(host.onError).not.toHaveBeenCalled();
  });

  it("処理中に閉じられた panel には reveal しない", async () => {
    const open = new Set([a.panel]);
    const { host, pending } = makeHost(open);
    const operation = new PreviewHistory(host).request("undo", a);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    open.delete(a.panel);
    pending[0]?.resolve();
    await operation;
    expect(host.reveal).not.toHaveBeenCalled();
  });

  it("失敗した要求は onError へ回し、フォーカスは戻し、後続の要求は止めない", async () => {
    const open = new Set([a.panel]);
    const { host, applied, pending } = makeHost(open);
    const history = new PreviewHistory(host);

    const failing = history.request("undo", a);
    const next = history.request("redo", a);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]?.reject(new Error("boom"));
    await failing; // reject しない
    expect(host.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }), "undo");
    expect(host.reveal).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]?.resolve();
    await next;
    expect(applied.map(([kind]) => kind)).toEqual(["undo", "redo"]);
    expect(host.reveal).toHaveBeenCalledTimes(2);
  });
});

/** version と変更イベントだけを持つ文書の代わり。 */
function makeDocument() {
  let version = 1;
  const listeners = new Set<() => void>();
  return {
    version: () => version,
    onDidChange: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    /** 内容の変更(version が増え、イベントが出る)。 */
    change() {
      version++;
      for (const listener of listeners) listener();
    },
    /** dirty 状態の変化のように、version の変わらないイベント。 */
    notifyWithoutChange() {
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("executeHistoryCommand", () => {
  const options = { attempts: 3, retryDelayMs: 20 };

  it("フォーカスが移らず効かなかったコマンドは、短く待ってやり直す", async () => {
    const document = makeDocument();
    const execute = vi.fn(async () => {
      // 1 回目はフォーカスが無くて効かず、2 回目で効く。
      if (execute.mock.calls.length === 2) document.change();
    });
    const host: HistoryCommandHost = { ...document, focusEditor: vi.fn(async () => {}), execute };
    await executeHistoryCommand("undo", host, options);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(host.focusEditor).toHaveBeenCalledTimes(2);
  });

  it("待ちを過ぎてから届いた変更を 2 回目の表示・フォーカス中に観測しても、コマンドは 1 回だけ実行する", async () => {
    const document = makeDocument();
    // コマンドは効いているが、文書の変更が拡張側に見えるのが遅れる。
    const execute = vi.fn(async () => {});
    const focusEditor = vi.fn(async () => {
      if (focusEditor.mock.calls.length === 2) document.change();
    });
    await executeHistoryCommand("undo", { ...document, focusEditor, execute }, options);
    expect(focusEditor).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("待っている間に変更が届けば、待ち時間を使い切らずに終わる", async () => {
    const document = makeDocument();
    const execute = vi.fn(async () => {
      setTimeout(() => document.change(), 5);
    });
    const run = executeHistoryCommand(
      "redo",
      {
        ...document,
        focusEditor: async () => {},
        execute,
      },
      { attempts: 3, retryDelayMs: 10_000 },
    );
    const outcome = await Promise.race([run.then(() => "done"), sleep(1000).then(() => "timeout")]);
    expect(outcome).toBe("done");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("取り消すものが無ければ attempts 回で終わり、購読を外す。version の変わらないイベントでは待ちを打ち切らない", async () => {
    const document = makeDocument();
    const execute = vi.fn(async () => {
      setTimeout(() => document.notifyWithoutChange(), 2);
    });
    const started = Date.now();
    await executeHistoryCommand(
      "undo",
      { ...document, focusEditor: async () => {}, execute },
      options,
    );
    expect(execute).toHaveBeenCalledTimes(options.attempts);
    // 3 回とも待ち切っている(イベントで早く起きていない)。
    expect(Date.now() - started).toBeGreaterThanOrEqual(
      options.attempts * options.retryDelayMs - 5,
    );
    expect(document.listenerCount()).toBe(0);
  });
});
