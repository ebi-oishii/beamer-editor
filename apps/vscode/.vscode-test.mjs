import { defineConfig } from "@vscode/test-cli";

/**
 * VS Code 統合テスト(実 VS Code を起動して Extension Host 内で mocha を走らせる)。
 * テスト本体は test-integration/ の TS を esbuild.integration.mjs で out-test/ へ
 * バンドルしてから実行する(`pnpm test:integration`)。
 */
export default defineConfig({
  files: "out-test/**/*.test.js",
  mocha: {
    ui: "tdd",
    timeout: 60_000,
    color: true,
  },
});
