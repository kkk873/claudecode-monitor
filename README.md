# Claude Code Monitor

`~/.claude/projects/**/*.jsonl` (Claude Code のセッションログ) をリアルタイムに tail して、
**User / Agents / Skills / MCP** の 4 レーンのシーケンス図としてブラウザに表示するツール。依存パッケージなし (Node 18+)。

## 使い方

Claude Code の中で:

```text
/claudecode-monitor          起動してブラウザを開く（タブを閉じると数秒後に自動で停止）
/claudecode-monitor keep     タブを閉じても止めない
/claudecode-monitor stop     停止
```

すでに起動していれば、2 つ目は立てずにブラウザを開くだけ。

## 入れ方

### A. プラグインとして（配布向け）

このリポジトリを GitHub に置き、Claude Code で:

```text
/plugin marketplace add <GitHubユーザー>/claudecode-monitor
/plugin install claudecode-monitor@claudecode-monitor
```

プラグインのスキルは `/claudecode-monitor:claudecode-monitor` の名前でも呼べる。

### B. 個人のスキルとして（手元だけ）

```bash
ln -s "$(pwd)/skills/claudecode-monitor" ~/.claude/skills/claudecode-monitor
```

### C. スキルを使わず直接

```bash
npx claudecode-monitor            # npm に公開した場合（今は非公開のため使えない）
node skills/claudecode-monitor/server.js
```

| オプション | 説明 |
|---|---|
| `--port N` | ポート（既定 4317、使用中なら次の番号）。127.0.0.1 のみで待ち受け |
| `--no-open` | ブラウザを開かない |
| `--keep-alive` | タブを閉じても止めない |
| `--detach` | 裏で起動してすぐ戻る（ログは `$TMPDIR/claudecode-monitor.log`） |
| `--stop` | 起動中のモニターを止める |

環境変数: `CLAUDE_PROJECTS`（監視するフォルダ）、`MAX_AGE_HOURS`（起動時に読むセッションの古さの上限、既定 72）

## 見え方

- レーンは User / Agents / Skills / MCP の 4 本
- 各参加者が動いている間は、ライフライン上の箱（活性区間）。Agents レーンでは左端の箱がメインエージェント、2 個目以降がサブエージェント（`A1`・`A2`）とバックグラウンドのコマンド（`B1`）
- 依頼は User から Agents への矢印。`AskUserQuestion` は「質問」「回答」の矢印で、返事を待つ間は User 側に箱が出る
- `Skill` 呼び出しや `/slash` コマンドで Skills レーンへ、MCP ツールはサーバーごとのライフラインへ矢印
- ツールは実行中・成功（黒）・失敗（赤）と所要時間。カードや矢印のラベルをクリックすると入力と結果を表示

## 開発

```bash
npm run demo    # ダミーのログを書き出しながら再生（http://localhost:4318）
```

## 仕組みと注意

- `server.js` が 600ms ごとに jsonl の追記分だけを読み、イベントに正規化して SSE で配信
- サブエージェントのログは `<session>/subagents/agent-<id>.jsonl`。親の `Agent` 呼び出しとはプロンプト文字列で対応付け
- ログ形式は Claude Code の内部仕様なので、バージョンによって変わる可能性あり

## ライセンス

MIT License。[LICENSE](LICENSE) を参照。

画面のデザイン（色・書体・罫線・部品の見た目）は、[mathbullet/skills](https://github.com/mathbullet/skills) の html プラグインのデザインシステム（`document.css`、MIT License, Copyright (c) 2026 mathbullet）を元にしている。元のライセンス表記は LICENSE の Third-party notices に収録。
