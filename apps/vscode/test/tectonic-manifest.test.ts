import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assetUrl, MANIFEST, targetForPlatform } from "../scripts/fetch-tectonic.mjs";

describe("同梱する Tectonic の一覧(tectonic.json)", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "../tectonic.json"), "utf8")) as {
    version: string;
    targets: Record<string, { asset: string; sha256: string; binary: string }>;
  };

  it("VS Code のターゲット 5 つに、版を含むアーカイブ名・sha256・バイナリ名が揃っている", () => {
    expect(Object.keys(manifest.targets).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-x64",
    ]);
    for (const [target, entry] of Object.entries(manifest.targets)) {
      expect(entry.asset, target).toContain(manifest.version);
      expect(entry.sha256, target).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.binary, target).toBe(target.startsWith("win32") ? "tectonic.exe" : "tectonic");
    }
    expect(MANIFEST.version).toBe(manifest.version);
  });

  it("取得元は Tectonic の GitHub Releases で、版とアーカイブ名を埋める", () => {
    expect(assetUrl("linux-x64")).toBe(
      `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${manifest.version}/${manifest.targets["linux-x64"]?.asset}`,
    );
    expect(() => assetUrl("plan9-mips")).toThrow();
  });

  it("Node の platform / arch を VS Code のターゲットにし、対応が無ければ null", () => {
    expect(targetForPlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(targetForPlatform("darwin", "x64")).toBe("darwin-x64");
    expect(targetForPlatform("linux", "x64")).toBe("linux-x64");
    expect(targetForPlatform("linux", "arm64")).toBe("linux-arm64");
    expect(targetForPlatform("win32", "x64")).toBe("win32-x64");
    expect(targetForPlatform("win32", "arm64")).toBeNull();
    expect(targetForPlatform("freebsd", "x64")).toBeNull();
  });
});
