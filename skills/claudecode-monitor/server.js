#!/usr/bin/env node
// Claude Code log monitor: tails ~/.claude/projects/**/*.jsonl and streams
// normalized events to the browser over Server-Sent Events.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(`Usage: claudecode-monitor [--port N] [--no-open] [--keep-alive] [--detach] [--stop]

  --port N       port to listen on (default 4317, or $PORT)
  --no-open      don't open the browser
  --keep-alive   keep running after the page is closed (default: stop a few seconds after the last page closes)
  --detach       run in the background (log: $TMPDIR/claudecode-monitor.log) and return
  --stop         stop a running monitor

Env: CLAUDE_PROJECTS (log dir), MAX_AGE_HOURS (default 72)`);
  process.exit(0);
}
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const ROOT = process.env.CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const PORT = Number(argVal('--port') || process.env.PORT || 4317);
const OPEN = !args.includes('--no-open') && !process.env.NO_OPEN;
const MAX_AGE_HOURS = Number(process.env.MAX_AGE_HOURS || 72);
const POLL_MS = 600;
const TEXT_LIMIT = 4000;
const FIELD_LIMIT = 1500;
const STOP_GRACE_MS = 5000; // survives page reloads and session switches
const SIGNATURE = 'claudecode-monitor';

const files = new Map();    // filePath -> tail state
const sessions = new Map(); // sessionId -> { id, project, cwd, title, firstPrompt, events, lastTs, mtime }
const clients = new Map();  // sessionId -> Set<res>
let seq = 0;
const autoStop = !args.includes('--keep-alive');
let everConnected = false;
let stopTimer = null;

// ---------- helpers ----------

const clip = (s, n = TEXT_LIMIT) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `… (+${s.length - n} chars)` : s);

function clipDeep(v, depth = 0) {
  if (typeof v === 'string') return clip(v, FIELD_LIMIT);
  if (depth > 4 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clipDeep(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = clipDeep(x, depth + 1);
  return out;
}

function contentToText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
  }
  return '';
}

function getSession(id, ctx) {
  let s = sessions.get(id);
  if (!s) {
    s = { id, project: ctx.project, cwd: null, title: null, firstPrompt: null, events: [], lastTs: 0, mtime: 0 };
    sessions.set(id, s);
  }
  return s;
}

// ---------- normalization ----------

function normalize(entry, ctx) {
  const out = [];
  const base = {
    session: entry.sessionId || ctx.sessionId,
    agent: ctx.agentId || (entry.isSidechain && entry.agentId) || null,
    ts: entry.timestamp ? Date.parse(entry.timestamp) : null,
  };
  const push = (kind, extra, idx = 0) =>
    out.push({ ...base, id: `${entry.uuid || 'x' + ++seq}:${idx}`, kind, ...extra });

  switch (entry.type) {
    case 'custom-title':
      out.push({ ...base, kind: 'meta', title: entry.customTitle });
      return out;
    case 'summary':
      out.push({ ...base, kind: 'meta', summary: entry.summary });
      return out;
    case 'attachment': {
      // background-agent completions are queued into the main session as attachments
      const a = entry.attachment || {};
      const p = typeof a.prompt === 'string' ? a.prompt : '';
      if (a.type === 'queued_command' && /^\s*<(task-notification|agent-message)/.test(p)) push('notify', { text: clip(p) });
      return out;
    }
    case 'user': {
      if (entry.isMeta) return out; // injected skill bodies, caveats, etc.
      const c = entry.message && entry.message.content;
      if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) {
        c.forEach((b, i) => {
          if (b.type !== 'tool_result') return;
          const tur = entry.toolUseResult && typeof entry.toolUseResult === 'object' && !Array.isArray(entry.toolUseResult) ? entry.toolUseResult : {};
          push('tool_result', {
            toolUseId: b.tool_use_id,
            isError: !!b.is_error,
            text: clip(contentToText(b.content)),
            resultAgentId: tur.agentId || null,
            resultTaskId: tur.backgroundTaskId || null,
            resultStatus: tur.status || null,
          }, i);
        });
        return out;
      }
      const text = contentToText(c);
      if (!text) return out;
      const cmd = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
      if (cmd) {
        const args = (text.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
        push('slash', { name: cmd[1].trim(), text: clip(args.trim()) });
        return out;
      }
      if (/^\s*<(local-command|system-reminder)/.test(text)) return out;
      if (/^\s*<task-notification>/.test(text)) {
        push('notify', { text: clip(text) });
        return out;
      }
      if (ctx.agentId && !ctx.sawPrompt) {
        ctx.sawPrompt = true;
        push('agent_prompt', { text: clip(text), agentType: ctx.meta && ctx.meta.agentType, description: ctx.meta && ctx.meta.description });
        return out;
      }
      push('user', { text: clip(text) });
      return out;
    }
    case 'assistant': {
      const m = entry.message || {};
      const blocks = Array.isArray(m.content) ? m.content : [];
      blocks.forEach((b, i) => {
        const extra = { msgId: m.id, stopReason: m.stop_reason || null, model: m.model };
        if (b.type === 'text' && b.text && b.text.trim()) push('text', { ...extra, text: clip(b.text) }, i);
        else if (b.type === 'tool_use') push('tool_use', { ...extra, name: b.name, toolUseId: b.id, input: clipDeep(b.input) }, i);
      });
      return out;
    }
    default:
      return out;
  }
}

// ---------- tailing ----------

function readMeta(metaPath) {
  try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return null; }
}

function describeFile(fp) {
  const rel = path.relative(ROOT, fp).split(path.sep);
  const project = rel[0];
  const base = path.basename(fp, '.jsonl');
  // <project>/<sessionId>/subagents/agent-<id>.jsonl
  if (rel.length >= 4 && rel[2] === 'subagents') {
    const agentId = base.replace(/^agent-/, '');
    return { project, sessionId: rel[1], agentId, metaPath: fp.replace(/\.jsonl$/, '.meta.json') };
  }
  // legacy: <project>/agent-<id>.jsonl (sessionId comes from entries)
  if (rel.length === 2 && base.startsWith('agent-')) {
    return { project, sessionId: null, agentId: base.replace(/^agent-/, ''), metaPath: null };
  }
  if (rel.length === 2) return { project, sessionId: base, agentId: null, metaPath: null };
  return null;
}

function listJsonl() {
  const found = [];
  let projects = [];
  try { projects = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return found; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const pdir = path.join(ROOT, p.name);
    let entries = [];
    try { entries = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) found.push(path.join(pdir, e.name));
      else if (e.isDirectory()) {
        const sub = path.join(pdir, e.name, 'subagents');
        let subs = [];
        try { subs = fs.readdirSync(sub); } catch { continue; }
        for (const f of subs) if (f.endsWith('.jsonl')) found.push(path.join(sub, f));
      }
    }
  }
  return found;
}

function tailFile(fp, st, newEvents) {
  let t = files.get(fp);
  if (!t) {
    const d = describeFile(fp);
    if (!d) return;
    t = { ...d, offset: 0, partial: '', sawPrompt: false, meta: null };
    files.set(fp, t);
  }
  if (t.metaPath && !t.meta) t.meta = readMeta(t.metaPath);
  if (st.size < t.offset) { t.offset = 0; t.partial = ''; }
  if (st.size === t.offset) return;

  const fd = fs.openSync(fp, 'r');
  const buf = Buffer.alloc(st.size - t.offset);
  fs.readSync(fd, buf, 0, buf.length, t.offset);
  fs.closeSync(fd);
  t.offset = st.size;

  const chunk = t.partial + buf.toString('utf8');
  const lines = chunk.split('\n');
  t.partial = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!t.sessionId && entry.sessionId) t.sessionId = entry.sessionId;
    const sid = t.sessionId || entry.sessionId;
    if (!sid) continue;
    const s = getSession(sid, t);
    s.mtime = Math.max(s.mtime, st.mtimeMs);
    if (!t.agentId && entry.cwd) s.cwd = entry.cwd;
    for (const ev of normalize(entry, t)) {
      ev.session = sid;
      if (ev.kind === 'meta') {
        if (ev.title) s.title = ev.title;
        if (ev.summary && !s.title) s.title = ev.summary;
        continue;
      }
      if (ev.kind === 'user' && !s.firstPrompt) s.firstPrompt = ev.text.slice(0, 120);
      if (ev.ts) s.lastTs = Math.max(s.lastTs, ev.ts);
      ev.seq = ++seq;
      s.events.push(ev);
      newEvents.push(ev);
    }
  }
}

let firstScan = true;
function scan() {
  const newEvents = [];
  const cutoff = Date.now() - MAX_AGE_HOURS * 3600e3;
  for (const fp of listJsonl()) {
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    // Old files are skipped on startup, but anything that changes later is picked up.
    if (!files.has(fp) && st.mtimeMs < cutoff) {
      const d = describeFile(fp);
      const parentLoaded = d && d.agentId && d.sessionId && sessions.has(d.sessionId);
      if (!parentLoaded) {
        if (firstScan) files.set(fp, { ...d, offset: st.size, partial: '', sawPrompt: true, skipped: true });
        continue;
      }
    }
    try { tailFile(fp, st, newEvents); } catch (e) { console.error('tail error', fp, e.message); }
  }
  firstScan = false;
  if (!newEvents.length) return;
  newEvents.sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.seq - b.seq);
  const bySession = new Map();
  for (const ev of newEvents) {
    if (!bySession.has(ev.session)) bySession.set(ev.session, []);
    bySession.get(ev.session).push(ev);
  }
  for (const [sid, evs] of bySession) {
    const set = clients.get(sid);
    if (!set) continue;
    const payload = `event: events\ndata: ${JSON.stringify(evs)}\n\n`;
    for (const res of set) res.write(payload);
  }
}

// ---------- http ----------

function sessionSummary(s) {
  return {
    id: s.id,
    project: s.project,
    cwd: s.cwd,
    title: s.title || s.firstPrompt || '(untitled)',
    lastTs: s.lastTs || s.mtime,
    count: s.events.length,
    agents: new Set(s.events.filter((e) => e.agent).map((e) => e.agent)).size,
  };
}

function totalClients() {
  let n = 0;
  for (const set of clients.values()) n += set.size;
  return n;
}

function shutdown(reason) {
  console.log(`stopping (${reason})`);
  for (const set of clients.values()) for (const res of set) res.end();
  server.close();
  setTimeout(() => process.exit(0), 200).unref();
}

// When "stop when the page is closed" is on, exit once no page has been connected for a few seconds.
function checkAutoStop() {
  clearTimeout(stopTimer);
  stopTimer = null;
  if (!autoStop || !everConnected || totalClients() > 0) return;
  stopTimer = setTimeout(() => { if (totalClients() === 0) shutdown('all pages closed'); }, STOP_GRACE_MS);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (url.pathname === '/api/ping') return json({ app: SIGNATURE });
  if (url.pathname === '/api/sessions') {
    return json([...sessions.values()].filter((s) => s.events.length).map(sessionSummary).sort((a, b) => b.lastTs - a.lastTs));
  }
  // Used by --stop. The custom header forces a CORS preflight we never allow, so other web pages can't trigger it.
  if (url.pathname === '/api/shutdown') {
    if (req.method !== 'POST' || req.headers['x-monitor'] !== '1') { res.writeHead(403); return res.end(); }
    json({ ok: true });
    return shutdown('--stop');
  }
  if (url.pathname === '/api/stream') {
    const sid = url.searchParams.get('session');
    const s = sessions.get(sid);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const evs = s ? [...s.events].sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.seq - b.seq) : [];
    res.write(`event: init\ndata: ${JSON.stringify(evs)}\n\n`);
    if (!clients.has(sid)) clients.set(sid, new Set());
    clients.get(sid).add(res);
    everConnected = true;
    checkAutoStop();
    const ka = setInterval(() => res.write(': ka\n\n'), 15000);
    res.on('close', () => { clearInterval(ka); clients.get(sid).delete(res); checkAutoStop(); });
    return;
  }
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const fp = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(fp)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type + '; charset=utf-8' });
    res.end(data);
  });
});

function openBrowser(url) {
  if (!OPEN) return;
  const { spawn } = require('child_process');
  const [cmd, cmdArgs] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try { spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
}

// If our own monitor already holds the port, just open it instead of starting a second one.
function alreadyRunning(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body).app === SIGNATURE); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function listen(port, triesLeft) {
  server.once('error', async (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    if (await alreadyRunning(port)) {
      const url = `http://localhost:${port}`;
      console.log(`Claude Code monitor is already running → ${url}`);
      openBrowser(url);
      process.exit(0);
    }
    if (triesLeft > 0) return listen(port + 1, triesLeft - 1);
    console.error(`port ${port} is in use`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    scan();
    setInterval(scan, POLL_MS);
    console.log(`Claude Code monitor → ${url}`);
    console.log(`watching ${ROOT} (sessions touched in last ${MAX_AGE_HOURS}h: ${sessions.size})`);
    console.log(autoStop ? 'stops automatically a few seconds after the page is closed' : 'keeps running after the page is closed; Ctrl+C or --stop to stop');
    // if the browser never shows up (failed to open, tab closed while loading), don't linger
    if (autoStop) setTimeout(() => { if (!everConnected) shutdown('no page opened within 60s'); }, 60000).unref();
    openBrowser(url);
  });
}

// --detach: re-launch ourselves in the background, print the URL, and return (used by the Claude Code skill).
function detach() {
  const { spawn } = require('child_process');
  const log = path.join(os.tmpdir(), 'claudecode-monitor.log');
  // append, and only read what this launch writes, so a running monitor's log isn't wiped
  const out = fs.openSync(log, 'a');
  const from = fs.fstatSync(out).size;
  const child = spawn(process.execPath, [__filename, ...args.filter((a) => a !== '--detach')], {
    detached: true, stdio: ['ignore', out, out], env: process.env,
  });
  child.unref();
  let exited = false;
  child.on('exit', () => { exited = true; });
  const t0 = Date.now();
  const poll = setInterval(() => {
    const text = fs.readFileSync(log).subarray(from).toString('utf8');
    if (/→ http/.test(text) || exited || Date.now() - t0 > 8000) {
      clearInterval(poll);
      process.stdout.write(text || 'monitor did not report a URL; see ' + log + '\n');
      if (!exited && /→ http/.test(text) && !/already running/.test(text)) console.log(`(running in the background, pid ${child.pid}; log: ${log})`);
      process.exit(/→ http/.test(text) ? 0 : 1);
    }
  }, 100);
}

// --stop: find a running monitor on our port range and ask it to shut down.
async function stopRunning() {
  for (let port = PORT; port <= PORT + 10; port++) {
    if (!(await alreadyRunning(port))) continue;
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/shutdown', method: 'POST', headers: { 'x-monitor': '1' } }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', resolve);
      req.end();
    });
    console.log(`stopped the monitor on port ${port}`);
    process.exit(0);
  }
  console.log('no running monitor found');
  process.exit(0);
}

if (args.includes('--detach')) detach();
else if (args.includes('--stop')) stopRunning();
else {
  process.on('SIGINT', () => shutdown('Ctrl+C'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  listen(PORT, 10);
}
