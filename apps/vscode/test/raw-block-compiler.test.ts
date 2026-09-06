import { describe, expect, it, vi } from "vitest";
import {
  affectsRawBlockCompile,
  dependencyFingerprint,
  RawBlockCompiler,
  type RawBlockCompilerFileSystem,
} from "../src/raw-block-compiler";

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
    rename: async (from, to) => {
      const data = files.get(from);
      if (!data) throw new Error(`ENOENT ${from}`);
      files.delete(from);
      files.set(to, data);
    },
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

  it("依存ファイルの指紋がキャッシュ名に入り、指紋が変わればコンパイルし直す", async () => {
    const { fs, files } = memoryFs();
    let fingerprint = "aaaa";
    const compile = vi.fn(async () => new Uint8Array([fingerprint.charCodeAt(0)]));
    const onReady = vi.fn();
    const compiler = new RawBlockCompiler({
      cacheDir: "/cache",
      fs,
      compile,
      buildDocument: (tex) => tex,
      fingerprint: async () => fingerprint,
      onReady,
      onFailed: vi.fn(),
    });
    const blocks = [{ key: "k1", tex: "x", environment: null }];
    compiler.request(blocks, "");
    await flush();
    expect([...files.keys()]).toEqual(["/cache/k1-aaaa.pdf"]);
    // 同じ指紋なら何もしない(届け直しもしない)。
    compiler.request(blocks, "");
    await flush();
    expect(compile).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledTimes(1);
    // 画像を差し替えるなどで指紋が変わると、同じ key でもコンパイルし直して届ける。
    fingerprint = "bbbb";
    compiler.request(blocks, "");
    await flush();
    expect(compile).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenLastCalledWith("k1", new Uint8Array(["b".charCodeAt(0)]));
    expect([...files.keys()].sort()).toEqual(["/cache/k1-aaaa.pdf", "/cache/k1-bbbb.pdf"]);
  });

  it("キャッシュは一時ファイルに書いてから最終名へ置き換え、一時ファイルを残さない", async () => {
    const { files } = memoryFs();
    const writes: string[] = [];
    const renames: [string, string][] = [];
    const fs: RawBlockCompilerFileSystem = {
      readFile: async () => {
        throw new Error("unused");
      },
      writeFile: async (path, data) => {
        writes.push(path);
        files.set(path, data);
      },
      mkdir: async () => {},
      exists: async () => false,
      rename: async (from, to) => {
        renames.push([from, to]);
        files.set(to, files.get(from) as Uint8Array);
        files.delete(from);
      },
    };
    new RawBlockCompiler({
      cacheDir: "/cache",
      fs,
      compile: async () => new Uint8Array([7]),
      buildDocument: (tex) => tex,
      onReady: vi.fn(),
      onFailed: vi.fn(),
    }).request([{ key: "k1", tex: "x", environment: null }], "");
    await flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^\/cache\/k1\.pdf\.[a-z0-9]+\.tmp$/);
    expect(renames).toEqual([[writes[0], "/cache/k1.pdf"]]);
    expect([...files.keys()]).toEqual(["/cache/k1.pdf"]);
  });

  it("resetFailures の後は失敗した key をもう一度試す", async () => {
    const { fs } = memoryFs();
    let broken = true;
    const compile = vi.fn(async () => {
      if (broken) throw new Error("missing figure.png");
      return new Uint8Array([1]);
    });
    const onReady = vi.fn();
    const compiler = new RawBlockCompiler({
      cacheDir: "/cache",
      fs,
      compile,
      buildDocument: (tex) => tex,
      onReady,
      onFailed: vi.fn(),
    });
    const blocks = [{ key: "k1", tex: "x", environment: null }];
    compiler.request(blocks, "");
    await flush();
    compiler.request(blocks, "");
    await flush();
    expect(compile).toHaveBeenCalledTimes(1);
    // 画像が置かれてテンプレート監視が refresh を呼んだ、という状況。
    broken = false;
    compiler.resetFailures();
    compiler.request(blocks, "");
    await flush();
    expect(compile).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenCalledWith("k1", new Uint8Array([1]));
  });

  it("エンジンが使えない失敗は、一度だけ onUnavailable を出してキューを止め、箱を失敗にしない", async () => {
    const { fs } = memoryFs();
    let tectonic = false;
    const compile = vi.fn(async () => {
      if (!tectonic) throw new Error("Tectonic が見つかりません: tectonic");
      return new Uint8Array([1]);
    });
    const onFailed = vi.fn();
    const onUnavailable = vi.fn();
    const onReady = vi.fn();
    const compiler = new RawBlockCompiler({
      cacheDir: "/cache",
      fs,
      compile,
      buildDocument: (tex) => tex,
      isUnavailable: (error) => error instanceof Error && error.message.includes("見つかりません"),
      onUnavailable,
      onReady,
      onFailed,
    });
    const blocks = [
      { key: "k1", tex: "a", environment: null },
      { key: "k2", tex: "b", environment: null },
    ];
    compiler.request(blocks, "");
    await flush();
    // 1 本目で分かった時点で止まる。2 本目は試さず、どちらも失敗扱いにしない。
    expect(compile).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith("Tectonic が見つかりません: tectonic");
    expect(onFailed).not.toHaveBeenCalled();
    // 以後の描画で要求されても何もしない(通知も増えない)。
    compiler.request(blocks, "");
    await flush();
    expect(compile).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    // 設定が直って reset されたら判定し直し、今度は両方コンパイルする。
    tectonic = true;
    compiler.reset();
    compiler.request(blocks, "");
    await flush();
    await flush();
    expect(compile).toHaveBeenCalledTimes(3);
    expect(onReady.mock.calls.map(([key]) => key)).toEqual(["k1", "k2"]);
  });

  it("reset は失敗の記録も消す", async () => {
    const { fs } = memoryFs();
    let broken = true;
    const compile = vi.fn(async () => {
      if (broken) throw new Error("! Undefined control sequence.");
      return new Uint8Array([1]);
    });
    const compiler = new RawBlockCompiler({
      cacheDir: "/cache",
      fs,
      compile,
      buildDocument: (tex) => tex,
      onReady: vi.fn(),
      onFailed: vi.fn(),
    });
    const blocks = [{ key: "k1", tex: "x", environment: null }];
    compiler.request(blocks, "");
    await flush();
    broken = false;
    compiler.reset();
    compiler.request(blocks, "");
    await flush();
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it("affectsRawBlockCompile は Tectonic の場所と有効/無効の設定だけを見る", () => {
    expect(affectsRawBlockCompile((section) => section === "beamerEditor.tectonicPath")).toBe(true);
    expect(
      affectsRawBlockCompile((section) => section === "beamerEditor.preview.compileRawBlocks"),
    ).toBe(true);
    expect(affectsRawBlockCompile((section) => section === "beamerEditor.managedFiles")).toBe(
      false,
    );
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

describe("dependencyFingerprint", () => {
  const hash = (text: string) => `h(${text})`;
  const table = new Map<string, { mtimeMs: number; size: number }>([
    ["/deck/figs/plot.pdf", { mtimeMs: 100, size: 10 }],
    ["/deck/mystyle.sty", { mtimeMs: 200, size: 20 }],
  ]);
  const stat = async (path: string) => table.get(path) ?? null;
  const resolvePath = (name: string) => `/deck/${name}`;

  it("拡張子の無い参照は候補を順に試し、無いものは missing として指紋に入れる", async () => {
    expect(
      await dependencyFingerprint(
        ["figs/plot", "mystyle.sty", "gone.png"],
        resolvePath,
        stat,
        hash,
      ),
    ).toBe("h(figs/plot.pdf|100|10\nmystyle.sty|200|20\ngone.png|missing)");
  });

  it("\\graphicspath のディレクトリの下も探し、そこにある画像の更新で指紋が変わる", async () => {
    const files = new Map<string, { mtimeMs: number; size: number }>([
      ["/deck/images/foo.png", { mtimeMs: 10, size: 1 }],
    ]);
    const statHere = async (path: string) => files.get(path) ?? null;
    const before = await dependencyFingerprint(["foo"], resolvePath, statHere, hash, ["images/"]);
    expect(before).toBe("h(images/foo.png|10|1)");
    files.set("/deck/images/foo.png", { mtimeMs: 11, size: 1 });
    expect(await dependencyFingerprint(["foo"], resolvePath, statHere, hash, ["images/"])).not.toBe(
      before,
    );
    // 末尾の / が無い指定も同じ。デッキ直下にあればそちらが先。
    expect(await dependencyFingerprint(["foo"], resolvePath, statHere, hash, ["images"])).toBe(
      "h(images/foo.png|11|1)",
    );
    files.set("/deck/foo.pdf", { mtimeMs: 5, size: 9 });
    expect(await dependencyFingerprint(["foo"], resolvePath, statHere, hash, ["images/"])).toBe(
      "h(foo.pdf|5|9)",
    );
  });

  it("依存が無ければ空文字で、ファイルの更新時刻が変われば指紋も変わる", async () => {
    expect(await dependencyFingerprint([], resolvePath, stat, hash)).toBe("");
    const before = await dependencyFingerprint(["figs/plot"], resolvePath, stat, hash);
    table.set("/deck/figs/plot.pdf", { mtimeMs: 101, size: 10 });
    expect(await dependencyFingerprint(["figs/plot"], resolvePath, stat, hash)).not.toBe(before);
  });
});
