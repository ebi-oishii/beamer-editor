/**
 * 現在フレームの描画ステージ。renderer が escape 済みの html を .slide-scale へ流し込み、
 * fit-scale（スライド論理サイズを holder に合わせて transform: scale）と
 * オーバーレイ（step に応じた covered トグル）を適用する。
 */

import type { RenderedFrame } from "@beamer-editor/renderer";
import { useEffect, useRef } from "react";
import { applyOverlay } from "./overlay.js";

/** スライド論理サイズが取れないときの近似フォールバック（apps/web の fitSlide 相当）。 */
const FALLBACK_W = 607;
const FALLBACK_H = 341;

/**
 * ResizeObserver で holder のサイズ変化を監視し、.slide を holder に収まるよう縮小する。
 * transform はレイアウト寸法を変えないため、見た目サイズも明示して中央寄せとはみ出しを正す。
 */
function useFitScale(
  holderRef: React.RefObject<HTMLElement | null>,
  scaleRef: React.RefObject<HTMLElement | null>,
  frame: RenderedFrame | undefined,
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: frame の html 差し替え時に再フィットしたい
  useEffect(() => {
    const holder = holderRef.current;
    const scaleBox = scaleRef.current;
    if (!holder || !scaleBox) return;

    const applyFit = () => {
      const slide = scaleBox.querySelector<HTMLElement>(".slide");
      const slideW = slide?.offsetWidth || FALLBACK_W;
      const slideH = slide?.offsetHeight || FALLBACK_H;
      const availW = holder.clientWidth - 24;
      const availH = holder.clientHeight - 24;
      const scale = Math.min(availW / slideW, availH / slideH, 1.6);
      scaleBox.style.transform = `scale(${scale})`;
      scaleBox.style.width = `${slideW * scale}px`;
      scaleBox.style.height = `${slideH * scale}px`;
    };

    applyFit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(applyFit);
    observer.observe(holder);
    return () => observer.disconnect();
  }, [holderRef, scaleRef, frame]);
}

export function Stage({
  frame,
  step,
}: {
  frame: RenderedFrame | undefined;
  step: number;
}): JSX.Element {
  const holderRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef<HTMLDivElement>(null);

  useFitScale(holderRef, scaleRef, frame);

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
      <div
        className="slide-scale"
        ref={scaleRef}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: renderer が escape 済みの信頼 HTML
        dangerouslySetInnerHTML={{ __html: frame.html }}
      />
    </div>
  );
}
