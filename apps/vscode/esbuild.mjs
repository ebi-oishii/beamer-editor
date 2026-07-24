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
  outfile: "media/webview.js",
  platform: "browser",
  sourcemap: true,
  target: "es2022",
};

async function build() {
  await Promise.all([esbuild.build(extensionOptions), esbuild.build(webviewOptions)]);
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
