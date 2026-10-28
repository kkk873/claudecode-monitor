---
name: claudecode-monitor
description: Claude Code のセッションログをリアルタイムに監視し、User・Agents・Skills・MCP の 4 レーンのシーケンス図としてブラウザに表示するモニターを起動・停止する。利用者が /claudecode-monitor と打ったときに使う。
argument-hint: "[stop | keep]"
disable-model-invocation: true
allowed-tools:
  - Bash(node:*)
  - mcp__Claude_Browser__preview_start
---

# Claude Code Monitor

このスキルのフォルダ（読み込み時に表示される「Base directory for this skill」）にある `server.js` を Node で実行する。以下 `<dir>` と書く。
Node 18 以上が要る。`node` が見つからなければ、そのことだけ伝えて終える。

引数: `$ARGUMENTS`

## 引数がないとき（起動）

1. サーバーを裏で起動する。ブラウザはまだ開かない

   ```bash
   node "<dir>/server.js" --detach --no-open
   ```

   すでに起動していれば、新しく立てずに URL だけを表示して戻る。失敗したら、出力の最後の数行をそのまま見せて終える

2. 出力にある URL（`http://localhost:<port>`）を開く
   - Claude デスクトップアプリのアプリ内ブラウザ（`mcp__Claude_Browser__preview_start` ツール）が使えるなら、`url` にその URL を渡して開く
   - 使えなければ（ターミナル版など）、次で既定のブラウザを開く。起動中のサーバーを見つけてブラウザを開くだけで、2 つ目は立てない

     ```bash
     node "<dir>/server.js" --detach
     ```

3. URL を 1 行で伝え、「タブを閉じると数秒後に自動で止まる」と添える

## 引数が `keep` のとき（止めずに残す）

起動と同じ手順で、1 のコマンドを次に変える。

```bash
node "<dir>/server.js" --detach --no-open --keep-alive
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
