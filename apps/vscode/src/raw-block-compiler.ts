/**
 * 生ブロックの部分コンパイル(#81)のキューとキャッシュ。`vscode` API には依存しない(注入)。
 *
 * - 描画のたびに RenderedDeck.rawBlocks を受け取り、まだ画像の無いものだけをキューに入れる
 * - コンパイルは 1 本ずつ(UI を塞がない・tectonic を並列に起動しない)
 * - 成功した PDF は cacheDir/<key>[-<依存の指紋>].pdf に置き、次回はコンパイルせずに読む。
 *   書き込みは一時ファイル + rename で、途中の状態を別のプレビューに読まれない
 * - 依存ファイル(画像・.sty など)の指紋がキャッシュの名前に入るので、外部ファイルを直せば作り直す
 * - 失敗は同じ指紋のまま再試行しない(本文・前置き・依存ファイルを直せば名前が変わる)。
 *   テンプレートや画像の更新で resetFailures() が呼ばれたときは、もう一度試す
 * - Tectonic が見つからない(isUnavailable)ときは、ブロックごとに失敗にせず、一度だけ onUnavailable を
 *   出してキューを止める。箱はプレースホルダのまま残る。設定が変わって reset() されたら判定し直す
 */

import type { RawBlockRef } from "@beamer-editor/renderer";

export interface RawBlockCompilerFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** 一時ファイルから最終名へ置き換える(上書き)。 */
  rename(from: string, to: string): Promise<void>;
}

export interface RawBlockCompilerOptions {
  cacheDir: string;
  fs: RawBlockCompilerFileSystem;
  /** standalone 文書の全文を PDF にする(compiler の compileFragment)。 */
  compile(document: string, signal: AbortSignal): Promise<Uint8Array>;
  /** 生ブロック本文と前置きから standalone 文書を組み立てる(compiler の buildFragmentDocument)。 */
  buildDocument(tex: string, preamble: string): string;
  /** 生ブロックが参照する外部ファイルの指紋。無ければ ""。変わればキャッシュも失敗も別扱いになる。 */
  fingerprint?(tex: string, preamble: string): Promise<string>;
  /** コンパイルの失敗が「エンジンが使えない」(Tectonic が無い・壊れている)ことによるものか。 */
  isUnavailable?(error: unknown): boolean;
  /** エンジンが使えないと分かったとき、一度だけ呼ぶ。 */
  onUnavailable?(message: string): void;
  onReady(key: string, pdf: Uint8Array): void;
  onFailed(key: string, message: string): void;
}

interface Job {
  key: string;
  tex: string;
  preamble: string;
}

export class RawBlockCompiler {
  private readonly queue: Job[] = [];
  private readonly queued = new Set<string>();
  /** 画像を届け終えたキャッシュ名(key + 依存の指紋)。 */
  private readonly done = new Set<string>();
  /** 失敗したキャッシュ名。 */
  private readonly failed = new Set<string>();
  private running = false;
  private disposed = false;
  /** エンジンが使えないと分かった後は、reset() まで何もしない。 */
  private unavailable = false;
  private controller: AbortController | undefined;

  constructor(private readonly options: RawBlockCompilerOptions) {}

  /** 描画結果の生ブロック一覧。キューに無いものを入れ、処理を進める(済んだものは処理時に指紋で見分ける)。 */
  request(blocks: readonly RawBlockRef[], preamble: string): void {
    if (this.disposed || this.unavailable) return;
    for (const block of blocks) {
      if (this.queued.has(block.key)) continue;
      this.queued.add(block.key);
      this.queue.push({ key: block.key, tex: block.tex, preamble });
    }
    void this.pump();
  }

  /** 失敗の記録を消す。テンプレート・画像などの外部ファイルが変わったときに呼び、次の描画で再試行させる。 */
  resetFailures(): void {
    this.failed.clear();
  }

  /**
   * エンジンの判定と失敗の記録を消し、待ち行列も捨てる。Tectonic の場所や有効/無効の設定が変わったときに
   * 呼び、次の描画で判定し直す(プレビューを開き直さなくてよい)。
   */
  reset(): void {
    this.unavailable = false;
    this.failed.clear();
    this.queue.length = 0;
    this.queued.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.queued.clear();
    this.controller?.abort();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.disposed) {
        const job = this.queue.shift();
        if (!job) break;
        this.queued.delete(job.key);
        await this.process(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async process(job: Job): Promise<void> {
    const { fs, cacheDir } = this.options;
    let fingerprint = "";
    try {
      fingerprint = (await this.options.fingerprint?.(job.tex, job.preamble)) ?? "";
    } catch {
      // 指紋が取れなければ依存なしとして扱う。
    }
    if (this.disposed) return;
    const cacheName = fingerprint === "" ? job.key : `${job.key}-${fingerprint}`;
    if (this.done.has(cacheName) || this.failed.has(cacheName)) return;
    const cachePath = `${cacheDir}/${cacheName}.pdf`;
    try {
      if (await fs.exists(cachePath)) {
        const pdf = await fs.readFile(cachePath);
        this.done.add(cacheName);
        if (!this.disposed) this.options.onReady(job.key, pdf);
        return;
      }
    } catch {
      // キャッシュが読めなければコンパイルし直す。
    }
    this.controller = new AbortController();
    try {
      const pdf = await this.options.compile(
        this.options.buildDocument(job.tex, job.preamble),
        this.controller.signal,
      );
      if (this.disposed) return;
      this.done.add(cacheName);
      try {
        await fs.mkdir(cacheDir);
        const temporary = `${cachePath}.${Math.random().toString(36).slice(2)}.tmp`;
        await fs.writeFile(temporary, pdf);
        await fs.rename(temporary, cachePath);
      } catch {
        // キャッシュに書けなくても画像は出す。
      }
      this.options.onReady(job.key, pdf);
    } catch (error) {
      if (this.disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      if (this.options.isUnavailable?.(error)) {
        // ブロックごとの赤枠にはせず、箱はそのまま残して一度だけ知らせる。残りも試さない。
        this.unavailable = true;
        this.queue.length = 0;
        this.queued.clear();
        this.options.onUnavailable?.(message);
        return;
      }
      this.failed.add(cacheName);
      this.options.onFailed(job.key, message);
    } finally {
      this.controller = undefined;
    }
  }
}

/** 変わったら生ブロックのコンパイルを判定し直す設定。 */
export const RAW_BLOCK_SETTINGS = [
  "beamerEditor.tectonicPath",
  "beamerEditor.preview.compileRawBlocks",
] as const;

/** 設定変更イベントが部分コンパイルに関わるか(affects は section を受けて判定する)。 */
export function affectsRawBlockCompile(affects: (section: string) => boolean): boolean {
  return RAW_BLOCK_SETTINGS.some((section) => affects(section));
}

export interface DependencyStat {
  mtimeMs: number;
  size: number;
}

/** 拡張子の無い参照(`\\includegraphics{fig}` など)に試す拡張子。先に見つかったものを使う。 */
export const DEPENDENCY_EXTENSIONS = ["", ".pdf", ".png", ".jpg", ".jpeg", ".eps", ".tex"];

/**
 * 依存ファイル名の一覧から指紋を作る。存在するものは更新時刻と大きさ、無いものは missing として並べ、
 * hash にかける。名前が無ければ ""(キャッシュ名に何も足さない)。
 * 名前はデッキのディレクトリ直下に加え、searchPaths(`\\graphicspath` のディレクトリ)の下でも探す。
 */
export async function dependencyFingerprint(
  names: readonly string[],
  resolvePath: (name: string) => string,
  stat: (path: string) => Promise<DependencyStat | null>,
  hash: (text: string) => string,
  searchPaths: readonly string[] = [],
): Promise<string> {
  if (names.length === 0) return "";
  const prefixes = ["", ...searchPaths.map((dir) => (dir.endsWith("/") ? dir : `${dir}/`))];
  const lines: string[] = [];
  for (const name of names) {
    const extensions = /\.[A-Za-z0-9]+$/.test(name) ? [""] : DEPENDENCY_EXTENSIONS;
    const candidates = prefixes.flatMap((prefix) =>
      extensions.map((extension) => `${prefix}${name}${extension}`),
    );
    let line = `${name}|missing`;
    for (const candidate of candidates) {
      const info = await stat(resolvePath(candidate));
      if (info) {
        line = `${candidate}|${info.mtimeMs}|${info.size}`;
        break;
      }
    }
    lines.push(line);
  }
  return hash(lines.join("\n"));
}
