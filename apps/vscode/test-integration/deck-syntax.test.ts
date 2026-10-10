import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

/** `_workbench.captureSyntaxTokens` の 1 トークン。c は本文、t は空白区切りのスコープ。 */
interface CapturedToken {
  c: string;
  t: string;
}

/** deck の色が付くか。option の範囲を示す meta.optional-arguments.deck は色ではないので数えない。 */
const deck = (scopes: string): boolean =>
  scopes.split(" ").some((s) => s.endsWith(".deck") && !s.startsWith("meta."));

const tempDirs: string[] = [];

suite("Issue #181: deck 語彙の構文強調", () => {
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    for (const directory of tempDirs.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  test("組み込みの LaTeX 文法の上で deck 語彙と option だけを色分けする", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "beamer-deck-syntax-"));
    tempDirs.push(directory);
    const file = path.join(directory, "deck.slide.tex");
    await writeFile(
      file,
      [
        "\\documentclass{beamer}",
        "\\deckcolor{structure}{0F62FE}",
        "\\begin{document}",
        "\\begin{frame}[label=a]{T}",
        "\\begin{itemize}",
        "\\item point",
        "\\end{itemize}",
        "% \\deckimage[x=0.999]{c.png} in a comment",
        "\\begin{deckcanvas}",
        "\\begin{decktext}[x=0.050,y=0.100,w=0.420,size=normal]",
        "body",
        "\\end{decktext}",
        "\\deckimage[x=0.520,y=0.140,w=0.400]{assets/result.pdf}",
        "\\end{deckcanvas}",
        "\\end{frame}",
        "\\end{document}",
        "",
      ].join("\n"),
    );

    const tokens = await vscode.commands.executeCommand<CapturedToken[]>(
      "_workbench.captureSyntaxTokens",
      vscode.Uri.file(file),
    );
    const scopesOf = (text: string): string[] =>
      tokens.filter((token) => token.c.trim() === text).map((token) => token.t);

    for (const name of ["deckcanvas", "decktext", "\\deckimage", "\\deckcolor"]) {
      const scopes = scopesOf(name);
      assert.ok(scopes.length > 0, `${name} がトークンとして出る`);
      assert.ok(
        scopes.every((s) => s.includes("entity.name.type.deck")),
        `${name}: ${scopes.join(" | ")}`,
      );
    }
    assert.ok(
      scopesOf("x").some((s) => s.includes("entity.other.attribute-name.deck")),
      "option のキー",
    );
    assert.ok(
      scopesOf("0.050").some((s) => s.includes("constant.numeric.deck")),
      "option の数値",
    );
    assert.ok(
      scopesOf("normal").some((s) => s.includes("constant.language.deck")),
      "option の語",
    );

    // deck 以外の LaTeX と、コメントの中は組み込みの文法のまま。
    const itemize = scopesOf("itemize");
    assert.ok(
      itemize.length > 0 && itemize.every((s) => !deck(s)),
      `itemize: ${itemize.join(" | ")}`,
    );
    // 本文で見ると、命令だけが切り出されて deck の scope を持っても見逃すので、
    // コメントの scope を持つトークンをすべて調べる。
    const comment = tokens.filter((token) => token.t.includes("comment"));
    assert.ok(
      comment.some((token) => token.c.includes("in a comment")) &&
        comment.every((token) => !deck(token.t)),
      `コメント内の \\deckimage は色分けしない: ${comment.map((token) => token.t).join(" | ")}`,
    );
    const commented = tokens.filter((token) => token.c.includes("0.999"));
    assert.ok(
      commented.length > 0 &&
        commented.every((token) => token.t.includes("comment") && !deck(token.t)),
      `コメント内の option: ${commented.map((token) => token.t).join(" | ")}`,
    );
  });

  test("option の中のコメントは読み飛ばし、閉じ括弧が無くても後続の LaTeX を巻き込まない", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "beamer-deck-syntax-"));
    tempDirs.push(directory);
    const file = path.join(directory, "deck.slide.tex");
    await writeFile(
      file,
      [
        "\\documentclass{beamer}",
        "\\begin{document}",
        "\\begin{frame}[label=a]{T}",
        "\\begin{deckcanvas}",
        "\\begin{decktext}[",
        "  x=0.111,",
        "  % \\deckimage y=0.777, ] env comment",
        "  y=0.222,w=0.333",
        "]",
        "body",
        "\\end{decktext}",
        "\\deckimage[",
        "  x=0.444,",
        "  % \\deckimage y=0.888, ] command comment",
        "  y=0.555,w=0.666",
        "]{a.png}",
        // 閉じ括弧の無い option は、波括弧の手前か、option の続きに見えない行
        // (ここでは \begin の行と本文の行)の頭で閉じる。
        "\\deckimage[x=0.5{b.png}",
        "\\deckimage[x=0.6",
        "\\begin{decktext}[x=0.7",
        "body",
        "\\end{decktext}",
        "\\end{deckcanvas}",
        "\\end{frame}",
        "\\begin{frame}[label=next]{Next}",
        "\\begin{itemize}",
        "\\item point",
        "\\end{itemize}",
        "\\end{frame}",
        "\\end{document}",
        "",
      ].join("\n"),
    );

    const tokens = await vscode.commands.executeCommand<CapturedToken[]>(
      "_workbench.captureSyntaxTokens",
      vscode.Uri.file(file),
    );
    const scopesOf = (text: string): string[] =>
      tokens.filter((token) => token.c.trim() === text).map((token) => token.t);
    const numeric = (value: string) => {
      const scopes = scopesOf(value);
      return scopes.length > 0 && scopes.every((s) => s.includes("constant.numeric.deck"));
    };

    // コメントの中は deck として色分けせず、コメント中の ] で option を閉じない。
    for (const line of ["env comment", "command comment"]) {
      const inComment = tokens.filter((token) => token.c.includes(line));
      assert.ok(
        inComment.length > 0 && inComment.every((token) => token.t.includes("comment")),
        `${line}: ${inComment.map((token) => token.t).join(" | ")}`,
      );
    }
    // コメントの中の \deckimage や値が、切り出されて deck の scope を持たない。
    const comment = tokens.filter((token) => token.t.includes("comment"));
    assert.ok(
      comment.every((token) => !deck(token.t)),
      `コメント: ${comment.map((token) => token.t).join(" | ")}`,
    );
    for (const value of ["0.777", "0.888"]) {
      const inComment = tokens.filter((token) => token.c.includes(value));
      assert.ok(
        inComment.length > 0 &&
          inComment.every((token) => token.t.includes("comment") && !deck(token.t)),
        `コメント内の ${value}: ${inComment.map((token) => token.t).join(" | ")}`,
      );
    }
    for (const value of ["0.111", "0.222", "0.333", "0.444", "0.555", "0.666"]) {
      assert.ok(numeric(value), `option の ${value}: ${scopesOf(value).join(" | ")}`);
    }
    for (const value of ["0.5", "0.6", "0.7"]) {
      assert.ok(
        numeric(value),
        `閉じ括弧の無い option の ${value}: ${scopesOf(value).join(" | ")}`,
      );
    }

    // 閉じ括弧の無い option の後でも、次の frame と itemize は組み込みの文法のまま。
    const builtIn: Record<string, string> = {
      frame: "meta.function.environment.frame.latex",
      itemize: "meta.function.environment.list.latex",
    };
    for (const [name, environment] of Object.entries(builtIn)) {
      const scopes = scopesOf(name);
      assert.ok(
        scopes.length > 0 &&
          scopes.every(
            (s) =>
              !deck(s) &&
              s.includes(environment) &&
              s.includes("variable.parameter.function.latex"),
          ),
        `${name}: ${scopes.join(" | ")}`,
      );
    }
    const commands = tokens.filter((token) =>
      ["begin", "\\begin", "end", "\\end"].includes(token.c.trim()),
    );
    assert.ok(
      commands.length > 0 &&
        commands.every((token) => token.t.includes("support.function.be.latex")),
      `\\begin / \\end: ${commands.map((token) => token.t).join(" | ")}`,
    );
    // option が閉じないまま続くと、次の frame の `label` が deck のキーとして読まれる。
    // 組み込みの文法は `label=next` を 1 つのトークンにするので、部分一致で拾う。deck のキーとして
    // 切り出されると、このトークンが無くなる。
    const label = tokens.filter((token) => token.c.includes("label=next"));
    assert.ok(
      label.length > 0 && label.every((token) => !deck(token.t)),
      `label=next: ${label.map((token) => token.t).join(" | ")}`,
    );
  });

  test("閉じ括弧の無い option は、option の続きに見えない行と次の命令で閉じる", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "beamer-deck-syntax-"));
    tempDirs.push(directory);
    const file = path.join(directory, "deck.slide.tex");
    // option の中では injection が働かないので、deck 自身の命令や環境の終わりも option に取られない。
    // 正しい option の続きの行は、parser の parseCanvasKeys と同じく「キー=」「,」「]」「%」の
    // どれかで始まる。それ以外の行(空行を含む)の頭で option を閉じる。
    // 既知の制限: parser は `x =` の直後で改行して値を次の行に書く形も受け付けるが、構文強調では
    // その行の頭で閉じる。formatter も「自由配置にする」もこの形を書き出さないので扱わない。
    await writeFile(
      file,
      [
        "\\documentclass{beamer}",
        "\\begin{document}",
        "\\begin{frame}[label=u]{U}",
        "  \\begin{deckcanvas}",
        "    \\deckimage[x=0.6",
        "    \\begin{decktext}[x=0.7",
        "      body $a=b$ key=1",
        "    \\end{decktext}",
        "    \\deckimage[",
        "      x=0.81,",
        "      % y=0.82, ] comment",
        "      , y=0.83",
        "      ,w=0.84",
        "    ]{a.png}",
        "    \\deckimage[x=0.91",
        "",
        "    w=0.92]{b.png}",
        "    \\deckimage[x=0.61 \\deckimage[x=0.62]{c.png}",
        "  \\end{deckcanvas}",
        "\\end{frame}",
        "\\end{document}",
        "",
      ].join("\n"),
    );

    const tokens = await vscode.commands.executeCommand<CapturedToken[]>(
      "_workbench.captureSyntaxTokens",
      vscode.Uri.file(file),
    );
    const scopesOf = (text: string): string[] =>
      tokens.filter((token) => token.c.trim() === text).map((token) => token.t);
    const option = "meta.optional-arguments.deck";
    const containing = (text: string) => tokens.filter((token) => token.c.includes(text));
    const show = (list: CapturedToken[]) =>
      list.map((token) => `${JSON.stringify(token.c)} ${token.t}`).join(" | ");

    // 本文の行はまるごと option の外。数式は組み込みの文法で読み、key=1 は色分けしない。
    const math = containing("a=b");
    assert.ok(
      math.length > 0 && math.every((token) => token.t.includes("meta.math") && !deck(token.t)),
      `$a=b$: ${show(math)}`,
    );
    for (const text of ["body", "key"]) {
      const outside = containing(text);
      assert.ok(
        outside.length > 0 && outside.every((token) => !deck(token.t) && !token.t.includes(option)),
        `${text}: ${show(outside)}`,
      );
    }

    // 環境の終わりは、deck のものも組み込みのものも、option の外でそれぞれの scope を持つ。
    const ends = tokens.filter((token) => ["end", "\\end"].includes(token.c.trim()));
    assert.ok(
      ends.length === 4 &&
        ends.every(
          (token) => token.t.includes("support.function.be.latex") && !token.t.includes(option),
        ),
      `\\end: ${show(ends)}`,
    );
    for (const name of ["decktext", "deckcanvas"]) {
      const scopes = scopesOf(name);
      assert.ok(
        scopes.length > 0 &&
          scopes.every((s) => s.includes("entity.name.type.deck") && !s.includes(option)),
        `${name}: ${scopes.join(" | ")}`,
      );
    }
    const frame = scopesOf("frame");
    assert.ok(
      frame.length > 0 &&
        frame.every(
          (s) =>
            s.includes("meta.function.environment.frame.latex") &&
            s.includes("variable.parameter.function.latex") &&
            !deck(s),
        ),
      `frame: ${frame.join(" | ")}`,
    );
    // 同じ行に続く deck の命令も option に取られず、命令として読む。
    const images = scopesOf("\\deckimage");
    assert.ok(
      images.length === 5 &&
        images.every((s) => s.includes("entity.name.type.deck") && !s.includes(option)),
      `\\deckimage: ${images.join(" | ")}`,
    );

    // 正しい複数行の option は、続きの行が , やコメントで始まっても最後の ] まで続く。
    for (const value of ["0.6", "0.7", "0.81", "0.83", "0.84", "0.91", "0.61", "0.62"]) {
      const scopes = scopesOf(value);
      assert.ok(
        scopes.length > 0 &&
          scopes.every((s) => s.includes("constant.numeric.deck") && s.includes(option)),
        `option の ${value}: ${scopes.join(" | ")}`,
      );
    }
    const closes = tokens.filter((token) =>
      token.t.includes("punctuation.definition.optional-arguments.end.deck"),
    );
    assert.ok(closes.length === 2, `option の ] : ${show(closes)}`);
    // 空行で閉じるので、その後の w=0.92 は option ではない。
    const afterBlank = containing("0.92");
    assert.ok(
      afterBlank.length > 0 &&
        afterBlank.every((token) => !deck(token.t) && !token.t.includes(option)),
      `空行の後の 0.92: ${show(afterBlank)}`,
    );

    // option の中で色の付かないトークンは、空白・区切りの , ・コメントだけ。
    const leaked = tokens.filter(
      (token) =>
        token.t.includes(option) &&
        !deck(token.t) &&
        !token.t.includes("comment") &&
        !/^[\s,]*$/.test(token.c),
    );
    assert.ok(leaked.length === 0, `option の中に紛れたトークン: ${show(leaked)}`);
  });

  test("option の中の \\% と \\] は TeX と同じくエスケープとして読み、コメントや終わりにしない", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "beamer-deck-syntax-"));
    tempDirs.push(directory);
    const file = path.join(directory, "deck.slide.tex");
    await writeFile(
      file,
      [
        "\\documentclass{beamer}",
        "\\begin{document}",
        "\\begin{frame}[label=e]{E}",
        "\\begin{deckcanvas}",
        "\\deckimage[x=0.1,y=50\\%]{a.png}",
        "next $m$ line",
        "\\deckimage[x=0.3\\],w=0.4]{b.png}",
        "\\end{deckcanvas}",
        "\\end{frame}",
        "\\end{document}",
        "",
      ].join("\n"),
    );

    const tokens = await vscode.commands.executeCommand<CapturedToken[]>(
      "_workbench.captureSyntaxTokens",
      vscode.Uri.file(file),
    );
    const option = "meta.optional-arguments.deck";
    const containing = (text: string) => tokens.filter((token) => token.c.includes(text));
    const show = (list: CapturedToken[]) =>
      list.map((token) => `${JSON.stringify(token.c)} ${token.t}`).join(" | ");

    // \% はコメントの始まりではない。このファイルにコメントは無い。
    const comment = tokens.filter((token) => token.t.includes("comment"));
    assert.ok(comment.length === 0, `コメント: ${show(comment)}`);
    const escapes = tokens.filter((token) => token.t.includes("constant.character.escape.tex"));
    assert.ok(
      escapes.length === 4 && escapes.every((token) => token.t.includes(option)),
      `エスケープ: ${show(escapes)}`,
    );

    // \% の後の ] で閉じるので、{a.png} と次の行は組み込みの文法のまま。
    for (const text of ["{a.png}", "next", "line"]) {
      const outside = containing(text);
      assert.ok(
        outside.length > 0 && outside.every((token) => !deck(token.t) && !token.t.includes(option)),
        `${text}: ${show(outside)}`,
      );
    }
    const math = tokens.filter((token) => token.c.trim() === "m");
    assert.ok(
      math.length > 0 && math.every((token) => token.t.includes("meta.math")),
      `$m$: ${show(math)}`,
    );

    // \] では閉じず、その後の w=0.4 まで option が続く。
    const width = tokens.filter((token) => token.c.trim() === "0.4");
    assert.ok(
      width.length > 0 &&
        width.every(
          (token) => token.t.includes("constant.numeric.deck") && token.t.includes(option),
        ),
      `0.4: ${show(width)}`,
    );
    const closes = tokens.filter((token) =>
      token.t.includes("punctuation.definition.optional-arguments.end.deck"),
    );
    assert.ok(closes.length === 2, `option の ] : ${show(closes)}`);
  });

  test("字下げしたキャンバスでも色分けし、後ろのフレームの組み込みの色分けを壊さない", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "beamer-deck-syntax-"));
    tempDirs.push(directory);
    const file = path.join(directory, "deck.slide.tex");
    // 「自由配置にする」が書き出すキャンバスと同じく、環境とコマンドを字下げする。
    await writeFile(
      file,
      [
        "\\documentclass{beamer}",
        "\\begin{document}",
        "\\begin{frame}[label=c]{C}",
        "  \\begin{deckcanvas}",
        "    \\begin{decktext}[x=0.123,y=0.234,w=0.345,size=small]",
        "      text",
        "    \\end{decktext}",
        "    \\deckimage[x=0.456,y=0.567,w=0.678]{a.png}",
        "  \\end{deckcanvas}",
        "\\end{frame}",
        "\\begin{frame}[label=d]{D}",
        "\\begin{itemize}",
        "\\item point",
        "\\end{itemize}",
        "\\end{frame}",
        "\\end{document}",
        "",
      ].join("\n"),
    );

    const tokens = await vscode.commands.executeCommand<CapturedToken[]>(
      "_workbench.captureSyntaxTokens",
      vscode.Uri.file(file),
    );
    const scopesOf = (text: string): string[] =>
      tokens.filter((token) => token.c.trim() === text).map((token) => token.t);

    for (const name of ["deckcanvas", "decktext", "\\deckimage"]) {
      const scopes = scopesOf(name);
      assert.ok(
        scopes.length > 0 && scopes.every((s) => s.includes("entity.name.type.deck")),
        `${name}: ${scopes.join(" | ")}`,
      );
    }
    for (const value of ["0.123", "0.234", "0.345", "0.456", "0.567", "0.678"]) {
      const scopes = scopesOf(value);
      assert.ok(
        scopes.length > 0 && scopes.every((s) => s.includes("constant.numeric.deck")),
        `option の ${value}: ${scopes.join(" | ")}`,
      );
    }
    // deck の環境の範囲が閉じ損なうと、後ろの \\end{frame} が組み込みの色分けを失う。
    const ends = tokens.filter((token) => token.c.trim() === "end" || token.c.trim() === "\\end");
    assert.ok(
      ends.length > 0 && ends.every((token) => token.t.includes("support.function.be.latex")),
      `\\end: ${ends.map((token) => token.t).join(" | ")}`,
    );
  });
});
