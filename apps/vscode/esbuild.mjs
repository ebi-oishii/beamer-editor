import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const extensionOptions = {
  bundle: true,
  entryPoints: ["src/extension.ts"],
  external: ["vscode"],
  format: "cjs",
  outfile: "dist/extension.cjs",
  platform: "node",
  sourcemap: true,
  target: "node20",
};

const webviewOptions = {
  bundle: true,
  entryPoints: ["src/webview.ts"],
  format: "iife",
  // React 自動ランタイム。react / react-dom は external にせずバンドルへ含める。
  jsx: "automatic",
  outfile: "media/webview.js",
  platform: "browser",
  sourcemap: true,
  target: "es2022",
  // KaTeX の CSS は media/webview.css へ、フォントは media/ へファイルとして抽出する。
  loader: {
    ".woff2": "file",
    ".woff": "file",
    ".ttf": "file",
  },
  assetNames: "[name]",
};

// pdf.js の worker(部分コンパイル画像のラスタライズ。#81)。Webview から別ファイルとして読むので media へ出す。
const pdfWorkerOptions = {
  bundle: true,
  entryPoints: ["node_modules/pdfjs-dist/build/pdf.worker.min.mjs"],
  format: "esm",
  outfile: "media/pdf.worker.mjs",
  platform: "browser",
  target: "es2022",
};

async function build() {
  await Promise.all([
    esbuild.build(extensionOptions),
    esbuild.build(webviewOptions),
    esbuild.build(pdfWorkerOptions),
  ]);
}

if (watch) {
  console.log("Starting watch mode");
  await build();
  const contexts = await Promise.all([
    esbuild.context(extensionOptions),
    esbuild.context(webviewOptions),
  ]);
  await Promise.all(contexts.map((context) => context.watch()));
  console.log("Watch mode enabled");
  await new Promise((resolve) => {
    setInterval(resolve, 2 ** 31 - 1);
  });
} else {
  await build();
}
