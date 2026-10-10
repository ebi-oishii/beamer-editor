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
        "% \\deckimage in a comment",
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
    const deck = (scopes: string): boolean => scopes.split(" ").some((s) => s.endsWith(".deck"));

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
    const comment = tokens.filter((token) => token.c.includes("in a comment"));
    assert.ok(
      comment.length > 0 && comment.every((token) => !deck(token.t)),
      "コメント内の \\deckimage は色分けしない",
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
        "  % y=0.777, ] env comment",
        "  y=0.222,w=0.333",
        "]",
        "body",
        "\\end{decktext}",
        "\\deckimage[",
        "  x=0.444,",
        "  % y=0.888, ] command comment",
        "  y=0.555,w=0.666",
        "]{a.png}",
        "\\deckimage[x=0.5{b.png}",
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
    const deck = (scopes: string): boolean => scopes.split(" ").some((s) => s.endsWith(".deck"));
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
    for (const value of ["0.777", "0.888"]) {
      const scopes = scopesOf(value);
      assert.ok(
        scopes.every((s) => !deck(s)),
        `コメント内の ${value}: ${scopes.join(" | ")}`,
      );
    }
    for (const value of ["0.111", "0.222", "0.333", "0.444", "0.555", "0.666"]) {
      assert.ok(numeric(value), `option の ${value}: ${scopesOf(value).join(" | ")}`);
    }

    // 閉じ括弧の無い option の後でも、次の frame と itemize は組み込みの文法のまま。
    for (const name of ["frame", "itemize"]) {
      const scopes = scopesOf(name);
      assert.ok(
        scopes.length > 0 && scopes.every((s) => !deck(s)),
        `${name}: ${scopes.join(" | ")}`,
      );
    }
    // option が閉じないまま続くと、次の frame の `label` が deck のキーとして読まれる。
    const labelKey = scopesOf("label");
    assert.ok(
      labelKey.every((s) => !deck(s)),
      `label: ${labelKey.join(" | ")}`,
    );
    // 組み込みの文法は `label=next` を 1 つのトークンにするので、部分一致で拾う。
    const label = tokens.filter((token) => token.c.includes("label=next"));
    assert.ok(
      label.length > 0 && label.every((token) => !deck(token.t)),
      `label=next: ${label.map((token) => token.t).join(" | ")}`,
    );
  });
});
