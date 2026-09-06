import { describe, expect, it, vi } from "vitest";
import { type HistoryKind, PreviewHistory, type PreviewHistoryHost } from "../src/preview-history";

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
