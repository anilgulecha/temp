// Agent 100's own test: starts it (the way a student does, or a given command) and checks its HTTP answers: pairing,
// the home-folder fence, files, real bash (output, exit codes, timeout, Stop), a repeated command reattaching, ping,
// stopping with its terminal. No browser. Exits nonzero on any failure.
//   node test.mjs                       run ./a100.mjs with node, in a throwaway home folder
//   node test.mjs --cmd "npx -y …"      start Agent 100 with this command instead (it must accept --port and --home)
//   node test.mjs --no-home             use the real home folder (Windows: Agent 100 lives in WSL, with its own home)
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const opt = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const PORT = Number(opt('port') ?? 4799), TOKEN = 'test-token-0123456789abcdef', B = `http://127.0.0.1:${PORT}`;
const home = process.argv.includes('--no-home') ? null : realpathSync(mkdtempSync(`${tmpdir()}/a100-test-`));
const cmd = opt('cmd') ?? `"${process.execPath}" "${fileURLToPath(new URL('a100.mjs', import.meta.url))}"`;
const results = []; let failed = 0;
const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) failed++; console.log(results.at(-1)); };

if (await fetch(`${B}/ping`, { method: 'OPTIONS' }).then(() => true, () => false)) { console.log(`BLOCKED: port ${PORT} is in use (an Agent 100 from an earlier run?)`); process.exit(3); }
const args = ['--port', String(PORT), ...(home ? ['--home', home] : []), '--yes'];
const child = spawn(`${cmd} ${args.join(' ')}`, { shell: true, env: { ...process.env, A100_TOKEN: TOKEN, WSLENV: `${process.env.WSLENV ? `${process.env.WSLENV}:` : ''}A100_TOKEN` }, stdio: ['pipe', 'pipe', 'pipe'], detached: platform() !== 'win32' });
let printed = ''; child.stdout.on('data', (d) => { printed += d; }); child.stderr.on('data', (d) => { printed += d; });
// Stop Agent 100 itself, not just the shell that started it: its stdin closing (Windows launcher), then the process group.
const stopAll = () => { try { child.stdin.end(); } catch {} try { if (platform() === 'win32') child.kill(); else process.kill(-child.pid, 'SIGTERM'); } catch {} if (home) rmSync(home, { recursive: true, force: true }); };
process.on('exit', stopAll);
const deadline = setTimeout(() => { console.log('TIMEOUT\n', printed.slice(-2000)); stopAll(); process.exit(2); }, Number(opt('timeout') ?? 600) * 1000);

const post = (op, body, token = TOKEN, headers = {}) => fetch(`${B}/${op}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });
const call = async (op, body) => (await post(op, body)).json();
const exec = async (body) => { const t = await (await post('exec', body)).text(); const lines = t.trim().split('\n').map((l) => JSON.parse(l)); return { out: lines.filter((l) => l.o !== undefined).map((l) => l.o).join(''), end: lines.at(-1) }; };

try {
  // Up: the printed code, then ping (Windows: the first run installs Node inside WSL, so wait long).
  for (let i = 0; ; i++) { if (await fetch(`${B}/ping`, { method: 'OPTIONS' }).then(() => true, () => false)) break; if (child.exitCode !== null) throw new Error(`Agent 100 exited (${child.exitCode}):\n${printed}`); await new Promise((r) => setTimeout(r, 500)); }
  await new Promise((r) => setTimeout(r, 300));
  check('prints the pairing code', printed.includes(`a100-${PORT}-${TOKEN}`));
  check('ping', (await call('ping')).value !== undefined);
  const hello = (await call('hello')).value;
  check('hello', !!hello?.home && !!hello?.root, JSON.stringify({ os: hello?.os, home: hello?.home, windows: hello?.windows, }));
  const H = hello.home, R = hello.root;
  check('wrong code refused', (await post('ping', {}, 'wrong-token-0123456789abcdef')).status === 401);
  const rebound = await new Promise((ok) => request({ host: '127.0.0.1', port: PORT, path: '/ping', method: 'POST', headers: { host: `evil.example:${PORT}`, authorization: `Bearer ${TOKEN}` } }, (res) => { res.resume(); ok(res.statusCode); }).on('error', () => ok(0)).end('{}'));
  check('other Host refused (DNS rebinding)', rebound === 403, String(rebound));
  const pre = await fetch(`${B}/exec`, { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' } });
  check('preflight from an opaque origin (local network access)', pre.status === 204 && pre.headers.get('access-control-allow-private-network') === 'true');

  // Files in the lab folder.
  const lab = (await call('folder', { name: 'test-lab' })).value?.path;
  check('lab folder under the root', lab?.startsWith(R), lab);
  const bytes = Buffer.from('héllo\nwörld\n');
  check('write', (await call('write', { path: `${lab}/dir/a.txt`, b64: bytes.toString('base64') })).value !== undefined);
  check('read back the same bytes', Buffer.from((await call('read', { path: `${lab}/dir/a.txt` })).value?.b64 ?? '', 'base64').equals(bytes));
  check('stat', (await call('stat', { path: `${lab}/dir/a.txt` })).value?.size === bytes.length);
  check('list', (await call('list', { path: `${lab}/dir` })).value?.map((f) => f.name).join() === 'a.txt');
  const t = JSON.stringify((await call('tree', { path: lab })).value);
  const entry = JSON.parse(t)[0]?.children?.find((e) => e.path === 'dir/a.txt');
  check('tree, with sizes and modification times', entry?.size === bytes.length && entry?.mtimeMs > 0, JSON.stringify(entry));
  check('missing file → not_found', (await call('read', { path: `${lab}/nope.txt` })).error?.code === 'not_found');

  // The fence: outside home, .. and symlinks out.
  check('outside home refused', (await call('read', { path: '/etc/hosts' })).error?.code === 'permission_denied');
  check('.. out of home refused', (await call('stat', { path: `${lab}/../../../../../../etc/hosts` })).error?.code === 'permission_denied');
  await exec({ call: 'ln', command: 'ln -s /etc etc-link', cwd: lab });
  check('symlink out of home refused', (await call('read', { path: `${lab}/etc-link/hosts` })).error?.code === 'permission_denied');
  check('relative path refused', (await call('read', { path: 'dir/a.txt' })).error?.code === 'invalid');

  // Real bash.
  let r = await exec({ call: 'b1', command: 'echo "$BASH_VERSION" | cut -d. -f1; pwd; cat dir/a.txt; echo oops >&2; exit 3', cwd: lab });
  check('bash runs in the lab folder', r.out.includes(lab) && /^\d+\n/.test(r.out), JSON.stringify(r.out.slice(0, 80)));
  check('stdout + stderr, UTF-8', r.out.includes('wörld') && r.out.includes('oops'));
  check('exit code', r.end.exit === 3);
  r = await exec({ call: 'b2', command: 'uname -s; command -v git python3 node | sed "s#.*/##" | tr "\\n" " "', cwd: lab });
  check('a real system (uname, tools found)', r.end.exit === 0, r.out.trim().replace(/\n/g, ' · '));
  r = await exec({ call: 'b3', command: 'echo "$GREETING"', cwd: lab, env: { GREETING: 'hi from env' } });
  check('environment variables', r.out.trim() === 'hi from env');
  r = await exec({ call: 'b4', command: 'sleep 30', cwd: lab, timeout: 1 });
  check('timeout', r.end.error?.code === 'timeout');
  // Stop: a long command, stopped from a second request; it must not finish (no done.txt).
  const long = exec({ call: 'b5', command: 'sleep 3; echo late > done.txt', cwd: lab });
  await new Promise((x) => setTimeout(x, 500)); await call('stop', { call: 'b5' });
  r = await long; await new Promise((x) => setTimeout(x, 3000));
  check('Stop kills the command and its children', r.end.error?.code === 'aborted' && (await call('stat', { path: `${lab}/done.txt` })).error?.code === 'not_found');
  // Asking again for the same call (a page reload) reattaches: it runs once.
  const first = exec({ call: 'b6', command: 'echo run >> runs.txt; sleep 1; echo ok', cwd: lab });
  await new Promise((x) => setTimeout(x, 300));
  const [a, b] = await Promise.all([first, exec({ call: 'b6', command: 'echo run >> runs.txt; sleep 1; echo ok', cwd: lab })]);
  const c = await exec({ call: 'b6', command: 'ignored', cwd: lab });
  const runs = Buffer.from((await call('read', { path: `${lab}/runs.txt` })).value?.b64 ?? '', 'base64').toString();
  check('same call again: reattached, ran once', a.out === 'ok\n' && b.out === 'ok\n' && c.out === 'ok\n' && runs === 'run\n', JSON.stringify(runs));
  check('remove', (await call('remove', { path: `${lab}/dir`, recursive: true })).value !== undefined && (await call('stat', { path: `${lab}/dir` })).error?.code === 'not_found');
  check('clear the lab folder', (await call('clear', { name: 'test-lab' })).value !== undefined && (await call('list', { path: lab })).value?.length === 0);
  // Closing the terminal (its input ends; on Windows the launcher passes that on into WSL) stops Agent 100.
  try { child.stdin.end(); } catch {}
  if (platform() !== 'win32') try { process.kill(-child.pid, 'SIGHUP'); } catch {}
  let gone = false; for (let i = 0; i < 40 && !gone; i++) { await new Promise((x) => setTimeout(x, 250)); gone = !(await fetch(`${B}/ping`, { method: 'OPTIONS' }).then(() => true, () => false)); }
  check('stops when its terminal closes', gone);
} catch (e) { check('no unexpected error', false, `${e.stack}\n--- Agent 100 printed:\n${printed.slice(-2000)}`); }
clearTimeout(deadline); stopAll();
console.log(`\n${results.length - failed}/${results.length} passed on ${platform()}${process.env.WSL_DISTRO_NAME ? ` (WSL ${process.env.WSL_DISTRO_NAME})` : ''}`);
process.exit(failed ? 1 : 0);
