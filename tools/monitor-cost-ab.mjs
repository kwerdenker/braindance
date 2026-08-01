#!/usr/bin/env node
// What a connected monitor costs the take, measured interleaved on the capture node.
//
// Gate 5 found that a viewer degrades the capture itself - backpressure from a link
// that cannot carry 14.6 MB/s reaches back through the server's stdin pipe into the
// grabber, which then misses USB deadlines and drops depth packets. **Both of its
// comparisons were sequential**, which this project has been burned by before: a
// sequential comparison on this rig once produced a 23% figure that was really 12.9%.
// The direction was never in doubt - 2 skipped packets against 52 is far outside any
// noise seen here - but the 11% was not a number anything should be sized against.
//
// So this runs the three arms **interleaved inside one continuous grabber run**:
//
//   A  no client connected
//   B  one browser-equivalent monitor at ÷1 ×1, over Wi-Fi from the editing machine
//   C  the same monitor at ÷4 ×3, which is the cap a recording take allows
//
// One grabber, one device open, one recording, windows cycling A-B-C-A-B-C-A-B-C.
// Nothing is restarted between arms, so device warm-up, exposure settling, thermal
// state and card behaviour are common to all three rather than confounded with them.
// The monitor is this process, running on the Mac, so the frames genuinely cross the
// wireless link the finding is about - a monitor on the node's own loopback would
// measure a different machine's problem.
//
// **Read delivered fps before anything else.** The loop idles 55% of every interval,
// so a run that does not sustain ~30.0 on arm A was competing for the machine and
// its other numbers are noise. That rule is `prof-summary`'s and it is enforced here
// rather than left to the reader: a run whose A arms miss the floor is thrown away.
//
//   node tools/monitor-cost-ab.mjs --host braindancePi.local --user braindancepi \
//     --key ~/.ssh/id_ed25519 --window 40 --rounds 3
//
// Needs the sensor attached to the node and the checkout at `--dir`. It records for
// the whole measurement, so it writes one take of roughly rounds x arms x window
// seconds and deletes it at the end unless `--keep`.
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const { WebSocket } = createRequire(join(REPO, 'package.json'))('ws');

const argv = process.argv.slice(2);
const flag = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const has = (n) => argv.includes(n);

const HOST = flag('--host', 'braindancePi.local');
const USER = flag('--user', 'braindancepi');
const KEY = flag('--key', `${process.env.HOME}/.ssh/id_ed25519`);
const DIR = flag('--dir', '~/kinect-nle');
const PORT = Number(flag('--port', '8080'));
const WINDOW = Number(flag('--window', '40'));
const ROUNDS = Number(flag('--rounds', '3'));
// The delivered-rate floor below which a window is contention rather than a result.
// 29.5 is `prof-summary`'s number and this uses the same one deliberately.
const FLOOR = Number(flag('--floor', '29.5'));
const KEEP = has('--keep');

const ssh = (cmd) => new Promise((resolve, reject) => {
  execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-i', KEY, `${USER}@${HOST}`, cmd],
    { maxBuffer: 64 * 1024 * 1024 },
    (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// The node's own counters, sampled at a window boundary. `frames` is what the
// recorder has durably taken, `skipped` is libfreenect2's own dropped-isochronous
// counter off the grabber's debug log - the quantity the finding is actually about,
// since a skipped depth packet is a frame that never existed rather than one that
// was dropped somewhere downstream.
async function sample() {
  const out = await ssh(
    `curl -s http://127.0.0.1:${PORT}/record/state; echo; `
    + `grep -c 'not all subsequences received' ${DIR}/run.log || true`);
  const [stateLine, skippedLine] = out.trim().split('\n');
  return {
    at: Date.now(),
    frames: JSON.parse(stateLine).frames ?? 0,
    skipped: Number(skippedLine.trim()) || 0,
  };
}

/** A monitor on this machine, so its frames cross the real wireless link. */
function connect() {
  const ws = new WebSocket(`ws://${HOST}:${PORT}/`, { headers: { Origin: `http://${HOST}:${PORT}` } });
  const state = { ws, frames: 0, bytes: 0 };
  ws.on('message', (data, isBinary) => { if (isBinary) { state.frames++; state.bytes += data.length; } });
  state.ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  state.set = (divisor, stride) => ws.send(JSON.stringify({ monitor: { divisor, stride } }));
  state.close = () => { try { ws.terminate(); } catch { /* already gone */ } };
  return state;
}

const ARMS = [
  { key: 'A', label: 'no client', setup: async () => null },
  { key: 'B', label: 'monitor ÷1 ×1', setup: async (m) => m.set(1, 1) },
  { key: 'C', label: 'monitor ÷4 ×3', setup: async (m) => m.set(4, 3) },
];

let server = null;
const rows = [];

try {
  console.log(`[cost] node ${USER}@${HOST}:${PORT}, ${ROUNDS} rounds x ${ARMS.length} arms x ${WINDOW}s`);
  const link = await ssh('ip -brief addr | grep -v "^lo" | head -3');
  console.log(`[cost] node link:\n${link.trim().split('\n').map((l) => `         ${l}`).join('\n')}`);

  // One grabber for the whole measurement. `--log debug` is what surfaces the
  // subsequence counter; the log goes to the node's disk and is read by grep rather
  // than streamed, so the reader never competes with the capture for the card.
  await ssh(`pkill -f 'server/index.js' || true; rm -f ${DIR}/run.log; sleep 1`);
  server = spawn('ssh', ['-o', 'BatchMode=yes', '-i', KEY, `${USER}@${HOST}`,
    `cd ${DIR} && XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 `
    + `node server/index.js --port ${PORT} --host 0.0.0.0 --record `
    + `--grabber "$PWD/native/build/grabber --log debug" > run.log 2>&1`],
    { stdio: ['ignore', 'inherit', 'inherit'] });

  // Warm-up, discarded entirely: device open, exposure settling and the first
  // recorder flush all land here and none of them belong in a window.
  console.log('[cost] warming up (device open, exposure, first flush) - discarded');
  await wait(20000);
  const first = await sample();
  if (!(first.frames > 0)) throw new Error('nothing is being recorded on the node - check run.log');

  const monitor = connect();
  await monitor.ready;
  console.log('[cost] monitor attached over the link\n');
  // Parked coarse between arms so the socket exists throughout and only the setting
  // changes. Arm A closes it, which is the one arm where the client genuinely is not
  // there - that is what "no client connected" means and a parked socket would not
  // reproduce it.
  monitor.close();
  await wait(1000);

  let live = null;
  for (let round = 1; round <= ROUNDS; round++) {
    for (const arm of ARMS) {
      if (arm.key === 'A') { live?.close(); live = null; await wait(1500); } else {
        if (!live) { live = connect(); await live.ready; await wait(500); }
        await arm.setup(live);
        await wait(500); // let the grant land before the window opens
      }
      const before = await sample();
      const beforeFrames = live?.frames ?? 0;
      await wait(WINDOW * 1000);
      const after = await sample();
      const secs = (after.at - before.at) / 1000;
      const row = {
        round,
        arm: arm.key,
        label: arm.label,
        recordedFps: (after.frames - before.frames) / secs,
        skipped: after.skipped - before.skipped,
        monitorFps: ((live?.frames ?? 0) - beforeFrames) / secs,
        secs,
      };
      rows.push(row);
      console.log(`  round ${round} ${arm.key} ${arm.label.padEnd(14)} `
        + `recorded ${row.recordedFps.toFixed(2)}fps  skipped ${String(row.skipped).padStart(4)}  `
        + `monitor ${row.monitorFps.toFixed(1)}fps`);
    }
  }
  live?.close();
} catch (err) {
  console.error(`\n[cost] the run did not finish: ${err.message}`);
  process.exitCode = 2;
} finally {
  try {
    await ssh(`curl -s -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:${PORT}/record/stop > /dev/null; `
      + `pkill -f 'server/index.js' || true`);
    if (!KEEP) await ssh(`rm -f ${DIR}/captures/*.knct ${DIR}/captures/*.idx || true`);
  } catch { /* the node going away during teardown is not a result */ }
  server?.kill('SIGKILL');
}

if (rows.length === 0) process.exit(process.exitCode ?? 2);

// --- the verdict -----------------------------------------------------------
console.log('\n[cost] method: one grabber, one device open, one continuous recording;'
  + ` ${ROUNDS} interleaved rounds of ${ARMS.length} arms at ${WINDOW}s each;`
  + ' first 20s discarded as warm-up; monitor on the editing machine over Wi-Fi;'
  + ' skipped counted from libfreenect2\'s own subsequence warnings.');

const baseline = rows.filter((r) => r.arm === 'A');
const contended = baseline.filter((r) => r.recordedFps < FLOOR);
console.log(`\n[cost] arm A delivered ${baseline.map((r) => r.recordedFps.toFixed(2)).join(', ')} fps`);
if (contended.length) {
  console.log(`[cost] THROWN AWAY: ${contended.length} of ${baseline.length} no-client windows fell under ${FLOOR}fps, `
    + 'so this machine was competing for itself and every other number here is noise. Re-run on a settled node.');
  process.exit(2);
}

console.log('\n| arm | recorded fps (median) | skipped / window (median) | monitor fps |');
console.log('| --- | --- | --- | --- |');
for (const arm of ARMS) {
  const mine = rows.filter((r) => r.arm === arm.key);
  console.log(`| ${arm.label} | ${median(mine.map((r) => r.recordedFps)).toFixed(2)} `
    + `| ${median(mine.map((r) => r.skipped))} | ${median(mine.map((r) => r.monitorFps)).toFixed(1)} |`);
}

// Paired within a round, which is the comparison that survives drift: a round's B is
// read against that same round's A rather than against a median taken elsewhere.
console.log('\n[cost] paired deltas, each within its own round');
let allSameSign = true;
for (const key of ['B', 'C']) {
  const deltas = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const a = rows.find((r) => r.round === round && r.arm === 'A');
    const x = rows.find((r) => r.round === round && r.arm === key);
    if (a && x) deltas.push({ fps: a.recordedFps - x.recordedFps, skipped: x.skipped - a.skipped });
  }
  const signs = new Set(deltas.map((d) => Math.sign(d.fps)));
  if (signs.size > 1) allSameSign = false;
  const pct = deltas.map((d, i) => (d.fps / rows.find((r) => r.round === i + 1 && r.arm === 'A').recordedFps) * 100);
  console.log(`  ${key} against A: fps cost ${pct.map((p) => `${p.toFixed(1)}%`).join(', ')} `
    + `(median ${median(pct).toFixed(1)}%), extra skipped ${deltas.map((d) => d.skipped).join(', ')}`);
}
console.log(`\n[cost] ${allSameSign ? 'every paired delta has the same sign' : 'PAIRED DELTAS DISAGREE IN SIGN - this is noise, not a result'}`);
process.exit(allSameSign ? 0 : 1);
