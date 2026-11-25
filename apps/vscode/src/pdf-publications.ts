import { resolve } from "node:path";

/** Distinguishes this panel's own PDF writes from edits to watched files. */
export class PdfPublications {
  private readonly pending = new Map<string, Set<Promise<string | undefined>>>();

  begin(path: string): (identity?: string) => void {
    const output = resolve(path);
    const writes = this.pending.get(output) ?? new Set();
    this.pending.set(output, writes);
    let finish: (identity: string | undefined) => void = () => {};
    const publication = new Promise<string | undefined>((resolve) => {
      finish = resolve;
    });
    writes.add(publication);
    return (identity) => {
      finish(identity);
      // A replacement can generate several batched watcher notifications.
      setTimeout(() => {
        writes.delete(publication);
        if (writes.size === 0) this.pending.delete(output);
      }, 2_000).unref();
    };
  }

  ownChange(
    output: string,
    identify: () => PromiseLike<string | undefined>,
  ): Promise<boolean> | undefined {
    const writes = this.pending.get(resolve(output));
    if (!writes) return undefined;
    // Wait for writes to finish before reading. If the destination changed
    // again before the watcher fired, it must still match one of our writes.
    return Promise.all(writes).then(async (artifacts) => {
      const identity = await identify();
      return identity !== undefined && artifacts.includes(identity);
    });
  }
}
