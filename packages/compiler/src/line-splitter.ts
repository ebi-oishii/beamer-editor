import { StringDecoder } from "node:string_decoder";

/**
 * Split a byte stream into lines across chunk boundaries. A line longer than
 * `limit` is cut there and the rest is dropped until the next newline, so one
 * unterminated line cannot grow without bound and no emitted line exceeds it.
 */
export function lineSplitter(onLine: (line: string) => void, limit: number) {
  const decoder = new StringDecoder("utf8");
  // Holds at most `limit` characters; once full, the line is being truncated
  // and later text is only scanned for the newline that ends it.
  let pending = "";
  const room = () => Math.max(0, limit - pending.length);
  const emit = (line: string) => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  return {
    append(chunk: Buffer | string) {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      let start = 0;
      for (let newline = text.indexOf("\n"); newline >= 0; newline = text.indexOf("\n", start)) {
        emit(pending + text.slice(start, Math.min(newline, start + room())));
        pending = "";
        start = newline + 1;
      }
      if (room() > 0) pending += text.slice(start, start + room());
    },
    end() {
      const rest = pending + decoder.end().slice(0, room());
      pending = "";
      if (rest.length > 0) emit(rest);
    },
  };
}
