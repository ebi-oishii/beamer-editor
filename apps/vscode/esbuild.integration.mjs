import { readdirSync } from "node:fs";
import * as esbuild from "esbuild";

/** test-integration/ の *.test.ts を out-test/ へ CJS でバンドルする。 */
const entryPoints = readdirSync("test-integration")
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => `test-integration/${name}`);

await esbuild.build({
  bundle: true,
  entryPoints,
  external: ["vscode", "mocha"],
  format: "cjs",
  outdir: "out-test",
  platform: "node",
  sourcemap: true,
  target: "node20",
});
