import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // test-integration/ は実 VS Code で動かす mocha テスト(`pnpm test:integration`)。
    // vitest の対象は unit テストの test/ だけにする。
    include: ["test/**/*.test.ts"],
  },
});
