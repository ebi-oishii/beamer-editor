import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.ts";
import {
  deckFontFamilies,
  defaultFontPaths,
  FONT_CATALOG,
  type FontIO,
  type FontPaths,
  fetchFont,
  resolveFont,
} from "../src/fonts.ts";

/**
 * ネットワーク・fs へ触れないフェイク FontIO。
 * 既存パス集合をメモリで持ち、download / copy は宛先を集合へ足す(実 IO と同じ観測に近づける)。
 * 呼び出しを記録して「何を落として何を配置したか」を検証できるようにする。
 */
function makeFakeIO(existing: readonly string[] = []) {
  const files = new Set(existing);
  const calls = { downloaded: [] as string[], copied: [] as string[], mkdirp: [] as string[] };
  const io: FontIO = {
    async exists(path) {
      return files.has(path);
    },
    async download(_url, destPath) {
      calls.downloaded.push(destPath);
      files.add(destPath);
    },
    async copy(_src, dest) {
      calls.copied.push(dest);
      files.add(dest);
    },
    async mkdirp(path) {
      calls.mkdirp.push(path);
    },
  };
  return { io, files, calls };
}

const PATHS: FontPaths = { cacheDir: "/cache", userFontDir: "/userfonts" };
const NOTO = "Noto Sans CJK JP";
const REGULAR = "NotoSansCJKjp-Regular.otf";
const BOLD = "NotoSansCJKjp-Bold.otf";
const NOTO_FILES = [REGULAR, BOLD];
const cachePath = (f: string) => join(PATHS.cacheDir, f);
const userPath = (f: string) => join("/userfonts", f);

describe("FONT_CATALOG(カタログ整合)", () => {
  it("最低 1 family あり、Noto Sans CJK JP を含む", () => {
    expect(FONT_CATALOG.length).toBeGreaterThan(0);
    expect(FONT_CATALOG.map((e) => e.family)).toContain(NOTO);
  });

  it("各エントリの family・license・files が妥当", () => {
    for (const entry of FONT_CATALOG) {
      expect(entry.family.trim().length).toBeGreaterThan(0);
      expect(entry.license.trim().length).toBeGreaterThan(0);
      expect(entry.files.length).toBeGreaterThan(0);
    }
  });

  it("各ファイルの fileName は OTF/TTF、URL は https でファイル名を含む", () => {
    for (const entry of FONT_CATALOG) {
      for (const file of entry.files) {
        expect(file.fileName).toMatch(/\.(otf|ttf)$/i);
        expect(file.url).toMatch(/^https:\/\//);
        expect(file.url).toContain(file.fileName);
      }
    }
  });
});

describe("resolveFont(4 状態)", () => {
  it("installed: userFontDir に全ファイルが揃う", async () => {
    const { io } = makeFakeIO(NOTO_FILES.map(userPath));
    const r = await resolveFont(NOTO, PATHS, io);
    expect(r.status).toBe("installed");
    expect(r.license).toBe("SIL OFL 1.1");
    expect(r.files.every((f) => f.inUserDir)).toBe(true);
  });

  it("cached: cacheDir に全ファイルが揃う(userFontDir には無い)", async () => {
    const { io } = makeFakeIO(NOTO_FILES.map(cachePath));
    const r = await resolveFont(NOTO, PATHS, io);
    expect(r.status).toBe("cached");
    expect(r.files.every((f) => f.inCache && !f.inUserDir)).toBe(true);
  });

  it("missing: どちらにも揃っていない", async () => {
    const { io } = makeFakeIO([]);
    const r = await resolveFont(NOTO, PATHS, io);
    expect(r.status).toBe("missing");
  });

  it("一部だけキャッシュにあると missing 扱い", async () => {
    const { io } = makeFakeIO([cachePath(REGULAR)]);
    const r = await resolveFont(NOTO, PATHS, io);
    expect(r.status).toBe("missing");
  });

  it("unknown-family: カタログに無い family", async () => {
    const { io } = makeFakeIO([]);
    const r = await resolveFont("ACME Gothic", PATHS, io);
    expect(r.status).toBe("unknown-family");
    expect(r.license).toBeNull();
    expect(r.files).toEqual([]);
  });
});

describe("fetchFont", () => {
  it("missing のとき全ファイルを取得し userFontDir へ配置する", async () => {
    const { io, calls } = makeFakeIO([]);
    const result = await fetchFont(NOTO, PATHS, io);
    expect(result.fetched.sort()).toEqual([...NOTO_FILES].sort());
    expect(result.skipped).toEqual([]);
    expect(result.installed.sort()).toEqual([...NOTO_FILES].sort());
    expect(calls.downloaded).toEqual(NOTO_FILES.map(cachePath));
    expect(calls.copied).toEqual(NOTO_FILES.map(userPath));
  });

  it("キャッシュ済みのファイルはダウンロードをスキップする", async () => {
    const { io, calls } = makeFakeIO([cachePath(REGULAR)]);
    const result = await fetchFont(NOTO, PATHS, io);
    expect(result.skipped).toEqual([REGULAR]);
    expect(result.fetched).toEqual([BOLD]);
    // ダウンロードは 1 本だけ、配置は両方(userFontDir にはまだ無い)。
    expect(calls.downloaded).toEqual([cachePath(BOLD)]);
    expect(result.installed.sort()).toEqual([...NOTO_FILES].sort());
  });

  it("userFontDir=null なら配置をスキップしキャッシュのみ", async () => {
    const paths: FontPaths = { cacheDir: "/cache", userFontDir: null };
    const { io, calls } = makeFakeIO([]);
    const result = await fetchFont(NOTO, paths, io);
    expect(result.fetched.sort()).toEqual([...NOTO_FILES].sort());
    expect(result.installed).toEqual([]);
    expect(calls.copied).toEqual([]);
  });

  it("冪等: 取得済みを再度呼んでも何も落とさず配置もしない", async () => {
    const { io } = makeFakeIO([]);
    await fetchFont(NOTO, PATHS, io);
    const second = await fetchFont(NOTO, PATHS, io);
    expect(second.fetched).toEqual([]);
    expect(second.installed).toEqual([]);
    expect(second.skipped.sort()).toEqual([...NOTO_FILES].sort());
  });

  it("unknown-family には何もせず空の結果を返す", async () => {
    const { io, calls } = makeFakeIO([]);
    const result = await fetchFont("ACME Gothic", PATHS, io);
    expect(result).toEqual({ fetched: [], skipped: [], installed: [] });
    expect(calls.downloaded).toEqual([]);
  });
});

describe("deckFontFamilies", () => {
  it("main/mono の family を出現順で重複排除する", () => {
    const src = [
      "\\deckfont{main}{Noto Sans CJK JP}",
      "\\deckfont{mono}{Source Han Code JP}",
      "\\deckfont{main}{Noto Sans CJK JP}", // 重複
      "\\deckfont{main}{IPAexGothic}",
    ].join("\n");
    expect(deckFontFamilies(src)).toEqual([
      "Noto Sans CJK JP",
      "Source Han Code JP",
      "IPAexGothic",
    ]);
  });

  it("空白ゆらぎを許容し、slot 以外は拾わない", () => {
    const src = "\\deckfont { main } { Noto Sans CJK JP }\n\\deckcolor{structure}{0F62FE}";
    expect(deckFontFamilies(src)).toEqual(["Noto Sans CJK JP"]);
  });

  it("deckfont が無ければ空配列", () => {
    expect(deckFontFamilies("\\deckcolor{alert}{DA1E28}")).toEqual([]);
  });
});

describe("parseArgs(純関数)", () => {
  it("command と sub を取る", () => {
    expect(parseArgs(["fonts", "status"])).toEqual({
      command: "fonts",
      sub: "status",
      family: undefined,
      json: false,
    });
  });

  it("--json はどの位置でも拾い、位置引数から除外する", () => {
    expect(parseArgs(["fonts", "status", "--json"]).json).toBe(true);
    const p = parseArgs(["fonts", "fetch", "Noto", "--json", "Sans"]);
    expect(p.json).toBe(true);
    expect(p.family).toBe("Noto Sans");
  });

  it("空白を含む family を複数語から連結する", () => {
    expect(parseArgs(["fonts", "fetch", "Noto", "Sans", "CJK", "JP"]).family).toBe(
      "Noto Sans CJK JP",
    );
  });

  it("family 省略時は undefined", () => {
    expect(parseArgs(["fonts", "fetch"]).family).toBeUndefined();
  });

  it("引数なしは全て未指定", () => {
    expect(parseArgs([])).toEqual({
      command: undefined,
      sub: undefined,
      family: undefined,
      json: false,
    });
  });
});

describe("defaultFontPaths(OS 分岐)", () => {
  it("darwin", () => {
    const p = defaultFontPaths("darwin", "/Users/test");
    expect(p.cacheDir).toContain(join("Library", "Application Support", "beamer-editor", "fonts"));
    expect(p.userFontDir).toContain(join("Library", "Fonts"));
  });

  it("win32", () => {
    const p = defaultFontPaths("win32", "/Users/test");
    expect(p.cacheDir).toContain(join("beamer-editor", "fonts"));
    expect(p.userFontDir).toContain(join("Microsoft", "Windows", "Fonts"));
  });

  it("linux / その他(XDG)", () => {
    const p = defaultFontPaths("linux", "/home/test");
    expect(p.cacheDir).toContain(join("beamer-editor", "fonts"));
    expect(p.userFontDir).toContain(join(".local", "share", "fonts"));
  });
});
