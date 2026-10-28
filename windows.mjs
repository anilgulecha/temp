// Windows: Agent 100 runs inside WSL (real bash there; files in the Linux home). A small port of the 1.6.0 launcher:
// with your consent it installs WSL + Ubuntu, opens the distribution's first-user setup, and installs Node (official
// build, SHA-256 checked) into ~/.local/share/agent100 inside WSL; then it copies this exact Agent 100 file there and
// runs it as your Linux user. Every change is asked first (--yes answers yes, for CI). No sudo, profile or PATH changes.
// Agent 100's stdin is a pipe from here: closing this window (or Ctrl-C) ends it inside WSL too.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

const NODE = { version: '24.21.0', url: (arch) => `https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-${arch}.tar.gz`,
  sha256: { x64: '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff', arm64: '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5' } };
// Inside WSL, Agent 100 (and the Agent's bash) gets this PATH: its Node first, then the standard Linux directories, and no
// Windows directories (WSL appends those, and Windows' node/npm would then shadow Linux ones).
const LINUX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const APP = '.local/share/agent100', INSTALL = ['--install', '-d', 'Ubuntu', '--web-download', '--no-launch'];
const say = (s = '') => process.stderr.write(`${s}\n`);
const text = (b) => (!b?.length ? '' : (b.includes(0) ? b.toString('utf16le') : b.toString('utf8')).replace(/^\uFEFF/, '').replaceAll('\0', ''));

export async function runWindows(argv, { version, self, command }) {
  const yes = argv.includes('--yes'), at = argv.indexOf('--wsl-distro'), distro = at >= 0 ? argv[at + 1] : undefined;
  const forwarded = argv.filter((a, i) => a !== '--yes' && (at < 0 || (i !== at && i !== at + 1)));
  const d = distro ? ['-d', distro] : [], name = distro ? ` -d ${distro}` : '';
  const interactive = process.stdin.isTTY && process.stderr.isTTY;
  const agree = async (q) => {
    if (yes) { say(`${q} yes (--yes)`); return true; }
    if (!interactive) return false;
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try { return /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim()); } finally { rl.close(); }
  };
  const wsl = (args, o = {}) => spawnSync('wsl.exe', args, { input: o.input, timeout: o.timeout ?? 120_000, maxBuffer: 1 << 26, windowsHide: true, env: { ...process.env, WSL_UTF8: '1' } });
  const stop = (...lines) => { say(['', ...lines].join('\n')); return 1; };

  // 1. WSL with a Linux distribution.
  const listed = () => { const l = wsl(['--list', '--quiet'], { timeout: 30_000 });
    return l.error?.code === 'ENOENT' ? null : l.status === 0 ? text(l.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : []; };
  let distros = listed();
  if (!distros?.length) {
    say(`Agent 100 runs on Windows inside WSL (Windows Subsystem for Linux), which ${distros ? 'has no Linux distribution yet' : 'is not installed here'}.`);
    if (!(await agree(`Install WSL with Ubuntu now (wsl.exe ${INSTALL.join(' ')})? Windows may ask for administrator approval and a restart.`)))
      return stop('Nothing was changed. To do it yourself, in an administrator PowerShell:', `  wsl.exe ${INSTALL.join(' ')}`, `Then run again: ${command}`);
    spawnSync('wsl.exe', INSTALL, { stdio: 'inherit' });
    distros = listed();
    if (!distros?.length) return stop(`If Windows asked for a restart, restart it. Then run again: ${command}`);
  }
  if (distro && !distros.includes(distro)) return stop(`WSL has no distribution "${distro}". Installed: ${distros.join(', ')}`);

  // 2. An ordinary Linux user (not root) with a home, and Node 20+.
  const PROBE = 'echo "uid=$(id -u)"; echo "home=$HOME"; echo "arch=$(uname -m)"; for n in "$HOME/$2/node-v$1/bin/node" "$(PATH=$3 command -v node)"; do [ -n "$n" ] && [ -x "$n" ] && echo "node=$n $("$n" --version)"; done; exit 0';
  const probe = () => {
    const r = wsl([...d, '--cd', '~', '--exec', 'sh', '-c', PROBE, 'probe', NODE.version, APP, LINUX_PATH]); if (r.status !== 0) return null;
    const v = {}; for (const l of text(r.stdout).split(/\r?\n/)) { const i = l.indexOf('='); if (i > 0) (v[l.slice(0, i)] ??= []).push(l.slice(i + 1).trim()); }
    return v.uid ? v : null;
  };
  let p = probe();
  if (!p) return stop(`WSL did not start. If it was just installed, restart Windows; or open it once with: wsl.exe${name}`);
  if (p.uid[0] === '0') {
    say('Your WSL distribution has no ordinary Linux user yet (it runs as root), and Agent 100 does not run as root.');
    // Its first-time setup asks a person for a username and password: never answered by --yes or without a terminal.
    if (!interactive) return stop(`Open it once (wsl.exe${name}), create your Linux user, type exit, then run again: ${command}`);
    if (!(await agree('Open its first-time setup now? It asks you to choose a Linux username and password; type exit at the Linux prompt to come back.')))
      return stop(`Open it once yourself (wsl.exe${name}), create your user, type exit, then run again: ${command}`);
    spawnSync('wsl.exe', d, { stdio: 'inherit' }); p = probe();
    if (!p || p.uid[0] === '0') return stop(`The default Linux user is still root. Create your user, then run again: ${command}`);
  }
  const home = p.home[0], arch = { x86_64: 'x64', aarch64: 'arm64' }[p.arch[0]] ?? p.arch[0];
  let node = (p.node ?? []).map((l) => l.split(' ')).find(([, v]) => Number(/^v(\d+)\./.exec(v ?? '')?.[1]) >= 20)?.[0];
  if (!node) {
    if (!NODE.sha256[arch]) return stop(`There is no Node build for Linux on ${arch}.`);
    if (!(await agree(`Agent 100 needs Node inside WSL. Install Node ${NODE.version} (official build, SHA-256 checked) into ~/${APP} there? No sudo; nothing else changes.`)))
      return stop('Nothing was changed.');
    say(`Downloading Node ${NODE.version} for Linux ${arch}…`);
    const res = await fetch(NODE.url(arch)); if (!res.ok) return stop(`Could not download Node (HTTP ${res.status}).`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== NODE.sha256[arch]) return stop('The Node download did not match its checksum; nothing was installed.');
    const target = `${home}/${APP}/node-v${NODE.version}`;
    const r = wsl([...d, '--cd', '~', '--exec', 'sh', '-c', 'set -e; rm -rf "$1.tmp"; mkdir -p "$1.tmp"; tar -xzf - -C "$1.tmp" --strip-components=1 --no-same-owner; rm -rf "$1"; mv "$1.tmp" "$1"', 'node-install', target], { input: bytes, timeout: 300_000 });
    if (r.status !== 0) return stop(`Installing Node inside WSL failed: ${text(r.stderr).slice(-300)}`);
    node = `${target}/bin/node`;
  }

  // 3. This exact Agent 100 file in WSL, then run it there.
  const file = `${home}/${APP}/a100-${version}.mjs`;
  const c = wsl([...d, '--cd', '~', '--exec', 'sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'copy', file], { input: readFileSync(self) });
  if (c.status !== 0) return stop(`Could not copy Agent 100 into WSL: ${text(c.stderr).slice(-300)}`);
  const bin = node.slice(0, node.lastIndexOf('/'));
  const child = spawn('wsl.exe', [...d, '--cd', '~', '--exec', '/usr/bin/env', `PATH=${bin}:${LINUX_PATH}`, node, file, '--parent-stdin', ...forwarded], { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: false });
  // Agent 100 in WSL stops when its stdin closes: on Ctrl-C, when this window closes, or when our own stdin ends.
  const end = () => { try { child.stdin.end(); } catch {} };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(s, end);
  process.stdin.on('end', end).on('close', end).resume();
  return new Promise((done) => { child.on('error', (e) => done(stop(`Could not start wsl.exe: ${e.message}`))); child.on('exit', (code) => done(code ?? 1)); });
}
