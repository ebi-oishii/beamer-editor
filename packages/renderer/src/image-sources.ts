const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Apply a host's resource URL to the renderer's local image references. */
export function rewriteImageSources(html: string, resolve: (path: string) => string): string {
  return html.replace(/(<img\b[^>]*\bsrc=")([^"]*)(")/g, (whole, pre, src, post) => {
    if (/^(?:https?:|data:|vscode-webview|vscode-resource:)/i.test(src)) return whole;
    const url = resolve(unescapeAttr(src)).replace(
      /[&<>"']/g,
      (char) => HTML_ESCAPES[char] as string,
    );
    return `${pre}${url}${post}`;
  });
}
