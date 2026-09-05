import { expandDeck, framesOf, mapExpandedToSource, parseDeck } from "@beamer-editor/core";
import { frameTitleText } from "@beamer-editor/renderer";
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

/** VS Code の設定変更など、本文に変更の無いイベントでは一覧を再解析しない。 */
export function hasSlideOutlineContentChanges(contentChanges: readonly unknown[]): boolean {
  return contentChanges.length > 0;
}

/**
 * 明示的に元ソースへ書かれた frame だけを、展開後のプレビュー番号で返す。
 * マクロ展開で生じた仮想 frame は出さず、タイトル等はプレビューと同じ展開後 frame を使う。
 */
export function slideOutlineEntries<Document extends SlideOutlineDocument>(
  document: Document,
): SlideOutlineEntry<Document>[] {
  const source = document.getText();
  const explicitStarts = new Set(framesOf(parseDeck(source)).map((frame) => frame.span.start));
  const expanded = expandDeck(source);
  return framesOf(expanded.doc).flatMap((frame, index) => {
    const start = mapExpandedToSource(expanded.map, frame.span.start);
    if (!explicitStarts.has(start)) return [];
    const raw = frame.type === "rawFrame";
    const frameNumber = index + 1;
    return [
      {
        document,
        version: document.version,
        frameNumber,
        title: frameTitleText(frame, frameNumber),
        label: raw ? frame.label : frame.options.label,
        raw,
        start,
      },
    ];
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

/** 編集中の一覧再構築をまとめる。対象切替・close・dispose 時には必ず取消す。 */
export class SlideOutlineRefreshScheduler<Document extends SlideOutlineDocument> {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly state: SlideOutlineState<Document>,
    private readonly changed: () => void,
    private readonly delayMs = 120,
  ) {}

  schedule(document: Document): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.state.refresh(document)) this.changed();
    }, this.delayMs);
  }

  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.cancel();
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
