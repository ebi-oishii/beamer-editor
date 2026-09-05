/**
 * @beamer-editor/ui の公開 API。
 * 環境非依存のプレビュー UI（React）と、ホストとの通信契約・メッセージ検証を提供する。
 */

export {
  type ExtensionToWebview,
  parseExtensionToWebview,
  parseWebviewToExtension,
  type WebviewToExtension,
} from "./messages.js";
export { DeckPreview } from "./preview/DeckPreview.js";
export { mountPreview } from "./preview/mount.js";
export { applyOverlay, isVisibleAtStep } from "./preview/overlay.js";
export { applyRawImages, decodeBase64, RawImageStore } from "./preview/raw-images.js";
export {
  type PreviewAction,
  type PreviewState,
  previewReducer,
} from "./preview/state.js";
export { PREVIEW_CSS } from "./preview/styles.js";
export {
  createMessageShellHost,
  type MessageTransport,
  type RasterImage,
  type RawBlockImageResult,
  type ShellHost,
} from "./shell-host.js";
