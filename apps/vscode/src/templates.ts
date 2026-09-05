/**
 * テンプレート(.sty + 画像)参照の解決(#70)。core はファイルシステムに触らないので、
 * ここでデッキのディレクトリ基準に探し、読み込み、画像の存在を確かめる。
 * `vscode` API には依存しない(fs は注入。テストではフェイクを渡す)。
 *
 * 配置規則(既存の Beamer テーマの慣習に合わせる):
 * - `\usetheme{X}` → デッキと同じディレクトリの beamertheme<X>.sty、無ければ templates/<任意>/beamertheme<X>.sty
 * - `\usepackage{path}` → デッキ基準の path.sty(`templates/corp/beamerthemecorp` のようにパスで指す)
 * - いずれもデッキのディレクトリ配下に限る(Webview のリソース許可とコンパイル時の CWD がそこ)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import {
  type DeckDocument,
  extractPreviewStyle,
  mergePreviewStyles,
  type PreviewStyle,
  type TemplateReference,
  type TemplateStatus,
  templateImagePaths,
  templateReferencesOf,
} from "@beamer-editor/core";

/** デッキのディレクトリ基準で相対パスを扱う最小のファイルシステム面。 */
export interface TemplateFileSystem {
  /** 相対パス(`/` 区切り)が既存のファイルか。 */
  isFile(relativePath: string): boolean;
  /** UTF-8 で読む。読めなければ null。 */
  readFile(relativePath: string): string | null;
  /** `templates/` 直下のサブディレクトリ名。無ければ []。 */
  templateDirs(): string[];
}

export interface ResolvedTemplate {
  reference: TemplateReference;
  /** デッキのディレクトリ基準の相対パス。 */
  path: string;
  text: string;
}

/** TeX(xelatex / lualatex)の既定の画像拡張子探索に合わせる。 */
const IMAGE_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg"];

/** 参照先候補を順に試し、最初に見つかった .sty を返す。 */
export function resolveTemplate(
  reference: TemplateReference,
  fs: TemplateFileSystem,
): ResolvedTemplate | null {
  const candidates =
    reference.kind === "theme"
      ? [reference.file, ...fs.templateDirs().map((dir) => `templates/${dir}/${reference.file}`)]
      : [reference.file];
  for (const candidate of candidates) {
    if (!fs.isFile(candidate)) continue;
    const text = fs.readFile(candidate);
    if (text !== null) return { reference, path: candidate, text };
  }
  return null;
}

/** 拡張子なしの参照は TeX と同じ順で拡張子を試す。 */
export function imageExists(imagePath: string, fs: TemplateFileSystem): boolean {
  if (/\.[A-Za-z0-9]+$/.test(imagePath)) return fs.isFile(imagePath);
  return IMAGE_EXTENSIONS.some((extension) => fs.isFile(`${imagePath}${extension}`));
}

/** 文書のテンプレート参照を全て解決する(見つからないものは null のまま並ぶ)。 */
export function resolveTemplates(
  doc: DeckDocument,
  fs: TemplateFileSystem,
): { reference: TemplateReference; resolved: ResolvedTemplate | null }[] {
  return templateReferencesOf(doc).map((reference) => ({
    reference,
    resolved: resolveTemplate(reference, fs),
  }));
}

/** lint(L022 / L023)へ渡す解決結果。 */
export function templateStatuses(doc: DeckDocument, fs: TemplateFileSystem): TemplateStatus[] {
  return resolveTemplates(doc, fs).map(({ reference, resolved }) => ({
    reference,
    resolvedPath: resolved?.path ?? null,
    missingImages: resolved
      ? templateImagePaths(resolved.text).filter((image) => !imageExists(image, fs))
      : [],
  }));
}

/**
 * プレビューの土台スタイル。テンプレート(参照順)→ preamble-extra 自身の順に重ね、
 * 後のものが前を上書きする。`%% style` 領域はさらにその上(renderer 側)。
 */
export function baseStyleOf(doc: DeckDocument, fs: TemplateFileSystem): PreviewStyle {
  const templates = resolveTemplates(doc, fs)
    .map(({ resolved }) => resolved)
    .filter((resolved): resolved is ResolvedTemplate => resolved !== null)
    .map((resolved) => extractPreviewStyle(resolved.text));
  return mergePreviewStyles(...templates, extractPreviewStyle(doc.preambleExtra.tex));
}

/** 実ファイルシステム。デッキのディレクトリ配下以外は見えない(`..` や絶対パスは拒否)。 */
export function nodeTemplateFileSystem(deckDir: string): TemplateFileSystem {
  const root = path.resolve(deckDir);
  const within = (relativePath: string): string | null => {
    if (path.isAbsolute(relativePath)) return null;
    const absolute = path.resolve(root, relativePath);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return absolute;
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
      if (absolute === null) return null;
      try {
        return readFileSync(absolute, "utf8");
      } catch {
        return null;
      }
    },
    templateDirs() {
      const templates = path.join(root, "templates");
      if (!existsSync(templates)) return [];
      try {
        return readdirSync(templates, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort();
      } catch {
        return [];
      }
    },
  };
}
