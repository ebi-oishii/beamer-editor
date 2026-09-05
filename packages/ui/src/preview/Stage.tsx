/**
 * 1 フレームの描画ステージ。renderer が escape 済みの html を .slide-scale へ流し込み、
 * 親(SlideScroll)が決めた倍率で transform: scale し、オーバーレイ(step に応じた covered
 * トグル)とキャンバス画像のドラッグを適用する。倍率の計算は持たない。
 */

import type { RenderedFrame } from "@beamer-editor/renderer";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { canvasPointFromPointer, normalizeCanvasCoordinate } from "./canvas-drag.js";
import {
  clampMenuPosition,
  collectDetachCandidates,
  type DetachCandidate,
  slideRelativeRect,
} from "./detach.js";
import { applyOverlay } from "./overlay.js";

/** 「自由配置にする」の要求。sourceSpan は展開後ソース、rect はスライド全体を 1 とした値。 */
export interface DetachRequest {
  sourceSpan: { start: number; end: number };
  rect: { x: number; y: number; width: number };
}

interface ContextMenuState {
  x: number;
  y: number;
  candidates: DetachCandidate[];
}

/** スライドの論理サイズ(px)。transform はレイアウト寸法を変えないため外側の box に持たせる。 */
export interface SlideSize {
  width: number;
  height: number;
}

function releasePointerCapture(element: HTMLElement, pointerId: number): void {
  try {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  } catch {
    // The element may already have been replaced by a newer deck render.
  }
}

export function Stage({
  frame,
  step,
  scale,
  slideSize,
  version,
  onMoveCanvasElement,
  onDetachToCanvas,
}: {
  frame: RenderedFrame;
  step: number;
  scale: number;
  slideSize: SlideSize;
  version: number;
  onMoveCanvasElement: (elementId: string, x: number, y: number) => void;
  /** 未指定ならフロー要素の右クリックメニューを出さない(ホストが未対応)。 */
  onDetachToCanvas?: ((request: DetachRequest) => void) | undefined;
}): JSX.Element {
  const scaleRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    element: HTMLElement;
    id: string;
    x: number;
    y: number;
    grabX: number;
    grabY: number;
    pointerId: number;
  }>();
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const highlightRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 描画後に実測サイズで位置を直し、スライドの右端・下端で右クリックしても項目が押せるようにする。
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element || !menu) return;
    const rect = element.getBoundingClientRect();
    const position = clampMenuPosition(
      menu.x,
      menu.y,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    element.style.left = `${position.x}px`;
    element.style.top = `${position.y}px`;
  }, [menu]);

  /** 候補要素の dev tools 風強調を付け替える(null で解除)。 */
  const highlight = useCallback((element: HTMLElement | null) => {
    highlightRef.current?.classList.remove("flow-target");
    highlightRef.current = element;
    element?.classList.add("flow-target");
  }, []);
  const closeMenu = useCallback(() => {
    highlight(null);
    setMenu(null);
  }, [highlight]);

  // 右クリック位置から外側へ向かう候補を集めてメニューを出す。候補が無ければ標準メニューに任せる。
  useEffect(() => {
    const scale = scaleRef.current;
    if (!scale || !onDetachToCanvas) return;
    const onContextMenu = (event: MouseEvent) => {
      const candidates = collectDetachCandidates(event.target as HTMLElement, scale);
      if (candidates.length === 0) return;
      event.preventDefault();
      highlight(candidates[0]?.element ?? null);
      setMenu({ x: event.clientX, y: event.clientY, candidates });
    };
    scale.addEventListener("contextmenu", onContextMenu);
    return () => scale.removeEventListener("contextmenu", onContextMenu);
  }, [onDetachToCanvas, highlight]);

  // メニュー外の pointerdown / Escape で閉じる。
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest(".context-menu")) closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menu, closeMenu]);

  // frame（html）または step が変わるたびに covered を再適用する。
  // biome-ignore lint/correctness/useExhaustiveDependencies: frame の html 差し替え時に再適用したい
  useEffect(() => {
    if (scaleRef.current) applyOverlay(scaleRef.current, step);
  }, [frame, step]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deck replacement must cancel a captured drag and close the menu.
  useEffect(() => {
    const drag = dragRef.current;
    if (drag) {
      drag.element.style.left = `${drag.x * 100}%`;
      drag.element.style.top = `${drag.y * 100}%`;
      drag.element.classList.remove("canvas-dragging", "canvas-selected");
      releasePointerCapture(drag.element, drag.pointerId);
      dragRef.current = undefined;
    }
    setSelected(null);
    closeMenu();
  }, [frame, version]);
  useEffect(() => {
    const editable = new Set(
      frame.canvasElements?.filter((element) => element.editable).map((element) => element.id) ??
        [],
    );
    scaleRef.current
      ?.querySelectorAll<HTMLElement>("[data-canvas-element-id]")
      .forEach((element) => {
        element.classList.toggle(
          "canvas-editable",
          editable.has(element.dataset.canvasElementId ?? ""),
        );
      });
  }, [frame]);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const drag = dragRef.current;
      if (!drag) return;
      drag.element.style.left = `${drag.x * 100}%`;
      drag.element.style.top = `${drag.y * 100}%`;
      drag.element.classList.remove("canvas-dragging");
      releasePointerCapture(drag.element, drag.pointerId);
      dragRef.current = undefined;
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, []);
  const onPointerDown = (event: PointerEvent) => {
    if (dragRef.current) return;
    const clearSelection = () => {
      if (dragRef.current || !selected) return;
      scaleRef.current
        ?.querySelector(`[data-canvas-element-id="${selected}"]`)
        ?.classList.remove("canvas-selected");
      setSelected(null);
    };
    const element = (event.target as HTMLElement).closest<HTMLElement>("[data-canvas-element-id]");
    if (!element) {
      clearSelection();
      return;
    }
    const id = element.dataset.canvasElementId;
    const descriptor = frame.canvasElements?.find(
      (candidate) => candidate.id === id && candidate.editable,
    );
    const canvas = element.closest<HTMLElement>(".canvas");
    if (!id || !descriptor || !canvas) {
      clearSelection();
      return;
    }
    if (selected) {
      scaleRef.current
        ?.querySelector(`[data-canvas-element-id="${selected}"]`)
        ?.classList.remove("canvas-selected");
    }
    const bounds = element.getBoundingClientRect();
    dragRef.current = {
      element,
      id,
      x: descriptor.position.x,
      y: descriptor.position.y,
      grabX: event.clientX - bounds.left,
      grabY: event.clientY - bounds.top,
      pointerId: event.pointerId,
    };
    element.setPointerCapture(event.pointerId);
    element.classList.add("canvas-selected", "canvas-dragging");
    setSelected(id);
    event.preventDefault();
  };
  const move = (event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const canvas = drag.element.closest<HTMLElement>(".canvas");
    const point =
      canvas &&
      canvasPointFromPointer(
        canvas.getBoundingClientRect(),
        event.clientX,
        event.clientY,
        drag.grabX,
        drag.grabY,
      );
    if (!point) return;
    drag.element.style.left = `${point.x * 100}%`;
    drag.element.style.top = `${point.y * 100}%`;
  };
  const finish = (event: PointerEvent, commit: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const canvas = drag.element.closest<HTMLElement>(".canvas");
    const point =
      canvas &&
      canvasPointFromPointer(
        canvas.getBoundingClientRect(),
        event.clientX,
        event.clientY,
        drag.grabX,
        drag.grabY,
      );
    drag.element.classList.remove("canvas-dragging");
    releasePointerCapture(drag.element, drag.pointerId);
    if (!commit || !point) {
      drag.element.style.left = `${drag.x * 100}%`;
      drag.element.style.top = `${drag.y * 100}%`;
    } else {
      const x = normalizeCanvasCoordinate(point.x);
      const y = normalizeCanvasCoordinate(point.y);
      if (x !== normalizeCanvasCoordinate(drag.x) || y !== normalizeCanvasCoordinate(drag.y))
        onMoveCanvasElement(drag.id, x, y);
    }
    dragRef.current = undefined;
  };
  // renderer HTML は dangerouslySetInnerHTML 由来なので、scale 要素で native pointer
  // events を委譲して実DOMの子要素を確実に扱う。
  // biome-ignore lint/correctness/useExhaustiveDependencies: handlers intentionally capture the current frame/selection.
  useEffect(() => {
    const scale = scaleRef.current;
    if (!scale) return;
    const pointerUp = (event: PointerEvent) => finish(event, true);
    const pointerCancel = (event: PointerEvent) => finish(event, false);
    scale.addEventListener("pointerdown", onPointerDown);
    scale.addEventListener("pointermove", move);
    scale.addEventListener("pointerup", pointerUp);
    scale.addEventListener("pointercancel", pointerCancel);
    return () => {
      scale.removeEventListener("pointerdown", onPointerDown);
      scale.removeEventListener("pointermove", move);
      scale.removeEventListener("pointerup", pointerUp);
      scale.removeEventListener("pointercancel", pointerCancel);
    };
  }, [frame, selected, version, onMoveCanvasElement]);

  const choose = (candidate: DetachCandidate) => {
    const slide = scaleRef.current?.querySelector<HTMLElement>(".slide");
    const rect = slide ? slideRelativeRect(candidate.element, slide) : null;
    closeMenu();
    if (rect) onDetachToCanvas?.({ sourceSpan: candidate.sourceSpan, rect });
  };

  return (
    // html は renderer が escape 済みの信頼データ（design.md §6）
    <div
      className="slide-layout"
      style={{ width: slideSize.width * scale, height: slideSize.height * scale }}
    >
      {/* transform はレイアウト寸法を変えない。内側を論理サイズに固定し、外側だけを見た目の
          scaled size にすることで、transform のはみ出しを二重に数えない(#58 の移植)。 */}
      <div
        className="slide-scale"
        ref={scaleRef}
        style={{
          width: slideSize.width,
          height: slideSize.height,
          transform: `scale(${scale})`,
        }}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: renderer が escape 済みの信頼 HTML
        dangerouslySetInnerHTML={{ __html: frame.html }}
      />
      {menu && onDetachToCanvas ? (
        <div
          ref={menuRef}
          className="context-menu"
          role="menu"
          aria-label="自由配置にする候補"
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.candidates.map((candidate) => (
            <button
              key={`${candidate.sourceSpan.start}-${candidate.sourceSpan.end}`}
              type="button"
              role="menuitem"
              onMouseEnter={() => highlight(candidate.element)}
              onFocus={() => highlight(candidate.element)}
              onClick={() => choose(candidate)}
            >
              {candidate.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
