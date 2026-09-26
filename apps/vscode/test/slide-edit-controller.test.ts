import { expect, it, vi } from "vitest";
import { resolveSlideCommandTarget, SlideEditController } from "../src/slide-edit-controller";
import { SlideOutlineState } from "../src/slide-outline";

function setup() {
  const document = {
    version: 1,
    uri: { toString: () => "file:///deck.slide.tex" },
    getText: () => "\\begin{document}\n\\begin{frame}{A}body\\end{frame}\n\\end{document}",
  };
  const state = new SlideOutlineState<typeof document>();
  state.setDocument(document);
  const host = {
    isEditable: () => true,
    apply: vi.fn(async () => true),
    changed: vi.fn(),
    warn: vi.fn(),
  };
  const controller = new SlideEditController(state, host);
  return { document, state, host, controller, entry: state.getEntries()[0] };
}
it("submits one edit batch and refreshes only after successful application", async () => {
  const { controller, host, entry, document } = setup();
  expect(await controller.execute("duplicate", entry)).toBe(true);
  expect(host.apply).toHaveBeenCalledTimes(1);
  expect(host.changed).toHaveBeenCalledWith(document);
});
it("rejects stale entries and entries from a previous document", async () => {
  const { controller, host, entry, document, state } = setup();
  document.version++;
  expect(await controller.execute("delete", entry)).toBe(false);
  state.setDocument({ ...document });
  expect(await controller.execute("delete", entry)).toBe(false);
  expect(host.apply).not.toHaveBeenCalled();
});
it("blocks overlapping requests, releases its lock on failed edits, and allows retry", async () => {
  const { controller, host, entry } = setup();
  let finish!: (value: boolean) => void;
  host.apply.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = controller.execute("insert", entry);
  expect(await controller.execute("duplicate", entry)).toBe(false);
  finish(false);
  expect(await first).toBe(false);
  expect(host.changed).not.toHaveBeenCalled();
  expect(await controller.execute("duplicate", entry)).toBe(true);
  expect(host.apply).toHaveBeenCalledTimes(2);
});
it("does not write readonly documents, invalid sources or edge no-ops", async () => {
  const { controller, host, entry } = setup();
  expect(await controller.execute("moveUp", entry)).toBe(false);
  expect(host.warn).toHaveBeenLastCalledWith("先頭のスライドはこれ以上上へ移動できません。");
  expect(await controller.execute("moveDown", entry)).toBe(false);
  expect(host.warn).toHaveBeenLastCalledWith("末尾のスライドはこれ以上下へ移動できません。");
  host.isEditable = () => false;
  expect(await controller.execute("insert", entry)).toBe(false);
  expect(host.apply).not.toHaveBeenCalled();
});
it("accepts preview moves only for the current explicit outline entry", async () => {
  const { controller, host, entry, document } = setup();
  expect(entry).toBeDefined();
  if (!entry) throw new Error("missing outline entry");
  expect(
    (await controller.executeAt("moveDown", document, document.version, entry.start)).applied,
  ).toBe(false);
  expect(host.apply).not.toHaveBeenCalled();
  const twoSlides = {
    ...document,
    getText: () =>
      "\\begin{document}\\n\\begin{frame}{A}body\\end{frame}\\n\\begin{frame}{B}body\\end{frame}\\n\\end{document}",
  };
  const state = new SlideOutlineState<typeof twoSlides>();
  state.setDocument(twoSlides);
  const moving = new SlideEditController(state, host);
  const target = state.getEntries()[0];
  expect(target).toBeDefined();
  if (!target) throw new Error("missing outline entry");
  expect(
    (await moving.executeAt("moveDown", twoSlides, twoSlides.version, target.start)).applied,
  ).toBe(true);
  expect(
    (await moving.executeAt("moveUp", twoSlides, twoSlides.version + 1, target.start)).applied,
  ).toBe(false);
});
it("palette commands pick a slide; palette insert inserts after the chosen slide", async () => {
  const { entry, state } = setup();
  const entries = state.getEntries();
  const pick = vi.fn(async () => entry);
  expect(await resolveSlideCommandTarget("insert", undefined, entries, pick)).toEqual({
    kind: "run",
    entry,
  });
  expect(pick).toHaveBeenLastCalledWith(entries, expect.stringContaining("挿入する位置"));
  expect(await resolveSlideCommandTarget("delete", undefined, entries, pick)).toEqual({
    kind: "run",
    entry,
  });
  expect(pick).toHaveBeenLastCalledWith(entries, "操作するスライドを選択");
  const cancel = vi.fn(async () => undefined);
  expect(await resolveSlideCommandTarget("insert", undefined, entries, cancel)).toEqual({
    kind: "cancel",
  });
  // A tree item is used directly; an empty deck has nowhere to pick and appends.
  expect(await resolveSlideCommandTarget("insert", entry, entries, cancel)).toEqual({
    kind: "run",
    entry,
  });
  expect(await resolveSlideCommandTarget("insert", undefined, [], cancel)).toEqual({
    kind: "run",
    entry: undefined,
  });
  expect(await resolveSlideCommandTarget("insert", "other", entries, pick)).toEqual({
    kind: "cancel",
  });
  expect(cancel).toHaveBeenCalledTimes(1);
});
