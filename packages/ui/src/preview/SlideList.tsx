/**
 * フレームのサムネイル一覧。クリックで goto、ダブルクリックで対象ソースへ jump。
 * 一覧は全ステップ表示（step=99 相当で covered を掛けない）。
 */

import type { RenderedFrame } from "@beamer-editor/renderer";
import { useEffect, useRef } from "react";
import { applyOverlay } from "./overlay.js";

/** aria-label に載せる修飾キー名(mac は Cmd、それ以外は Ctrl。判定不能時は Ctrl)。 */
const MODIFIER_LABEL =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform) ? "Cmd" : "Ctrl";

function Thumb({
  frame,
  index,
  active,
  onSelect,
  onJump,
}: {
  frame: RenderedFrame;
  index: number;
  active: boolean;
  onSelect: (index: number) => void;
  onJump: (index: number) => void;
}): JSX.Element {
  const scaleRef = useRef<HTMLDivElement>(null);

  // 一覧は全ステップ表示（apps/web は applyOverlay(item, 99)）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: frame の html 差し替え時に再適用したい
  useEffect(() => {
    if (scaleRef.current) applyOverlay(scaleRef.current, 99);
  }, [frame]);

  return (
    // biome-ignore lint/a11y/useSemanticElements: スライド html（内部に <a> 等）を含むため button 不可
    <div
      className={active ? "thumb active" : "thumb"}
      data-index={index}
      role="button"
      tabIndex={0}
      aria-label={`フレーム ${frame.index}: ${frame.titleText}（Enter で選択、${MODIFIER_LABEL}+Enter でソースへ移動）`}
      onClick={() => onSelect(index)}
      onDoubleClick={() => onJump(index)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          // ダブルクリックと等価のキーボード操作(コントロールの「ソースへ」ボタンでも可)。
          e.preventDefault();
          onJump(index);
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(index);
        }
      }}
    >
      <div
        className="thumb-scale"
        ref={scaleRef}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: renderer が escape 済みの信頼 HTML
        dangerouslySetInnerHTML={{ __html: frame.html }}
      />
      <div className="thumb-label">
        {frame.index}. {frame.titleText}
        {frame.isRaw ? " ⚠" : ""}
      </div>
    </div>
  );
}

export function SlideList({
  frames,
  current,
  onSelect,
  onJump,
}: {
  frames: RenderedFrame[];
  current: number;
  onSelect: (index: number) => void;
  onJump: (index: number) => void;
}): JSX.Element {
  return (
    <aside className="slide-list">
      {frames.map((frame, i) => (
        <Thumb
          key={frame.index}
          frame={frame}
          index={i}
          active={i === current}
          onSelect={onSelect}
          onJump={onJump}
        />
      ))}
    </aside>
  );
}
