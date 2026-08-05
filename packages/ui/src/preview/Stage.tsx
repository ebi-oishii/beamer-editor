/**
 * 現在フレームの描画ステージ。renderer が escape 済みの html を .slide-scale へ流し込み、
 * fit-scale（スライド論理サイズを holder に合わせて transform: scale）と
 * オーバーレイ（step に応じた covered トグル）を適用する。
 */

import type { RenderedFrame } from "@beamer-editor/renderer";
import { useEffect, useRef } from "react";
import { applyOverlay } from "./overlay.js";
import type { ZoomState } from "./zoom.js";

/** スライド論理サイズが取れないときの近似フォールバック（apps/web の fitSlide 相当）。 */
const FALLBACK_W = 607;
const FALLBACK_H = 341;
const MIN_FIT_SCALE = 0.1;

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
  onFitScaleChange,
}: {
  frame: RenderedFrame | undefined;
  step: number;
  zoom: ZoomState;
  onFitScaleChange: (scale: number) => void;
}): JSX.Element {
  const holderRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef<HTMLDivElement>(null);

  useFitScale(holderRef, layoutRef, scaleRef, frame, zoom, onFitScaleChange);

  // frame（html）または step が変わるたびに covered を再適用する。
  // biome-ignore lint/correctness/useExhaustiveDependencies: frame の html 差し替え時に再適用したい
  useEffect(() => {
    if (scaleRef.current) applyOverlay(scaleRef.current, step);
  }, [frame, step]);

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
