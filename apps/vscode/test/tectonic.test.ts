import { constants } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  type BundledTectonicHost,
  bundledTectonicPath,
  detectBundledTectonic,
  resolveTectonicPath,
} from "../src/tectonic";

function host(overrides: Partial<BundledTectonicHost> = {}): BundledTectonicHost {
  return {
    platform: "darwin",
    existsSync: vi.fn(() => true),
    accessSync: vi.fn(),
    chmodSync: vi.fn(),
    ...overrides,
  };
}

describe("同梱 Tectonic の検出", () => {
  it("bin/ の下の同梱バイナリを返し、Windows だけ .exe を付ける", () => {
    expect(bundledTectonicPath("/ext", "darwin")).toBe("/ext/bin/tectonic");
    expect(bundledTectonicPath("/ext", "linux")).toBe("/ext/bin/tectonic");
    expect(bundledTectonicPath("/ext", "win32")).toBe("/ext/bin/tectonic.exe");
  });

  it("無ければ undefined(汎用 VSIX や対象外の環境では PATH の tectonic に任せる)", () => {
    expect(detectBundledTectonic("/ext", host({ existsSync: () => false }))).toBeUndefined();
  });

  it("実行できなければ 0o755 を付け直し、付け直せなくてもパスは返す", () => {
    const denied = () => {
      throw new Error("EACCES");
    };
    const chmodSync = vi.fn();
    expect(detectBundledTectonic("/ext", host({ accessSync: denied, chmodSync }))).toBe(
      "/ext/bin/tectonic",
    );
    expect(chmodSync).toHaveBeenCalledWith("/ext/bin/tectonic", 0o755);
    expect(detectBundledTectonic("/ext", host({ accessSync: denied, chmodSync: denied }))).toBe(
      "/ext/bin/tectonic",
    );
    // 実行できるなら触らない。Windows では確認も chmod もしない。
    const untouched = vi.fn();
    const accessSync = vi.fn();
    detectBundledTectonic("/ext", host({ accessSync, chmodSync: untouched }));
    expect(accessSync).toHaveBeenCalledWith("/ext/bin/tectonic", constants.X_OK);
    expect(untouched).not.toHaveBeenCalled();
    detectBundledTectonic(
      "/ext",
      host({ platform: "win32", accessSync: denied, chmodSync: untouched }),
    );
    expect(untouched).not.toHaveBeenCalled();
  });

  it("設定があればそれを優先し、無ければ同梱、どちらも無ければ undefined", () => {
    expect(resolveTectonicPath("/opt/tectonic", "/ext/bin/tectonic")).toBe("/opt/tectonic");
    expect(resolveTectonicPath(undefined, "/ext/bin/tectonic")).toBe("/ext/bin/tectonic");
    expect(resolveTectonicPath(undefined, undefined)).toBeUndefined();
  });
});
