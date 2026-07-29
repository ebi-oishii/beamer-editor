/**
 * プレビュー全体を束ねるトップレベルコンポーネント。
 * ShellHost から deck 更新を購読し、previewReducer でナビ状態を管理して
 * SlideList / Stage / Controls を合成する。deck.css は <style> として注入する。
 */

import type { RenderedDeck } from "@beamer-editor/renderer";
import { type KeyboardEvent, useEffect, useReducer, useRef, useState } from "react";
import type { ShellHost } from "../shell-host.js";
import { Controls } from "./Controls.js";
import { SlideList } from "./SlideList.js";
import { Stage } from "./Stage.js";
import { type PreviewAction, type PreviewState, previewReducer } from "./state.js";

const EMPTY_DECK: RenderedDeck = { title: "", frames: [], css: "" };
const INITIAL_STATE: PreviewState = { current: 0, step: 1 };

export function DeckPreview({ host }: { host: ShellHost }): JSX.Element {
  const [deck, setDeck] = useState<RenderedDeck>(EMPTY_DECK);
  // 表示中 deck の document version。jumpToSource に添えて古い版からのジャンプを検出させる。
  const [version, setVersion] = useState(Number.NEGATIVE_INFINITY);

  // frameCount を reducer へ渡すため ref に写す（reducer の同一性を保つ）。
  const frameCountRef = useRef(0);
  frameCountRef.current = deck.frames.length;
  const [state, dispatch] = useReducer(
    (s: PreviewState, a: PreviewAction) => previewReducer(s, a, frameCountRef.current),
    INITIAL_STATE,
    // パネル再表示時は前回のナビ状態から復元する(範囲外は deckLoaded がクランプ)。
    (initial) => host.loadNavState?.() ?? initial,
  );

  // ナビ状態を保存する(VS-7: current / step のみ。ソース本文や AST は保存しない)。
  useEffect(() => {
    host.saveNavState?.({ current: state.current, step: state.step });
  }, [host, state.current, state.step]);

  // ホストからの deck 更新を購読する。
  useEffect(
    () =>
      host.subscribe((next, nextVersion) => {
        setDeck(next);
        setVersion(nextVersion);
      }),
    [host],
  );

  // deck が変わったら位置を保ったまま読み込み直す（編集中は現在フレームを維持）。
  useEffect(() => {
    dispatch({ type: "deckLoaded", frameCount: deck.frames.length, keepPosition: true });
  }, [deck]);

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

  // フレーム移動のキーボード操作(スライダー等の入力要素の矢印キーは奪わない)。
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      dispatch({ type: "prev" });
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      dispatch({ type: "next" });
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
      <SlideList
        frames={deck.frames}
        current={state.current}
        onSelect={(i) => dispatch({ type: "goto", index: i })}
        onJump={(i) => host.jumpToSource(i, version)}
      />
      <section className="stage">
        <Stage frame={frame} step={state.step} />
        <Controls
          frame={frame}
          total={deck.frames.length}
          step={state.step}
          onPrev={() => dispatch({ type: "prev" })}
          onNext={() => dispatch({ type: "next" })}
          onStep={(s) => dispatch({ type: "setStep", step: s })}
        />
      </section>
    </div>
  );
}
