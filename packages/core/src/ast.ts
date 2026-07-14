/**
 * AST 型定義(ドラフト・レビュー用)
 *
 * docs/subset-spec.md v1.1 に対応する。設計上の不変条件:
 *
 * - すべてのノードが source span を持つ(プレビュー→ソースジャンプ、lint 位置表示の基盤)。
 * - `%` コメントは直近のノードに付随して保持する(フォーマッタは消さない)。
 * - サブセット外の構文はエラーにせず Raw* ノードに落とす(生ブロック 3 段階:
 *   インライン / ブロック / フレーム)。
 * - GUI 操作・フォーマッタは「AST 変換 → 触れたフレームの正規形再出力」で実装するため、
 *   正規形の再出力に必要な情報(座標精度、オプション、区切り)はすべて AST が持つ。
 *
 * 数式ノードについて: KaTeX 非対応数式の「生ブロック落ち」(subset-spec §2.6)は
 * パース時ではなくプレビューパイプライン側の判定であるため、AST 上は Math ノードのまま保持する。
 */

// ---------------------------------------------------------------------------
// 位置情報・コメント
// ---------------------------------------------------------------------------

/** ソース上の範囲。ソーステキストに対する UTF-16 コードユニットのオフセット(半開区間)。 */
export interface SourceSpan {
  start: number;
  end: number;
}

/** `%` コメント。text は `%` を含まない本文。 */
export interface Comment {
  text: string;
  span: SourceSpan;
}

/** 全ノード共通の基底。 */
export interface BaseNode {
  span: SourceSpan;
  /** 直前の行にあった % コメント(複数行可)。 */
  leadingComments?: Comment[];
  /** 同一行の末尾にあった % コメント。 */
  trailingComment?: Comment;
}

// ---------------------------------------------------------------------------
// オーバーレイ(§2.7)
// ---------------------------------------------------------------------------

/** `<n>` = {from:n, to:n} / `<n->` = {from:n, to:null} / `<n-m>` / `<n,m>` は ranges 2 個。 */
export interface OverlayRange {
  from: number;
  /** null は開区間(`n-`)。 */
  to: number | null;
}

export interface OverlaySpec {
  ranges: OverlayRange[];
  span: SourceSpan;
}

// ---------------------------------------------------------------------------
// 文書(§1)
// ---------------------------------------------------------------------------

export type AspectRatio = "169" | "43";

export interface DeckDocument extends BaseNode {
  type: "document";
  /** `%% deck-source-version: N`。欠落は null(L017)。 */
  sourceVersion: number | null;
  aspectRatio: AspectRatio;
  metadata: DeckMetadata;
  macros: MacroSection;
  /** `%% preamble-extra` 領域。ツールは解釈しない素通しテキスト。 */
  preambleExtra: RawRegion;
  /** ツール管理プリアンブルのうち、上記以外の部分(不透明。手編集は L006)。 */
  managedPreamble: RawRegion;
  /** document 環境の中身: フレームとセクションの列。 */
  body: DeckElement[];
}

/** ツールが素通しする生テキスト領域。 */
export interface RawRegion extends BaseNode {
  type: "rawRegion";
  tex: string;
}

/** メタデータ(§1.1): title / author / date / institute / subtitle。 */
export interface DeckMetadata extends BaseNode {
  type: "metadata";
  title?: MetaField;
  author?: MetaField;
  date?: MetaField;
  institute?: MetaField;
  subtitle?: MetaField;
}

export interface MetaField extends BaseNode {
  value: InlineNode[];
}

// ---------------------------------------------------------------------------
// マクロ(§4)
// ---------------------------------------------------------------------------

/** `%% macros` 領域。領域外の定義は AST に取り込まず lint(L003)のみ。 */
export interface MacroSection extends BaseNode {
  type: "macroSection";
  /**
   * 解釈できた定義の列。`\def` 等の対象外定義は RawBlock として位置ごと保持する
   * (定義はエラーにせず、呼び出し箇所が生ブロックに落ちる。§4)。
   */
  entries: Array<MacroDefinition | RawBlockNode>;
}

export interface MacroDefinition extends BaseNode {
  type: "macroDefinition";
  kind: "newcommand" | "renewcommand" | "newenvironment";
  /** バックスラッシュを除いた名前。`deck` 始まりは予約(L016)。 */
  name: string;
  paramCount: number;
  /** 省略可能引数のデフォルト値(1 個まで)。なければ null。 */
  optionalDefault: string | null;
  /** 置換本体(生テキスト。展開器が #1〜#9 を置換する)。 */
  body: string;
  /** newenvironment の end 側本体。 */
  endBody?: string;
  /**
   * 単純な引数置換として展開可能か。false の定義はエラーにせず、
   * 呼び出し箇所が RawInline / RawBlock に落ちる(L002)。
   */
  expandable: boolean;
}

// ---------------------------------------------------------------------------
// フレームとセクション(§2.1)
// ---------------------------------------------------------------------------

export type DeckElement = FrameNode | RawFrameNode | SectionNode;

export interface SectionNode extends BaseNode {
  type: "section";
  level: "section" | "subsection";
  title: InlineNode[];
}

export interface FrameNode extends BaseNode {
  type: "frame";
  options: FrameOptions;
  /** `\begin{frame}{タイトル}` のタイトル。なければ null。 */
  title: InlineNode[] | null;
  /**
   * フレーム本文。CanvasNode を含むフレームはキャンバスフレーム(§2.8)。
   * キャンバスと通常フロー要素の混在は構文上は保持し、L014 が検出する。
   */
  body: BlockNode[];
}

/** 受理するフレームオプションは 4 つのみ。未知オプションはフレームごと RawFrame へ。 */
export interface FrameOptions {
  fragile: boolean;
  plain: boolean;
  allowframebreaks: boolean;
  /** 永続アドレス(ai-protocol §3)。キャンバスフレームは必須(L011)。 */
  label: string | null;
  span: SourceSpan | null;
}

/** 解釈不能フレーム(生ブロック第 3 段階)。一覧・並べ替えは可能、内容は不透明。 */
export interface RawFrameNode extends BaseNode {
  type: "rawFrame";
  tex: string;
  /** 読み取れた場合のみ(一覧表示・アドレッシングに使う)。 */
  title: string | null;
  label: string | null;
}

// ---------------------------------------------------------------------------
// ブロック要素(§2.2〜2.4、§2.6〜2.8)
// ---------------------------------------------------------------------------

export type BlockNode =
  | ParagraphNode
  | ListNode
  | ColumnsNode
  | BlockEnvNode
  | CenterNode
  | TableNode
  | ImageNode
  | DisplayMathNode
  | PauseNode
  | TitlePageNode
  | TocNode
  | CanvasNode
  | RawBlockNode;

/** インライン要素の連なり(地の文)。 */
export interface ParagraphNode extends BaseNode {
  type: "paragraph";
  children: InlineNode[];
}

/** itemize / enumerate。ネスト 3 段までは lint(パーサは深くても読む)。 */
export interface ListNode extends BaseNode {
  type: "list";
  kind: "itemize" | "enumerate";
  items: ListItemNode[];
}

export interface ListItemNode extends BaseNode {
  type: "listItem";
  /** `\item<2->` 等(§2.6)。 */
  overlay: OverlaySpec | null;
  children: BlockNode[];
}

/** `\textwidth` / `\linewidth` の係数(§2.3、§2.4)。 */
export interface DimFactor {
  factor: number;
  unit: "textwidth" | "linewidth";
  span: SourceSpan;
}

export interface ColumnsNode extends BaseNode {
  type: "columns";
  /** `[T]` のみ受理。 */
  topAligned: boolean;
  columns: ColumnNode[];
}

export interface ColumnNode extends BaseNode {
  type: "column";
  width: DimFactor;
  children: BlockNode[];
}

export interface BlockEnvNode extends BaseNode {
  type: "blockEnv";
  kind: "block" | "alertblock" | "exampleblock";
  overlay: OverlaySpec | null;
  title: InlineNode[];
  children: BlockNode[];
}

export interface CenterNode extends BaseNode {
  type: "center";
  children: BlockNode[];
}

/** tabular + booktabs(§2.4)。列指定は l/c/r のみ(`|` 等は環境ごと RawBlock へ)。 */
export interface TableNode extends BaseNode {
  type: "table";
  columns: Array<"l" | "c" | "r">;
  rows: TableRow[];
}

export type TableRow = TableCellsRow | TableRuleRow;

export interface TableCellsRow extends BaseNode {
  type: "tableCells";
  cells: InlineNode[][];
}

export interface TableRuleRow extends BaseNode {
  type: "tableRule";
  rule: "toprule" | "midrule" | "bottomrule";
}

/** `\includegraphics`(§2.4)。オプションは width / height のみ、値は DimFactor のみ。 */
export interface ImageNode extends BaseNode {
  type: "image";
  path: string;
  width: DimFactor | null;
  height: DimFactor | null;
}

/** ディスプレイ数式(§2.6)。中身は KaTeX に渡す生 TeX。 */
export interface DisplayMathNode extends BaseNode {
  type: "displayMath";
  kind: "bracket" | "equation" | "equation*" | "align" | "align*";
  tex: string;
}

export interface PauseNode extends BaseNode {
  type: "pause";
}

export interface TitlePageNode extends BaseNode {
  type: "titlePage";
}

export interface TocNode extends BaseNode {
  type: "tableOfContents";
}

// ---------------------------------------------------------------------------
// キャンバス(§2.8)
// ---------------------------------------------------------------------------

/** 座標は本文領域に対する 0.000〜1.000 の正規化値。正規形は小数 3 桁(§2.8)。 */
export interface CanvasPosition {
  x: number;
  y: number;
  width: number;
  span: SourceSpan;
}

export type CanvasFontSize =
  | "tiny"
  | "scriptsize"
  | "footnotesize"
  | "small"
  | "normal"
  | "large"
  | "Large";

export interface CanvasNode extends BaseNode {
  type: "canvas";
  /** 許容外の直下要素は RawBlock として保持し L014 が検出する。 */
  items: CanvasItemNode[];
}

export type CanvasItemNode = CanvasTextNode | CanvasImageNode | RawBlockNode;

export interface CanvasTextNode extends BaseNode {
  type: "canvasText";
  position: CanvasPosition;
  size: CanvasFontSize;
  /**
   * decktext 内の許容語彙(§2.8): paragraph(インライン要素・数式・改行)と
   * ネスト 1 段までのリストのみ。深さ・内容の逸脱は L014 が検査する
   * (パーサは BlockNode として読めるものは読む)。
   */
  children: Array<ParagraphNode | ListNode | RawBlockNode>;
}

export interface CanvasImageNode extends BaseNode {
  type: "canvasImage";
  position: CanvasPosition;
  /** PNG / JPEG / PDF のみ(L015)。高さは寸法プローブの縦横比から自動算出。 */
  path: string;
}

// ---------------------------------------------------------------------------
// インライン要素(§2.5〜2.6)
// ---------------------------------------------------------------------------

export type InlineNode =
  | TextNode
  | StyledTextNode
  | ColorTextNode
  | UrlNode
  | HrefNode
  | LineBreakNode
  | InlineMathNode
  | RawInlineNode;

/** 地のテキスト。特殊文字(`\%`、`---` 等)はデコード済みの値を持ち、正規形再出力時に再エンコードする。 */
export interface TextNode extends BaseNode {
  type: "text";
  value: string;
}

export interface StyledTextNode extends BaseNode {
  type: "styled";
  style: "textbf" | "emph" | "textit" | "texttt" | "alert";
  children: InlineNode[];
}

export interface ColorTextNode extends BaseNode {
  type: "colorText";
  /** 定義済み色名のみ(§2.5)。 */
  color: string;
  children: InlineNode[];
}

export interface UrlNode extends BaseNode {
  type: "url";
  url: string;
}

export interface HrefNode extends BaseNode {
  type: "href";
  url: string;
  children: InlineNode[];
}

export interface LineBreakNode extends BaseNode {
  type: "lineBreak";
}

export interface InlineMathNode extends BaseNode {
  type: "inlineMath";
  /** `$...$` か `\(...\)` か(正規形はどちらかに揃える。フォーマッタ仕様で確定)。 */
  delimiter: "dollar" | "paren";
  tex: string;
}

// ---------------------------------------------------------------------------
// 生ブロック(§3)
// ---------------------------------------------------------------------------

/** 生ブロック化の理由。lint(L001 等)の報告とデバッグに使う。 */
export type RawReason =
  | "unknown-command"
  | "unknown-environment"
  | "unexpandable-macro-call"
  | "canvas-unsupported-content"
  | "canvas-overlay"
  | "unsupported-table-spec"
  | "unsupported-option";

/** 未知コマンド + 引数グループ(生ブロック第 1 段階)。 */
export interface RawInlineNode extends BaseNode {
  type: "rawInline";
  tex: string;
  reason: RawReason;
}

/** 未知環境まるごと(生ブロック第 2 段階)。プレビューは部分コンパイル画像。 */
export interface RawBlockNode extends BaseNode {
  type: "rawBlock";
  tex: string;
  /** `\begin{X}` の X。環境でない塊は null。 */
  environment: string | null;
  reason: RawReason;
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

/** フレームが キャンバスフレーム(§2.8)かどうか。 */
export function isCanvasFrame(frame: FrameNode): boolean {
  return frame.body.some((block) => block.type === "canvas");
}

/** 文書中のフレーム(生フレーム含む)を出現順に返す。序数アドレス(ai-protocol §3)の基盤。 */
export function framesOf(doc: DeckDocument): Array<FrameNode | RawFrameNode> {
  return doc.body.filter(
    (el): el is FrameNode | RawFrameNode => el.type === "frame" || el.type === "rawFrame",
  );
}
