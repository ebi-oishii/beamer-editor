/** Distinguishes this panel's own PDF writes from edits to watched files. */
export class PdfPublications {
  private readonly pending = new Map<string, Set<Promise<Uint8Array | undefined>>>();

  begin(output: string): (bytes?: Uint8Array) => void {
    const writes = this.pending.get(output) ?? new Set();
    this.pending.set(output, writes);
    let finish: (bytes: Uint8Array | undefined) => void = () => {};
    const publication = new Promise<Uint8Array | undefined>((resolve) => {
      finish = resolve;
    });
    writes.add(publication);
    return (bytes) => {
      finish(bytes);
      // A replacement can generate several batched watcher notifications.
      setTimeout(() => {
        writes.delete(publication);
        if (writes.size === 0) this.pending.delete(output);
      }, 2_000).unref();
    };
  }

  ownChange(output: string, read: () => PromiseLike<Uint8Array>): Promise<boolean> | undefined {
    const writes = this.pending.get(output);
    if (!writes) return undefined;
    // Wait for writes to finish before reading. If the destination changed
    // again before the watcher fired, it must still match one of our writes.
    return Promise.all(writes).then(async (artifacts) => {
      try {
        const actual = Buffer.from(await read());
        return artifacts.some((bytes) => bytes !== undefined && actual.equals(bytes));
      } catch {
        return false;
      }
    });
  }
}
