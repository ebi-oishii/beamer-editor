import { afterEach, expect, it, vi } from "vitest";
import { PdfPublications } from "../src/pdf-publications";

afterEach(() => vi.useRealTimers());

it("matches notifications for overlapping writes to the same destination", async () => {
  vi.useFakeTimers();
  const writes = new PdfPublications();
  const path = "/deck.pdf";
  const finishExport = writes.begin(path);
  const finishSave = writes.begin(path);
  finishSave(Uint8Array.of(1));
  vi.advanceTimersByTime(2_100);
  const notification = writes.ownChange(path, async () => Uint8Array.of(2));
  finishExport(Uint8Array.of(2));
  await expect(notification).resolves.toBe(true);
  await expect(writes.ownChange(path, async () => Uint8Array.of(3))).resolves.toBe(false);
  expect(writes.ownChange("/image.pdf", async () => Uint8Array.of(2))).toBeUndefined();
  vi.advanceTimersByTime(2_100);
  expect(writes.ownChange(path, async () => Uint8Array.of(2))).toBeUndefined();
});
