import { access, link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  exportPdf,
  nodeProcessRunner,
  PdfExportError,
  type ProcessResult,
  type ProcessRunner,
} from "../src/index.ts";

const directories: string[] = [];

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "beamer-editor-compiler-test-"));
  directories.push(value);
  return value;
}

async function source(name = "talk.slide.tex") {
  const dir = await directory();
  const path = join(dir, name);
  const text = "% source must stay exactly as supplied\n\\includegraphics{figure.png}\n";
  await writeFile(path, text);
  return { dir, path, text };
}

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { exitCode: 0, stdout: "tectonic 0.16.0\n", stderr: "", ...overrides };
}

function successfulRunner(
  calls: Array<{ command: string; args: readonly string[]; cwd: string }>,
): ProcessRunner {
  return {
    async run(command, args, options) {
      calls.push({ command, args, cwd: options.cwd });
      if (args[0] === "--version") return result();
      const outdir = args[args.indexOf("--outdir") + 1] as string;
      const input = args.at(-1) as string;
      await writeFile(join(outdir, basename(input).replace(/\.tex$/, ".pdf")), "%PDF-1.7\n");
      return result({ stdout: "" });
    },
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

describe("exportPdf", () => {
  it("passes an untouched absolute source to Tectonic with shell-safe argv and stages output in OS temp", async () => {
    const input = await source("-evil; name.slide.tex");
    const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    const output = join(input.dir, "final.pdf");
    const value = await exportPdf(
      { inputPath: input.path, outputPath: output, tectonicPath: "tectonic-custom" },
      { runner: successfulRunner(calls) },
    );

    expect(value).toMatchObject({
      format: "pdf",
      inputPath: input.path,
      outputPath: output,
      overwritten: false,
      engineVersion: "0.16.0",
    });
    expect(calls).toEqual([
      { command: "tectonic-custom", args: ["--version"], cwd: input.dir },
      {
        command: "tectonic-custom",
        args: ["-X", "compile", "--outdir", expect.any(String), input.path],
        cwd: input.dir,
      },
    ]);
    const outputDirectory = calls[1]?.args[3];
    expect(typeof outputDirectory).toBe("string");
    expect((outputDirectory as string).startsWith(tmpdir())).toBe(true);
    expect(await readFile(input.path, "utf8")).toBe(input.text);
    expect(await readFile(output, "utf8")).toBe("%PDF-1.7\n");
  });

  it("uses talk.pdf for talk.slide.tex and talk.tex", async () => {
    for (const name of ["talk.slide.tex", "talk.tex"]) {
      const input = await source(name);
      const value = await exportPdf({ inputPath: input.path }, { runner: successfulRunner([]) });
      expect(value.outputPath).toBe(join(input.dir, "talk.pdf"));
    }
  });

  it("does not invoke Tectonic when an output exists without --overwrite", async () => {
    const input = await source();
    const output = join(input.dir, "talk.pdf");
    await writeFile(output, "old PDF");
    const runner: ProcessRunner = {
      run: async () => {
        throw new Error("must not run");
      },
    };
    await expect(exportPdf({ inputPath: input.path }, { runner })).rejects.toMatchObject({
      code: "E_OUTPUT_EXISTS",
    });
    expect(await readFile(output, "utf8")).toBe("old PDF");
  });

  it("rejects input/output aliases before invoking Tectonic and preserves the source", async () => {
    const input = await source();
    const hardlink = join(input.dir, "same.pdf");
    const symlinkPath = join(input.dir, "same-link.pdf");
    await link(input.path, hardlink);
    await symlink(input.path, symlinkPath);
    const runner: ProcessRunner = {
      run: async () => {
        throw new Error("must not run");
      },
    };
    for (const overwrite of [false, true]) {
      for (const outputPath of [input.path, hardlink, symlinkPath]) {
        await expect(
          exportPdf({ inputPath: input.path, outputPath, overwrite }, { runner }),
        ).rejects.toMatchObject({
          code: "E_INPUT",
        });
      }
    }
    expect(await readFile(input.path, "utf8")).toBe(input.text);
  });

  it("treats every existing output entry, including a broken symlink, as occupied", async () => {
    const input = await source();
    const output = join(input.dir, "talk.pdf");
    await symlink(join(input.dir, "missing.pdf"), output);
    const runner: ProcessRunner = {
      run: async () => {
        throw new Error("must not run");
      },
    };
    await expect(exportPdf({ inputPath: input.path }, { runner })).rejects.toMatchObject({
      code: "E_OUTPUT_EXISTS",
    });
  });

  it("maps an unreadable output preflight path to E_IO without invoking Tectonic", async () => {
    const input = await source();
    const notDirectory = join(input.dir, "not-a-directory");
    await writeFile(notDirectory, "not a directory");
    const runner: ProcessRunner = {
      run: async () => {
        throw new Error("must not run");
      },
    };
    await expect(
      exportPdf({ inputPath: input.path, outputPath: join(notDirectory, "talk.pdf") }, { runner }),
    ).rejects.toMatchObject({ code: "E_IO" });
  });

  it("only replaces an existing output after successful compilation", async () => {
    const input = await source();
    const output = join(input.dir, "talk.pdf");
    await writeFile(output, "old PDF");
    const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    const value = await exportPdf(
      { inputPath: input.path, overwrite: true },
      { runner: successfulRunner(calls) },
    );
    expect(value.overwritten).toBe(true);
    expect(await readFile(output, "utf8")).toBe("%PDF-1.7\n");
  });

  it("leaves an existing output alone on nonzero and zero/no-PDF compiler results, and cleans temp output", async () => {
    const input = await source();
    const output = join(input.dir, "talk.pdf");
    await writeFile(output, "old PDF");
    const temps: string[] = [];
    const makeTemp = async () => {
      const value = await mkdtemp(join(tmpdir(), "beamer-editor-export-cleanup-"));
      temps.push(value);
      return value;
    };
    for (const compile of [result({ exitCode: 1, stderr: "bad tex" }), result({ stdout: "" })]) {
      let call = 0;
      const runner: ProcessRunner = { run: async () => (call++ === 0 ? result() : compile) };
      await expect(
        exportPdf(
          { inputPath: input.path, overwrite: true },
          { runner, temporaryDirectory: makeTemp },
        ),
      ).rejects.toMatchObject({ code: "E_COMPILE" });
      expect(await readFile(output, "utf8")).toBe("old PDF");
    }
    await expect(Promise.all(temps.map((path) => access(path)))).rejects.toBeDefined();
  });

  it("does not clobber an output created after preflight while Tectonic is running", async () => {
    const input = await source();
    const output = join(input.dir, "talk.pdf");
    let calls = 0;
    const runner: ProcessRunner = {
      async run(_command, args) {
        if (calls++ === 0) return result();
        const outdir = args[args.indexOf("--outdir") + 1] as string;
        await writeFile(join(outdir, "talk.slide.pdf"), "%PDF-1.7\n");
        await writeFile(output, "other writer");
        return result({ stdout: "" });
      },
    };
    await expect(exportPdf({ inputPath: input.path }, { runner })).rejects.toMatchObject({
      code: "E_OUTPUT_EXISTS",
    });
    expect(await readFile(output, "utf8")).toBe("other writer");
  });

  it("gives concurrent no-overwrite exports unique staging paths and one winner", async () => {
    const input = await source();
    const runners = [successfulRunner([]), successfulRunner([])];
    const outcomes = await Promise.allSettled(
      runners.map((runner) => exportPdf({ inputPath: input.path }, { runner })),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "E_OUTPUT_EXISTS" } });
    expect(await readFile(join(input.dir, "talk.pdf"), "utf8")).toBe("%PDF-1.7\n");
  });

  it("returns success when post-publication staging cleanup fails", async () => {
    const input = await source();
    let leftover: string | undefined;
    const value = await exportPdf(
      { inputPath: input.path },
      {
        runner: successfulRunner([]),
        removeStagingFile: async (path) => {
          leftover = path;
          throw new Error("cleanup unavailable");
        },
      },
    );
    expect(value.format).toBe("pdf");
    expect(await readFile(join(input.dir, "talk.pdf"), "utf8")).toBe("%PDF-1.7\n");
    expect(await readFile(leftover as string, "utf8")).toBe("%PDF-1.7\n");
  });

  it("maps a missing executable and cancellation to typed errors", async () => {
    const input = await source();
    const absent: ProcessRunner = {
      run: async () => {
        const error = new Error("spawn tectonic ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
    };
    await expect(exportPdf({ inputPath: input.path }, { runner: absent })).rejects.toMatchObject({
      code: "E_TECTONIC_NOT_FOUND",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      exportPdf(
        { inputPath: input.path, signal: controller.signal },
        { runner: successfulRunner([]) },
      ),
    ).rejects.toMatchObject({ code: "E_CANCELLED" });
  });

  it("observes cancellation after an awaited setup step before starting compilation", async () => {
    const input = await source();
    const controller = new AbortController();
    let calls = 0;
    const runner: ProcessRunner = {
      async run() {
        calls++;
        if (calls === 1) controller.abort();
        return result();
      },
    };
    await expect(
      exportPdf({ inputPath: input.path, signal: controller.signal }, { runner }),
    ).rejects.toMatchObject({
      code: "E_CANCELLED",
    });
    expect(calls).toBe(1);
  });

  it("does not spawn after a pre-aborted signal and kills a running child on abort", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      nodeProcessRunner.run("definitely-not-a-command", [], {
        cwd: tmpdir(),
        signal: preAborted.signal,
      }),
    ).resolves.toMatchObject({ cancelled: true });

    const controller = new AbortController();
    const running = nodeProcessRunner.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: tmpdir(),
      signal: controller.signal,
    });
    controller.abort();
    await expect(running).resolves.toMatchObject({ cancelled: true });
  });

  it("terminates when cancellation races between preflight and abort listener registration", async () => {
    let aborted = false;
    const raceSignal = {
      get aborted() {
        return aborted;
      },
      addEventListener() {
        aborted = true;
      },
      removeEventListener() {},
    } as unknown as AbortSignal;
    await expect(
      nodeProcessRunner.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: tmpdir(),
        signal: raceSignal,
      }),
    ).resolves.toMatchObject({ cancelled: true });
  });

  it("times out a process that ignores SIGTERM and escalates until the promise settles", async () => {
    const started = Date.now();
    const value = await nodeProcessRunner.run(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { cwd: tmpdir(), timeoutMs: 250 },
    );
    expect(value).toMatchObject({ timedOut: true, cancelled: false });
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("uses separate version and compile timeouts and maps compile timeout without replacing output", async () => {
    const input = await source();
    const output = join(input.dir, "talk.pdf");
    await writeFile(output, "old PDF");
    const timeoutValues: Array<number | undefined> = [];
    let call = 0;
    const runner: ProcessRunner = {
      async run(_command, _args, options) {
        timeoutValues.push(options.timeoutMs);
        return call++ === 0 ? result() : result({ timedOut: true, stderr: "stuck" });
      },
    };
    await expect(
      exportPdf(
        { inputPath: input.path, outputPath: output, overwrite: true, timeoutMs: 12_345 },
        { runner },
      ),
    ).rejects.toMatchObject({
      code: "E_COMPILE",
      message: expect.stringContaining("12.345 秒でタイムアウト"),
    });
    expect(timeoutValues).toEqual([10_000, 12_345]);
    expect(await readFile(output, "utf8")).toBe("old PDF");
  });

  it("rejects missing input and an unusable Tectonic version", async () => {
    const missing = join(await directory(), "missing.tex");
    await expect(
      exportPdf({ inputPath: missing }, { runner: successfulRunner([]) }),
    ).rejects.toMatchObject({ code: "E_INPUT" });
    const input = await source();
    const runner: ProcessRunner = { run: async () => result({ stdout: "not tectonic\n" }) };
    await expect(exportPdf({ inputPath: input.path }, { runner })).rejects.toMatchObject({
      code: "E_TECTONIC_VERSION",
    });
  });

  it.runIf(process.env.TECTONIC_INTEGRATION === "1")(
    "compiles with the locally installed Tectonic when explicitly requested",
    async () => {
      const dir = await directory();
      const input = join(dir, "integration.tex");
      await writeFile(
        input,
        "\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}Hello\\end{frame}\n\\end{document}\n",
      );
      const value = await exportPdf({ inputPath: input, overwrite: true });
      expect(await readFile(value.outputPath, "utf8")).toContain("%PDF-");
    },
  );
});

describe("PdfExportError", () => {
  it("exposes a stable machine-readable code", () => {
    expect(new PdfExportError("E_COMPILE", "failed").code).toBe("E_COMPILE");
  });
});
