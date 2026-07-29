import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileProbes } from "../src/file-probes.ts";

const assets = fileURLToPath(new URL("../../../fixtures/assets/", import.meta.url));
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "beamer-file-probes-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("createNodeFileProbes", () => {
  it("resolves relative and absolute regular files without throwing", () => {
    const probes = createNodeFileProbes(assets);

    expect(probes.fileExists("logo.png")).toBe(true);
    expect(probes.fileExists(resolve(assets, "logo.png"))).toBe(true);
    expect(probes.fileExists("missing.png")).toBe(false);
  });

  it("reads PNG, JPEG, and PDF dimensions and reports probe errors", () => {
    const probes = createNodeFileProbes(assets);

    expect(probes.probeImage("logo.png")).toEqual({
      ok: true,
      metadata: { format: "png", dimensions: { width: 240, height: 160, unit: "px" } },
    });
    expect(probes.probeImage("tiny.jpg")).toEqual({
      ok: true,
      metadata: { format: "jpeg", dimensions: { width: 1, height: 1, unit: "px" } },
    });
    expect(probes.probeImage("result-chart.pdf")).toEqual({
      ok: true,
      metadata: { format: "pdf", dimensions: { width: 226.77, height: 170.08, unit: "pt" } },
    });
    expect(probes.probeImage("missing.png")).toEqual({ ok: false, error: { code: "not-found" } });
    expect(probes.probeImage("unsupported.svg")).toEqual({
      ok: false,
      error: { code: "unsupported-format" },
    });
  });

  it("rejects truncated PNG and JPEG headers", () => {
    const directory = temporaryDirectory();
    writeFileSync(
      join(directory, "truncated.png"),
      readFileSync(join(assets, "logo.png")).subarray(0, 24),
    );
    writeFileSync(
      join(directory, "truncated.jpg"),
      readFileSync(join(assets, "tiny.jpg")).subarray(0, 12),
    );
    const probes = createNodeFileProbes(directory);

    expect(probes.probeImage("truncated.png")).toEqual({
      ok: false,
      error: { code: "invalid-data" },
    });
    expect(probes.probeImage("truncated.jpg")).toEqual({
      ok: false,
      error: { code: "invalid-data" },
    });
    writeFileSync(
      join(directory, "inconsistent.jpg"),
      Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03]),
    );
    expect(probes.probeImage("inconsistent.jpg")).toEqual({
      ok: false,
      error: { code: "invalid-data" },
    });
  });

  it("reads Flate object streams with array filter declarations", () => {
    const directory = temporaryDirectory();
    const stream = deflateSync(Buffer.from("1 0 obj << /MediaBox [10 20 210 320] >> endobj"));
    writeFileSync(
      join(directory, "array-filter.pdf"),
      Buffer.concat([
        Buffer.from(
          `%PDF-1.7\n<< /Type /ObjStm /Filter [/FlateDecode] /Length ${stream.length} >>\nstream\n`,
        ),
        stream,
        Buffer.from("\nendstream\n%%EOF\n"),
      ]),
    );

    expect(createNodeFileProbes(directory).probeImage("array-filter.pdf")).toEqual({
      ok: true,
      metadata: { format: "pdf", dimensions: { width: 200, height: 300, unit: "pt" } },
    });
  });

  it("captures an absolute base directory before the working directory changes", () => {
    const probes = createNodeFileProbes(relative(process.cwd(), assets));
    const previous = process.cwd();
    const directory = temporaryDirectory();
    try {
      process.chdir(directory);
      expect(probes.fileExists("logo.png")).toBe(true);
    } finally {
      process.chdir(previous);
    }
  });

  it("falls back safely for indirect PDF stream lengths", () => {
    const directory = temporaryDirectory();
    const stream = deflateSync(Buffer.from("<< /MediaBox [0 0 72 144] >>"));
    writeFileSync(
      join(directory, "indirect-length.pdf"),
      Buffer.concat([
        Buffer.from("%PDF-1.7\n<< /Filter /FlateDecode /Length 12 0 R >>\nstream\n"),
        stream,
        Buffer.from("\nendstream\n%%EOF\n"),
      ]),
    );

    expect(createNodeFileProbes(directory).probeImage("indirect-length.pdf")).toEqual({
      ok: true,
      metadata: { format: "pdf", dimensions: { width: 72, height: 144, unit: "pt" } },
    });
  });

  it("rejects non-regular and oversized files without reading them", () => {
    const directory = temporaryDirectory();
    const probes = createNodeFileProbes(directory);
    mkdirSync(join(directory, "directory.png"));
    writeFileSync(join(directory, "oversized.pdf"), "%PDF-\n");
    truncateSync(join(directory, "oversized.pdf"), 17 * 1024 * 1024);

    expect(probes.probeImage("directory.png")).toEqual({
      ok: false,
      error: { code: "unreadable" },
    });
    expect(probes.probeImage("oversized.pdf")).toEqual({
      ok: false,
      error: { code: "unreadable" },
    });
  });

  it("caps decompression of high-ratio PDF Flate streams", () => {
    const directory = temporaryDirectory();
    const payload = Buffer.from("x".repeat(5 * 1024 * 1024));
    const stream = deflateSync(payload);
    writeFileSync(
      join(directory, "bomb.pdf"),
      Buffer.concat([
        Buffer.from("%PDF-1.7\n<< /Type /ObjStm /Filter /FlateDecode >>\nstream\n"),
        stream,
        Buffer.from("\nendstream\n%%EOF\n"),
      ]),
    );

    expect(createNodeFileProbes(directory).probeImage("bomb.pdf")).toEqual({
      ok: false,
      error: { code: "invalid-data" },
    });
  });

  it("reads bounded prefixes from valid raster files larger than one MiB", () => {
    const directory = temporaryDirectory();
    const padding = Buffer.alloc(1024 * 1024 + 1);
    const fixtures: ReadonlyArray<readonly [string, string]> = [
      ["large.png", "logo.png"],
      ["large.jpg", "tiny.jpg"],
    ];
    for (const [name, fixture] of fixtures) {
      writeFileSync(
        join(directory, name),
        Buffer.concat([readFileSync(join(assets, fixture)), padding]),
      );
    }
    const probes = createNodeFileProbes(directory);

    expect(probes.probeImage("large.png")).toMatchObject({
      ok: true,
      metadata: { format: "png", dimensions: { width: 240, height: 160 } },
    });
    expect(probes.probeImage("large.jpg")).toMatchObject({
      ok: true,
      metadata: { format: "jpeg", dimensions: { width: 1, height: 1 } },
    });
  });
});
