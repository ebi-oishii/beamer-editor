/**
 * 1 フレームの描画ステージ。renderer が escape 済みの html を .slide-scale へ流し込み、
 * 親(SlideScroll)が決めた倍率で transform: scale し、オーバーレイ(step に応じた covered
 * トグル)とキャンバス画像のドラッグを適用する。倍率の計算は持たない。
 */

import type { RenderedFrame } from "@beamer-editor/renderer";
import { useEffect, useRef, useState } from "react";
import { canvasPointFromPointer, normalizeCanvasCoordinate } from "./canvas-drag.js";
import { applyOverlay } from "./overlay.js";

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
}: {
  frame: RenderedFrame;
  step: number;
  scale: number;
  slideSize: SlideSize;
  version: number;
  onMoveCanvasElement: (elementId: string, x: number, y: number) => void;
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
      (candidate) => candidate.id === id && candidate.kind === "image" && candidate.editable,
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
    </div>
  );
}
