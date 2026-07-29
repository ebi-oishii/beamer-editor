/**
 * プレビュー全体を束ねるトップレベルコンポーネント。
 * ShellHost から deck 更新を購読し、previewReducer でナビ状態を管理して
 * SlideList / Stage / Controls を合成する。deck.css は <style> として注入する。
 */

import type { RenderedDeck } from "@beamer-editor/renderer";
import { useEffect, useReducer, useRef, useState } from "react";
import type { ShellHost } from "../shell-host.js";
import { Controls } from "./Controls.js";
import { SlideList } from "./SlideList.js";
import { Stage } from "./Stage.js";
import { type PreviewAction, type PreviewState, previewReducer } from "./state.js";

const EMPTY_DECK: RenderedDeck = { title: "", frames: [], css: "" };
const INITIAL_STATE: PreviewState = { current: 0, step: 1 };

export function DeckPreview({ host }: { host: ShellHost }): JSX.Element {
  const [deck, setDeck] = useState<RenderedDeck>(EMPTY_DECK);

  // frameCount を reducer へ渡すため ref に写す（reducer の同一性を保つ）。
  const frameCountRef = useRef(0);
  frameCountRef.current = deck.frames.length;
  const [state, dispatch] = useReducer(
    (s: PreviewState, a: PreviewAction) => previewReducer(s, a, frameCountRef.current),
    INITIAL_STATE,
  );

  // ホストからの deck 更新を購読する。
  useEffect(() => host.subscribe((next) => setDeck(next)), [host]);

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

  return (
    <div className="beamer-preview">
      <SlideList
        frames={deck.frames}
        current={state.current}
        onSelect={(i) => dispatch({ type: "goto", index: i })}
        onJump={(i) => host.jumpToSource(i)}
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
