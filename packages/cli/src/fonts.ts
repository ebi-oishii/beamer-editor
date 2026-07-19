/**
 * フォントカタログと解決・取得ロジック(スタイルトラック S2。theme-design.md §4)。
 *
 * `\deckfont` は名前参照であり、フォントバイナリはリポジトリに同梱しない。
 * 標準の Noto Sans CJK JP はローカルに無ければ `deck fonts fetch` が取得して
 * キャッシュする(tectonic のパッケージ自動取得と同じ思想)。会社指定フォントの
 * ように再配布できないものは「名前参照 + 各自インストール」で扱い、カタログに
 * 無い family は unknown-family として扱う(解決状態の表示のみ)。
 *
 * fs / ネットワークは L004 と同じ「ファイルアクセス注入」パターンで注入可能にし、
 * ネットワークへ触れずに単体テストできるようにする(本体は FontIO 越しにしか
 * 外界へ触れない)。
 */

import { createWriteStream } from "node:fs";
import { access, copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

export interface FontFile {
  fileName: string;
  url: string;
}

export interface FontCatalogEntry {
  /** fontspec / xeCJK に渡すフォント名(\deckfont の第 2 引数と一致させる)。 */
  family: string;
  /** Regular / Bold などのフォントファイル群。 */
  files: FontFile[];
  license: string;
}

/**
 * カタログ本体。今は標準の Noto Sans CJK JP のみ。
 *
 * 採用 URL(2026-07-18 に `curl -sIL` で HTTP 200 + Content-Length を確認):
 *   タグ: notofonts/noto-cjk の Sans2.004(再現性のため main ではなくタグ固定)
 *   Regular: .../Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf  → 16,467,736 bytes
 *   Bold:    .../Sans/OTF/Japanese/NotoSansCJKjp-Bold.otf     → 17,032,620 bytes
 * 第一候補の googlefonts/noto-cjk は notofonts/noto-cjk へリダイレクトされるため、
 * リダイレクト後の raw.githubusercontent.com を直接指す(LFS ポインタではなく実体。
 * サイズが 16MB 超であることで実体だと確認済み)。
 */
const NOTO_CJK_TAG = "Sans2.004";
const NOTO_CJK_BASE = `https://raw.githubusercontent.com/notofonts/noto-cjk/${NOTO_CJK_TAG}/Sans/OTF/Japanese`;

export const FONT_CATALOG: readonly FontCatalogEntry[] = [
  {
    family: "Noto Sans CJK JP",
    license: "SIL OFL 1.1",
    files: [
      { fileName: "NotoSansCJKjp-Regular.otf", url: `${NOTO_CJK_BASE}/NotoSansCJKjp-Regular.otf` },
      { fileName: "NotoSansCJKjp-Bold.otf", url: `${NOTO_CJK_BASE}/NotoSansCJKjp-Bold.otf` },
    ],
  },
];

/** fs / ネットワークの注入口。単体テストではフェイクを渡す。 */
export interface FontIO {
  exists(path: string): Promise<boolean>;
  download(url: string, destPath: string): Promise<void>;
  copy(src: string, dest: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
}

export interface FontPaths {
  /** ダウンロードしたフォントのキャッシュ置き場。 */
  cacheDir: string;
  /** OS のユーザーフォントディレクトリ。null なら配置をスキップ(キャッシュのみ)。 */
  userFontDir: string | null;
}

export type FontStatus = "installed" | "cached" | "missing" | "unknown-family";

/** 1 ファイルの所在。fetchFont が「何を落として何を配置するか」を決める粒度。 */
export interface ResolvedFontFile {
  fileName: string;
  url: string;
  /** userFontDir に存在するか(userFontDir が null なら常に false)。 */
  inUserDir: boolean;
  /** cacheDir に存在するか。 */
  inCache: boolean;
}

export interface FontResolution {
  family: string;
  status: FontStatus;
  license: string | null;
  files: ResolvedFontFile[];
}

/** OS 既定のフォントパス。darwin を第一に、win32 / それ以外(XDG)も面倒を見る。 */
export function defaultFontPaths(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): FontPaths {
  if (platform === "darwin") {
    return {
      cacheDir: join(home, "Library", "Application Support", "beamer-editor", "fonts"),
      userFontDir: join(home, "Library", "Fonts"),
    };
  }
  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return {
      cacheDir: join(localAppData, "beamer-editor", "fonts"),
      userFontDir: join(localAppData, "Microsoft", "Windows", "Fonts"),
    };
  }
  // linux / その他: XDG Base Directory に従う。
  const dataHome = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
  return {
    cacheDir: join(dataHome, "beamer-editor", "fonts"),
    userFontDir: join(home, ".local", "share", "fonts"),
  };
}

/** カタログから family を引く(見つからなければ undefined)。 */
export function catalogEntry(family: string): FontCatalogEntry | undefined {
  return FONT_CATALOG.find((e) => e.family === family);
}

/**
 * family の解決状態を返す。
 *   installed: userFontDir に全ファイルが揃っている
 *   cached:    (installed でなく)cacheDir に全ファイルが揃っている
 *   missing:   カタログにはあるが、どちらにも揃っていない
 *   unknown-family: カタログに無い(= 名前参照のみ。各自インストールの会社フォント等)
 */
export async function resolveFont(
  family: string,
  paths: FontPaths,
  io: FontIO,
): Promise<FontResolution> {
  const entry = catalogEntry(family);
  if (!entry) {
    return { family, status: "unknown-family", license: null, files: [] };
  }
  const files: ResolvedFontFile[] = [];
  for (const f of entry.files) {
    const inUserDir =
      paths.userFontDir !== null && (await io.exists(join(paths.userFontDir, f.fileName)));
    const inCache = await io.exists(join(paths.cacheDir, f.fileName));
    files.push({ fileName: f.fileName, url: f.url, inUserDir, inCache });
  }
  const status: FontStatus =
    paths.userFontDir !== null && files.every((f) => f.inUserDir)
      ? "installed"
      : files.every((f) => f.inCache)
        ? "cached"
        : "missing";
  return { family, status, license: entry.license, files };
}

export interface FetchResult {
  /** 今回ダウンロードしてキャッシュに入れたファイル。 */
  fetched: string[];
  /** すでにキャッシュにあり、ダウンロードを省いたファイル。 */
  skipped: string[];
  /** 今回 userFontDir へコピー配置したファイル。 */
  installed: string[];
}

/**
 * family を取得する。キャッシュに無いものだけダウンロードし、userFontDir があれば
 * そこへコピーで配置する。既にキャッシュ/配置済みのものは触らない(冪等)。
 * カタログに無い family は何もせず空の結果を返す(CLI 側で unknown-family を報告)。
 */
export async function fetchFont(
  family: string,
  paths: FontPaths,
  io: FontIO,
): Promise<FetchResult> {
  const result: FetchResult = { fetched: [], skipped: [], installed: [] };
  const resolution = await resolveFont(family, paths, io);
  if (resolution.status === "unknown-family") {
    return result;
  }
  await io.mkdirp(paths.cacheDir);
  for (const file of resolution.files) {
    const cachePath = join(paths.cacheDir, file.fileName);
    // 1. キャッシュ確保: 無ければダウンロード。
    if (file.inCache) {
      result.skipped.push(file.fileName);
    } else {
      await io.download(file.url, cachePath);
      result.fetched.push(file.fileName);
    }
    // 2. 配置: userFontDir があり、未配置ならコピー。
    if (paths.userFontDir !== null && !file.inUserDir) {
      await io.mkdirp(paths.userFontDir);
      await io.copy(cachePath, join(paths.userFontDir, file.fileName));
      result.installed.push(file.fileName);
    }
  }
  return result;
}

/**
 * デッキソースの `%% style` 領域から `\deckfont{main|mono}{名前}` の family を抽出する
 * (`fonts status <deck>` が「そのデッキで使われうるフォント」を出すための純関数)。
 * core のパーサには依存しない軽量スキャン。重複は取り除き、出現順を保つ。
 */
export function deckFontFamilies(texSource: string): string[] {
  const re = /\\deckfont\s*\{\s*(?:main|mono)\s*\}\s*\{([^}]*)\}/g;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of texSource.matchAll(re)) {
    const family = (m[1] ?? "").trim();
    if (family.length > 0 && !seen.has(family)) {
      seen.add(family);
      out.push(family);
    }
  }
  return out;
}

/** Node 実体の FontIO(fs + 組み込み fetch)。CLI が本番で使う。 */
export const nodeFontIO: FontIO = {
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  async download(url, destPath) {
    const res = await fetch(url);
    if (!res.ok || res.body === null) {
      throw new Error(`ダウンロード失敗 (HTTP ${res.status}): ${url}`);
    }
    // web ReadableStream → Node stream でファイルへ流す(大きい OTF を一気に持たない)。
    // 組み込み fetch の body(DOM 系 ReadableStream)と node:stream/web の型は
    // 同一実体だが型名が食い違うため、fromWeb 用に後者へ読み替える(実行時は無変換)。
    const webBody = res.body as unknown as NodeWebReadableStream<Uint8Array>;
    await pipeline(Readable.fromWeb(webBody), createWriteStream(destPath));
  },
  async copy(src, dest) {
    await copyFile(src, dest);
  },
  async mkdirp(path) {
    await mkdir(path, { recursive: true });
  },
};
