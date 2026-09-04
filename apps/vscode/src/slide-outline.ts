import { framesOf, type InlineNode, parseDeck } from "@beamer-editor/core";
import { resolveSourceViewColumn, type VisibleSourceEditor } from "./source-navigation";

/** TreeView が扱う TextDocument の最小面。offset は VS Code と同じ UTF-16 単位。 */
export interface SlideOutlineDocument {
  readonly version: number;
  readonly uri: { toString(): string };
  getText(): string;
}

/** 一覧の一行。`version` はクリック時に古い span を使わないための世代番号。 */
export interface SlideOutlineEntry<Document extends SlideOutlineDocument = SlideOutlineDocument> {
  readonly document: Document;
  readonly version: number;
  readonly frameNumber: number;
  readonly title: string;
  readonly label: string | null;
  readonly raw: boolean;
  readonly start: number;
}

function inlineText(nodes: readonly InlineNode[], source: string): string {
  return nodes
    .map((node, index) => {
      const previous = nodes[index - 1];
      // Parser は空白だけの TextNode を省くため、装飾・数式の間にある見出しの
      // 区切りだけは元ソースの span から戻す。
      const separator =
        previous && /\s/.test(source.slice(previous.span.end, node.span.start)) ? " " : "";
      const text = (() => {
        switch (node.type) {
          case "text":
            return node.value;
          case "styled":
          case "colorText":
          case "href":
            return inlineText(node.children, source);
          case "url":
            return node.url;
          case "inlineMath":
            return node.tex;
          case "lineBreak":
            return " ";
          case "rawInline":
            return node.tex;
        }
      })();
      return separator + text;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 元ソースを直接 parse して明示的な frame だけを出現順に返す。
 * 展開済み deck は使わないため、マクロ呼び出しから生じる仮想フレームは表示しない。
 */
export function slideOutlineEntries<Document extends SlideOutlineDocument>(
  document: Document,
): SlideOutlineEntry<Document>[] {
  return framesOf(parseDeck(document.getText())).map((frame, index) => {
    const raw = frame.type === "rawFrame";
    const parsedTitle = raw
      ? frame.title
      : frame.title
        ? inlineText(frame.title, document.getText())
        : "";
    const frameNumber = index + 1;
    return {
      document,
      version: document.version,
      frameNumber,
      title: parsedTitle || `frame ${frameNumber}`,
      label: raw ? frame.label : frame.options.label,
      raw,
      start: frame.span.start,
    };
  });
}

/** 現在の source document と一覧をまとめる小さな状態保持。 */
export class SlideOutlineState<Document extends SlideOutlineDocument> {
  private document: Document | undefined;
  private entries: SlideOutlineEntry<Document>[] = [];
  private version: number | undefined;

  setDocument(document: Document | undefined): boolean {
    if (this.document === document && (!document || this.version === document.version)) {
      return false;
    }
    this.document = document;
    this.entries = document ? slideOutlineEntries(document) : [];
    this.version = document?.version;
    return true;
  }

  refresh(document: Document): boolean {
    if (document !== this.document) return false;
    return this.setDocument(document);
  }

  getEntries(): readonly SlideOutlineEntry<Document>[] {
    return this.entries;
  }

  getDocument(): Document | undefined {
    return this.document;
  }

  /** 同じ document object と version の item だけを source navigation に渡す。 */
  isCurrent(entry: SlideOutlineEntry<Document>): boolean {
    return entry.document === this.document && entry.version === this.document.version;
  }

  hasDocument(document: Document): boolean {
    return this.document === document;
  }
}

/**
 * managedFiles 設定変更時の一覧対象を決める。text editor が active ならそれを優先し、
 * webview に focus がある場合だけ、現在一覧に出ている preview source を再評価する。
 */
export function managedOutlineDocument<Document>(
  activeDocument: Document | undefined,
  outlinedDocument: Document | undefined,
  isManaged: (document: Document) => boolean,
): Document | undefined {
  const candidate = activeDocument ?? outlinedDocument;
  return candidate && isManaged(candidate) ? candidate : undefined;
}

/** Tree item の reveal に必要な host 面。VS Code API は extension.ts に閉じ込める。 */
export interface SlideOutlineRevealHost<Document extends SlideOutlineDocument, Editor, ViewColumn> {
  readonly visibleEditors: readonly VisibleSourceEditor<ViewColumn>[];
  readonly fallbackViewColumn: ViewColumn | undefined;
  showTextDocument(document: Document, viewColumn: ViewColumn): PromiseLike<Editor>;
  reveal(editor: Editor, offset: number): void;
}

/**
 * source が既に見えている列を優先して Tree item を reveal する。
 * showTextDocument は await 中に文書が編集されうるため、戻った時点でも identity/version が
 * 一致する場合だけ旧 offset を使う。これにより preview を置換せず、古い span も使わない。
 */
export async function revealSlideOutlineEntry<
  Document extends SlideOutlineDocument,
  Editor,
  ViewColumn,
>(
  entry: SlideOutlineEntry<Document>,
  state: SlideOutlineState<Document>,
  host: SlideOutlineRevealHost<Document, Editor, ViewColumn>,
): Promise<boolean> {
  if (!state.isCurrent(entry)) return false;
  const viewColumn = resolveSourceViewColumn(
    entry.document.uri,
    host.visibleEditors,
    host.fallbackViewColumn,
  );
  if (viewColumn === undefined) return false;
  const editor = await host.showTextDocument(entry.document, viewColumn);
  if (!state.isCurrent(entry)) return false;
  host.reveal(editor, entry.start);
  return true;
}
