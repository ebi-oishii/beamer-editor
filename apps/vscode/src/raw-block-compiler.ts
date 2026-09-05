/**
 * 生ブロックの部分コンパイル(#81)のキューとキャッシュ。`vscode` API には依存しない(注入)。
 *
 * - 描画のたびに RenderedDeck.rawBlocks を受け取り、まだ画像の無い key だけをキューに入れる
 * - コンパイルは 1 本ずつ(UI を塞がない・tectonic を並列に起動しない)
 * - 成功した PDF は cacheDir/<key>.pdf に置き、次回はコンパイルせずに読む
 * - 失敗した key は同じセッションでは再試行しない(本文か前置きを直せば key が変わる)
 */

import type { RawBlockRef } from "@beamer-editor/renderer";

export interface RawBlockCompilerFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface RawBlockCompilerOptions {
  cacheDir: string;
  fs: RawBlockCompilerFileSystem;
  /** standalone 文書の全文を PDF にする(compiler の compileFragment)。 */
  compile(document: string, signal: AbortSignal): Promise<Uint8Array>;
  /** 生ブロック本文と前置きから standalone 文書を組み立てる(compiler の buildFragmentDocument)。 */
  buildDocument(tex: string, preamble: string): string;
  onReady(key: string, pdf: Uint8Array): void;
  onFailed(key: string, message: string): void;
}

export class RawBlockCompiler {
  private readonly queue: { key: string; tex: string; preamble: string }[] = [];
  private readonly queued = new Set<string>();
  private readonly done = new Set<string>();
  private readonly failed = new Set<string>();
  private running = false;
  private disposed = false;
  private controller: AbortController | undefined;

  constructor(private readonly options: RawBlockCompilerOptions) {}

  /** 描画結果の生ブロック一覧。未処理の key だけをキューへ入れ、処理を進める。 */
  request(blocks: readonly RawBlockRef[], preamble: string): void {
    if (this.disposed) return;
    for (const block of blocks) {
      if (this.done.has(block.key) || this.failed.has(block.key) || this.queued.has(block.key))
        continue;
      this.queued.add(block.key);
      this.queue.push({ key: block.key, tex: block.tex, preamble });
    }
    void this.pump();
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

  private async process(job: { key: string; tex: string; preamble: string }): Promise<void> {
    const { fs, cacheDir } = this.options;
    const cachePath = `${cacheDir}/${job.key}.pdf`;
    try {
      if (await fs.exists(cachePath)) {
        const pdf = await fs.readFile(cachePath);
        this.done.add(job.key);
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
      this.done.add(job.key);
      try {
        await fs.mkdir(cacheDir);
        await fs.writeFile(cachePath, pdf);
      } catch {
        // キャッシュに書けなくても画像は出す。
      }
      this.options.onReady(job.key, pdf);
    } catch (error) {
      if (this.disposed) return;
      this.failed.add(job.key);
      this.options.onFailed(job.key, error instanceof Error ? error.message : String(error));
    } finally {
      this.controller = undefined;
    }
  }
}
