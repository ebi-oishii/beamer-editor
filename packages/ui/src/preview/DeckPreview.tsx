/**
 * プレビュー全体を束ねるトップレベルコンポーネント。
 * ShellHost から deck 更新を購読し、previewReducer でナビ状態を管理して
 * SlideScroll(全フレームの縦一列表示)と現在フレームの step 操作を合成する。
 * deck.css は <style> として注入する。
 */

import type { RenderedDeck } from "@beamer-editor/renderer";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ShellHost } from "../shell-host.js";
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
  const fitScaleRef = useRef(fitScale);
  fitScaleRef.current = fitScale;
  const previewRef = useRef<HTMLElement>(null);
  const pendingWheelDirection = useRef<1 | -1 | undefined>();
  const wheelAnimationFrame = useRef<number | undefined>();

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

  // 指定フレームを表示領域の上端へスクロールさせる要求(◀▶・矢印キー・復元)。
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

  // wheel は React の passive 設定に依存せず native listener で扱う。高精度ホイールの
  // 多数のイベントは一描画フレームにつき一段階へ畳み、通常スクロールは一切妨げない。
  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.deltaY === 0) return;
      event.preventDefault();
      pendingWheelDirection.current = event.deltaY > 0 ? -1 : 1;
      if (wheelAnimationFrame.current !== undefined) return;
      wheelAnimationFrame.current = requestAnimationFrame(() => {
        wheelAnimationFrame.current = undefined;
        const direction = pendingWheelDirection.current;
        pendingWheelDirection.current = undefined;
        if (direction) setZoom((current) => stepZoom(current, fitScaleRef.current, direction));
      });
    };
    preview.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      preview.removeEventListener("wheel", onWheel);
      if (wheelAnimationFrame.current !== undefined) {
        cancelAnimationFrame(wheelAnimationFrame.current);
        wheelAnimationFrame.current = undefined;
      }
    };
  }, []);

  /** フレーム移動(◀▶・矢印キー)。移動先を表示領域の上端へスクロールする。 */
  const move = (action: PreviewAction) => {
    const next = previewReducer(state, action, deck.frames.length);
    dispatch(action);
    if (next.current !== state.current) requestReveal(next.current);
  };
  const moveRef = useRef(move);
  moveRef.current = move;

  // Webview が開かれた直後にも動くよう、フォーカスを強制せず ownerDocument で扱う。
  // プレビュー内か document 自身に発生したキーだけを受け、他の UI の入力を奪わない。
  useEffect(() => {
    const preview = previewRef.current;
    const ownerDocument = preview?.ownerDocument;
    if (!preview || !ownerDocument) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (
        !(target instanceof Node) ||
        (!preview.contains(target) &&
          target !== ownerDocument.body &&
          target !== ownerDocument.documentElement)
      ) {
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          setZoom((current) => stepZoom(current, fitScaleRef.current, 1));
        } else if (event.key === "-") {
          event.preventDefault();
          setZoom((current) => stepZoom(current, fitScaleRef.current, -1));
        } else if (event.key === "0") {
          event.preventDefault();
          setZoom("fit");
        }
        return;
      }
      // range の未修飾左右キーは値変更へ委ね、フレーム移動に使わない。
      if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        target instanceof HTMLInputElement &&
        target.type === "range"
      ) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveRef.current({ type: "prev" });
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        moveRef.current({ type: "next" });
      }
    };
    ownerDocument.addEventListener("keydown", handleKeyDown);
    return () => ownerDocument.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <section className="beamer-preview" ref={previewRef} aria-label="Beamer スライドプレビュー">
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
      <div className="preview-status" aria-live="polite" aria-atomic="true">
        フレーム {deck.frames.length === 0 ? 0 : state.current + 1} / {deck.frames.length}
      </div>
      {frame && frame.stepCount > 1 ? (
        <div className="step-control">
          <label>
            step{" "}
            <input
              type="range"
              min={1}
              max={frame.stepCount}
              value={state.step}
              aria-label={`オーバーレイ step（${frame.stepCount} 段階）`}
              onChange={(event) => dispatch({ type: "setStep", step: Number(event.target.value) })}
            />
          </label>
          <span className="step-indicator">
            {state.step}/{frame.stepCount}
          </span>
        </div>
      ) : null}
    </section>
  );
}
