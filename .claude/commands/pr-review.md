---
description: リモートの最新headでcode-reviewを走らせる
argument-hint: <PR番号>
---

PR $ARGUMENTS を `code-review` スキルでレビューする。

## 1. head を確定する

```sh
gh pr view <番号> --json headRefOid --jq .headRefOid
git fetch origin pull/<番号>/head
```

`git rev-parse FETCH_HEAD` が `headRefOid` と一致することを確認する。違えば止める。

## 2. code-review スキルを起動する

Skill ツールで `code-review` を起動する。**自分で手順をなぞらない。** スキルに任せることで並列のファインダーが走る。

引数には PR番号ではなく **1で確定した SHA** を渡し、次を明示する。

- 対象は `<SHA>`。PR番号から引き直さない
- `git checkout` とローカルブランチ作成をしない。読むのは `git show <SHA>:<path>` と `git diff <base>...<SHA>`
- 実体が要るときはスクラッチパッドへ `git worktree add --detach <dir> <SHA>` し、終わったら `git worktree remove`
- 報告の冒頭に読んだ SHA を書く

## 3. 戻ってきたら

報告の SHA が1と一致するか確認する。違えば内容を使わない。

ユーザーへ出す指摘は、自分で `git show <SHA>:<path>` を読んで裏を取ったものだけにする。
