/**
 * 現在フレームの描画ステージ。renderer が escape 済みの html を .slide-scale へ流し込み、
 * fit-scale（スライド論理サイズを holder に合わせて transform: scale）と
 * オーバーレイ（step に応じた covered トグル）を適用する。
 */

import type { RenderedFrame } from "@beamer-editor/renderer";
import { useEffect, useRef, useState } from "react";
import { canvasPointFromPointer, normalizeCanvasCoordinate } from "./canvas-drag.js";
import { applyOverlay } from "./overlay.js";
import type { ZoomState } from "./zoom.js";

/** スライド論理サイズが取れないときの近似フォールバック（apps/web の fitSlide 相当）。 */
const FALLBACK_W = 607;
const FALLBACK_H = 341;
const MIN_FIT_SCALE = 0.1;

function releasePointerCapture(element: HTMLElement, pointerId: number): void {
  try {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  } catch {
    // The element may already have been replaced by a newer deck render.
  }
}

/**
 * ResizeObserver で holder のサイズ変化を監視し、.slide を holder に収まるよう縮小する。
 * transform はレイアウト寸法を変えないため、外側の layout box に見た目サイズを持たせる。
 */
function useFitScale(
  holderRef: React.RefObject<HTMLElement | null>,
  layoutRef: React.RefObject<HTMLElement | null>,
  scaleRef: React.RefObject<HTMLElement | null>,
  frame: RenderedFrame | undefined,
  zoom: ZoomState,
  onFitScaleChange: (scale: number) => void,
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: frame の html 差し替え時に再フィットしたい
  useEffect(() => {
    const holder = holderRef.current;
    const layoutBox = layoutRef.current;
    const scaleBox = scaleRef.current;
    if (!holder || !layoutBox || !scaleBox) return;

    const applyFit = () => {
      const slide = scaleBox.querySelector<HTMLElement>(".slide");
      const slideW = slide?.offsetWidth || FALLBACK_W;
      const slideH = slide?.offsetHeight || FALLBACK_H;
      const availW = Math.max(0, holder.clientWidth - 24);
      const availH = Math.max(0, holder.clientHeight - 24);
      const fitScale = Math.max(MIN_FIT_SCALE, Math.min(availW / slideW, availH / slideH, 1.6));
      const effectiveScale = zoom === "fit" ? fitScale : zoom;
      // ResizeObserver 内からの state 更新は、親側の stable callback と同値 no-op guard が前提。
      onFitScaleChange(fitScale);
      scaleBox.style.transform = `scale(${effectiveScale})`;
      layoutBox.style.width = `${slideW * effectiveScale}px`;
      layoutBox.style.height = `${slideH * effectiveScale}px`;
    };

    applyFit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(applyFit);
    observer.observe(holder);
    return () => observer.disconnect();
  }, [holderRef, layoutRef, scaleRef, frame, zoom, onFitScaleChange]);
}

export function Stage({
  frame,
  step,
  zoom,
  version,
  onMoveCanvasElement,
  onFitScaleChange,
}: {
  frame: RenderedFrame | undefined;
  step: number;
  zoom: ZoomState;
  version: number;
  onMoveCanvasElement: (elementId: string, x: number, y: number) => void;
  onFitScaleChange: (scale: number) => void;
}): JSX.Element {
  const holderRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
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

  useFitScale(holderRef, layoutRef, scaleRef, frame, zoom, onFitScaleChange);

  // frame（html）または step が変わるたびに covered を再適用する。
  // biome-ignore lint/correctness/useExhaustiveDependencies: frame の html 差し替え時に再適用したい
  useEffect(() => {
    if (scaleRef.current) applyOverlay(scaleRef.current, step);
  }, [frame, step]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deck replacement must cancel a captured drag.
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
  }, [frame, version]);
  useEffect(() => {
    const editable = new Set(
      frame?.canvasElements?.filter((element) => element.editable).map((element) => element.id) ??
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
    if (!element || !frame) {
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

  if (!frame) {
    return (
      <div className="slide-holder" ref={holderRef}>
        <div className="empty">フレームがありません</div>
      </div>
    );
  }

  return (
    <div className="slide-holder" ref={holderRef}>
      {/* html は renderer が escape 済みの信頼データ（design.md §6） */}
      <div className="slide-layout" ref={layoutRef}>
        <div
          className="slide-scale"
          ref={scaleRef}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: renderer が escape 済みの信頼 HTML
          dangerouslySetInnerHTML={{ __html: frame.html }}
        />
      </div>
    </div>
  );
}
