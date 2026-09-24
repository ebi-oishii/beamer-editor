import { readFileSync } from "node:fs";

/** Package metadata is the single version authority for the CLI and generated skill. */
export const CLI_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
