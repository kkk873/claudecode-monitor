---
name: claudecode-monitor
description: Claude Code のセッションログをリアルタイムに監視し、メインエージェント・サブエージェント・スキルの 3 レーンのシーケンス図としてブラウザに表示するモニターを起動・停止する。利用者が /claudecode-monitor と打ったときに使う。
argument-hint: "[stop | keep]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

# Claude Code Monitor

このスキルのフォルダ（読み込み時に表示される「Base directory for this skill」）にある `server.js` を Node で実行する。以下 `<dir>` と書く。
Node 18 以上が要る。`node` が見つからなければ、そのことだけ伝えて終える。

引数: `$ARGUMENTS`

## 引数がないとき（起動）

```bash
node "<dir>/server.js" --detach
```

- サーバーを裏で起動してブラウザを開き、すぐ戻る。すでに起動していれば、新しく立てずにブラウザを開くだけ
- 出力にある URL を 1 行で伝え、「タブを閉じると数秒後に自動で止まる」と添える
- 失敗したら、出力の最後の数行をそのまま見せる

## 引数が `keep` のとき（止めずに残す）

```bash
node "<dir>/server.js" --detach --keep-alive
```

タブを閉じても止まらない。止めるときは `/claudecode-monitor stop` と伝える。

## 引数が `stop` のとき（停止）

```bash
node "<dir>/server.js" --stop
```

出力をそのまま 1 行で伝える。

## してはいけないこと

- `server.js` や `public/` の中身を読んだり直したりしない。起動と停止だけをする
- Bash の `run_in_background` で起動しない。`--detach` がセッションから切り離して起動するため
