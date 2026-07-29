/**
 * プレビュー状態の純粋 reducer。current フレームとオーバーレイ step を管理する。
 * DOM や React に依存せず単体テスト可能にする（apps/web の showFrame 相当のナビ規則）。
 */

export interface PreviewState {
  /** 現在フレーム（0 起点）。 */
  current: number;
  /** オーバーレイの現在ステップ（1 起点）。 */
  step: number;
}

export type PreviewAction =
  | { type: "deckLoaded"; frameCount: number; keepPosition: boolean }
  | { type: "goto"; index: number }
  | { type: "prev" }
  | { type: "next" }
  | { type: "setStep"; step: number };

function clamp(index: number, frameCount: number): number {
  if (frameCount <= 0) return 0;
  return Math.max(0, Math.min(index, frameCount - 1));
}

/**
 * 規則:
 * - current は [0, frameCount-1] にクランプする。
 * - フレームが変わる遷移（goto/prev/next で current 変化、deckLoaded で keepPosition=false）は
 *   step を 1 にリセットする。
 * - deckLoaded keepPosition=true は current を維持する（範囲外はクランプ）。step は保つ。
 * - setStep は step のみ更新する（1 以上）。
 */
export function previewReducer(
  state: PreviewState,
  action: PreviewAction,
  frameCount: number,
): PreviewState {
  switch (action.type) {
    case "deckLoaded": {
      if (!action.keepPosition) {
        return { current: 0, step: 1 };
      }
      // deck が空(未着)の間は位置を保持する(getState からの復元直後を 0 で潰さない)。
      if (action.frameCount <= 0) {
        return state;
      }
      const current = clamp(state.current, action.frameCount);
      return current === state.current ? state : { ...state, current };
    }
    case "goto": {
      const current = clamp(action.index, frameCount);
      return current === state.current ? state : { current, step: 1 };
    }
    case "prev": {
      const current = clamp(state.current - 1, frameCount);
      return current === state.current ? state : { current, step: 1 };
    }
    case "next": {
      const current = clamp(state.current + 1, frameCount);
      return current === state.current ? state : { current, step: 1 };
    }
    case "setStep": {
      const step = Math.max(1, action.step);
      return step === state.step ? state : { ...state, step };
    }
  }
}
