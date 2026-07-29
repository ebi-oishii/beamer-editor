/**
 * 前後移動ボタン・フレームインジケータ・オーバーレイ step スライダー。
 * step スライダーは stepCount<=1 のフレームでは隠す（apps/web の #step-box hidden 相当）。
 */

import type { RenderedFrame } from "@beamer-editor/renderer";

export function Controls({
  frame,
  total,
  step,
  onPrev,
  onNext,
  onStep,
}: {
  frame: RenderedFrame | undefined;
  total: number;
  step: number;
  onPrev: () => void;
  onNext: () => void;
  onStep: (step: number) => void;
}): JSX.Element {
  const stepCount = frame?.stepCount ?? 1;
  const indicator = frame
    ? `${frame.index} / ${total}${frame.label ? `（label=${frame.label}）` : ""}`
    : `0 / ${total}`;

  return (
    <div className="controls">
      <button type="button" aria-label="前のフレーム" onClick={onPrev}>
        ◀
      </button>
      <span className="frame-indicator" aria-live="polite">
        {indicator}
      </span>
      <button type="button" aria-label="次のフレーム" onClick={onNext}>
        ▶
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
