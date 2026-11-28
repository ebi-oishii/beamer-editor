import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SYNCTEX_BYTES = 32 * 1024 * 1024;
const decompress = promisify(gunzip);

export interface PdfSourcePages {
  sourceDigest: string;
  pages: readonly { page: number; lines: readonly number[] }[];
}

export function pdfSourceDigest(text: string): string {
  return createHash("sha256")
    .update(text.replace(/^\uFEFF/, ""))
    .digest("hex");
}

export async function readPdfSourceDigest(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (info.isFile() && info.size <= MAX_SOURCE_BYTES)
      return pdfSourceDigest(await readFile(path, "utf8"));
  } catch {
    // Mapping is optional, including when the input changes during compilation.
  }
  return undefined;
}

/** Read the physical sheets and source lines from the final pass of the PDF's own compile. */
export function parseSyncTexPages(text: string, inputPath: string): PdfSourcePages["pages"] {
  const inputTags = new Set<number>();
  const pages: { page: number; lines: number[] }[] = [];
  let content = false;
  let sheet: { page: number; lines: Set<number> } | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!content) {
      const input = /^Input:(\d+):(.+)$/.exec(line);
      if (input?.[2] && resolve(dirname(inputPath), input[2]) === inputPath)
        inputTags.add(Number(input[1]));
      if (line === "Content:") content = true;
      continue;
    }
    if (line === "Postamble:") return sheet ? [] : pages;
    const opening = /^\{(\d+)$/.exec(line);
    if (opening) {
      const page = Number(opening[1]);
      if (sheet || !Number.isSafeInteger(page) || page !== pages.length + 1) return [];
      sheet = { page, lines: new Set() };
      continue;
    }
    if (!sheet) continue;
    const closing = /^\}(\d+)$/.exec(line);
    if (closing) {
      if (Number(closing[1]) !== sheet.page) return [];
      pages.push({ page: sheet.page, lines: [...sheet.lines] });
      sheet = undefined;
      continue;
    }
    const node = /^[[(hvxkg$](\d+),(\d+)(?:,\d+)?:/.exec(line);
    if (node && inputTags.has(Number(node[1]))) {
      const position = Number(node[2]);
      if (Number.isSafeInteger(position) && position > 0) sheet.lines.add(position);
    }
  }
  return [];
}

export async function readPdfSourcePages(
  compiledPdf: string,
  inputPath: string,
  sourceDigest: string | undefined,
): Promise<PdfSourcePages | undefined> {
  if (!sourceDigest) return undefined;
  try {
    if (sourceDigest !== (await readPdfSourceDigest(inputPath))) return undefined;
    const path = compiledPdf.replace(/\.pdf$/, ".synctex.gz");
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_SYNCTEX_BYTES) return undefined;
    const text = await decompress(await readFile(path), { maxOutputLength: MAX_SYNCTEX_BYTES });
    const pages = parseSyncTexPages(text.toString("utf8"), inputPath);
    if (pages.some((page) => page.lines.length)) return { sourceDigest, pages };
  } catch {
    // Missing, oversized or unsupported SyncTeX leaves manual page navigation available.
  }
  return undefined;
}
