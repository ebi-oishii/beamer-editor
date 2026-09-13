import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles, PackageManager } from "@vscode/vsce";
import { expect, it } from "vitest";

it("確認済みのTectonic通知原文をvsceの梱包対象に含める", async () => {
  const root = join(__dirname, "..");
  const files = await listFiles({ cwd: root, packageManager: PackageManager.None });
  for (const name of [
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "ENGINE-NOTICES.txt",
    "GPL-2.0.txt",
    "LGPL-2.1.txt",
  ]) {
    expect(files).toContain(`third-party/tectonic/${name}`);
  }
  // 上流 0.17.0 の LICENSE の原文。編集や梱包時の差し替えを検知する。
  expect(
    createHash("sha256")
      .update(readFileSync(join(root, "third-party/tectonic/LICENSE")))
      .digest("hex"),
  ).toBe("814a258f76e420b25cb3c07172eb2b3956f34cefbf0a650413b78e65c425f306");
});
