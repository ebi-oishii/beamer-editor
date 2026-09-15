/**
 * 生ブロックの部分コンパイル(#81)のキューとキャッシュ。`vscode` API には依存しない(注入)。
 *
 * - 描画のたびに RenderedDeck.rawBlocks を受け取り、まだ画像の無いものだけをキューに入れる。
 *   最新の描画に含まれない key は待ち行列から落とす(編集中に古い本文のコンパイルが積まれない)
 * - コンパイルは 1 本ずつ(UI を塞がない・tectonic を並列に起動しない)
 * - 成功した PDF は cacheDir/<key>[-<依存の指紋>].pdf に置き、次回はコンパイルせずに読む。
 *   書き込みは一時ファイル + rename で、途中の状態を別のプレビューに読まれない
 * - 依存ファイル(画像・.sty など)の指紋がキャッシュの名前に入るので、外部ファイルを直せば作り直す
 * - 失敗は同じ指紋のまま再試行しない(本文・前置き・依存ファイルを直せば名前が変わる)。
 *   テンプレートや画像の更新で resetFailures() が呼ばれたときは、もう一度試す
 * - Tectonic が見つからない(isUnavailable)ときは、ブロックごとに失敗にせず、一度だけ onUnavailable を
 *   出してキューを止める。箱はプレースホルダのまま残る。設定が変わって reset() されたら判定し直す
 * - reset() は実行中のコンパイルも中止し、reset 前に始まった処理の結果(成功・失敗・キャッシュ読み)は
 *   世代で見分けて捨てる。届け済みの記録(done)も消すので、設定を戻したときや Webview 再生成時に
 *   キャッシュから送り直せる。新しい設定でのジョブを古い結果で潰さない
 * - forgetDelivered() は done / failed の配信記録を消す。実行中は止めない。Webview が作り直されたときに
 *   成功はキャッシュから再送し、失敗は再コンパイルして通知する
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
  /** 一度 cancel されたジョブは、同じ key が再度 wanted になっても復活させない。 */
  cancelled: boolean;
  controller: AbortController | undefined;
}

export class RawBlockCompiler {
  private readonly queue: Job[] = [];
  private readonly queued = new Set<string>();
  /** 直近の描画に含まれている key。含まれないジョブは待ち行列から落とし、結果も届けない。 */
  private readonly wanted = new Set<string>();
  /** 画像を届け終えたキャッシュ名(key + 依存の指紋)。 */
  private readonly done = new Map<string, string>();
  /** 失敗したキャッシュ名。 */
  private readonly failed = new Map<string, string>();
  private running = false;
  private disposed = false;
  /** エンジンが使えないと分かった後は、reset() まで何もしない。 */
  private unavailable = false;
  /** reset() ごとに進む世代。処理の途中で変わっていたら、その処理の結果は捨てる。 */
  private generation = 0;
  /** 今 process しているジョブ。同じ世代の未キャンセル job とだけ重複を抑止する。 */
  private current: Job | undefined;

  constructor(private readonly options: RawBlockCompilerOptions) {}

  /** 描画結果の生ブロック一覧。最新に無い key は待ち行列から落とし、まだ無いものだけを入れる。 */
  request(blocks: readonly RawBlockRef[], preamble: string): void {
    if (this.disposed || this.unavailable) return;
    this.wanted.clear();
    for (const block of blocks) this.wanted.add(block.key);
    for (const [cacheName, key] of this.done)
      if (!this.wanted.has(key)) this.done.delete(cacheName);
    for (const [cacheName, key] of this.failed)
      if (!this.wanted.has(key)) this.failed.delete(cacheName);
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const job = this.queue[i];
      if (job && this.wanted.has(job.key)) continue;
      if (job) this.queued.delete(job.key);
      this.queue.splice(i, 1);
    }
    if (this.current && !this.wanted.has(this.current.key)) this.cancel(this.current);
    for (const block of blocks) {
      const inFlightSameGeneration = this.current?.key === block.key && !this.current.cancelled;
      if (this.queued.has(block.key) || inFlightSameGeneration) continue;
      this.queued.add(block.key);
      this.queue.push({
        key: block.key,
        tex: block.tex,
        preamble,
        cancelled: false,
        controller: undefined,
      });
    }
    void this.pump();
  }

  /** 失敗の記録を消す。テンプレート・画像などの外部ファイルが変わったときに呼び、次の描画で再試行させる。 */
  resetFailures(): void {
    this.failed.clear();
  }

  /**
   * 成功・失敗の配信記録を消す。実行中のコンパイルは止めない。Webview が作り直されたときに呼び、
   * 成功はキャッシュから画像を送り直し、失敗は再コンパイルして通知する。
   */
  forgetDelivered(): void {
    this.done.clear();
    this.failed.clear();
  }

  /**
   * エンジンの判定と失敗・届け済みの記録を消し、待ち行列を捨て、実行中のコンパイルを中止する。
   * Tectonic の場所や有効/無効の設定が変わったときに呼び、次の描画で判定し直す
   * (プレビューを開き直さなくてよい)。中止が効かずに旧ジョブが完了しても、世代が違うのでその結果は
   * 届けず、done / failed にも入れない。done を消すので、設定を戻したときはキャッシュから送り直す。
   */
  reset(): void {
    this.generation += 1;
    this.unavailable = false;
    this.failed.clear();
    this.done.clear();
    this.wanted.clear();
    this.queue.length = 0;
    this.queued.clear();
    if (this.current) this.cancel(this.current);
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.queued.clear();
    this.wanted.clear();
    if (this.current) this.cancel(this.current);
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
    const generation = this.generation;
    this.current = job;
    /** dispose / reset されたか、最新の描画にこの key がもう無い。 */
    const drop = () =>
      job.cancelled || this.disposed || generation !== this.generation || !this.wanted.has(job.key);
    try {
      let fingerprint = "";
      try {
        fingerprint = (await this.options.fingerprint?.(job.tex, job.preamble)) ?? "";
      } catch {
        // 指紋が取れなければ依存なしとして扱う。
      }
      if (drop()) return;
      const cacheName = fingerprint === "" ? job.key : `${job.key}-${fingerprint}`;
      if (this.done.has(cacheName) || this.failed.has(cacheName)) return;
      const cachePath = `${cacheDir}/${cacheName}.pdf`;
      try {
        if (await fs.exists(cachePath)) {
          const pdf = await fs.readFile(cachePath);
          if (drop()) return;
          this.done.set(cacheName, job.key);
          this.options.onReady(job.key, pdf);
          return;
        }
      } catch {
        // キャッシュが読めなければコンパイルし直す。
      }
      // exists / readFile の待ちのあいだに reset / 間引きが走ると controller がまだ無い。
      // その直後に tectonic を起動しないよう、AbortController を作る直前にもう一度見る。
      if (drop()) return;
      job.controller = new AbortController();
      try {
        const pdf = await this.options.compile(
          this.options.buildDocument(job.tex, job.preamble),
          job.controller.signal,
        );
        if (drop()) return;
        try {
          await fs.mkdir(cacheDir);
          const temporary = `${cachePath}.${Math.random().toString(36).slice(2)}.tmp`;
          await fs.writeFile(temporary, pdf);
          await fs.rename(temporary, cachePath);
        } catch {
          // キャッシュに書けなくても画像は出す。
        }
        if (drop()) return;
        this.done.set(cacheName, job.key);
        this.options.onReady(job.key, pdf);
      } catch (error) {
        if (drop()) return;
        const message = error instanceof Error ? error.message : String(error);
        if (this.options.isUnavailable?.(error)) {
          // ブロックごとの赤枠にはせず、箱はそのまま残して一度だけ知らせる。残りも試さない。
          this.unavailable = true;
          this.queue.length = 0;
          this.queued.clear();
          this.options.onUnavailable?.(message);
          return;
        }
        this.failed.set(cacheName, job.key);
        this.options.onFailed(job.key, message);
      } finally {
        job.controller = undefined;
      }
    } finally {
      if (this.current === job) this.current = undefined;
    }
  }

  private cancel(job: Job): void {
    job.cancelled = true;
    job.controller?.abort();
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
