import { constants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type LayoutFinding,
  parseLayoutFindings,
  type RenderedDeck,
  rewriteImageSources,
} from "@beamer-editor/renderer";
import { build } from "esbuild";
import { chromiumLayoutResult } from "./chromium-pipe.ts";

export const BROWSER_CHECKS = ["layout", "image-load", "overflow", "editable-elements"] as const;

export type BrowserLayout =
  | { status: "completed"; findings: LayoutFinding[] }
  | { status: "unavailable"; message: string };

async function browserExecutable(): Promise<string | undefined> {
  const configured = process.env.DECK_PREVIEW_BROWSER?.trim();
  if (configured) return configured;
  const pathNames = [
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "msedge",
  ];
  const candidates = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((dir) =>
      pathNames.map((name) => join(dir, process.platform === "win32" ? `${name}.exe` : name)),
    );
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  } else if (process.platform === "win32") {
    for (const root of [
      process.env.LOCALAPPDATA,
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
    ]) {
      if (root)
        candidates.push(
          join(root, "Google", "Chrome", "Application", "chrome.exe"),
          join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        );
    }
  }
  for (const candidate of candidates) {
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  return undefined;
}

export async function inspectSavedPreview(
  input: string,
  deck: RenderedDeck,
): Promise<BrowserLayout> {
  const browser = await browserExecutable();
  if (!browser)
    return {
      status: "unavailable",
      message:
        "Chromium 系ブラウザーが見つかりません。DECK_PREVIEW_BROWSER で実行ファイルを指定できます。",
    };
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "beamer-preview-layout-"));
    const cwd = dirname(resolve(input));
    const browserDeck = {
      ...deck,
      frames: deck.frames.map((frame) => ({
        ...frame,
        html: rewriteImageSources(frame.html, (file) => pathToFileURL(resolve(cwd, file)).href),
      })),
    };
    const entry = fileURLToPath(new URL("./preview-layout-browser.ts", import.meta.url));
    await build({
      entryPoints: [entry],
      outfile: join(directory, "preview.js"),
      bundle: true,
      platform: "browser",
      logLevel: "silent",
      loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" },
      define: { "process.env.NODE_ENV": '"production"' },
    });
    const page = join(directory, "preview.html");
    const data = JSON.stringify(browserDeck).replaceAll("<", "\\u003c");
    await writeFile(
      page,
      `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src file:; style-src file: 'unsafe-inline'; font-src data:; img-src file: data:">
<style>html,body,#app{margin:0;width:100%;height:100%}#app{display:flex}</style>
<link rel="stylesheet" href="preview.css"></head>
<body><div id="app"></div><script type="application/json" id="deck-input">${data}</script>
<script src="preview.js"></script></body></html>`,
    );
    const output = await chromiumLayoutResult(
      browser,
      cwd,
      join(directory, "profile"),
      pathToFileURL(page).href,
    );
    const findings = parseLayoutFindings(JSON.parse(output));
    if (!findings)
      return { status: "unavailable", message: "ブラウザーで表示検査を完了できませんでした。" };
    return { status: "completed", findings };
  } catch (error) {
    return {
      status: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
