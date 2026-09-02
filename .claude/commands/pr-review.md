---
description: リモートの最新headでcode-reviewを走らせる
argument-hint: <PR番号>
---

PR $ARGUMENTS を `code-review` スキルでレビューする。

## 1. base と head を SHA で固定する

問い合わせは 1 回だけにする。ここで得た OID が以降すべての基準になる。

```sh
gh pr view <番号> --json baseRefName,baseRefOid,headRefOid
```

両方の commit object をローカルに用意する。`FETCH_HEAD` は次の fetch で上書きされるので、**head の検証を base の fetch より先に済ませる。**

```sh
git fetch origin pull/<番号>/head
git rev-parse FETCH_HEAD                # headRefOid と一致すること
git fetch origin <baseRefName>
git cat-file -e <baseRefOid>^{commit}   # 成功すること
```

**どちらか一方でも満たせなければ、レビューを始めずに止める。** `FETCH_HEAD` が `headRefOid` と違うのは、問い合わせと fetch の間に PR が更新されたということ。`cat-file` が失敗するのは base commit がローカルに無いということ。

以降は `<baseRefOid>` と `<headRefOid>` だけを使い、ref 名と PR番号は二度と引かない。base を OID で固定してあるので、レビュー中に `main` が進んでも対象差分は変わらない。

## 2. code-review スキルを起動する

Skill ツールで `code-review` を起動する。**自分で手順をなぞらない。** スキルに任せることで並列のファインダーが走る。

引数には PR番号でも ref 名でもなく、**1で固定した 2 つの SHA** を渡し、次を明示する。

- 差分は `git diff <baseRefOid>...<headRefOid>`(3 点リーダ。GitHub の Files changed と同じ merge-base 起点になる)
- ファイル内容は `git show <headRefOid>:<path>` で読む
- ref 名・PR番号・`origin/main` から引き直さない
- `git checkout` とローカルブランチ作成をしない
- 実体が要るときはスクラッチパッドへ `git worktree add --detach <dir> <headRefOid>` し、終わったら `git worktree remove`
- 報告の冒頭に base と head の両 SHA を書く

## 3. 戻ってきたら

報告の base SHA と head SHA が、両方とも1で固定した値と一致するか確認する。**片方でも違えば内容を使わない。**

ユーザーへ出す指摘は、自分で `git show <headRefOid>:<path>` を読んで裏を取ったものだけにする。
