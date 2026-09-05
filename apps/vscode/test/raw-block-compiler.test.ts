import { describe, expect, it, vi } from "vitest";
import { RawBlockCompiler, type RawBlockCompilerFileSystem } from "../src/raw-block-compiler";

function memoryFs(initial: Record<string, Uint8Array> = {}) {
  const files = new Map(Object.entries(initial));
  const fs: RawBlockCompilerFileSystem = {
    readFile: async (path) => {
      const data = files.get(path);
      if (!data) throw new Error(`ENOENT ${path}`);
      return data;
    },
    writeFile: async (path, data) => {
      files.set(path, data);
    },
    mkdir: async () => {},
    exists: async (path) => files.has(path),
  };
  return { fs, files };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("RawBlockCompiler", () => {
  it("未処理の key を 1 本ずつコンパイルし、PDF をキャッシュして onReady へ渡す", async () => {
    const { fs, files } = memoryFs();
    const order: string[] = [];
    let release: (() => void) | undefined;
    const compile = vi.fn(async (document: string) => {
      order.push(`start ${document}`);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push(`end ${document}`);
      return new Uint8Array([1, 2, 3]);
    });
    const onReady = vi.fn();
    const compiler = new RawBlockCompiler({
      cacheDir: "/cache",
      fs,
      compile,
      buildDocument: (tex, preamble) => `${preamble}|${tex}`,
      onReady,
      onFailed: vi.fn(),
    });
    compiler.request(
      [
        { key: "k1", tex: "A", environment: null },
        { key: "k2", tex: "B", environment: null },
        { key: "k1", tex: "A", environment: null },
      ],
      "P",
    );
    await flush();
    // 並列に起動しない。
    expect(order).toEqual(["start P|A"]);
    release?.();
    await flush();
    await flush();
    expect(order).toEqual(["start P|A", "end P|A", "start P|B"]);
    release?.();
    await flush();
    await flush();
    expect(onReady.mock.calls.map(([key]) => key)).toEqual(["k1", "k2"]);
    expect(files.get("/cache/k1.pdf")).toEqual(new Uint8Array([1, 2, 3]));
    // 同じ key を再要求してもコンパイルし直さない。
    compiler.request([{ key: "k1", tex: "A", environment: null }], "P");
    await flush();
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it("キャッシュにある key はコンパイルせずに読んで返す", async () => {
    const cached = new Uint8Array([9, 9]);
    const { fs } = memoryFs({ "/cache/hit.pdf": cached });
    const compile = vi.fn();
    const onReady = vi.fn();
    new RawBlockCompiler({
      cacheDir: "/cache",
      fs,
      compile,
      buildDocument: (tex) => tex,
      onReady,
      onFailed: vi.fn(),
    }).request([{ key: "hit", tex: "x", environment: null }], "");
    await flush();
    expect(compile).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledWith("hit", cached);
  });

  it("失敗は onFailed へメッセージを渡し、同じ key は再試行しない", async () => {
    const { fs } = memoryFs();
    const compile = vi.fn(async () => {
      throw new Error("! Undefined control sequence.");
    });
    const onFailed = vi.fn();
    const compiler = new RawBlockCompiler({
      cacheDir: "/cache",
      fs,
      compile,
      buildDocument: (tex) => tex,
      onReady: vi.fn(),
      onFailed,
    });
    compiler.request([{ key: "bad", tex: "\\bad", environment: null }], "");
    await flush();
    expect(onFailed).toHaveBeenCalledWith("bad", "! Undefined control sequence.");
    compiler.request([{ key: "bad", tex: "\\bad", environment: null }], "");
    await flush();
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("dispose すると実行中のコンパイルを中止し、結果を届けない", async () => {
    const { fs } = memoryFs();
    let aborted = false;
    const compile = vi.fn(
      (_document: string, signal: AbortSignal) =>
        new Promise<Uint8Array>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const onReady = vi.fn();
    const onFailed = vi.fn();
    const compiler = new RawBlockCompiler({
      cacheDir: "/cache",
      fs,
      compile,
      buildDocument: (tex) => tex,
      onReady,
      onFailed,
    });
    compiler.request([{ key: "slow", tex: "x", environment: null }], "");
    await flush();
    compiler.dispose();
    await flush();
    expect(aborted).toBe(true);
    expect(onReady).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });
});
