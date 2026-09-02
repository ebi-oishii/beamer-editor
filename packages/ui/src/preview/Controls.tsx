/**
 * 前後移動ボタン・フレームインジケータ・オーバーレイ step スライダー。
 * step スライダーは stepCount<=1 のフレームでは隠す（apps/web の #step-box hidden 相当）。
 */

import type { RenderedFrame } from "@beamer-editor/renderer";
import { formatZoom, type ZoomState } from "./zoom.js";

export function Controls({
  frame,
  total,
  step,
  onPrev,
  onNext,
  onStep,
  onJump,
  zoom,
  fitScale,
  onZoomOut,
  onZoomIn,
  onZoomFit,
  onZoomActual,
}: {
  frame: RenderedFrame | undefined;
  total: number;
  step: number;
  onPrev: () => void;
  onNext: () => void;
  onStep: (step: number) => void;
  onJump: () => void;
  zoom: ZoomState;
  fitScale: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onZoomFit: () => void;
  onZoomActual: () => void;
}): JSX.Element {
  const stepCount = frame?.stepCount ?? 1;
  // label はスライドのキャプションに出す。ここは n / N だけにし、幅を総数の桁で固定して
  // フレームが変わっても右側のボタンが動かないようにする。
  const indicator = `${frame?.index ?? 0} / ${total}`;
  const indicatorWidth = `${String(total).length * 2 + 3}ch`;

  return (
    <div className="controls">
      <button type="button" aria-label="前のフレーム" onClick={onPrev}>
        ◀
      </button>
      <span className="frame-indicator" aria-live="polite" style={{ minWidth: indicatorWidth }}>
        {indicator}
      </span>
      <button type="button" aria-label="次のフレーム" onClick={onNext}>
        ▶
      </button>
      <span className="zoom-box">
        <button type="button" aria-label="縮小" disabled={!frame} onClick={onZoomOut}>
          −
        </button>
        <span className="zoom-indicator" aria-live="polite">
          {formatZoom(zoom, fitScale)}
        </span>
        <button type="button" aria-label="拡大" disabled={!frame} onClick={onZoomIn}>
          ＋
        </button>
        <button type="button" aria-label="画面に合わせる" disabled={!frame} onClick={onZoomFit}>
          フィット
        </button>
        <button type="button" aria-label="100%表示" disabled={!frame} onClick={onZoomActual}>
          100%
        </button>
      </span>
      {/* キーボードだけでもソースジャンプできる明示ボタン(サムネイルのダブルクリックと等価) */}
      <button
        type="button"
        aria-label="このフレームのソース位置へ移動"
        disabled={!frame}
        onClick={onJump}
      >
        ソースへ
      </button>
      {stepCount > 1 ? (
        <span className="step-box">
          <label>
            step{" "}
            <input
              type="range"
              min={1}
              max={stepCount}
              value={step}
              aria-label={`オーバーレイ step（${stepCount} 段階）`}
              onChange={(e) => onStep(Number(e.target.value))}
            />
          </label>
          <span className="step-indicator">
            {step}/{stepCount}
          </span>
        </span>
      ) : null}
    </div>
  );
}
