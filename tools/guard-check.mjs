#!/usr/bin/env node
// Proves the two things the security commit claims: that a socket is held to the
// same origin rule the mutating routes stand behind, and that nothing is on the
// network unless somebody typed a flag saying so.
//
// Both claims are about what the server *refuses*, and a refusal is the one kind of
// behaviour that looks identical to a feature that was never reached. So every row
// here has a positive twin: the cross-origin upgrade must be refused **and** the
// same-origin one must open, the LAN address must be unreachable by default **and**
// reachable under `--host`. A check that only asserted the refusals would pass just
// as happily against a server that refused every upgrade, or bound to nothing at all.
//
// The bind half cannot be faked with a loopback alias. It asks the real network
// interface this machine has, because "not listening on 0.0.0.0" is only a
// meaningful claim if there is a second address a client could have arrived on -
// which is why a machine with no non-internal IPv4 makes this UNPROVEN rather than
// a pass. Same reading as `library-check`'s low-space row: "not tested here" and
// "tested and fine" are different answers.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const { WebSocket } = createRequire(join(REPO, 'package.json'))('ws');

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const PORT = Number(flag('--port', '8321'));
const MUTATE = flag('--mutate');
const WORK = join(REPO, '.guard-check');

// --- mutations -------------------------------------------------------------
// Each names source text and must match exactly once, because a replacement that
// matched nothing would spawn the unmutated server and be recorded as this check
// having missed a bug it was never shown.
//
// One row per term, deliberately. `origin-allows-null` exists because
// `upgrade-skips-origin` fails four rows at once, and a mutation that fails
// everything cannot tell you which assertion is load-bearing - the same reason
// step 6 split its cumulative grade table into one row per term.
const MUTATIONS = {
  // The control for the whole guard: the upgrade stops asking.
  'upgrade-skips-origin': { file: 'server/index.js', edits: [[
    `  if (!originAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\\r\\nConnection: close\\r\\n\\r\\n');
    socket.destroy();
    return;
  }
`, '']] },
  // The control for the bind: back to whatever Node does when nobody says.
  'listen-any-host': { file: 'server/index.js', edits: [[
    "const HOST = flag('--host', LOOPBACK);", "const HOST = flag('--host', '0.0.0.0');"]] },
  // The control for the scheme half. It is the predicate as originally written -
  // a parsed origin host against a raw Host string - which passed every row this
  // file had before an external review pointed at it.
  'origin-ignores-scheme': { file: 'server/http-guard.js', edits: [[
    "  return originUrl.protocol === 'http:' && originUrl.host === hostUrl.host;",
    '  return originUrl.host === rawHost;',
  ]] },
  // The control for the authority-shape check, which is the hole the scheme fix
  // opened and this closed.
  'host-parsed-loosely': { file: 'server/http-guard.js', edits: [[
    '  if (/[@/?#\\s\\\\]/.test(rawHost)) return false;',
    '  if (false) return false;',
  ]] },
  // A `file://` page and a sandboxed iframe both send the literal string `null`,
  // which is not a URL and is same-origin with anything. Treating an unparseable
  // origin as absent is the plausible wrong reading of "no origin is not a browser".
  'origin-allows-null': { file: 'server/http-guard.js', edits: [[
    `  } catch {
    // \`null\` is what a sandboxed iframe and a \`file://\` page send, and it is not a
    // URL. Neither is same-origin with anything.
    return false;
  }`, `  } catch {
    return true;
  }`]] },
};
if (MUTATE && !MUTATIONS[MUTATE]) {
  console.error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

// --- the staged tree -------------------------------------------------------
// Copied out of `server/` with the siblings symlinked, exactly as `library-check`
// does it: a mutation applied in place and restored afterwards leaves a mutated
// working tree behind any crash, which is the one state a proof tool must never be
// able to produce.
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
cpSync(join(REPO, 'server'), join(WORK, 'server'), { recursive: true });
for (const name of ['web', 'node_modules', 'vendor', 'captures']) {
  const from = join(REPO, name);
  if (existsSync(from)) symlinkSync(from, join(WORK, name));
}
if (MUTATE) {
  const spec = MUTATIONS[MUTATE];
  const path = join(WORK, spec.file);
  let source = readFileSync(path, 'utf8');
  for (const [from, to] of spec.edits) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) {
      console.error(`mutation ${MUTATE} matched ${hits} times in ${spec.file}, expected exactly 1 - refusing to run an unmutated server`);
      process.exit(2);
    }
    source = source.replace(from, to);
  }
  writeFileSync(path, source);
}

// --- harness ---------------------------------------------------------------
let checked = 0, failed = 0, unproven = 0;
const ok = (label, pass, detail = '') => {
  checked++;
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const servers = [];
const start = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(WORK, 'server/index.js'), '--port', String(PORT), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(child);
  const log = [];
  const onData = (c) => {
    log.push(c.toString());
    if (log.join('').includes('viewer on')) setTimeout(() => resolve(() => log.join('')), 150);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  setTimeout(() => reject(new Error(`server never came up:\n${log.join('')}`)), 15000);
});
const stopAll = () => { for (const c of servers) c.kill('SIGKILL'); servers.length = 0; };

// A WebSocket upgrade carrying whatever Origin we choose. `null` as the argument
// means send no header at all, which is what every server-side fetch across the
// capture-node link looks like.
const upgrade = (origin, path = '/') => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`, origin === null ? {} : { headers: { Origin: origin } });
  const done = (r) => { try { ws.terminate(); } catch { /* already gone */ } resolve(r); };
  ws.on('open', () => done('open'));
  ws.on('unexpected-response', (_req, res) => done(`refused ${res.statusCode}`));
  ws.on('error', (e) => done(`error ${e.message}`));
  setTimeout(() => done('timeout'), 5000);
});

// An upgrade carrying a chosen Host as well as a chosen Origin. The two are
// compared against each other, so a row that only ever varies one of them is
// testing half the predicate.
const upgradeWithHost = (origin, host) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, { headers: { Origin: origin, Host: host } });
  const done = (r) => { try { ws.terminate(); } catch { /* already gone */ } resolve(r); };
  ws.on('open', () => done('open'));
  ws.on('unexpected-response', (_req, res) => done(`refused ${res.statusCode}`));
  ws.on('error', (e) => done(`error ${e.message}`));
  setTimeout(() => done('timeout'), 5000);
});

// Two Host headers, which `req.headers.host` collapses to the first. Sent down a
// raw socket because no HTTP client will produce it on purpose - and it must not
// open, whether Node rejects the request outright or the guard does.
const duplicateHostUpgrade = () => new Promise((resolve) => {
  const s = new Socket();
  let seen = '';
  const done = (r) => { s.destroy(); resolve(r); };
  s.setTimeout(5000);
  s.once('timeout', () => done('timeout'));
  s.once('error', (e) => done(`error ${e.message}`));
  s.on('data', (c) => {
    seen += c.toString();
    if (seen.includes('\r\n')) done(seen.split('\r\n')[0]);
  });
  s.connect(PORT, '127.0.0.1', () => {
    s.write([
      'GET / HTTP/1.1',
      'Host: 127.0.0.1:' + PORT,
      'Host: evil.example',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + Buffer.from('0123456789abcdef').toString('base64'),
      'Sec-WebSocket-Version: 13',
      'Origin: http://127.0.0.1:' + PORT,
      '', '',
    ].join('\r\n'));
  });
});

const reachable = (host) => new Promise((resolve) => {
  const s = new Socket();
  const done = (r) => { s.destroy(); resolve(r); };
  s.setTimeout(3000);
  s.once('connect', () => done(true));
  s.once('timeout', () => done(false));
  s.once('error', () => done(false));
  s.connect(PORT, host);
});

const LAN = Object.values(networkInterfaces()).flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? null;
const SAMPLE = join(REPO, 'captures', 'sample.knct');

try {
  console.log(`[guard] ${MUTATE ? `MUTATED: ${MUTATE} (${MUTATIONS[MUTATE].file})` : 'unmutated tree'}`);
  console.log(`[guard] lan address ${LAN ?? '(none - the bind rows cannot be tested here)'}\n`);

  console.log('[guard] the socket is held to the same origin rule the mutating routes are');
  await start(['--replay', SAMPLE]);
  ok('a page on this server may open the viewer socket', await upgrade(`http://127.0.0.1:${PORT}`) === 'open');
  ok('a page somewhere else may not, and WebSocket has no preflight to stop it first',
    await upgrade('http://evil.example') === 'refused 403');
  ok('a `file://` page or sandboxed iframe sending literal `null` is refused too',
    await upgrade('null') === 'refused 403');
  ok('a request with no Origin still opens, which is what every capture-node fetch is',
    await upgrade(null) === 'open');
  ok('the export socket is behind the same answer, not just the viewer one',
    await upgrade('http://evil.example', '/export') === 'refused 403');
  ok('and an unknown socket path is still a 404 rather than a 403, so the guard did not swallow the router',
    await upgrade(`http://127.0.0.1:${PORT}`, '/nope') === 'refused 404');

  // **These four came out of an external review, and the predicate as first
  // written passed every row above while failing all of them.** An origin is a
  // scheme, a host and a port; comparing a parsed host against a raw header
  // compared one of the three and normalised only one side. So the rows that
  // caught the original guard are the ones sending spellings, not values.
  ok('an https origin is not this http server, even though the host and port match exactly',
    await upgrade(`https://127.0.0.1:${PORT}`) === 'refused 403');
  ok('and neither is a ws: or wss: origin, which is the same hole spelled differently',
    await upgrade(`wss://127.0.0.1:${PORT}`) === 'refused 403');
  // The other direction: a refusal this strict would be a guard that breaks the
  // product, so the canonicalising cases have to still open.
  const hostVariants = await Promise.all([
    upgradeWithHost(`http://127.0.0.1:${PORT}`, `127.0.0.1:${PORT}`),
    upgradeWithHost('http://localhost', 'localhost:80'),
    upgradeWithHost('http://LOCALHOST', 'localhost'),
  ]);
  ok('while spellings of one authority still open - a default port written out, and a host in capitals',
    hostVariants.every((r) => r === 'open'), hostVariants.join(', '));
  // A Host header is an authority and nothing else. `new URL('http://' + host)`
  // consumes userinfo, a path, a query or a fragment and normalises what is left
  // to the trusted authority, so all four of these were allowed by the first
  // version of the parsed comparison - the fix that closed the scheme hole opened
  // these.
  const malformed = await Promise.all([
    upgradeWithHost(`http://127.0.0.1:${PORT}`, `evil.example@127.0.0.1:${PORT}`),
    upgradeWithHost(`http://127.0.0.1:${PORT}`, `127.0.0.1:${PORT}/path`),
    upgradeWithHost(`http://127.0.0.1:${PORT}`, `127.0.0.1:${PORT}?q`),
    upgradeWithHost(`http://127.0.0.1:${PORT}`, `127.0.0.1:${PORT}#f`),
  ]);
  ok('a Host carrying userinfo, a path, a query or a fragment does not upgrade - it is an authority or it is not a Host',
    malformed.every((r) => r !== 'open'), malformed.join(', '));
  const dup = await duplicateHostUpgrade();
  ok('and two Host headers do not upgrade, whoever refuses them - `req.headers.host` keeps only the first, so the one that was checked is not necessarily the one anything downstream believes',
    !/^HTTP\/1\.1 101/.test(dup), dup.slice(0, 40));

  console.log('\n[guard] nothing is on the network unless somebody typed a flag');
  ok('the server is up on loopback', await reachable('127.0.0.1'));
  if (LAN) {
    ok('and is NOT reachable on this machine\'s own LAN address by default', (await reachable(LAN)) === false, LAN);
  } else {
    unproven++;
    console.log(`  UNPROVEN  no non-internal IPv4 on this machine, so "not on the network" has no second address to mean anything`);
  }
  stopAll();

  const log = await start(['--replay', SAMPLE, '--host', '0.0.0.0']);
  ok('--host widens it, so a capture node is still reachable from the Mac', LAN ? await reachable(LAN) : true, LAN ?? 'loopback only');
  ok('and it says so on stdout rather than widening quietly', /reachable from the network/.test(log()));
  ok('the origin guard is unchanged by widening - the bind is not the thing protecting the socket',
    await upgrade('http://evil.example') === 'refused 403');
} catch (err) {
  failed++;
  console.log(`\n  FAIL  the run did not finish: ${err.message}`);
} finally {
  stopAll();
  rmSync(WORK, { recursive: true, force: true });
}

console.log(`\n[guard] ${checked} assertions, ${failed} failed${unproven ? `, ${unproven} unproven` : ''}`);
if (MUTATE) {
  // Exit code alone cannot tell "the mutation was caught" from "the tool crashed
  // before asserting anything", and this repo has been bitten by exactly that.
  if (failed === 0) { console.log('[guard] NOT CAUGHT - the check passed a server it should have rejected'); process.exit(1); }
  console.log(`[guard] caught, as required (${failed} assertion${failed === 1 ? '' : 's'} fired)`);
  process.exit(1);
}
if (failed) { console.log('[guard] FAIL'); process.exit(1); }
if (unproven) { console.log('[guard] PASS, with claims untested here'); process.exit(2); }
console.log('[guard] PASS');
process.exit(0);
