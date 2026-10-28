#!/usr/bin/env node
// Agent 100 2.0 (spike): real bash and files on this computer for a KiteRooms lab. The lab page (Pi, the model, the
// Teacher, the conversation, every rule about who may do what) stays in the browser; this only runs the commands and
// file actions the page asks for, on loopback,
// for a page that has the pairing code. No dependencies. Linux and macOS run it directly; on Windows it runs itself
// inside WSL (windows.mjs), so the Agent always gets a real bash.
//   File actions: anywhere under your home folder (symlinks resolved). Commands: real bash as you, starting in the
//   lab's folder under ~/kiterooms (bash itself is not confined).
//   Each command is keyed by its tool call: asking again (after a reload) reattaches to it or returns its result.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir, tmpdir, platform, constants } from 'node:os';
import { mkdir, readFile, writeFile, readdir, stat, lstat, realpath, rm, mkdtemp } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '2.0.0-spike.0', NPX = 'npx @kalviumjr/agent100@2';
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
if (process.argv.includes('--help')) { console.log(`Usage: a100 [--port 4777] [--root ~/kiterooms]${platform() === 'win32' ? ' [--wsl-distro <name>] [--yes]' : ''}\nGives a KiteRooms lab real bash and files on this computer.${platform() === 'win32' ? '\nOn Windows it runs inside WSL, asking before it sets anything up (--yes: agree to every step).' : ''}`); process.exit(0); }
if (process.argv.includes('--version')) { console.log(VERSION); process.exit(0); }
if (platform() === 'win32') { const { runWindows } = await import('./windows.mjs'); process.exit(await runWindows(process.argv.slice(2), { version: VERSION, self: fileURLToPath(import.meta.url), command: NPX })); }

const HOME = await realpath(resolve(arg('home', homedir()))), TMP = await realpath(tmpdir());
const ROOT = resolve(arg('root', join(HOME, 'kiterooms'))), PORT = Number(arg('port', 4777));
// The pairing token stays the same across restarts (a paired lab reconnects by itself), in a file only you can read.
function pairingToken() {
  if (process.env.A100_TOKEN) return process.env.A100_TOKEN; // tests
  const dir = platform() === 'darwin' ? join(homedir(), 'Library/Application Support/Agent100') : join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'agent100');
  const file = join(dir, 'pairing-token');
  try { return readFileSync(file, 'utf8').trim(); } catch {}
  mkdirSync(dir, { recursive: true, mode: 0o700 }); const t = randomBytes(18).toString('base64url'); writeFileSync(file, t, { mode: 0o600 }); return t;
}
const TOKEN = Buffer.from(pairingToken());
const WINDOWS = process.env.WSL_DISTRO_NAME && `\\\\wsl.localhost\\${process.env.WSL_DISTRO_NAME}${ROOT.replaceAll('/', '\\')}`;
const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.cache']); // listed, not walked

const fail = (code, message) => Object.assign(new Error(message), { code });
const CODES = { ENOENT: 'not_found', EACCES: 'permission_denied', EPERM: 'permission_denied', ENOTDIR: 'not_directory', EISDIR: 'is_directory', EINVAL: 'invalid' };
const inside = (p) => [HOME, TMP].some((r) => p === r || p.startsWith(r + sep));
/** An absolute path inside your home folder (or the temp folder), with symlinks resolved; anything else is refused. */
async function safe(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) throw fail('invalid', 'an absolute path is needed');
  let probe = resolve(p); const rest = [];
  for (;;) {
    let real;
    try { real = await realpath(probe); } catch (e) { if (e.code !== 'ENOENT') throw e; rest.unshift(basename(probe)); probe = dirname(probe); continue; }
    const full = join(real, ...rest);
    if (!inside(full)) throw fail('permission_denied', `Agent 100 only works inside your home folder (${HOME}): ${p}`);
    return full;
  }
}
const folderPath = (name) => { if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(name ?? '')) throw fail('invalid', 'bad folder name'); return join(ROOT, name); };
async function info(p) { const s = await lstat(p); return { name: basename(p), path: p, kind: s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'symlink' : 'file', size: s.size, mtimeMs: s.mtimeMs }; }
async function tree(dir, base = dir, budget = { n: 3000 }) {
  const out = [];
  for (const n of (await readdir(dir)).sort()) {
    if (--budget.n < 0) break;
    const p = join(dir, n), s = await lstat(p), rel = p.slice(base.length + 1);
    out.push(s.isDirectory() ? { path: rel, dir: true, children: SKIP.has(n) ? [] : await tree(p, base, budget) } : { path: rel, size: s.size, mtimeMs: s.mtimeMs });
  }
  return out;
}

const ops = {
  ping: async () => ({}), // the page asks once a second, to show when Agent 100 is gone
  hello: async () => ({ version: VERSION, home: HOME, root: ROOT, windows: WINDOWS || null, os: platform() }),
  folder: async ({ name }) => { const p = folderPath(name); await mkdir(p, { recursive: true }); return { path: await realpath(p), files: (await readdir(p)).length }; },
  clear: async ({ name }) => { const p = folderPath(name); await rm(p, { recursive: true, force: true }); await mkdir(p, { recursive: true }); return {}; },
  stat: async ({ path }) => info(await safe(path)),
  read: async ({ path }) => { const p = await safe(path); if ((await stat(p)).size > 20e6) throw fail('invalid', 'file too big'); return { b64: (await readFile(p)).toString('base64') }; },
  write: async ({ path, b64 }) => { const p = await safe(path); await mkdir(dirname(p), { recursive: true }); await writeFile(p, Buffer.from(b64, 'base64')); return {}; },
  mkdir: async ({ path }) => { await mkdir(await safe(path), { recursive: true }); return {}; },
  list: async ({ path }) => { const p = await safe(path); return Promise.all((await readdir(p)).map((n) => info(join(p, n)))); },
  tree: async ({ path }) => tree(await safe(path)),
  realpath: async ({ path }) => ({ path: await realpath(await safe(path)) }),
  remove: async ({ path, recursive }) => { await rm(await safe(path), { recursive: !!recursive, force: true }); return {}; },
  tmpdir: async ({ prefix }) => ({ path: await mkdtemp(join(TMP, `a100-${String(prefix ?? '').replace(/[^\w-]/g, '')}`)) }),
  stop: async ({ call }) => { runs.get(call)?.kill('aborted'); return {}; },
};

// Commands, keyed by the page's tool call. Output is kept (its last 2 MB) so a page that reloads can reattach.
const runs = new Map();
async function begin(call, { command, cwd, env, timeout }) {
  const r = { out: [], size: 0, subs: new Set(), done: null, why: null };
  runs.set(call, r);
  const emit = (m) => { r.out.push(m); r.size += m.o.length; while (r.size > 2e6 && r.out.length > 1) r.size -= r.out.shift().o.length; for (const s of r.subs) s(m); };
  const finish = (m) => { if (r.done) return; r.done = m; r.at = Date.now(); for (const s of r.subs) s(m); r.subs.clear(); prune(); };
  try {
    const dir = await safe(cwd);
    const child = spawn('bash', ['-c', String(command)], { cwd: dir, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    r.kill = (why) => { r.why ??= why; try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = timeout > 0 && setTimeout(() => r.kill('timeout'), timeout * 1000);
    for (const s of ['stdout', 'stderr']) child[s].setEncoding('utf8').on('data', (o) => emit({ o, s }));
    child.on('error', (e) => finish({ error: { code: 'spawn_error', message: e.message } }));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      finish(r.why ? { error: { code: r.why, message: r.why === 'timeout' ? `timed out after ${timeout} s` : 'stopped' } } : { exit: code ?? 128 + (constants.signals[signal] ?? 0) });
    });
  } catch (e) { r.kill = () => {}; finish({ error: { code: e.code === 'permission_denied' || e.code === 'not_found' ? 'spawn_error' : 'unknown', message: e.message } }); }
  return r;
}
function prune() { const done = [...runs].filter(([, r]) => r.done).sort((a, b) => a[1].at - b[1].at); for (const [k, r] of done) if (done.length - 300 > 0 || Date.now() - r.at > 30 * 60e3) { runs.delete(k); done.shift(); } }

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'POST',
  'access-control-allow-private-network': 'true', 'access-control-max-age': '600' };
const authorized = (req) => { const t = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, '')); return t.length === TOKEN.length && timingSafeEqual(t, TOKEN); };
async function body(req) { const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > 64e6) throw fail('invalid', 'request too big'); chunks.push(c); } return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
const server = createServer(async (req, res) => {
  // Only for pages that reached us as 127.0.0.1 / localhost (not a DNS name rebound to us), with the pairing code.
  if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)) { res.writeHead(403); return res.end(); }
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const json = (status, value) => { res.writeHead(status, { ...CORS, 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (req.method !== 'POST' || !authorized(req)) return json(401, { error: { code: 'unauthorized', message: 'wrong pairing code' } });
  let args; try { args = await body(req); } catch (e) { return json(400, { error: { code: 'invalid', message: e.message } }); }
  if (req.url === '/exec') { // NDJSON: { o, s } output chunks, then { exit } or { error }
    if (typeof args.call !== 'string' || !args.call) return json(400, { error: { code: 'invalid', message: 'call is needed' } });
    const r = runs.get(args.call) ?? (await begin(args.call, args));
    res.writeHead(200, { ...CORS, 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    const send = (m) => res.write(`${JSON.stringify(m)}\n`);
    for (const m of r.out) send(m);
    if (r.done) { send(r.done); return res.end(); }
    const sub = (m) => { send(m); if (!m.o && m.o !== '') res.end(); };
    r.subs.add(sub); res.on('close', () => r.subs.delete(sub)); // the page went away: the command keeps running
    return;
  }
  const op = Object.hasOwn(ops, req.url.slice(1)) && ops[req.url.slice(1)];
  if (!op) return json(404, { error: { code: 'invalid', message: 'no such operation' } });
  try { json(200, { value: await op(args) }); } catch (e) { json(200, { error: { code: CODES[e.code] ?? e.code ?? 'unknown', message: e.message } }); }
});
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is in use: is Agent 100 already running? (Or use --port.)` : e.message); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent 100 ${VERSION}: real bash and files for your KiteRooms labs.\nLab folders: ${ROOT}${WINDOWS ? `\n  In Windows: ${WINDOWS}` : ''}`);
  console.log(`\nPaste this code into the lab when it asks:\n\n    a100-${PORT}-${TOKEN}\n\nKeep this window open while you work. Ctrl-C stops Agent 100.`);
});
const quit = () => { for (const r of runs.values()) if (!r.done) r.kill('aborted'); process.exit(0); };
process.on('SIGINT', quit); process.on('SIGTERM', quit); process.on('SIGHUP', quit);
// Started by the Windows launcher: its pipe closes when the Windows window does, and then Agent 100 stops too.
if (process.argv.includes('--parent-stdin')) { process.stdin.on('end', quit).on('close', quit).resume(); }
