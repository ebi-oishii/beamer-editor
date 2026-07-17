import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // fixtures をそのまま静的配信する(/basic.tex、/assets/logo.png)。
  // renderer が出す相対パス画像(assets/...)がそのまま解決される。
  publicDir: resolve(here, "../../fixtures"),
  server: {
    fs: {
      allow: [resolve(here, "../..")],
    },
  },
});
