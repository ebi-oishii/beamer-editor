import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("配布スクリプト", () => {
  let work: string;
  let extension: string;

  beforeEach(() => {
    work = realpathSync(mkdtempSync(join(tmpdir(), "beamer packaging ")));
    extension = join(work, "extension with spaces");
    mkdirSync(join(extension, "scripts"), { recursive: true });
    for (const script of ["fetch-tectonic.mjs", "package.mjs"]) {
      copyFileSync(join(__dirname, "../scripts", script), join(extension, "scripts", script));
    }
    writeFileSync(join(extension, "tectonic.json"), JSON.stringify({ targets: {} }));
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it.each([
    "relative",
    "absolute",
  ])("%s の出力先に空白・シェル特殊文字があっても一つの引数として渡し、成功する", (kind) => {
    // 実際の子プロセスで引数を受け取り、vsce と同じ cwd / -o の規約で出力する。
    // PATH 上の vsce シムには依存せず、拡張の依存パッケージから CLI を解決する。
    const vsceDir = join(extension, "node_modules/@vscode/vsce");
    mkdirSync(vsceDir, { recursive: true });
    writeFileSync(
      join(vsceDir, "package.json"),
      JSON.stringify({ name: "@vscode/vsce", type: "commonjs", bin: { vsce: "vsce" } }),
    );
    writeFileSync(
      join(vsceDir, "vsce"),
      `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(args));
`,
    );
    const out =
      kind === "absolute" ? join(work, "my build & preview.vsix") : "my build & preview.vsix";
    execFileSync(
      process.execPath,
      [join(extension, "scripts/package.mjs"), "--target", "universal", "--out", out],
      { cwd: work },
    );
    expect(JSON.parse(readFileSync(resolve(extension, out), "utf8"))).toEqual([
      "package",
      "--no-dependencies",
      "-o",
      out,
    ]);
  });

  it.each([
    "tar.gz",
    "zip",
  ])("%s を展開し、一時ディレクトリから rename できない出力先にもバイナリを配置する", (format) => {
    const binary = format === "zip" ? "tectonic.exe" : "tectonic";
    const contents = "tectonic fixture\n";
    const cache = join(extension, ".tectonic-cache");
    mkdirSync(cache);
    const asset = `fixture.${format}`;
    const archive = join(cache, asset);
    if (format === "zip") {
      // 内容が "tectonic fixture\n" の tectonic.exe 一つを収めた ZIP。
      writeFileSync(
        archive,
        Buffer.from(
          "UEsDBBQAAAAIAGoZK12BjdFWEwAAABEAAAAMAAAAdGVjdG9uaWMuZXhlK0lNLsnPy0xWSMusKCktSuUCAFBLAQIUAxQAAAAIAGoZK12BjdFWEwAAABEAAAAMAAAAAAAAAAAAAACAAQAAAAB0ZWN0b25pYy5leGVQSwUGAAAAAAEAAQA6AAAAPQAAAAAA",
          "base64",
        ),
      );
    } else {
      writeFileSync(join(work, binary), contents);
      execFileSync("tar", ["-czf", archive, "-C", work, binary]);
    }
    // 上流の LICENSE も同梱物として配る。取得はキャッシュ済みとして扱い、ネットワークには出ない。
    const licenseText = "MIT License (fixture)\n";
    writeFileSync(join(cache, "tectonic-LICENSE.txt"), licenseText);
    writeFileSync(
      join(extension, "tectonic.json"),
      JSON.stringify({
        version: "9.9.9",
        releaseUrl: "https://example.invalid/{version}/{asset}",
        license: {
          sourceUrl: "https://example.invalid/{version}/LICENSE",
          sha256: createHash("sha256").update(licenseText).digest("hex"),
          file: "tectonic-LICENSE.txt",
        },
        targets: {
          fixture: {
            asset,
            binary,
            sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
          },
        },
      }),
    );
    // 実際の展開・コピーを動かし、別ファイルシステム間の rename の失敗だけを再現する。
    const preload = join(work, "cross-device.cjs");
    writeFileSync(
      preload,
      `const fs = require("node:fs");
fs.renameSync = () => { throw Object.assign(new Error("cross-device link"), { code: "EXDEV" }); };
require("node:module").syncBuiltinESMExports();
`,
    );
    const out = join(work, "output bin");
    execFileSync(
      process.execPath,
      [
        "--require",
        preload,
        join(extension, "scripts/fetch-tectonic.mjs"),
        "--target",
        "fixture",
        "--out",
        out,
      ],
      { cwd: work },
    );
    expect(readFileSync(join(out, binary), "utf8")).toBe(contents);
    // 再配布に必要な LICENSE と、何をどこから同梱したかの NOTICE がバイナリと一緒に置かれる。
    expect(readFileSync(join(out, "tectonic-LICENSE.txt"), "utf8")).toBe(licenseText);
    const notice = readFileSync(join(out, "tectonic-NOTICE.md"), "utf8");
    expect(notice).toContain("9.9.9");
    expect(notice).toContain("https://example.invalid/9.9.9/fixture.");
    expect(notice).toContain("tectonic-LICENSE.txt");
    if (format === "tar.gz" && process.platform !== "win32") {
      expect(statSync(join(out, binary)).mode & 0o777).toBe(0o755);
    }
  });
});
