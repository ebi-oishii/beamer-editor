import { CANVAS_FONT_SIZES, type CanvasFontSize, isCanvasFontSize } from "@beamer-editor/core";
/**
 * 1 フレームの描画ステージ。renderer が escape 済みの html を .slide-scale へ流し込み、
 * 親(SlideScroll)が決めた倍率で transform: scale し、オーバーレイ(step に応じた covered
 * トグル)とキャンバス画像のドラッグを適用する。倍率の計算は持たない。
 */

import { clampCanvasPosition, clampCanvasWidth, roundCanvasCoordinate } from "@beamer-editor/core";
import type { RenderedFrame } from "@beamer-editor/renderer";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { canvasPointFromPointer } from "./canvas-drag.js";
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

interface DragState {
  element: HTMLElement;
  resize: boolean;
  startClientX: number;
  originalWidth: string;
  id: string;
  x: number;
  y: number;
  /** 本文領域内へ収めるとき右端の余地になる箱の幅。移動では変わらない。 */
  width: number;
  /** pointerdown 時点の実測高さ。drag 中の再描画・load では再測定せず、次 gesture で更新する。 */
  height: number;
  grabX: number;
  grabY: number;
  pointerId: number;
  /** contextmenu と buttons の扱いは mouse gesture にだけ適用する。 */
  pointerType: string;
}

/** ドラッグを取り消す共通処理: 箱を元の位置へ戻し、pointer capture を放す。 */
function cancelDrag(drag: DragState): void {
  drag.element.style.left = `${drag.x * 100}%`;
  drag.element.style.top = `${drag.y * 100}%`;
  drag.element.style.width = drag.originalWidth;
  const handle = drag.element
    .closest(".canvas")
    ?.querySelector<HTMLElement>(".canvas-resize-handle");
  if (handle) handle.style.left = `${(drag.x + drag.width) * 100}%`;
  drag.element.classList.remove("canvas-dragging");
  releasePointerCapture(drag.element, drag.pointerId);
}

export function Stage({
  frame,
  step,
  scale,
  slideSize,
  version,
  onSetCanvasFontSize,
  onResizeCanvasElement,
  onMoveCanvasElement,
  onDetachToCanvas,
}: {
  frame: RenderedFrame;
  step: number;
  scale: number;
  slideSize: SlideSize;
  version: number;
  onSetCanvasFontSize?: ((elementId: string, size: CanvasFontSize) => void) | undefined;
  onResizeCanvasElement?: ((elementId: string, width: number) => void) | undefined;
  onMoveCanvasElement: (elementId: string, x: number, y: number) => void;
  /** 未指定ならフロー要素の右クリックメニューを出さない(ホストが未対応)。 */
  onDetachToCanvas?: ((request: DetachRequest) => void) | undefined;
}): JSX.Element {
  const scaleRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState>();
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

  // A sibling control also works for <img>, which cannot contain a handle.
  useEffect(() => {
    const descriptor = frame.canvasElements?.find((item) => item.id === selected && item.editable);
    const element = scaleRef.current?.querySelector<HTMLElement>(
      `[data-canvas-element-id="${selected}"]`,
    );
    const canvas = element?.closest<HTMLElement>(".canvas");
    if (!descriptor || !canvas || !onResizeCanvasElement) return;
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "canvas-resize-handle";
    handle.dataset.resizeElementId = descriptor.id;
    handle.setAttribute(
      "aria-label",
      descriptor.kind === "image" ? "画像の幅を変更" : "テキストの幅を変更",
    );
    handle.addEventListener("dblclick", (event) => event.stopPropagation());
    handle.title = "ドラッグで幅を変更（左右キーでも変更）";
    handle.style.left = `${(descriptor.position.x + descriptor.position.width) * 100}%`;
    handle.style.top = `${descriptor.position.y * 100}%`;
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      const width = clampCanvasWidth(
        descriptor.position.x,
        descriptor.position.width + (event.key === "ArrowRight" ? 0.01 : -0.01),
      );
      if (width !== null && width !== descriptor.position.width)
        onResizeCanvasElement(descriptor.id, width);
    });
    canvas.append(handle);
    return () => handle.remove();
  }, [frame, selected, onResizeCanvasElement]);

  useEffect(() => {
    const descriptor = frame.canvasElements?.find(
      (item) => item.id === selected && item.editable && item.kind === "text",
    );
    const element = scaleRef.current?.querySelector<HTMLElement>(
      `[data-canvas-element-id="${selected}"]`,
    );
    const canvas = element?.closest<HTMLElement>(".canvas");
    if (!descriptor || !canvas || !onSetCanvasFontSize) return;
    const select = document.createElement("select");
    select.className = "canvas-font-size";
    select.setAttribute("aria-label", "テキストの文字サイズ");
    select.style.left = `${descriptor.position.x * 100}%`;
    select.style.top = `${descriptor.position.y * 100}%`;
    for (const size of CANVAS_FONT_SIZES) {
      const option = document.createElement("option");
      option.value = size;
      option.textContent = size;
      select.append(option);
    }
    select.value = descriptor.fontSize ?? "normal";
    for (const event of ["pointerdown", "click", "dblclick"])
      select.addEventListener(event, (event) => event.stopPropagation());
    select.addEventListener("keydown", (event) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", " "].includes(event.key))
        event.stopPropagation();
    });
    select.addEventListener("change", () => {
      if (isCanvasFontSize(select.value)) onSetCanvasFontSize(descriptor.id, select.value);
    });
    canvas.append(select);
    return () => select.remove();
  }, [frame, selected, onSetCanvasFontSize]);

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
      cancelDrag(drag);
      drag.element.classList.remove("canvas-selected");
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
      cancelDrag(drag);
      dragRef.current = undefined;
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, []);
  const onPointerDown = (event: PointerEvent) => {
    const clearSelection = () => {
      if (dragRef.current || !selected) return;
      scaleRef.current
        ?.querySelector(`[data-canvas-element-id="${selected}"]`)
        ?.classList.remove("canvas-selected");
      setSelected(null);
    };
    const handleId = (event.target as HTMLElement).closest<HTMLElement>("[data-resize-element-id]")
      ?.dataset.resizeElementId;
    const element = handleId
      ? scaleRef.current?.querySelector<HTMLElement>(`[data-canvas-element-id="${handleId}"]`)
      : (event.target as HTMLElement).closest<HTMLElement>("[data-canvas-element-id]");
    const id = element?.dataset.canvasElementId;
    const descriptor = frame.canvasElements?.find(
      (candidate) => candidate.id === id && candidate.editable,
    );
    const canvas = element?.closest<HTMLElement>(".canvas");
    const active = dragRef.current;
    if (active) {
      // Mouse の右・中ボタンは、この時点で取り消す。contextmenu が来ない操作でも drag と
      // pointer capture を残さない(#108)。touch/pen の追加接触は別 pointer として届くため無視する。
      if (active.pointerType === "mouse" && event.button !== 0) {
        cancelDrag(active);
        dragRef.current = undefined;
      }
      return;
    }
    if (event.button !== 0) {
      // 背景・編集不能要素の右/中クリックは従来どおり選択を外す。一方、編集可能な箱の右クリックは
      // context menu の対象を選び直さず、現在の選択を維持する。primary click と同じ「対象を選択」の
      // 副作用を持たせないことで、メニュー操作後にも選択枠が不意に変わらない。
      if (!descriptor || !canvas) clearSelection();
      return;
    }
    if (!element) {
      clearSelection();
      return;
    }
    if (!id || !descriptor || !canvas) {
      clearSelection();
      return;
    }
    if (handleId && !onResizeCanvasElement) return;
    if (selected) {
      scaleRef.current
        ?.querySelector(`[data-canvas-element-id="${selected}"]`)
        ?.classList.remove("canvas-selected");
    }
    const bounds = element.getBoundingClientRect();
    const canvasBounds = canvas.getBoundingClientRect();
    dragRef.current = {
      resize: Boolean(handleId),
      startClientX: event.clientX,
      originalWidth: element.style.width,
      element,
      id,
      x: descriptor.position.x,
      y: descriptor.position.y,
      width: descriptor.position.width,
      height:
        Number.isFinite(bounds.height) &&
        Number.isFinite(canvasBounds.height) &&
        canvasBounds.height > 0
          ? bounds.height / canvasBounds.height
          : 0,
      grabX: event.clientX - bounds.left,
      grabY: event.clientY - bounds.top,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
    };
    element.setPointerCapture(event.pointerId);
    element.classList.add("canvas-selected", "canvas-dragging");
    setSelected(id);
    event.preventDefault();
  };
  const resizeWidth = (drag: DragState, event: PointerEvent): number | null => {
    const canvas = drag.element.closest<HTMLElement>(".canvas");
    const bounds = canvas?.getBoundingClientRect();
    if (!bounds || !Number.isFinite(bounds.width) || bounds.width <= 0) return null;
    return clampCanvasWidth(
      drag.x,
      drag.width + (event.clientX - drag.startClientX) / bounds.width,
    );
  };
  const move = (event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // ボタンを押したまま別のボタンを押しても pointerdown は来ず、buttons が変わった pointermove が来る。
    // 主ボタン以外が加わった(右・中ボタン)か、主ボタンが離れているのに move が来た(pointerup が
    // コンテキストメニューに吸われた)ときは、contextmenu を待たずにここで取り消す(#108)。
    if (drag.pointerType === "mouse" && event.buttons !== 1) {
      cancelDrag(drag);
      dragRef.current = undefined;
      return;
    }
    if (drag.resize) {
      const width = resizeWidth(drag, event);
      if (width !== null) {
        drag.element.style.width = `${width * 100}%`;
        const handle = drag.element
          .closest(".canvas")
          ?.querySelector<HTMLElement>(".canvas-resize-handle");
        if (handle) handle.style.left = `${(drag.x + width) * 100}%`;
      }
      return;
    }
    const canvas = drag.element.closest<HTMLElement>(".canvas");
    const raw =
      canvas &&
      canvasPointFromPointer(
        canvas.getBoundingClientRect(),
        event.clientX,
        event.clientY,
        drag.grabX,
        drag.grabY,
      );
    if (!raw) return;
    const point = clampCanvasPosition(raw.x, raw.y, drag.width, drag.height);
    drag.element.style.left = `${point.x * 100}%`;
    drag.element.style.top = `${point.y * 100}%`;
  };
  const finish = (event: PointerEvent, commit: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.resize) {
      const width = resizeWidth(drag, event);
      cancelDrag(drag);
      dragRef.current = undefined;
      if (commit && width !== null && event.clientX !== drag.startClientX && width !== drag.width)
        onResizeCanvasElement?.(drag.id, width);
      return;
    }
    const canvas = drag.element.closest<HTMLElement>(".canvas");
    const raw =
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
    if (!commit || !raw) {
      drag.element.style.left = `${drag.x * 100}%`;
      drag.element.style.top = `${drag.y * 100}%`;
    } else {
      // 選択クリックでは既存の領域外配置まで黙って書き換えない。pointer 由来の
      // 座標が実際に動いた gesture だけを clamp して source へ commit する。
      if (
        roundCanvasCoordinate(raw.x) === roundCanvasCoordinate(drag.x) &&
        roundCanvasCoordinate(raw.y) === roundCanvasCoordinate(drag.y)
      ) {
        drag.element.style.left = `${drag.x * 100}%`;
        drag.element.style.top = `${drag.y * 100}%`;
      } else {
        const point = clampCanvasPosition(raw.x, raw.y, drag.width, drag.height);
        onMoveCanvasElement(drag.id, point.x, point.y);
      }
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
    // mouse の右クリックだけは pointerup がメニューに吸われ得るため取り消す。touch/pen の長押し
    // contextmenu は通常の gesture なので pointercancel / pointerup まで維持する。
    const cancelOnContextMenu = () => {
      const drag = dragRef.current;
      if (drag?.pointerType !== "mouse") return;
      cancelDrag(drag);
      dragRef.current = undefined;
    };
    scale.addEventListener("pointerdown", onPointerDown);
    scale.addEventListener("pointermove", move);
    scale.addEventListener("pointerup", pointerUp);
    scale.addEventListener("pointercancel", pointerCancel);
    scale.addEventListener("contextmenu", cancelOnContextMenu);
    return () => {
      scale.removeEventListener("pointerdown", onPointerDown);
      scale.removeEventListener("pointermove", move);
      scale.removeEventListener("pointerup", pointerUp);
      scale.removeEventListener("pointercancel", pointerCancel);
      scale.removeEventListener("contextmenu", cancelOnContextMenu);
    };
  }, [frame, selected, version, onMoveCanvasElement, onResizeCanvasElement]);

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
              disabled={candidate.blocked !== undefined}
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
