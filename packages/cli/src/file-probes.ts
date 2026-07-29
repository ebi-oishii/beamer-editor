import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import type {
  FileExistsProbe,
  ImageFormat,
  ImageProbe,
  ImageProbeErrorCode,
  ImageProbeResult,
  ImageUnit,
} from "@beamer-editor/core";

const MAX_JPEG_SCAN_BYTES = 1024 * 1024;
const MAX_PDF_BYTES = 16 * 1024 * 1024;
const MAX_PDF_STREAM_BYTES = 4 * 1024 * 1024;
const MAX_INFLATED_PDF_STREAM_BYTES = 4 * 1024 * 1024;

function failure(code: ImageProbeErrorCode): ImageProbeResult {
  return { ok: false, error: { code } };
}

function metadata(
  format: ImageFormat,
  width: number,
  height: number,
  unit: ImageUnit,
): ImageProbeResult {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    return failure("invalid-data");
  return { ok: true, metadata: { format, dimensions: { width, height, unit } } };
}

function pngDimensions(bytes: Buffer): ImageProbeResult {
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return failure("invalid-data");
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR")
    return failure("invalid-data");
  return metadata("png", bytes.readUInt32BE(16), bytes.readUInt32BE(20), "px");
}

function jpegDimensions(bytes: Buffer): ImageProbeResult {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return failure("invalid-data");
  const limit = Math.min(bytes.length, MAX_JPEG_SCAN_BYTES);
  let offset = 2;
  while (offset < limit) {
    while (offset < limit && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > limit) return failure("invalid-data");
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > limit) return failure("invalid-data");
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (length < 8 || offset + length > bytes.length) return failure("invalid-data");
      const components = bytes[offset + 7];
      if (components === undefined || components === 0 || length < 8 + 3 * components)
        return failure("invalid-data");
      return metadata("jpeg", bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3), "px");
    }
    offset += length;
  }
  return failure("invalid-data");
}

function mediaBox(text: string): ImageProbeResult | null {
  const match =
    /\/MediaBox\s*\[\s*([-+]?(?:\d+\.?\d*|\.\d+))\s+([-+]?(?:\d+\.?\d*|\.\d+))\s+([-+]?(?:\d+\.?\d*|\.\d+))\s+([-+]?(?:\d+\.?\d*|\.\d+))\s*\]/.exec(
      text,
    );
  if (!match) return null;
  const values = match.slice(1).map(Number);
  const [left, bottom, right, top] = values as [number, number, number, number];
  return metadata("pdf", Math.abs(right - left), Math.abs(top - bottom), "pt");
}

function pdfDimensions(bytes: Buffer): ImageProbeResult {
  if (bytes.length > MAX_PDF_BYTES || bytes.toString("ascii", 0, 5) !== "%PDF-")
    return failure("invalid-data");
  const direct = mediaBox(bytes.toString("latin1"));
  if (direct) return direct;
  const source = bytes.toString("latin1");
  const streamPattern = /<<[\s\S]{0,8192}?>>\s*stream\r?\n/g;
  for (const match of source.matchAll(streamPattern)) {
    const dictionary = match[0];
    if (!/\/Filter\s*(?:\/FlateDecode|\[\s*\/FlateDecode\s*\])/.test(dictionary)) continue;
    const start = (match.index ?? 0) + match[0].length;
    const length = /\/Length\s+(\d+)(?!\d)(?!\s+\d+\s+R\b)/.exec(dictionary)?.[1];
    const declaredLength = length === undefined ? undefined : Number(length);
    const hasDirectLength =
      declaredLength !== undefined &&
      declaredLength <= MAX_PDF_STREAM_BYTES &&
      start + declaredLength <= bytes.length;
    let end = hasDirectLength ? start + (declaredLength ?? 0) : source.indexOf("endstream", start);
    if (!hasDirectLength && end > start && bytes[end - 1] === 10) end--;
    if (!hasDirectLength && end > start && bytes[end - 1] === 13) end--;
    if (end < start || end - start > MAX_PDF_STREAM_BYTES) continue;
    try {
      const decoded = inflateSync(bytes.subarray(start, end), {
        maxOutputLength: MAX_INFLATED_PDF_STREAM_BYTES,
      }).toString("latin1");
      const result = mediaBox(decoded);
      if (result) return result;
    } catch {
      // Another stream may still be a valid object stream.
    }
  }
  return failure("invalid-data");
}

function readRegularFile(
  path: string,
  maxReadBytes: number,
  maxFileBytes?: number,
): Buffer | ImageProbeResult {
  let descriptor: number | undefined;
  try {
    // O_NONBLOCK avoids waiting on a FIFO before fstat can reject it.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (maxFileBytes !== undefined && stat.size > maxFileBytes))
      return failure("unreadable");
    const bytes = Buffer.alloc(Math.min(stat.size, maxReadBytes));
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    return bytes.subarray(0, offset);
  } catch (error) {
    return failure((error as NodeJS.ErrnoException).code === "ENOENT" ? "not-found" : "unreadable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Creates synchronous Node-backed probes while keeping the core package platform-neutral. */
export function createNodeFileProbes(baseDirectory: string): {
  fileExists: FileExistsProbe;
  probeImage: ImageProbe;
} {
  const resolvedBaseDirectory = resolve(baseDirectory);
  const fullPath = (path: string): string =>
    isAbsolute(path) ? path : resolve(resolvedBaseDirectory, path);
  const fileExists: FileExistsProbe = (path) => {
    try {
      return statSync(fullPath(path)).isFile();
    } catch {
      return false;
    }
  };
  const probeImage: ImageProbe = (path) => {
    const extension = path.match(/\.([^.\\/]+)$/)?.[1]?.toLowerCase();
    if (extension !== "png" && extension !== "jpg" && extension !== "jpeg" && extension !== "pdf")
      return failure("unsupported-format");
    const bytes =
      extension === "pdf"
        ? readRegularFile(fullPath(path), MAX_PDF_BYTES, MAX_PDF_BYTES)
        : readRegularFile(fullPath(path), MAX_JPEG_SCAN_BYTES);
    if (!Buffer.isBuffer(bytes)) return bytes;
    if (extension === "png") return pngDimensions(bytes);
    if (extension === "pdf") return pdfDimensions(bytes);
    return jpegDimensions(bytes);
  };
  return { fileExists, probeImage };
}
