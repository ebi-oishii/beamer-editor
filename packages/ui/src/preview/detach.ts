/**
 * 「自由配置にする」の候補集め(UI 非依存の DOM 補助)。renderer が付けた
 * data-flow-block / data-source-start / data-source-end を、右クリック位置から
 * 外側へ向かって拾う。内側の候補が先。
 */

export interface DetachCandidate {
  element: HTMLElement;
  kind: string;
  sourceSpan: { start: number; end: number };
  /** メニューに出す文言(単位と冒頭の抜粋)。 */
  label: string;
}

const EXCERPT_LENGTH = 16;

function kindLabel(element: HTMLElement, kind: string): string {
  if (kind === "paragraph") return "段落";
  if (kind === "image") return "画像";
  if (kind === "list") return element.tagName === "OL" ? "番号付きリスト" : "箸条書き";
  return "要素";
}

/** テキストノードを空白でつないだ本文(textContent だと隣接する li が詰まる)。 */
function textOf(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  return [...node.childNodes].map(textOf).join(" ");
}

/** 「段落「冒頭…」を自由配置にする」の形。画像は抜粋なし。 */
export function candidateLabel(element: HTMLElement, kind: string): string {
  const base = kindLabel(element, kind);
  const text = kind === "image" ? "" : textOf(element).replace(/\s+/g, " ").trim();
  const excerpt = text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}…` : text;
  return excerpt ? `${base}「${excerpt}」を自由配置にする` : `${base}を自由配置にする`;
}

export function collectDetachCandidates(target: HTMLElement, root: HTMLElement): DetachCandidate[] {
  const candidates: DetachCandidate[] = [];
  let element = target.closest<HTMLElement>("[data-flow-block]");
  while (element && root.contains(element)) {
    const kind = element.dataset.flowBlock ?? "";
    const start = Number(element.dataset.sourceStart);
    const end = Number(element.dataset.sourceEnd);
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start) {
      candidates.push({
        element,
        kind,
        sourceSpan: { start, end },
        label: candidateLabel(element, kind),
      });
    }
    element = element.parentElement?.closest<HTMLElement>("[data-flow-block]") ?? null;
  }
  return candidates;
}

/** 要素の左上と幅を、スライド全体を 1 とした値で返す。倍率は両方の rect に掛かるので打ち消える。 */
export function slideRelativeRect(
  element: HTMLElement,
  slide: HTMLElement,
): { x: number; y: number; width: number } | null {
  const s = slide.getBoundingClientRect();
  if (!(s.width > 0) || !(s.height > 0)) return null;
  const r = element.getBoundingClientRect();
  return {
    x: (r.left - s.left) / s.width,
    y: (r.top - s.top) / s.height,
    width: r.width / s.width,
  };
}
