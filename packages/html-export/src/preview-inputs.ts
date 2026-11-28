/** Node-backed inputs shared by the live preview and preview-check. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import {
  type DeckDocument,
  extractPreviewStyle,
  graphicsPathsOf,
  joinImageSearchPath,
  mergePreviewStyles,
  type PreviewStyle,
  type TemplateReference,
  type TemplateStatus,
  templateImagePaths,
  templateReferencesOf,
} from "@beamer-editor/core";
import type { EditingPreviewOptions, PreviewAsset } from "@beamer-editor/renderer";

export interface TemplateFileSystem {
  isFile(relativePath: string): boolean;
  readFile(relativePath: string): string | null;
  templateDirs(): string[];
}

export interface ResolvedTemplate {
  reference: TemplateReference;
  path: string;
  text: string;
}

const IMAGE_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg"];

export function resolveTemplate(
  reference: TemplateReference,
  fs: TemplateFileSystem,
): ResolvedTemplate | null {
  const candidates =
    reference.kind === "theme"
      ? [
          reference.file,
          ...fs.templateDirs().map((directory) => `templates/${directory}/${reference.file}`),
        ]
      : [reference.file];
  for (const candidate of candidates) {
    if (!fs.isFile(candidate)) continue;
    const text = fs.readFile(candidate);
    if (text !== null) return { reference, path: candidate, text };
  }
  return null;
}

function resolveExactImagePath(imagePath: string, fs: TemplateFileSystem): string | null {
  if (/\.[A-Za-z0-9]+$/.test(imagePath)) return fs.isFile(imagePath) ? imagePath : null;
  const extension = IMAGE_EXTENSIONS.find((candidate) => fs.isFile(`${imagePath}${candidate}`));
  return extension === undefined ? null : `${imagePath}${extension}`;
}

export function resolveImagePath(
  imagePath: string,
  fs: TemplateFileSystem,
  searchPaths: readonly string[] = [],
): string | null {
  const direct = resolveExactImagePath(imagePath, fs);
  if (direct !== null) return direct;
  for (const directory of searchPaths) {
    const found = resolveExactImagePath(joinImageSearchPath(directory, imagePath), fs);
    if (found !== null) return found;
  }
  return null;
}

export function imageExists(
  imagePath: string,
  fs: TemplateFileSystem,
  searchPaths: readonly string[] = [],
): boolean {
  return resolveImagePath(imagePath, fs, searchPaths) !== null;
}

export function resolveTemplates(doc: DeckDocument, fs: TemplateFileSystem) {
  return templateReferencesOf(doc).map((reference) => ({
    reference,
    resolved: resolveTemplate(reference, fs),
  }));
}

export function templateStatuses(doc: DeckDocument, fs: TemplateFileSystem): TemplateStatus[] {
  const extraPaths = graphicsPathsOf(doc.preambleExtra.tex);
  return resolveTemplates(doc, fs).map(({ reference, resolved }) => ({
    reference,
    resolvedPath: resolved?.path ?? null,
    missingImages: resolved
      ? templateImagePaths(resolved.text).filter(
          (image) =>
            !nonLocalImage(image) &&
            !imageExists(image, fs, [...graphicsPathsOf(resolved.text), ...extraPaths]),
        )
      : [],
  }));
}

function baseStyleAndAssetsOf(
  doc: DeckDocument,
  fs: TemplateFileSystem,
): {
  baseStyle: PreviewStyle;
  baseAssets: NonNullable<EditingPreviewOptions["baseAssets"]>;
} {
  const layers = [
    ...resolveTemplates(doc, fs).flatMap(({ reference, resolved }) =>
      resolved === null
        ? []
        : [
            {
              style: extractPreviewStyle(resolved.text),
              source: "template" as const,
              span: reference.span,
              templatePath: resolved.path,
            },
          ],
    ),
    {
      style: extractPreviewStyle(doc.preambleExtra.tex),
      source: "preamble" as const,
      span: doc.preambleExtra.span,
    },
  ];
  const merged = mergePreviewStyles(...layers.map((layer) => layer.style));
  const searchPaths = merged.imageSearchPaths ?? [];
  if (merged.logo)
    merged.logo = {
      ...merged.logo,
      path: resolveImagePath(merged.logo.path, fs, searchPaths) ?? merged.logo.path,
    };
  if (merged.background)
    merged.background = {
      path: resolveImagePath(merged.background.path, fs, searchPaths) ?? merged.background.path,
    };
  const selected: Partial<Record<"logo" | "background", (typeof layers)[number]>> = {};
  for (const layer of layers) {
    if (layer.style.logo) selected.logo = layer;
    if (layer.style.background) selected.background = layer;
  }
  const asset = (slot: "logo" | "background"): PreviewAsset | undefined => {
    const layer = selected[slot];
    const value = merged[slot];
    if (!layer || !value) return undefined;
    const path = value.path;
    return {
      path,
      exists: nonLocalImage(path) || fs.isFile(path),
      source: layer.source,
      span: layer.span,
      ...(layer.source === "template" ? { templatePath: layer.templatePath } : {}),
    };
  };
  const logo = asset("logo");
  const background = asset("background");
  const baseAssets = {
    ...(logo ? { logo } : {}),
    ...(background ? { background } : {}),
  };
  return { baseStyle: merged, baseAssets };
}

export function baseStyleOf(doc: DeckDocument, fs: TemplateFileSystem): PreviewStyle {
  return baseStyleAndAssetsOf(doc, fs).baseStyle;
}

const nonLocalImage = (assetPath: string) =>
  /^(?:https?:|data:|vscode-webview|vscode-resource:)/i.test(assetPath);

/** Both preview hosts resolve the same style and inspect local assets only. */
export function editingPreviewOptions(
  doc: DeckDocument,
  fs: TemplateFileSystem,
): EditingPreviewOptions {
  const { baseStyle, baseAssets } = baseStyleAndAssetsOf(doc, fs);
  const fileExists = (assetPath: string) => nonLocalImage(assetPath) || fs.isFile(assetPath);
  return {
    baseStyle,
    baseAssets,
    fileExists,
  };
}

/** Restricts preview assets to the deck directory. */
export function nodeTemplateFileSystem(deckDirectory: string): TemplateFileSystem {
  const root = path.resolve(deckDirectory);
  const within = (relativePath: string): string | null => {
    if (path.isAbsolute(relativePath)) return null;
    const absolute = path.resolve(root, relativePath);
    const relative = path.relative(root, absolute);
    return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      ? null
      : absolute;
  };
  return {
    isFile(relativePath) {
      const absolute = within(relativePath);
      try {
        return absolute !== null && statSync(absolute).isFile();
      } catch {
        return false;
      }
    },
    readFile(relativePath) {
      const absolute = within(relativePath);
      try {
        return absolute === null ? null : readFileSync(absolute, "utf8");
      } catch {
        return null;
      }
    },
    templateDirs() {
      try {
        return readdirSync(path.join(root, "templates"), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort();
      } catch {
        return [];
      }
    },
  };
}
