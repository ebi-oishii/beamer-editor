import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

interface Reply {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

/** Start an isolated Chromium instance and wait for the editing UI's result. */
export async function chromiumLayoutResult(
  browser: string,
  cwd: string,
  profile: string,
  url: string,
): Promise<string> {
  const timeout = AbortSignal.timeout(30_000);
  const child = spawn(
    browser,
    [
      "--headless=new",
      "--disable-background-networking",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      `--user-data-dir=${profile}`,
      "--remote-debugging-pipe",
      "about:blank",
    ],
    {
      cwd,
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      signal: timeout,
      windowsHide: true,
    },
  );
  const commands = child.stdio[3] as Writable;
  const responses = child.stdio[4] as Readable;
  let failure: Error | undefined;
  let sequence = 0;
  let waitForReply: ((reply: Reply) => void) | undefined;
  const fail = (error: Error) => {
    failure = error;
    waitForReply?.({ error: { message: error.message } });
  };
  child.on("error", fail);
  const closed = once(child, "close").catch(() => []);
  child.on("close", () => fail(new Error("ブラウザーが表示検査の途中で終了しました。")));
  commands.on("error", fail);
  responses.on("error", fail);
  responses.setEncoding("utf8");
  let pending = "";
  responses.on("data", (chunk: string) => {
    pending += chunk;
    let boundary = pending.indexOf("\0");
    while (boundary >= 0) {
      const message = pending.slice(0, boundary);
      pending = pending.slice(boundary + 1);
      boundary = pending.indexOf("\0");
      try {
        const reply = JSON.parse(message) as Reply;
        if (reply.id === sequence) waitForReply?.(reply);
      } catch {
        fail(new Error("ブラウザーの表示検査結果を読み取れませんでした。"));
      }
    }
  });

  const send = async <T>(method: string, params?: object, sessionId?: string): Promise<T> => {
    if (failure) throw failure;
    const id = ++sequence;
    const reply = await new Promise<Reply>((resolve) => {
      waitForReply = resolve;
      commands.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    });
    waitForReply = undefined;
    if (reply.error) throw new Error(reply.error.message ?? method);
    return reply.result as T;
  };

  try {
    const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url });
    const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    while (!timeout.aborted) {
      const response = await send<{ result?: { value?: unknown } }>(
        "Runtime.evaluate",
        {
          expression: "document.getElementById('layout-result')?.textContent",
          returnByValue: true,
        },
        sessionId,
      ).catch((error: unknown) => {
        // Navigation can replace the empty document between attach and the first evaluation.
        if (failure) throw error;
        return undefined;
      });
      const result = response?.result?.value;
      if (typeof result === "string") {
        await send("Browser.close").catch(() => undefined);
        return result;
      }
      await delay(30, undefined, { signal: timeout });
    }
    throw new Error("ブラウザーでの表示検査がタイムアウトしました。");
  } finally {
    if (child.exitCode === null) child.kill();
    await Promise.race([closed, delay(1000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}
