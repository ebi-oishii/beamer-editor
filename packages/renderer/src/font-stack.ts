/**
 * 等幅スタックの末尾。Windows の Latin 等幅(Consolas / Cascadia Mono)を挟んでから総称へ落とす。
 * 総称 monospace だけだと日本語 Windows では MS ゴシックになり、バックスラッシュ(U+005C)が ¥ に見える。
 * renderer の `--deck-font-mono` と ui の PREVIEW_CSS が共有する。
 *
 * Courier New は入れない。日本語 Windows には Consolas が必ずあるので要らず、入れると macOS では
 * OS 標準の Courier New が Menlo の代わりに、Linux では fontconfig の割り当て先(Liberation Mono など)が
 * distro 既定の等幅の代わりに使われてしまう。
 *
 * katex を読み込む render.ts から切り離しておき、ui(Webview バンドル)がこの定数だけを
 * import しても renderer 本体が入らないようにする(package.json の sideEffects: false と対)。
 */
export const MONO_FONT_FALLBACK = `Consolas, "Cascadia Mono", monospace`;
