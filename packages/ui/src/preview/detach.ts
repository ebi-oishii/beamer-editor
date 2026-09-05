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
  /** 候補にできない理由(renderer の data-detach-blocked)。あれば項目は無効表示。 */
  blocked?: string;
}

const BLOCKED_REASONS: Record<string, string> = {
  "unsupported-kind": "この種類は canvas に置けません",
  overlay: "表示条件(\\pause / overlay)が変わります",
};

const EXCERPT_LENGTH = 16;

function kindLabel(element: HTMLElement, kind: string): string {
  switch (kind) {
    case "paragraph":
      return "段落";
    case "image":
      return "画像";
    case "list":
      return element.tagName === "OL" ? "番号付きリスト" : "箸条書き";
    case "columns":
      return "段組";
    case "blockEnv":
      return "ブロック";
    case "center":
      return "中央寄せ";
    case "table":
      return "表";
    case "displayMath":
      return "数式";
    case "rawBlock":
      return "生ブロック";
    default:
      return "要素";
  }
}

/** テキストノードを空白でつないだ本文(textContent だと隣接する li が詰まる)。 */
function textOf(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  return [...node.childNodes].map(textOf).join(" ");
}

/** 「段落「冒頭…」を自由配置にする」の形。画像は抜粋なし。候補外なら理由を添えた無効項目の文言。 */
export function candidateLabel(element: HTMLElement, kind: string, blocked?: string): string {
  const base = kindLabel(element, kind);
  const text = kind === "image" ? "" : textOf(element).replace(/\s+/g, " ").trim();
  const excerpt = text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}…` : text;
  const subject = excerpt ? `${base}「${excerpt}」` : base;
  if (blocked !== undefined) {
    return `${subject}は自由配置にできません(${BLOCKED_REASONS[blocked] ?? blocked})`;
  }
  return `${subject}を自由配置にする`;
}

export function collectDetachCandidates(target: HTMLElement, root: HTMLElement): DetachCandidate[] {
  const candidates: DetachCandidate[] = [];
  let element = target.closest<HTMLElement>("[data-flow-block]");
  while (element && root.contains(element)) {
    const kind = element.dataset.flowBlock ?? "";
    const start = Number(element.dataset.sourceStart);
    const end = Number(element.dataset.sourceEnd);
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start) {
      const blocked = element.dataset.detachBlocked;
      candidates.push({
        element,
        kind,
        sourceSpan: { start, end },
        label: candidateLabel(element, kind, blocked),
        ...(blocked !== undefined ? { blocked } : {}),
      });
    }
    element = element.parentElement?.closest<HTMLElement>("[data-flow-block]") ?? null;
  }
  return candidates;
}

/**
 * 右クリック位置に出すメニューが画面外へはみ出さないようにする。右・下にはみ出すなら
 * クリック位置の左・上へ反転し、それでも収まらなければ画面内へ clamp する。
 */
export function clampMenuPosition(
  x: number,
  y: number,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 4,
): { x: number; y: number } {
  let left = x;
  let top = y;
  if (left + size.width > viewport.width - margin) left = x - size.width;
  if (top + size.height > viewport.height - margin) top = y - size.height;
  left = Math.max(margin, Math.min(left, viewport.width - size.width - margin));
  top = Math.max(margin, Math.min(top, viewport.height - size.height - margin));
  return { x: left, y: top };
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
