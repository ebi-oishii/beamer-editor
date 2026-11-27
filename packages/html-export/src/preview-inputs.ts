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
  styleImageOverrides,
  type TemplateReference,
  type TemplateStatus,
  templateImagePaths,
  templateReferencesOf,
} from "@beamer-editor/core";
import type { EditingPreviewOptions } from "@beamer-editor/renderer";

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

export function baseStyleOf(doc: DeckDocument, fs: TemplateFileSystem): PreviewStyle {
  const templates = resolveTemplates(doc, fs).flatMap(({ resolved }) =>
    resolved === null ? [] : [extractPreviewStyle(resolved.text)],
  );
  const merged = mergePreviewStyles(...templates, extractPreviewStyle(doc.preambleExtra.tex));
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
  return merged;
}

const nonLocalImage = (assetPath: string) =>
  /^(?:https?:|data:|vscode-webview|vscode-resource:)/i.test(assetPath);

/** Both preview hosts resolve the same style and inspect local assets only. */
export function editingPreviewOptions(
  doc: DeckDocument,
  fs: TemplateFileSystem,
): EditingPreviewOptions {
  const baseStyle = baseStyleOf(doc, fs);
  const preambleStyle = extractPreviewStyle(doc.preambleExtra.tex);
  const overrides = styleImageOverrides(doc);
  const preamblePaths = new Set([
    !overrides.logo && preambleStyle.logo && baseStyle.logo?.path,
    !overrides.background && preambleStyle.background && baseStyle.background?.path,
  ]);
  const fileExists = (assetPath: string) => nonLocalImage(assetPath) || fs.isFile(assetPath);
  return {
    baseStyle,
    fileExists,
    templates: templateStatuses(doc, fs),
    preambleDiagnostics: [...preamblePaths].flatMap((assetPath) =>
      assetPath && !fileExists(assetPath)
        ? [
            {
              code: "L004",
              severity: "error",
              message: `プリアンブルが参照する画像 ${assetPath} が見つかりません`,
              span: doc.preambleExtra.span,
            },
          ]
        : [],
    ),
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
