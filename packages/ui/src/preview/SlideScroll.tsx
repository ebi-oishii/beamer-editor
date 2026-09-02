/**
 * 全フレームを縦一列に並べるスクロール表示(Marp のプレビューと同じ読み方)。
 * 旧サムネイル一覧の役割(俯瞰・クリックで選択・ダブルクリックでソースへ)をここが担い、
 * 現在フレームだけが step スライダーに従う。他のフレームは全ステップ表示。
 */

import type { RenderedFrame } from "@beamer-editor/renderer";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type SlideSize, Stage } from "./Stage.js";
import { fitWidthScale, frameAtScrollTop, trailingSpace } from "./scroll-layout.js";
import type { ZoomState } from "./zoom.js";

/** スライド論理サイズが取れないときの近似(455.24pt × 256.07pt)。 */
const FALLBACK_SLIDE: SlideSize = { width: 607, height: 341 };
/** .slide-scroll の padding(styles.ts の値と揃える)。 */
const SCROLL_PADDING = 12;
/** 現在フレーム以外は全ステップ表示(旧サムネイルと同じ step=99 相当)。 */
const ALL_STEPS = 99;

/** aria-label に載せる修飾キー名(mac は Cmd、それ以外は Ctrl。判定不能時は Ctrl)。 */
const MODIFIER_LABEL =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform) ? "Cmd" : "Ctrl";

/** 指定フレームを表示領域の上端へスクロールする要求。token が変わるたびに実行する。 */
export interface RevealRequest {
  index: number;
  token: number;
}

function SlideCard({
  frame,
  index,
  active,
  step,
  scale,
  slideSize,
  version,
  onSelect,
  onJump,
  onMoveCanvasElement,
}: {
  frame: RenderedFrame;
  index: number;
  active: boolean;
  step: number;
  scale: number;
  slideSize: SlideSize;
  version: number;
  onSelect: (index: number) => void;
  onJump: (index: number) => void;
  onMoveCanvasElement: (frameIndex: number, elementId: string, x: number, y: number) => void;
}): JSX.Element {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    // Ctrl/Cmd+Enter はダブルクリックと等価のソースジャンプ(コントロールの「ソースへ」でも可)。
    if (event.ctrlKey || event.metaKey) onJump(index);
    else onSelect(index);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: スライド html（内部に <a> 等）を含むため button 不可
    <div
      className={active ? "slide-card active" : "slide-card"}
      data-index={index}
      role="button"
      tabIndex={0}
      aria-label={`フレーム ${frame.index}: ${frame.titleText}（Enter で選択、${MODIFIER_LABEL}+Enter でソースへ移動）`}
      onClick={() => onSelect(index)}
      onDoubleClick={() => onJump(index)}
      onKeyDown={handleKeyDown}
    >
      <Stage
        frame={frame}
        step={step}
        scale={scale}
        slideSize={slideSize}
        version={version}
        onMoveCanvasElement={(elementId, x, y) => onMoveCanvasElement(index, elementId, x, y)}
      />
      <div className="slide-caption">
        {frame.index}. {frame.titleText}
        {frame.isRaw ? " ⚠" : ""}
      </div>
    </div>
  );
}

export function SlideScroll({
  frames,
  current,
  step,
  zoom,
  version,
  reveal,
  onSelect,
  onJump,
  onScrollActive,
  onMoveCanvasElement,
  onFitScaleChange,
}: {
  frames: RenderedFrame[];
  current: number;
  step: number;
  zoom: ZoomState;
  version: number;
  reveal: RevealRequest | undefined;
  onSelect: (index: number) => void;
  onJump: (index: number) => void;
  /** スクロールで表示領域の上端に来たフレームが変わった通知。 */
  onScrollActive: (index: number) => void;
  onMoveCanvasElement: (frameIndex: number, elementId: string, x: number, y: number) => void;
  onFitScaleChange: (scale: number) => void;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [slideSize, setSlideSize] = useState<SlideSize>(FALLBACK_SLIDE);

  // 表示領域のサイズ。初回は描画前に同期計測して、極小倍率で一瞬描かれるのを避ける。
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const next = { width: container.clientWidth, height: container.clientHeight };
      setViewport((cur) => (cur.width === next.width && cur.height === next.height ? cur : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // スライド論理サイズ(offsetWidth は transform の影響を受けない)。全フレーム同一なので先頭で測る。
  // biome-ignore lint/correctness/useExhaustiveDependencies: frames の html 差し替え時に再計測したい
  useLayoutEffect(() => {
    const slide = containerRef.current?.querySelector<HTMLElement>(".slide");
    const width = slide?.offsetWidth || FALLBACK_SLIDE.width;
    const height = slide?.offsetHeight || FALLBACK_SLIDE.height;
    setSlideSize((cur) => (cur.width === width && cur.height === height ? cur : { width, height }));
  }, [frames]);

  const fitScale = fitWidthScale(viewport.width, slideSize.width, SCROLL_PADDING * 2);
  const scale = zoom === "fit" ? fitScale : zoom;
  useEffect(() => {
    onFitScaleChange(fitScale);
  }, [fitScale, onFitScaleChange]);

  // 要求されたフレームを上端へ揃える。倍率反映(子の inline style)は同じ commit で済んでいる。
  useEffect(() => {
    if (!reveal) return;
    const container = containerRef.current;
    const card = container?.querySelectorAll<HTMLElement>(".slide-card")[reveal.index];
    if (!container || !card) return;
    container.scrollTop = card.offsetTop - SCROLL_PADDING;
  }, [reveal]);

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    const cards = [...container.querySelectorAll<HTMLElement>(".slide-card")].map((card) => ({
      top: card.offsetTop,
      height: card.offsetHeight,
    }));
    const index = frameAtScrollTop(container.scrollTop, cards);
    if (index !== current) onScrollActive(index);
  };

  const paddingBottom =
    SCROLL_PADDING + trailingSpace(viewport.height, slideSize.height * scale, SCROLL_PADDING);

  return (
    <div
      className="slide-scroll"
      ref={containerRef}
      onScroll={handleScroll}
      style={{ paddingBottom }}
    >
      {frames.length === 0 ? <div className="empty">フレームがありません</div> : null}
      {frames.map((frame, i) => (
        <SlideCard
          key={frame.index}
          frame={frame}
          index={i}
          active={i === current}
          step={i === current ? step : ALL_STEPS}
          scale={scale}
          slideSize={slideSize}
          version={version}
          onSelect={onSelect}
          onJump={onJump}
          onMoveCanvasElement={onMoveCanvasElement}
        />
      ))}
    </div>
  );
}
