/**
 * 全フレームを縦一列に並べるスクロール表示(Marp のプレビューと同じ読み方)。
 * 旧サムネイル一覧の役割(俯瞰・クリックで選択・ダブルクリックでソースへ)をここが担い、
 * 現在フレームだけが step スライダーに従う。他のフレームは全ステップ表示。
 */

import type { RenderedFrame } from "@beamer-editor/renderer";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type DetachRequest, type SlideSize, Stage } from "./Stage.js";
import { fitWidthScale, frameAtScrollTop, trailingSpace } from "./scroll-layout.js";
import type { ZoomState } from "./zoom.js";

/** スライド論理サイズが取れないときの近似(455.24pt × 256.07pt)。 */
const FALLBACK_SLIDE: SlideSize = { width: 607, height: 341 };
/** .slide-scroll の padding(styles.ts の値と揃える)。 */
const SCROLL_PADDING = 12;
/** .slide-card の padding(styles.ts の値と揃える)。幅合わせで横スクロールを出さないために差し引く。 */
const CARD_PADDING = 4;
/** 現在フレーム以外は全ステップ表示(旧サムネイルと同じ step=99 相当)。 */
const ALL_STEPS = 99;

/** aria-label に載せる修飾キー名(mac は Cmd、それ以外は Ctrl。判定不能時は Ctrl)。 */
const MODIFIER_LABEL =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform) ? "Cmd" : "Ctrl";

/** computed style の有限な正の px 値。取れないときは undefined。 */
function computedPixelSize(slide: HTMLElement, property: "width" | "height"): number | undefined {
  const value = slide.ownerDocument.defaultView?.getComputedStyle(slide)[property];
  if (!value?.endsWith("px")) return undefined;
  const size = Number.parseFloat(value);
  return Number.isFinite(size) && size > 0 ? size : undefined;
}

/**
 * スライドの論理サイズ。pt 指定の端数を保つため computed style を優先し、取れなければ
 * 整数の offset、それも無ければ近似値へ落とす(#58 と同じ優先順)。
 */
function measureSlideSize(slide: HTMLElement | null): SlideSize {
  if (!slide) return FALLBACK_SLIDE;
  return {
    width: computedPixelSize(slide, "width") ?? (slide.offsetWidth || FALLBACK_SLIDE.width),
    height: computedPixelSize(slide, "height") ?? (slide.offsetHeight || FALLBACK_SLIDE.height),
  };
}

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
  onDetachToCanvas,
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
  onDetachToCanvas: ((frameIndex: number, request: DetachRequest) => void) | undefined;
}): JSX.Element {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    // Ctrl/Cmd+Enter はダブルクリックと等価のソースジャンプ。
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
      aria-current={active ? true : undefined}
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
        onDetachToCanvas={
          onDetachToCanvas ? (request) => onDetachToCanvas(index, request) : undefined
        }
      />
      <div className="slide-caption">
        {frame.index}. {frame.titleText}
        {frame.label ? `（label=${frame.label}）` : ""}
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
  onDetachToCanvas,
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
  /** 未指定ならフロー要素の右クリックメニューを出さない(ホストが未対応)。 */
  onDetachToCanvas?: ((frameIndex: number, request: DetachRequest) => void) | undefined;
  onFitScaleChange: (scale: number) => void;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [slideSize, setSlideSize] = useState<SlideSize>(FALLBACK_SLIDE);
  const hasViewportMeasurement = useRef(false);
  const currentRef = useRef(current);
  currentRef.current = current;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // fit の resize 前に、読んでいるカード内での位置を記録する。親で reveal を
  // 発行すると常にカード先頭へ戻ってしまうため、このコンポーネントで復元する。
  const resizeAnchor = useRef<{ frameIndex: number; ratio: number }>();
  const lastResizeAnchor = useRef<{ frameIndex: number; ratio: number }>();
  const restoredScrollTop = useRef<number | undefined>();
  const restoringScroll = useRef(false);

  // 表示領域のサイズ。初回は描画前に同期計測して、極小倍率で一瞬描かれるのを避ける。
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const next = { width: container.clientWidth, height: container.clientHeight };
      const wasMeasured = hasViewportMeasurement.current;
      hasViewportMeasurement.current = true;
      setViewport((cur) => {
        if (cur.width === next.width && cur.height === next.height) return cur;
        // 初回計測・手動倍率では位置を保存しない。初回は既存の reveal、手動倍率は
        // resize しても表示倍率が変わらないため、どちらも復元の対象外である。
        if (wasMeasured && cur.width > 0 && cur.height > 0 && zoomRef.current === "fit") {
          const index = currentRef.current;
          const card = container.querySelectorAll<HTMLElement>(".slide-card")[index];
          const height = card?.offsetHeight ?? 0;
          if (card && height > 0) {
            const top = card.offsetTop - SCROLL_PADDING;
            const anchor = {
              frameIndex: index,
              ratio: (container.scrollTop - top) / height,
            };
            resizeAnchor.current = anchor;
            lastResizeAnchor.current = anchor;
          } else if (lastResizeAnchor.current) {
            // collapse 中は壊れた比率で上書きせず、直前の有効アンカーを復元待ちにする。
            resizeAnchor.current = lastResizeAnchor.current;
          }
        }
        return next;
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // スライド論理サイズ(レイアウト寸法は transform の影響を受けない)。全フレーム同一なので先頭で測る。
  // biome-ignore lint/correctness/useExhaustiveDependencies: frames の html 差し替え時に再計測したい
  useLayoutEffect(() => {
    const next = measureSlideSize(
      containerRef.current?.querySelector<HTMLElement>(".slide") ?? null,
    );
    setSlideSize((cur) => (cur.width === next.width && cur.height === next.height ? cur : next));
  }, [frames]);

  const fitScale = fitWidthScale(
    viewport.width,
    slideSize.width,
    (SCROLL_PADDING + CARD_PADDING) * 2,
  );
  const scale = zoom === "fit" ? fitScale : zoom;
  useEffect(() => {
    onFitScaleChange(fitScale);
  }, [fitScale, onFitScaleChange]);

  // ResizeObserver で記録したアンカーを、倍率反映後のカード寸法で復元する。
  // レイアウト effect なので、復元値で発生する scroll は current を変更しない。
  useLayoutEffect(() => {
    const anchor = resizeAnchor.current;
    if (!anchor) return;
    const container = containerRef.current;
    if (!container || viewport.width <= 0 || viewport.height <= 0) return;
    const cards = container.querySelectorAll<HTMLElement>(".slide-card");
    if (anchor.frameIndex < 0 || anchor.frameIndex >= cards.length) {
      resizeAnchor.current = undefined;
      return;
    }
    const card = cards[anchor.frameIndex];
    if (!card || card.offsetHeight <= 0) return;
    const scrollTop = card.offsetTop - SCROLL_PADDING + anchor.ratio * card.offsetHeight;
    resizeAnchor.current = undefined;
    // setter が同期で scroll event を出す実装でも抑制し、代入後はブラウザが clamp した
    // 実値を記録する。次の実スクロールで値が違えば stale sentinel を必ず捨てる。
    restoringScroll.current = true;
    container.scrollTop = scrollTop;
    restoringScroll.current = false;
    restoredScrollTop.current = container.scrollTop;
  });

  // 要求されたフレームを上端へ揃える。倍率反映(子の inline style)は同じ commit で済んでいる。
  useEffect(() => {
    if (!reveal) return;
    const container = containerRef.current;
    const card = container?.querySelectorAll<HTMLElement>(".slide-card")[reveal.index];
    if (!container || !card) return;
    // 同じ commit に明示 reveal がある場合は、resize 用の sentinel を持ち越さない。
    restoredScrollTop.current = undefined;
    resizeAnchor.current = undefined;
    lastResizeAnchor.current = { frameIndex: reveal.index, ratio: 0 };
    container.scrollTop = card.offsetTop - SCROLL_PADDING;
  }, [reveal]);

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    // resize 復元が発生させた scroll は現在フレームの追従判定に使わない。
    if (restoringScroll.current) return;
    if (restoredScrollTop.current !== undefined) {
      const restored = restoredScrollTop.current;
      restoredScrollTop.current = undefined;
      if (restored === container.scrollTop) return;
    }
    const cards = [...container.querySelectorAll<HTMLElement>(".slide-card")].map((card) => ({
      top: card.offsetTop,
      height: card.offsetHeight,
    }));
    // collapse 中の offsetHeight=0 では frameAtScrollTop が先頭を返し得るため、
    // ブラウザが scrollTop を clamp して発火した scroll もナビ状態に反映しない。
    if (
      container.clientWidth <= 0 ||
      container.clientHeight <= 0 ||
      cards.some((card) => card.height <= 0)
    )
      return;
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
          onDetachToCanvas={onDetachToCanvas}
        />
      ))}
    </div>
  );
}
