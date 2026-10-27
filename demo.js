#!/usr/bin/env node
// Demo: writes a fake Claude Code session (main agent + 2 subagents + a skill)
// into a temp dir, line by line, and starts the monitor pointed at it.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccmon-demo-'));
const sid = randomUUID();
const proj = path.join(root, '-demo-project');
const subDir = path.join(proj, sid, 'subagents');
fs.mkdirSync(subDir, { recursive: true });
const mainFile = path.join(proj, sid + '.jsonl');

const now = () => new Date().toISOString();
const write = (file, obj) => fs.appendFileSync(file, JSON.stringify({ uuid: randomUUID(), sessionId: sid, timestamp: now(), cwd: '/demo/project', ...obj }) + '\n');
const user = (file, content, extra = {}) => write(file, { type: 'user', message: { role: 'user', content }, ...extra });
const asst = (file, block, stop = 'tool_use') =>
  write(file, { type: 'assistant', message: { id: 'msg_' + randomUUID().slice(0, 8), role: 'assistant', model: 'claude-opus-5-5', stop_reason: stop, content: [block] } });
const toolUse = (file, name, input) => { const id = 'toolu_' + randomUUID().slice(0, 12); asst(file, { type: 'tool_use', id, name, input }); return id; };
const toolResult = (file, id, text, tur = {}) => user(file, [{ type: 'tool_result', tool_use_id: id, content: text }], { toolUseResult: tur });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function subagent(agentId, type, prompt, steps) {
  const f = path.join(subDir, `agent-${agentId}.jsonl`);
  fs.writeFileSync(f.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: type }));
  const w = (fn, ...a) => fn(f, ...a);
  write(f, { type: 'user', isSidechain: true, agentId, message: { role: 'user', content: prompt } });
  for (const [name, input, out, ms] of steps) {
    await sleep(ms);
    const id = w(toolUse, name, input);
    await sleep(ms);
    w(toolResult, id, out);
  }
  await sleep(500);
  w(asst, { type: 'text', text: `${type} finished: found what was asked.` }, 'end_turn');
}

async function run() {
  write(mainFile, { type: 'custom-title', customTitle: 'Demo: refactor auth module' });
  user(mainFile, 'Refactor the auth module and add tests. Use the explore agent first.');
  await sleep(1200);
  asst(mainFile, { type: 'text', text: "I'll explore the codebase first, then plan the change." }, 'tool_use');
  await sleep(600);
  const q = toolUse(mainFile, 'AskUserQuestion', { questions: [{ question: 'Keep the old token format for backward compatibility?', header: 'Compat',
    options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false }] });
  await sleep(2500);
  toolResult(mainFile, q, 'User answered: "Keep the old token format for backward compatibility?"="Yes"');
  await sleep(600);
  const s1 = toolUse(mainFile, 'Skill', { skill: 'code-review', args: 'auth/' });
  await sleep(700);
  toolResult(mainFile, s1, 'Launching skill: code-review');
  await sleep(600);

  const p1 = 'Find every place the auth token is validated.';
  const p2 = 'List existing tests touching auth.';
  const a1 = toolUse(mainFile, 'Agent', { subagent_type: 'Explore', description: 'Find token validation', prompt: p1 });
  await sleep(300);
  const a2 = toolUse(mainFile, 'Agent', { subagent_type: 'general-purpose', description: 'Survey auth tests', prompt: p2 });
  await sleep(400);
  const id1 = randomUUID().slice(0, 16), id2 = randomUUID().slice(0, 16);
  await Promise.all([
    subagent(id1, 'Explore', p1, [
      ['Grep', { pattern: 'validateToken', path: '/demo/project/src' }, 'src/auth/token.ts\nsrc/api/middleware.ts', 500],
      ['Read', { file_path: '/demo/project/src/auth/token.ts' }, 'export function validateToken() {...}', 600],
      ['Read', { file_path: '/demo/project/src/api/middleware.ts' }, '...', 400],
    ]).then(() => toolResult(mainFile, a1, 'Token validated in 2 places: token.ts, middleware.ts', { agentId: id1, status: 'completed' })),
    subagent(id2, 'general-purpose', p2, [
      ['Glob', { pattern: '**/*.test.ts' }, 'auth.test.ts\nsession.test.ts', 700],
      ['Bash', { command: 'npx vitest list auth', description: 'List auth tests' }, '12 tests', 900],
    ]).then(() => toolResult(mainFile, a2, '12 tests in 2 files.', { agentId: id2, status: 'completed' })),
  ]);
  await sleep(800);
  asst(mainFile, { type: 'text', text: 'Both explorations are done. Applying the refactor now.' });
  await sleep(500);
  const bgId = 'b' + randomUUID().slice(0, 7);
  const bg = toolUse(mainFile, 'Bash', { command: 'npm run build', description: 'Build in the background', run_in_background: true });
  await sleep(300);
  toolResult(mainFile, bg, `Command running in background with ID: ${bgId}`, { backgroundTaskId: bgId });
  for (const [name, input, out, err] of [
    ['Edit', { file_path: '/demo/project/src/auth/token.ts', old_string: 'a', new_string: 'b' }, 'ok'],
    ['Bash', { command: 'npx vitest run auth', description: 'Run auth tests' }, '1 failed', true],
    ['Edit', { file_path: '/demo/project/src/auth/token.ts', old_string: 'b', new_string: 'c' }, 'ok'],
    ['Bash', { command: 'npx vitest run auth', description: 'Run auth tests' }, '12 passed'],
  ]) {
    await sleep(700);
    const id = toolUse(mainFile, name, input);
    await sleep(900);
    user(mainFile, [{ type: 'tool_result', tool_use_id: id, content: out, is_error: !!err }]);
  }
  write(mainFile, { type: 'attachment', attachment: { type: 'queued_command',
    prompt: `<task-notification>\n<task-id>${bgId}</task-id>\n<status>completed</status>\n<summary>Background command "npm run build" completed</summary>\n</task-notification>` } });
  for (const [tool, input, out] of [
    ['navigate', { url: 'http://localhost:3000/login' }, 'navigated'],
    ['screenshot', {}, '[image]'],
    ['find', { query: 'Sign in' }, 'ref_12 button "Sign in"'],
  ]) {
    await sleep(600);
    const id = toolUse(mainFile, 'mcp__browser__' + tool, input);
    await sleep(700);
    toolResult(mainFile, id, out);
  }
  await sleep(500);
  const g = toolUse(mainFile, 'mcp__github__create_issue', { title: 'Follow up: remove legacy token path' });
  await sleep(900);
  toolResult(mainFile, g, 'Created issue #42');
  await sleep(600);
  asst(mainFile, { type: 'text', text: 'Refactor complete; all 12 auth tests pass.' }, 'end_turn');
}

const port = process.env.PORT || 4318;
const srv = spawn(process.execPath, [path.join(__dirname, 'skills', 'claudecode-monitor', 'server.js')], {
  env: { ...process.env, CLAUDE_PROJECTS: root, PORT: port }, stdio: 'inherit',
});
setTimeout(() => run().then(() => console.log('demo finished — logs in', root)), 2500);
process.on('SIGINT', () => { srv.kill(); process.exit(); });
