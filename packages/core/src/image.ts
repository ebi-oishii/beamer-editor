/** Filesystem-independent contracts for image inspection. */
export type ImageFormat = "png" | "jpeg" | "pdf";
export type ImageUnit = "px" | "pt";

export interface ImageDimensions {
  width: number;
  height: number;
  unit: ImageUnit;
}

export interface ImageMetadata {
  format: ImageFormat;
  dimensions: ImageDimensions;
}

export type ImageProbeErrorCode =
  | "not-found"
  | "unreadable"
  | "unsupported-format"
  | "invalid-data";

export type ImageProbeResult =
  | { ok: true; metadata: ImageMetadata }
  | { ok: false; error: { code: ImageProbeErrorCode } };

/** Synchronous by design so linting remains deterministic and side-effect free in core. */
export type FileExistsProbe = (path: string) => boolean;
export type ImageProbe = (path: string) => ImageProbeResult;
