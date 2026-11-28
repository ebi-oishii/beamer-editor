/**
 * Compatibility exports for callers that historically imported preview asset
 * resolution from the VS Code package. CLI and the editor share this module.
 */
export {
  baseStyleOf,
  imageExists,
  nodeTemplateFileSystem,
  type ResolvedTemplate,
  resolveImagePath,
  resolveTemplate,
  resolveTemplates,
  type TemplateFileSystem,
  templateStatuses,
} from "@beamer-editor/html-export";
