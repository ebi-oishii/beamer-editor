export interface TextEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export interface TextSelection {
  selectionStart: number;
  selectionEnd: number;
}

const INDENT = "\t";

function lineStartAt(value: string, position: number): number {
  if (position === 0) return 0;
  return value.lastIndexOf("\n", position - 1) + 1;
}

function affectedEndAt(value: string, selectionStart: number, selectionEnd: number): number {
  if (selectionEnd > selectionStart && value[selectionEnd - 1] === "\n") {
    return selectionEnd - 1;
  }
  return selectionEnd;
}

function indent(value: string, selectionStart: number, selectionEnd: number): TextEdit {
  if (selectionStart === selectionEnd) {
    return {
      value: `${value.slice(0, selectionStart)}${INDENT}${value.slice(selectionEnd)}`,
      selectionStart: selectionStart + INDENT.length,
      selectionEnd: selectionEnd + INDENT.length,
    };
  }

  const blockStart = lineStartAt(value, selectionStart);
  const blockEnd = affectedEndAt(value, selectionStart, selectionEnd);
  const lines = value.slice(blockStart, blockEnd).split("\n");
  const replacement = lines.map((line) => `${INDENT}${line}`).join("\n");

  return {
    value: `${value.slice(0, blockStart)}${replacement}${value.slice(blockEnd)}`,
    selectionStart: selectionStart + INDENT.length,
    selectionEnd: selectionEnd + lines.length * INDENT.length,
  };
}

function removableIndentLength(line: string): number {
  if (line.startsWith("\t")) return 1;
  return line.match(/^ {1,2}/)?.[0].length ?? 0;
}

function outdent(value: string, selectionStart: number, selectionEnd: number): TextEdit {
  const blockStart = lineStartAt(value, selectionStart);
  const nextLineBreak = value.indexOf("\n", selectionEnd);
  const blockEnd =
    selectionStart === selectionEnd
      ? nextLineBreak === -1
        ? value.length
        : nextLineBreak
      : affectedEndAt(value, selectionStart, selectionEnd);
  const lines = value.slice(blockStart, blockEnd).split("\n");
  const removals: Array<{ position: number; length: number }> = [];
  let lineOffset = 0;

  const replacement = lines
    .map((line) => {
      const length = removableIndentLength(line);
      if (length > 0) removals.push({ position: blockStart + lineOffset, length });
      lineOffset += line.length + 1;
      return line.slice(length);
    })
    .join("\n");

  const adjustPosition = (position: number): number =>
    position -
    removals.reduce(
      (removed, removal) =>
        removed + Math.min(removal.length, Math.max(0, position - removal.position)),
      0,
    );

  return {
    value: `${value.slice(0, blockStart)}${replacement}${value.slice(blockEnd)}`,
    selectionStart: adjustPosition(selectionStart),
    selectionEnd: adjustPosition(selectionEnd),
  };
}

/** textarea の Tab / Shift+Tab に対応する文字列編集を返す。 */
export function editIndentation(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  outdentRequested: boolean,
): TextEdit {
  return outdentRequested
    ? outdent(value, selectionStart, selectionEnd)
    : indent(value, selectionStart, selectionEnd);
}

/** 現在行の先頭空白を引き継いだ改行を返す。 */
export function editNewlineWithIndent(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): TextEdit {
  const lineStart = lineStartAt(value, selectionStart);
  const beforeCursor = value.slice(lineStart, selectionStart);
  const indentation = beforeCursor.match(/^[\t ]*/)?.[0] ?? "";
  const insertion = `\n${indentation}`;
  const cursor = selectionStart + insertion.length;

  return {
    value: `${value.slice(0, selectionStart)}${insertion}${value.slice(selectionEnd)}`,
    selectionStart: cursor,
    selectionEnd: cursor,
  };
}

/** 指定位置を含む行の選択範囲を返す。ジャンプ先を視覚的に示すために使う。 */
export function lineSelectionAt(value: string, position: number): TextSelection {
  const safePosition = Math.max(0, Math.min(position, value.length));
  const selectionStart = lineStartAt(value, safePosition);
  const lineBreak = value.indexOf("\n", safePosition);
  return {
    selectionStart,
    selectionEnd: lineBreak === -1 ? value.length : lineBreak,
  };
}
