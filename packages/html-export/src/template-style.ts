import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type DeckDocument,
  extractPreviewStyle,
  mergePreviewStyles,
  type PreviewStyle,
  templateReferencesOf,
} from "@beamer-editor/core";

const within = (root: string, candidate: string): string | undefined => {
  if (isAbsolute(candidate)) return undefined;
  const absolute = resolve(root, candidate);
  const rel = relative(root, absolute);
  return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
    ? undefined
    : absolute;
};

const actualFile = async (root: string, candidate: string): Promise<string | undefined> => {
  const absolute = within(root, candidate);
  if (!absolute) return undefined;
  try {
    if (!(await stat(absolute)).isFile()) return undefined;
    const [rootReal, fileReal] = await Promise.all([realpath(root), realpath(absolute)]);
    const rel = relative(rootReal, fileReal);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
    return fileReal;
  } catch {
    return undefined;
  }
};

const readTextFile = async (root: string, candidate: string): Promise<string | undefined> => {
  const absolute = await actualFile(root, candidate);
  return absolute ? readFile(absolute, "utf8").catch(() => undefined) : undefined;
};

const templateDirectories = async (root: string): Promise<string[]> => {
  try {
    return (await readdir(join(root, "templates"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
};

/** Resolve the same local template and preamble style inputs used by the live preview. */
export async function nodePreviewBaseStyle(
  doc: DeckDocument,
  deckDirectory: string,
): Promise<PreviewStyle> {
  const root = resolve(deckDirectory);
  const directories = await templateDirectories(root);
  const styles: PreviewStyle[] = [];
  for (const reference of templateReferencesOf(doc)) {
    const candidates =
      reference.kind === "theme"
        ? [reference.file, ...directories.map((dir) => `templates/${dir}/${reference.file}`)]
        : [reference.file];
    for (const candidate of candidates) {
      const text = await readTextFile(root, candidate);
      if (text === undefined) continue;
      styles.push(extractPreviewStyle(text));
      break;
    }
  }
  styles.push(extractPreviewStyle(doc.preambleExtra.tex));
  const merged = mergePreviewStyles(...styles);
  const resolveImage = async (path: string): Promise<string> => {
    if (extname(path)) return path;
    for (const extension of [".pdf", ".png", ".jpg", ".jpeg"]) {
      if ((await actualFile(root, `${path}${extension}`)) !== undefined)
        return `${path}${extension}`;
    }
    return path;
  };
  if (merged.logo) merged.logo = { ...merged.logo, path: await resolveImage(merged.logo.path) };
  if (merged.background) merged.background = { path: await resolveImage(merged.background.path) };
  return merged;
}
