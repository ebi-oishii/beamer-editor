import { expect, it, vi } from "vitest";
import { SlideEditController } from "../src/slide-edit-controller";
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
  host.isEditable = () => false;
  expect(await controller.execute("insert", entry)).toBe(false);
  expect(host.apply).not.toHaveBeenCalled();
});
