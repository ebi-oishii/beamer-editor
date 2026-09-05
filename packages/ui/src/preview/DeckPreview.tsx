/**
 * プレビュー全体を束ねるトップレベルコンポーネント。
 * ShellHost から deck 更新を購読し、previewReducer でナビ状態を管理して
 * SlideScroll(全フレームの縦一列表示)/ Controls を合成する。deck.css は <style> として注入する。
 */

import type { RenderedDeck } from "@beamer-editor/renderer";
import { type KeyboardEvent, useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ShellHost } from "../shell-host.js";
import { Controls } from "./Controls.js";
import { type RevealRequest, SlideScroll } from "./SlideScroll.js";
import { type PreviewAction, type PreviewState, previewReducer } from "./state.js";
import { stepZoom, type ZoomState } from "./zoom.js";

const EMPTY_DECK: RenderedDeck = { title: "", frames: [], css: "" };
const INITIAL_STATE: PreviewState = { current: 0, step: 1 };

export function DeckPreview({ host }: { host: ShellHost }): JSX.Element {
  const [deck, setDeck] = useState<RenderedDeck>(EMPTY_DECK);
  // 表示中 deck の document version。jumpToSource に添えて古い版からのジャンプを検出させる。
  const [version, setVersion] = useState(Number.NEGATIVE_INFINITY);
  const [restoredNav] = useState(() => host.loadNavState?.());
  const [zoom, setZoom] = useState<ZoomState>(() => restoredNav?.zoom ?? "fit");
  const [fitScale, setFitScale] = useState(1);

  // frameCount を reducer へ渡すため ref に写す（reducer の同一性を保つ）。
  const frameCountRef = useRef(0);
  frameCountRef.current = deck.frames.length;
  const [state, dispatch] = useReducer(
    (s: PreviewState, a: PreviewAction) => previewReducer(s, a, frameCountRef.current),
    INITIAL_STATE,
    // パネル再表示時は前回のナビ状態から復元する(範囲外は deckLoaded がクランプ)。
    (initial) => restoredNav ?? initial,
  );
  const currentRef = useRef(state.current);
  currentRef.current = state.current;

  // 指定フレームを表示領域の上端へスクロールさせる要求(◀▶・矢印キー・復元・ズーム変更)。
  // クリックやスクロール追従による選択では出さない(見ている場所を動かさない)。
  const [reveal, setReveal] = useState<RevealRequest | undefined>();
  const revealToken = useRef(0);
  const requestReveal = useCallback((index: number) => {
    revealToken.current += 1;
    setReveal({ index, token: revealToken.current });
  }, []);

  // ナビ状態を保存する(VS-7: current / step / zoom のみ。ソース本文や AST は保存しない)。
  useEffect(() => {
    host.saveNavState?.({ current: state.current, step: state.step, zoom });
  }, [host, state.current, state.step, zoom]);

  // ホストからの deck 更新を購読する。version は同期的に読めるよう ref にも写す。
  const versionRef = useRef(Number.NEGATIVE_INFINITY);
  useEffect(
    () =>
      host.subscribe((next, nextVersion) => {
        versionRef.current = nextVersion;
        setDeck(next);
        setVersion(nextVersion);
      }),
    [host],
  );

  // ソース側(CodeLens・コマンド・カーソル追従)からの表示要求。表示中の版と違えば無視する
  // (古い版のフレーム番号で別のフレームへ動かない)。
  useEffect(
    () =>
      host.onRevealFrame?.((frameIndex, requestVersion) => {
        if (requestVersion !== versionRef.current) return;
        dispatch({ type: "goto", index: frameIndex });
        requestReveal(frameIndex);
      }),
    [host, requestReveal],
  );

  // deck が変わったら位置を保ったまま読み込み直す（編集中は現在フレームを維持）。
  // 初回(復元を含む)だけは現在フレームまでスクロールし、表示と現在フレームを揃える。
  const revealedInitial = useRef(false);
  useEffect(() => {
    dispatch({ type: "deckLoaded", frameCount: deck.frames.length, keepPosition: true });
    if (!revealedInitial.current && deck.frames.length > 0) {
      revealedInitial.current = true;
      requestReveal(Math.min(currentRef.current, deck.frames.length - 1));
    }
  }, [deck, requestReveal]);

  // ズームを変えても読んでいたフレームが上端に残るようにする(初回マウント時は対象なし)。
  const lastZoom = useRef(zoom);
  useEffect(() => {
    if (lastZoom.current === zoom) return;
    lastZoom.current = zoom;
    requestReveal(currentRef.current);
  }, [zoom, requestReveal]);

  // deck.css（%% style 由来の CSS 変数）を <style> として注入・更新する。
  const styleRef = useRef<HTMLStyleElement | null>(null);
  useEffect(() => {
    if (!styleRef.current) {
      styleRef.current = document.createElement("style");
      document.head.append(styleRef.current);
    }
    styleRef.current.textContent = deck.css;
  }, [deck.css]);
  useEffect(
    () => () => {
      styleRef.current?.remove();
      styleRef.current = null;
    },
    [],
  );

  // アクティブフレームの変化をホストへ通知する。
  useEffect(() => {
    host.notifyActiveFrame(state.current);
  }, [host, state.current]);

  const frame = deck.frames[state.current];
  const handleFitScaleChange = useCallback((next: number) => {
    setFitScale((current) => (current === next ? current : next));
  }, []);

  // step を現在フレームの stepCount 内へ収める。復元 state が上限を超えていた場合の
  // ほか、文書編集で表示中フレームの stepCount が減った場合もここでクランプされる。
  useEffect(() => {
    if (frame && state.step > frame.stepCount) {
      dispatch({ type: "setStep", step: frame.stepCount });
    }
  }, [frame, state.step]);

  /** フレーム移動(◀▶・矢印キー)。移動先を表示領域の上端へスクロールする。 */
  const move = (action: PreviewAction) => {
    const next = previewReducer(state, action, deck.frames.length);
    dispatch(action);
    if (next.current !== state.current) requestReveal(next.current);
  };

  // フレーム移動のキーボード操作(スライダー等の入力要素の矢印キーは奪わない)。
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      move({ type: "prev" });
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      move({ type: "next" });
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: 矢印キーのフレーム移動を束ねるコンテナ。
    <div
      className="beamer-preview"
      role="group"
      aria-label="Beamer スライドプレビュー"
      onKeyDown={handleKeyDown}
    >
      <SlideScroll
        frames={deck.frames}
        current={state.current}
        step={state.step}
        zoom={zoom}
        version={version}
        reveal={reveal}
        onSelect={(i) => dispatch({ type: "goto", index: i })}
        onJump={(i) => host.jumpToSource(i, version)}
        onScrollActive={(i) => dispatch({ type: "goto", index: i })}
        onMoveCanvasElement={(frameIndex, elementId, x, y) =>
          host.moveCanvasElement?.(frameIndex, elementId, version, x, y)
        }
        onDetachToCanvas={
          host.detachToCanvas
            ? (frameIndex, request) => {
                host.detachToCanvas?.(frameIndex, version, request.sourceSpan, request.rect);
              }
            : undefined
        }
        onFitScaleChange={handleFitScaleChange}
      />
      <Controls
        frame={frame}
        total={deck.frames.length}
        step={state.step}
        onPrev={() => move({ type: "prev" })}
        onNext={() => move({ type: "next" })}
        onStep={(s) => dispatch({ type: "setStep", step: s })}
        onJump={() => host.jumpToSource(state.current, version)}
        zoom={zoom}
        fitScale={fitScale}
        onZoomOut={() => setZoom((current) => stepZoom(current, fitScale, -1))}
        onZoomIn={() => setZoom((current) => stepZoom(current, fitScale, 1))}
        onZoomFit={() => setZoom("fit")}
        onZoomActual={() => setZoom(1)}
      />
    </div>
  );
}
