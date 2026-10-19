/**
 * ユーザー領域(`%% macros` / `%% style` / `%% preamble-extra`)の名前と、parser が領域と認める範囲。
 * ツール管理プリアンブルの範囲決め(managed-preamble.ts)は名前だけを共有し、上限はより手前で止まる
 * 独自の規則で決める(ユーザー領域を消さないよう、迷ったら拒否する側に倒すため)。
 * 公開 API ではない(index.ts から export しない)。
 */

export const USER_REGION_NAMES = ["macros", "style", "preamble-extra"] as const;
export type UserRegionName = (typeof USER_REGION_NAMES)[number];

/**
 * parser がユーザー領域と認める範囲: 開始印と終了印の最初の出現(行頭やコメントは問わない)が
 * どちらもあるとき、開始印の位置(`begin`)・開始印の次の行頭(`contentStart`)・終了印の位置(`end`)。
 */
export function userRegion(
  src: string,
  name: UserRegionName,
): { begin: number; contentStart: number; end: number } | null {
  const begin = src.indexOf(`%% ${name}:begin`);
  const end = src.indexOf(`%% ${name}:end`);
  if (begin === -1 || end === -1) return null;
  return { begin, contentStart: src.indexOf("\n", begin) + 1, end };
}
