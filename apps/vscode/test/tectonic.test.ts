import { constants, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type BundledTectonicHost,
  bundledTectonicPath,
  detectBundledTectonic,
  resolveTectonicPath,
  tectonicPathFromConfig,
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

  it("設定値は空白だけなら無いものとして扱い、同梱にフォールバックする", () => {
    expect(tectonicPathFromConfig("/opt/tectonic", "/ext/bin/tectonic")).toBe("/opt/tectonic");
    expect(tectonicPathFromConfig("  /opt/tectonic  ", "/ext/bin/tectonic")).toBe("/opt/tectonic");
    // 既定値の空文字・空白・文字列でない値は「指定なし」。同梱があればそれを使う。
    expect(tectonicPathFromConfig("", "/ext/bin/tectonic")).toBe("/ext/bin/tectonic");
    expect(tectonicPathFromConfig("   ", "/ext/bin/tectonic")).toBe("/ext/bin/tectonic");
    expect(tectonicPathFromConfig(undefined, "/ext/bin/tectonic")).toBe("/ext/bin/tectonic");
    expect(tectonicPathFromConfig(42, "/ext/bin/tectonic")).toBe("/ext/bin/tectonic");
    // 同梱の無い汎用 VSIX では従来どおり PATH の tectonic に任せる。
    expect(tectonicPathFromConfig("", undefined)).toBeUndefined();
  });

  it("設定を読むのは書き出しと部分コンパイルの 2 か所で、どちらも同じ解決を通す(#112 との配線)", () => {
    // 部分コンパイルが設定値を直接 compiler へ渡すと、既定値が空のとき同梱を無視して
    // E_TECTONIC_NOT_FOUND になる。読み出し口が解決関数の外へ増えないことをここで押さえる。
    const source = readFileSync(join(__dirname, "../src/extension.ts"), "utf8");
    expect(source.match(/get<unknown>\("tectonicPath"\)/g)).toHaveLength(2);
    expect(source.match(/tectonicPathFromConfig\(/g)).toHaveLength(2);
    expect(source).not.toMatch(/normalizeTectonicPath\(/);
  });
});
