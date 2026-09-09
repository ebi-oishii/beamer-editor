import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expandDeck } from "@beamer-editor/core";
import { renderDeck } from "@beamer-editor/renderer";
import { isVisibleAtStep, PREVIEW_CSS } from "@beamer-editor/ui";
import { nodePreviewBaseStyle } from "./template-style.js";

export type HtmlExportErrorCode =
  | "E_INPUT"
  | "E_OUTPUT_EXISTS"
  | "E_ASSET"
  | "E_IO"
  | "E_CANCELLED";
export class HtmlExportError extends Error {
  constructor(
    public readonly code: HtmlExportErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "HtmlExportError";
  }
}
export interface HtmlExportRequest {
  inputPath: string;
  outputPath?: string;
  signal?: AbortSignal;
  /** Packaged KaTeX dist directory. CLI callers normally use package resolution. */
  katexAssetsPath?: string;
}
export interface HtmlExportResult {
  format: "html";
  inputPath: string;
  outputPath: string;
  indexPath: string;
}
interface Asset {
  target: string;
  bytes: Uint8Array;
}
const abort = (signal?: AbortSignal) => {
  if (signal?.aborted)
    throw new HtmlExportError("E_CANCELLED", "HTML 書き出しはキャンセルされました");
};
const json = (v: unknown) =>
  JSON.stringify(v)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
async function entry(path: string) {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
const decodedAttribute = (value: string): string =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
export function defaultHtmlOutputPath(inputPath: string): string {
  const p = resolve(inputPath),
    f = basename(p);
  return join(
    dirname(p),
    `${f.endsWith(".slide.tex") ? f.slice(0, -10) : basename(f, extname(f))}-html`,
  );
}
function source(value: string, root: string): string | undefined {
  const clean = value.replace(/[?#].*$/, "");
  if (/^(https?:|data:)/i.test(value)) return undefined;
  if (
    !clean ||
    /^file:/i.test(value) ||
    isAbsolute(clean) ||
    clean.includes("\\") ||
    clean.split("/").includes("..")
  )
    throw new HtmlExportError("E_ASSET", `許可されない画像パス: ${value}`);
  const path = resolve(root, clean),
    rel = relative(root, path);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new HtmlExportError("E_ASSET", `デッキ外の画像は使えません: ${value}`);
  return path;
}
async function collect(
  frames: readonly string[],
  root: string,
  signal?: AbortSignal,
): Promise<{ frames: string[]; assets: Asset[] }> {
  const rootReal = await realpath(root).catch((e) => {
    throw new HtmlExportError("E_INPUT", `デッキのディレクトリを確認できません: ${root}`, e);
  });
  const assets: Asset[] = [],
    map = new Map<string, string>(),
    hashes = new Map<string, string>();
  const rewritten = await Promise.all(
    frames.map(async (frame) => {
      const matches = [...frame.matchAll(/(<img\b[^>]*\bsrc=")([^"]*)(")/g)];
      for (const m of matches) {
        abort(signal);
        const raw = decodedAttribute(m[2] ?? "");
        if (map.has(raw)) continue;
        const path = source(raw, root);
        if (!path) continue;
        let sourceEntry: Awaited<ReturnType<typeof entry>>;
        try {
          sourceEntry = await entry(path);
        } catch (e) {
          throw new HtmlExportError("E_ASSET", `画像を確認できません: ${raw}`, e);
        }
        if (!/\.(png|jpe?g)$/i.test(path) || !sourceEntry?.isFile())
          throw new HtmlExportError("E_ASSET", `画像を読み込めません: ${raw}`);
        const real = await realpath(path).catch((e) => {
          throw new HtmlExportError("E_ASSET", `画像を読み込めません: ${raw}`, e);
        });
        const rel = relative(rootReal, real);
        if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel))
          throw new HtmlExportError("E_ASSET", `デッキ外の画像は使えません: ${raw}`);
        let bytes: Uint8Array;
        try {
          bytes = await readFile(real);
        } catch (e) {
          throw new HtmlExportError("E_ASSET", `画像を読み込めません: ${raw}`, e);
        }
        const hash = createHash("sha256").update(bytes).digest("hex"),
          target = hashes.get(hash) ?? `assets/${hash.slice(0, 20)}${extname(path).toLowerCase()}`;
        if (!hashes.has(hash)) {
          hashes.set(hash, target);
          assets.push({ target, bytes });
        }
        map.set(raw, target);
      }
      return frame.replace(
        /(<img\b[^>]*\bsrc=")([^"]*)(")/g,
        (_all, a, value, c) => `${a}${map.get(decodedAttribute(value)) ?? value}${c}`,
      );
    }),
  );
  return { frames: rewritten, assets };
}
const VIEWER_JS = `(()=>{const visible=${isVisibleAtStep.toString()};const d=JSON.parse(document.querySelector('#deck-data').textContent);let f=0,s=1,scale=1;const a=document.querySelector('#app');function r(){const x=d.frames[f];a.innerHTML='<main class="slide-scroll"><article class="slide-card active"><div class="slide-layout"><div class="slide-scale" style="zoom:'+scale+'">'+x.html+'</div></div></article></main><nav class="html-export-controls"><button id="p">←</button><span>'+(f+1)+' / '+d.frames.length+'　'+s+' / '+x.stepCount+'</span><button id="n">→</button><button id="zoom">＋</button></nav>';document.querySelectorAll('[data-min]').forEach(e=>e.classList.toggle('covered',!visible({min:e.dataset.min},s)));document.querySelectorAll('[data-overlay]').forEach(e=>e.classList.toggle('covered',!visible({overlay:e.dataset.overlay},s)));document.querySelector('#p').onclick=()=>{if(s>1)s--;else if(f){f--;s=d.frames[f].stepCount}r()};document.querySelector('#n').onclick=()=>{if(s<x.stepCount)s++;else if(f<d.frames.length-1){f++;s=1}r()};document.querySelector('#zoom').onclick=()=>{scale=scale===1?1.25:1;r()}}document.addEventListener('keydown',e=>{if(e.key==='ArrowLeft')document.querySelector('#p').click();if(e.key==='ArrowRight')document.querySelector('#n').click()});r()})();`;
const VIEWER_CSS = `${PREVIEW_CSS}\n.html-export-controls{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:#fff;padding:8px;border-radius:6px;box-shadow:0 1px 6px #777}.html-export-controls button{margin:0 4px}`;
function documentHtml(title: string, frames: readonly { html: string; stepCount: number }[]) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: https: http:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; font-src 'self' data:"><title>${title.replaceAll("<", "&lt;")}</title><link rel="stylesheet" href="viewer.css"><link rel="stylesheet" href="deck.css"><link rel="stylesheet" href="katex/katex.min.css"></head><body><div id="app"></div><script id="deck-data" type="application/json">${json({ frames })}</script><script src="viewer.js"></script></body></html>`;
}
export async function exportHtml(request: HtmlExportRequest): Promise<HtmlExportResult> {
  const inputPath = resolve(request.inputPath),
    outputPath = resolve(request.outputPath ?? defaultHtmlOutputPath(inputPath));
  abort(request.signal);
  let inputEntry: Awaited<ReturnType<typeof entry>>;
  try {
    inputEntry = await entry(inputPath);
  } catch (e) {
    throw new HtmlExportError("E_INPUT", `入力 TeX を確認できません: ${request.inputPath}`, e);
  }
  if (!inputEntry?.isFile())
    throw new HtmlExportError("E_INPUT", `入力 TeX を読み込めません: ${request.inputPath}`);
  let outputEntry: Awaited<ReturnType<typeof entry>>;
  try {
    outputEntry = await entry(outputPath);
  } catch (e) {
    throw new HtmlExportError("E_IO", `出力先を確認できません: ${outputPath}`, e);
  }
  if (outputEntry)
    throw new HtmlExportError("E_OUTPUT_EXISTS", `出力先は既に存在します: ${outputPath}`);
  let sourceText: string;
  try {
    sourceText = await readFile(inputPath, "utf8");
  } catch (e) {
    throw new HtmlExportError("E_INPUT", `入力 TeX を読み込めません: ${request.inputPath}`, e);
  }
  let deck: ReturnType<typeof renderDeck>;
  try {
    const expanded = expandDeck(sourceText);
    const baseStyle = await nodePreviewBaseStyle(expanded.doc, dirname(inputPath));
    deck = renderDeck(expanded.doc, undefined, { baseStyle });
  } catch (e) {
    throw new HtmlExportError("E_INPUT", "入力 TeX を解析できません", e);
  }
  const collected = await collect(
    deck.frames.map((f) => f.html),
    dirname(inputPath),
    request.signal,
  );
  abort(request.signal);
  if (deck.frames.length === 0)
    throw new HtmlExportError("E_INPUT", "書き出すフレームがありません");
  let made = false;
  try {
    abort(request.signal);
    await mkdir(outputPath);
    made = true;
    abort(request.signal);
    await writeFile(join(outputPath, ".incomplete"), "incomplete\n");
    if (collected.assets.length > 0) await mkdir(join(outputPath, "assets"));
    for (const asset of collected.assets) {
      abort(request.signal);
      await writeFile(join(outputPath, asset.target), asset.bytes);
    }
    abort(request.signal);
    await writeFile(join(outputPath, "viewer.css"), VIEWER_CSS);
    abort(request.signal);
    await writeFile(join(outputPath, "deck.css"), deck.css);
    const katexDir = request.katexAssetsPath
      ? resolve(request.katexAssetsPath)
      : dirname(fileURLToPath(import.meta.resolve("katex/dist/katex.min.css")));
    await mkdir(join(outputPath, "katex", "fonts"), { recursive: true });
    abort(request.signal);
    await writeFile(
      join(outputPath, "katex", "katex.min.css"),
      await readFile(join(katexDir, "katex.min.css")),
    );
    for (const font of await readdir(join(katexDir, "fonts"))) {
      if (/\.(woff2?|ttf)$/i.test(font)) {
        abort(request.signal);
        await writeFile(
          join(outputPath, "katex", "fonts", font),
          await readFile(join(katexDir, "fonts", font)),
        );
      }
    }
    abort(request.signal);
    await writeFile(join(outputPath, "viewer.js"), VIEWER_JS);
    abort(request.signal);
    await writeFile(
      join(outputPath, "index.html"),
      documentHtml(
        deck.title,
        deck.frames.map((f, i) => ({
          html: collected.frames[i] ?? f.html,
          stepCount: f.stepCount,
        })),
      ),
    );
    abort(request.signal);
    await rm(join(outputPath, ".incomplete"));
    abort(request.signal);
    return { format: "html", inputPath, outputPath, indexPath: join(outputPath, "index.html") };
  } catch (e) {
    if (made) await rm(outputPath, { recursive: true, force: true }).catch(() => undefined);
    if (e instanceof HtmlExportError) throw e;
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new HtmlExportError("E_OUTPUT_EXISTS", `出力先は既に存在します: ${outputPath}`, e);
    throw new HtmlExportError("E_IO", `HTML の書き出しに失敗しました: ${String(e)}`, e);
  }
}
