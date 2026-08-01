#!/usr/bin/env node
// Step 9: the monitor negotiates decimation on the live socket, and a take never
// pays for it.
//
// The finding this exists for is gate 5's: a connected viewer degrades the capture
// itself, because backpressure from a link that cannot carry 14.6 MB/s reaches back
// through the server's stdin pipe into the grabber, which then misses USB deadlines
// and drops depth packets. Those frames never reach the file, so no amount of
// downloading recovers them. The behaviour that answers it is a depth divisor and a
// frame stride the client asks for over the socket already carrying the frames.
//
// **Three claims, and the third is the one that matters.**
//
//  1. The negotiation is honest: what the server grants is what it sends, what it
//     refuses it says it refused, and the setting on screen is the setting on the
//     wire. A monitor that displayed `÷4` over a full-rate stream would be the
//     misattribution this whole design is built to avoid.
//  2. It is one mechanism. A socket frame at `÷k` is byte-identical to the same
//     frame from the HTTP frame API at `÷k`, because both call `decimatePayload`.
//     Two loops that agreed today would be two things to keep agreeing.
//  3. **The take is untouched, and that is an identity rather than an assurance.**
//     With a monitor watching at `÷4 ×3`, every frame in the closed take is byte
//     for byte a frame the grabber emitted - checked against the *writer's own log*
//     rather than against anything a reader produced, because step 7 established
//     that asking the library what was recorded makes the library scan the take
//     being written. This is the `nearClip` versus `--min-depth` failure class:
//     footage destroyed in the one situation where nobody is watching for it.
//
// And the refusal, which is the design decision this step had to take upstairs. The
// doc forbids decimation that changes itself - a monitor is an instrument, and an
// instrument that silently rescales is worse than none. So nothing caps a running
// stream; `/record/start` refuses instead, names the monitors and what they cost,
// and takes `acceptMonitorCost` from an operator who means it. **Every refusal here
// has a positive twin**, because a check built only out of refusals passes against a
// server that refuses everything: the coarse monitor must record, the loopback
// monitor must record, and the override must work.
//
//   node tools/monitor-check.mjs
//   node tools/monitor-check.mjs --mutate decimate-reaches-recorder   # must FAIL
//
// It spawns its own servers and needs none running. There is no Kinect on this
// machine, so the stream is `tools/fake-grabber.mjs` - real KNCT framing over real
// depth and real JPEGs read out of a capture, which is what claims 1 to 3 are about.
// **What it does not prove is the sensor half**: that a decimated monitor actually
// stops the grabber dropping USB packets is a measurement on the node with the
// hardware attached, it is in the commit body, and no row here stands in for it.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { MessageParser, TYPE_HELLO, TYPE_FRAME } from '../server/protocol.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const { WebSocket } = createRequire(join(REPO, 'package.json'))('ws');

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const PORT = Number(flag('--port', '8341'));
const MUTATE = flag('--mutate');
const WORK = join(REPO, '.monitor-check');
const SOURCE = join(REPO, 'captures', 'sample.knct');

// --- mutations -------------------------------------------------------------
// Each names source text and must match exactly once. A replacement matching
// nothing would run the unmutated server and be recorded as this check having
// missed a bug it was never shown - and this tool follows the four server tools'
// convention, so a caught mutation exits non-zero with assertions fired.
const MUTATIONS = {
  // **The control for claim 3, and the reason this file exists.** The decimation a
  // monitor asked for reaches the recorder, so the take is written at whatever the
  // viewer happened to be watching - footage destroyed in the one situation where
  // nobody is watching for it.
  //
  // **It leaks into the recorder and nowhere else, and that placement is the whole
  // point.** The first version decimated at the top of `handleMessage`, which
  // corrupted the socket as well - so it failed section 1's very first row and the
  // run aborted long before reaching the take. It was recorded as caught, at six
  // assertions, none of which were about a take. A control that fails for a
  // neighbouring reason is not a control for the thing it names, and this repo has
  // been caught by that exact shape before. Now the socket is untouched, sections 1
  // and 2 pass in full, and what goes red is the identity between the take and the
  // writer's log.
  'decimate-reaches-recorder': { file: 'server/index.js', edits: [[
    '    recorder.write(msg.raw);',
    "    recorder.write(encodeMessage(TYPE_FRAME, decimatePayload(msg.payload, 4, 'leak')));",
  ]] },
  // The stride is accepted, echoed, displayed - and not applied. Every frame goes
  // out. This is what a negotiation that reports rather than acts looks like, and
  // the bytes-on-the-wire rows are what catch it.
  'stride-ignored': { file: 'server/index.js', edits: [[
    '    if (frameSeq % m.stride !== 0) continue;',
    '    if (false) continue;',
  ]] },
  // The divisor is accepted and echoed and never sampled, so a monitor showing `÷8`
  // is pulling 486KB a frame. Same failure as above on the other axis, kept separate
  // because a mutation that fails every row cannot say which row is load-bearing.
  'divisor-ignored': { file: 'server/index.js', edits: [[
    '        out = decimatePayload(payload, m.divisor, `frame ${frameSeq}`);',
    '        out = payload;',
  ]] },
  // The server applies the setting and does not say what it applied. The client then
  // renders the label it hoped for over whatever it was actually given, which is the
  // failure the design's "always visible" sentence is about.
  'grant-not-echoed': { file: 'server/index.js', edits: [[
    '      sendMonitor(ws, bad.length ? bad.join(\'; \') : null);',
    '      /* mutation: granted silently */',
  ]] },
  // **The control for the refusal.** A take starts however fine the monitors are, so
  // the frames it loses are lost with nothing said. The pre-press warning goes with
  // it, which is why two rows fail rather than one.
  'start-never-refuses': { file: 'server/index.js', edits: [[
    '  if (costly.length && body.acceptMonitorCost !== true) {',
    '  if (false) {',
  ]] },
  // **The control for the positive twins.** Every monitor counts as costly, loopback
  // or not, so the server refuses to record whenever anything is watching. This is
  // the mutation a refusal-only check cannot see: it makes the product useless and
  // every "it refused" assertion in this file still passes.
  'refuse-ignores-loopback': { file: 'server/index.js', edits: [[
    'const costsTheTake = (m) => !m.loopback && (m.divisor < RECORDING_CAP.divisor || m.stride < RECORDING_CAP.stride);',
    'const costsTheTake = (m) => (m.divisor < RECORDING_CAP.divisor || m.stride < RECORDING_CAP.stride);',
  ]] },
  // The range check goes, so a divisor of 0 or 99 is accepted and stored. Zero is
  // the interesting one - `frameSeq % 0` is NaN, so a stride of 0 sends nothing at
  // all and reads as a dead sensor.
  'accept-any-setting': { file: 'server/index.js', edits: [[
    'const whole = (v, max) => (Number.isInteger(v) && v >= 1 && v <= max ? v : null);',
    'const whole = (v, max) => (typeof v === \'number\' ? v : null);',
  ]] },
};
if (MUTATE && !MUTATIONS[MUTATE]) {
  console.error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

// --- the staged tree -------------------------------------------------------
// A mutation applied in place and restored afterwards leaves a mutated working tree
// behind any crash, which is the one state a proof tool must never produce.
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
cpSync(join(REPO, 'server'), join(WORK, 'server'), { recursive: true });
cpSync(join(REPO, 'tools'), join(WORK, 'tools'), { recursive: true });
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
let checked = 0, failed = 0;
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
    if (log.join('').includes('viewer on')) setTimeout(() => resolve(() => log.join('')), 200);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  setTimeout(() => reject(new Error(`server never came up:\n${log.join('')}`)), 15000);
});
const stopAll = async () => {
  for (const c of servers) c.kill('SIGKILL');
  servers.length = 0;
  await wait(150);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A monitor: opens the socket, optionally negotiates, and records what arrives.
 *
 * It keeps every binary frame's length and the JSON it was told, because the whole
 * question is whether those two agree. Frames are counted from the moment the
 * setting was *granted* rather than from connect, so frames already in flight under
 * the previous setting cannot be read as the new one failing to apply.
 */
function monitor(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
  const state = { name, ws, frames: [], grants: [], since: 0, open: false };
  ws.on('message', (data, isBinary) => {
    // The declared depth length rather than the message length, for the reason
    // `DEPTH_FULL` sets out - the colour half is a JPEG and moves on its own.
    if (isBinary) { state.frames.push(depthOf(data)); return; }
    const msg = JSON.parse(data.toString('utf8'));
    if (msg.monitor) state.grants.push(msg.monitor);
  });
  state.ready = new Promise((resolve, reject) => {
    ws.on('open', () => { state.open = true; resolve(state); });
    ws.on('error', reject);
  });
  // Frames seen since the last `mark()`, which is what every rate row measures over.
  state.mark = () => { state.since = state.frames.length; };
  state.seen = () => state.frames.slice(state.since);
  // **Resolves to null rather than throwing when no answer comes back.** A server
  // that applies a setting and says nothing is a real failure mode - it is what
  // `grant-not-echoed` plants - and it has to fail the row about being told, not
  // abort the run before any later row gets to speak. The first version threw here
  // and that mutation was recorded as caught at four assertions, one of which was
  // the harness timing out. Every caller reads the result with `?.`, so a null lands
  // on the assertion it belongs to.
  state.ask = async (monitorPatch) => {
    const before = state.grants.length;
    ws.send(JSON.stringify({ monitor: monitorPatch }));
    try {
      await waitFor(() => state.grants.length > before, 2500, 'the server to answer a setting request');
      return state.grants.at(-1);
    } catch {
      return null;
    }
  };
  state.close = () => { try { ws.terminate(); } catch { /* already gone */ } };
  return state;
}

const waitFor = async (cond, ms, what = 'condition') => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return true;
    await wait(30);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
};

const post = (path, body) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

const get = (path) => fetch(`http://127.0.0.1:${PORT}${path}`).then((r) => r.json());

/** Every message in a take file, parsed back out of the bytes on disk. */
function readTake(path) {
  const parser = new MessageParser();
  const out = { hello: null, frames: [] };
  for (const msg of parser.push(readFileSync(path))) {
    if (msg.type === TYPE_HELLO) out.hello ??= Buffer.from(msg.payload);
    else if (msg.type === TYPE_FRAME) out.frames.push(Buffer.from(msg.payload));
  }
  return out;
}

const sha = (b) => createHash('sha256').update(b).digest('hex');

/** The writer's own record of what it put on stdout: `type length sha256`. */
const readEmitLog = (path) => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
  const [type, length, hash] = line.split(' ');
  return { type: Number(type), length: Number(length), hash };
});

// **The depth block, which is the only fixed quantity a frame has.** The first
// version of this file compared whole-frame byte counts against a constant, and
// every such row failed: the colour block is a JPEG, so a full frame off the sample
// ranges over 485,869 to 492,860 bytes and no two are alike. Comparing totals would
// have meant either a tolerance band - which cannot tell a ÷2 frame from a busy
// JPEG - or a number that is wrong on most frames.
//
// The declared depth length is exact, is what the divisor actually changes, and is
// read out of the frame's own header rather than inferred from its size. So every
// row below asserts on it.
const DEPTH_FULL = 512 * 424 * 2;
const depthAt = (k) => Math.ceil(512 / k) * Math.ceil(424 / k) * 2;
const depthOf = (buf) => buf.readUInt32LE(0);

// `--grabber` is one space-separated string, so the writer and its arguments arrive
// as a single flag. The staged copy under `WORK` rather than the repo's, so a
// mutation of `server/` is what the grabber's own import of `protocol.js` resolves
// against too.
const streamer = (extra = '') => ['--grabber',
  `${join(WORK, 'tools/fake-grabber.mjs')} --source ${SOURCE} --fps 30 ${extra}`.trim()];

try {
  console.log(`[monitor] ${MUTATE ? `MUTATED: ${MUTATE} (${MUTATIONS[MUTATE].file})` : 'unmutated tree'}\n`);
  ok('the fixture this check measures against is here', existsSync(SOURCE),
    existsSync(SOURCE) ? '' : `${SOURCE} is missing - run tools/make-fixture.js`);
  if (!existsSync(SOURCE)) throw new Error('no sample capture to stream');

  // ------------------------------------------------- 1. the negotiation
  console.log('[monitor] what the server grants is what it sends');
  const caps = join(WORK, 'caps-1');
  mkdirSync(caps, { recursive: true });
  await start([...streamer(),
    '--captures', caps, '--name', 'negotiate', '--projects', join(WORK, 'p1'), '--presets', join(WORK, 'q1')]);

  const a = await monitor('a').ready;
  await waitFor(async () => a.frames.length > 5, 8000, 'the first frames to arrive');
  ok('a monitor is told its setting on connect without asking', a.grants.length >= 1,
    JSON.stringify(a.grants[0] ?? null));
  ok('and it starts at full rate - the default is the honest one, since a coarse default would be a downgrade nobody chose',
    a.grants[0]?.divisor === 1 && a.grants[0]?.stride === 1);
  ok('a full-rate frame carries the whole depth grid', a.frames.every((n) => n === DEPTH_FULL),
    `${[...new Set(a.frames)].join('/')} against ${DEPTH_FULL}`);

  // The divisor, measured on the wire rather than read off the label.
  for (const k of [2, 4, 8]) {
    const grant = await a.ask({ divisor: k });
    ok(`asking for depth ÷${k} is granted, and answered`, grant?.divisor === k, JSON.stringify(grant));
    a.mark();
    await wait(600);
    const seen = a.seen();
    ok(`and the frames that arrive are ÷${k} frames - the label is not the claim, the bytes are`,
      seen.length > 0 && seen.every((n) => n === depthAt(k)),
      `${seen.length} frames, depth ${[...new Set(seen)].join('/')}, expected ${depthAt(k)}`);
  }

  // The stride. Counted as a ratio against a full-rate monitor watching the same
  // stream, so a slow machine cannot fail this by delivering fewer frames overall -
  // both arms lose the same frames.
  const pacer = await monitor('pacer').ready;
  await a.ask({ divisor: 1, stride: 3 });
  a.mark(); pacer.mark();
  await wait(2000);
  const strided = a.seen().length, fullRate = pacer.seen().length;
  ok('a stride of 3 delivers about a third of what a full-rate monitor beside it sees',
    strided > 0 && fullRate > 0 && Math.abs(strided / fullRate - 1 / 3) < 0.12,
    `${strided} against ${fullRate} = ${(strided / Math.max(1, fullRate)).toFixed(3)}`);
  ok('and the full-rate monitor beside it is unaffected - one client\'s setting is its own',
    fullRate > 20, `${fullRate} frames in 2s`);

  // Refusals, each with the setting surviving unchanged. A validator that reset the
  // setting on a bad value would be a second way to downgrade a monitor silently.
  await a.ask({ divisor: 4, stride: 2 });
  for (const bad of [{ divisor: 0 }, { divisor: 17 }, { divisor: 2.5 }, { divisor: 'four' }, { stride: 0 }, { stride: 99 }]) {
    const grant = await a.ask(bad);
    ok(`${JSON.stringify(bad)} is refused with a reason`, Boolean(grant?.refused),
      grant ? (grant.refused ?? 'accepted') : 'no answer at all');
    ok('and the setting it had is still the setting it has', grant?.divisor === 4 && grant?.stride === 2,
      grant ? `÷${grant.divisor} ×${grant.stride}` : 'no answer at all');
  }
  a.mark();
  await wait(600);
  const afterBad = a.seen();
  ok('and the wire still carries the setting that survived, not the ones that were refused',
    afterBad.length > 0 && afterBad.every((n) => n === depthAt(4)),
    `depth ${[...new Set(afterBad)].join('/')}, expected ${depthAt(4)}`);

  a.close(); pacer.close();
  await stopAll();

  // ------------------------------------------------- 2. one mechanism
  console.log('\n[monitor] the socket and the frame API decimate identically, because they are one function');
  const caps2 = join(WORK, 'caps-2');
  mkdirSync(caps2, { recursive: true });
  await start(['--replay', SOURCE, '--captures', caps2, '--name', 'onemech',
    '--projects', join(WORK, 'p2'), '--presets', join(WORK, 'q2')]);
  // A replay server serves the same file it streams, so a frame can be fetched over
  // HTTP and watched on the socket and the two compared byte for byte. Anything else
  // would be comparing two different frames and calling them equal.
  const viaHttp = {};
  for (const k of [1, 4]) {
    const res = await fetch(`http://127.0.0.1:${PORT}/capture/sample/frame/7?decimate=${k}`);
    viaHttp[k] = Buffer.from(await res.arrayBuffer());
  }
  ok('the frame API answers a full frame and a ÷4 one',
    depthOf(viaHttp[1]) === DEPTH_FULL && depthOf(viaHttp[4]) === depthAt(4),
    `depth ${depthOf(viaHttp[1])} and ${depthOf(viaHttp[4])}`);
  ok('and the ÷4 frame is smaller in exactly the depth block, colour untouched',
    viaHttp[4].readUInt32LE(4) === viaHttp[1].readUInt32LE(4),
    `${viaHttp[4].readUInt32LE(4)} colour bytes against ${viaHttp[1].readUInt32LE(4)}`);

  // The socket half: watch at ÷4 and find the frame whose timestamp matches the one
  // fetched. Matching on the stamp rather than on arrival order is what makes this a
  // comparison of the same moment rather than of two neighbours.
  const b = await monitor('b').ready;
  await b.ask({ divisor: 4 });
  const bodies = [];
  b.ws.on('message', (data, isBinary) => { if (isBinary) bodies.push(Buffer.from(data)); });
  const wantStamp = viaHttp[4].readBigUInt64LE(8);
  await waitFor(async () => bodies.some((f) => f.readBigUInt64LE(8) === wantStamp), 12000,
    'the socket to deliver the frame the API was asked for');
  const fromSocket = bodies.find((f) => f.readBigUInt64LE(8) === wantStamp);
  ok('the same frame at ÷4 is byte-identical off the socket and off the frame API',
    fromSocket.equals(viaHttp[4]), `${sha(fromSocket).slice(0, 12)} against ${sha(viaHttp[4]).slice(0, 12)}`);
  b.close();
  await stopAll();

  // ------------------------------------------------- 3. the take is untouched
  console.log('\n[monitor] a monitor never costs the take a byte');
  const recDir = join(WORK, 'caps-3');
  mkdirSync(recDir, { recursive: true });
  const emitLog = join(WORK, 'emitted.log');
  writeFileSync(emitLog, '');
  await start([...streamer(`--emit-log ${emitLog}`),
    '--captures', recDir, '--name', 'shooting', '--record',
    '--projects', join(WORK, 'p3'), '--presets', join(WORK, 'q3')]);

  // Watching coarsely, so the recorder is running with a decimating monitor attached
  // - which is the only configuration in which the leak this row is about can happen.
  const watcher = await monitor('watcher').ready;
  const watchGrant = await watcher.ask({ divisor: 4, stride: 3 });
  ok('a monitor is watching the take at ÷4 ×3', watchGrant?.divisor === 4 && watchGrant?.stride === 3,
    JSON.stringify(watchGrant));
  await waitFor(async () => watcher.frames.length > 4, 8000, 'decimated frames to arrive');
  ok('and it really is receiving decimated frames while the take runs',
    watcher.frames.length > 0 && watcher.frames.every((n) => n === depthAt(4)),
    `depth ${[...new Set(watcher.frames)].join('/')}, expected ${depthAt(4)}`);

  await waitFor(async () => (await get('/record/state')).frames > 40, 20000, 'the take to gather frames');
  const stopped = await post('/record/stop');
  ok('the take stops cleanly', stopped.status === 200, JSON.stringify(stopped.body).slice(0, 80));
  watcher.close();
  await wait(400);

  const takes = readdirSync(recDir).filter((f) => f.endsWith('.knct'));
  ok('exactly one take was written', takes.length === 1, takes.join(', '));
  const take = readTake(join(recDir, takes[0]));
  const emitted = readEmitLog(emitLog);
  const emittedFrames = emitted.filter((e) => e.type === TYPE_FRAME);

  ok('the take carries frames', take.frames.length > 20, `${take.frames.length} frames`);
  // The identity. Every frame in the file is a frame the writer logged putting on
  // stdout, by hash - so a recorder handed a decimated buffer fails here even though
  // the file would still parse, still index and still play.
  const emittedHashes = new Set(emittedFrames.map((e) => e.hash));
  const strangers = take.frames.filter((f) => !emittedHashes.has(sha(f)));
  ok('every frame on disk is byte for byte a frame the grabber emitted, with a monitor watching decimated throughout',
    strangers.length === 0,
    strangers.length ? `${strangers.length} of ${take.frames.length} frames are not in the writer's log; `
      + `first declares ${depthOf(strangers[0])} depth bytes where a full frame declares ${DEPTH_FULL}`
      : `${take.frames.length} frames matched`);
  // The blunt second reading, because a hash set answers "is it one of them" and not
  // "is it the right size". A leak changes the length, and saying so names the bug.
  ok('and every one of them carries the full depth grid rather than a decimated one',
    take.frames.every((f) => depthOf(f) === DEPTH_FULL),
    `depth ${[...new Set(take.frames.map(depthOf))].join('/')} against ${DEPTH_FULL}`);
  ok('the take is in order and contiguous in the writer\'s log, so this is the stream rather than a lucky subset',
    (() => {
      const idx = take.frames.map((f) => emittedFrames.findIndex((e) => e.hash === sha(f)));
      return idx.every((v, i) => v >= 0 && (i === 0 || v === idx[i - 1] + 1));
    })(), `${take.frames.length} frames`);
  await stopAll();

  // ------------------------------------------------- 4. the refusal, and its twins
  console.log('\n[monitor] a take refuses to start under a monitor that would cost it frames');
  const recDir4 = join(WORK, 'caps-4');
  mkdirSync(recDir4, { recursive: true });
  await start([...streamer(),
    '--captures', recDir4, '--name', 'refusing', '--host', '0.0.0.0',
    '--projects', join(WORK, 'p4'), '--presets', join(WORK, 'q4')]);

  // The positive twin first, and deliberately: a check that opened with the refusal
  // would pass against a server that refused everything, and the order is what makes
  // that impossible to skip.
  const idle = await post('/record/start');
  ok('with nothing watching, a take starts', idle.status === 200 && idle.body.armed === true,
    JSON.stringify(idle.body).slice(0, 90));
  await post('/record/stop');

  const local = await monitor('loopback').ready;
  await waitFor(async () => local.frames.length > 2, 8000, 'the loopback monitor to receive frames');
  const withLocal = await post('/record/start');
  ok('a full-rate monitor on loopback does not refuse it - its frames never cross the link the refusal is about',
    withLocal.status === 200 && withLocal.body.armed === true,
    JSON.stringify(withLocal.body).slice(0, 90));
  await post('/record/stop');
  local.close();
  await wait(200);

  // The refusal itself needs a monitor that is genuinely off-machine, so this arrives
  // on the LAN address rather than on loopback. Without a second address the claim
  // has nothing to mean, which is `guard-check`'s reading and the same one here.
  const { networkInterfaces } = await import('node:os');
  const LAN = Object.values(networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? null;
  ok('this machine has a second address, so "over the network" is a thing a monitor can be', Boolean(LAN),
    LAN ?? 'no non-internal IPv4');

  if (LAN) {
    const remote = new WebSocket(`ws://${LAN}:${PORT}/`, { headers: { Origin: `http://${LAN}:${PORT}` } });
    const grants = [];
    remote.on('message', (data, isBinary) => {
      if (!isBinary) { const m = JSON.parse(data.toString('utf8')); if (m.monitor) grants.push(m.monitor); }
    });
    await new Promise((res, rej) => { remote.on('open', res); remote.on('error', rej); });
    await waitFor(async () => grants.length > 0, 4000, 'the remote monitor to be told its setting');
    ok('a monitor arriving over the network is told it is not on loopback', grants[0].loopback === false,
      JSON.stringify(grants[0]));
    ok('and is told, before pressing anything, that a take would refuse at this setting',
      grants[0].wouldRefuseRecording === true);

    const state = await get('/record/state');
    ok('the record surface says the same thing over HTTP, so the button can warn before it is pressed',
      state.monitors?.wouldRefuse === true && state.monitors.costingTheTake.length === 1,
      JSON.stringify(state.monitors));

    // Counted before the attempt rather than compared against an empty directory:
    // the two positive twins above deliberately recorded, so "no take exists" would
    // be asserting that those rows failed. What the refusal claims is that it
    // created nothing, and a delta is what says that.
    const takesBefore = readdirSync(recDir4).filter((f) => f.endsWith('.knct')).length;
    const refused = await post('/record/start');
    ok('and the take refuses, naming the cost rather than a status', refused.status === 409
      && /costs the take frames/.test(refused.body.error ?? ''), (refused.body.error ?? '').slice(0, 110));
    ok('and nothing was armed by the attempt', (await get('/record/state')).armed === false);
    const takesAfter = readdirSync(recDir4).filter((f) => f.endsWith('.knct')).length;
    ok('and no take file was opened by it', takesAfter === takesBefore,
      `${takesBefore} takes before, ${takesAfter} after`);

    // Twin one: coarsen and it records. Without this the refusal could be
    // unconditional and every row above would still pass.
    remote.send(JSON.stringify({ monitor: { divisor: 4, stride: 3 } }));
    const coarsened = await waitFor(async () => grants.at(-1)?.divisor === 4 && grants.at(-1)?.stride === 3,
      4000, 'the coarser grant').catch(() => false);
    ok('the coarser setting is granted and answered', coarsened === true, JSON.stringify(grants.at(-1)));
    ok('coarsened to the cap, the same monitor no longer blocks it', grants.at(-1)?.wouldRefuseRecording === false);
    const coarse = await post('/record/start');
    ok('and the take starts', coarse.status === 200 && coarse.body.armed === true,
      JSON.stringify(coarse.body).slice(0, 90));
    await post('/record/stop');

    // Twin two: the override. An operator on ethernet genuinely does not pay this,
    // and a refusal with no way past it would be a cap wearing a refusal's clothes.
    remote.send(JSON.stringify({ monitor: { divisor: 1, stride: 1 } }));
    await waitFor(async () => grants.at(-1)?.divisor === 1 && grants.at(-1)?.stride === 1,
      4000, 'the full-rate grant').catch(() => false);
    const forced = await post('/record/start', { acceptMonitorCost: true });
    ok('and an operator who accepts the cost in as many words gets the take',
      forced.status === 200 && forced.body.armed === true, JSON.stringify(forced.body).slice(0, 90));
    await post('/record/stop');
    try { remote.terminate(); } catch { /* already gone */ }
  }
} catch (err) {
  failed++;
  console.log(`\n  FAIL  the run did not finish: ${err.message}`);
} finally {
  await stopAll();
  rmSync(WORK, { recursive: true, force: true });
}

console.log(`\n[monitor] ${checked} assertions, ${failed} failed`);
if (MUTATE) {
  // Exit code alone cannot tell "the mutation was caught" from "the tool crashed
  // before asserting anything", and this repo has been bitten by exactly that twice.
  if (failed === 0) { console.log('[monitor] NOT CAUGHT - the check passed a server it should have rejected'); process.exit(1); }
  console.log(`[monitor] caught, as required (${failed} assertion${failed === 1 ? '' : 's'} fired)`);
  process.exit(1);
}
if (failed) { console.log('[monitor] FAIL'); process.exit(1); }
console.log('[monitor] PASS');
process.exit(0);
