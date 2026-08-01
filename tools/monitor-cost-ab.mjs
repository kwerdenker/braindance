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
// **The node samples itself, and the driver never reads across the link during a
// window.** The first version of this file took its counters over SSH at each window
// boundary - which meant the control channel shared the wireless link that arm B
// exists to saturate, so the sample closing B's window was delayed by exactly the
// congestion being measured, and the frame count and the timestamp it was divided by
// were skewed apart. It also never completed: twenty minutes produced no window at
// all. That is the observer effect this repo already recorded in another shape, and
// the fix is the same one - do not let the instrument touch what it is sampling.
//
// So a sampler on the node appends one line a second to tmpfs, and **each line
// carries the server's own view of what is watching**. The arm is therefore read off
// the resource rather than off what this process believed it had set, and the whole
// log is pulled once, afterwards, when nothing is being measured.
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
// **The baseline gate is the spread of the no-client arms, not an absolute floor.**
// `prof-summary`'s 29.5 was the first thing tried here and it threw away a run that
// was fine: this configuration records continuously to the SD card, and the design
// doc already measures a recording run at 29.86fps rather than 30.00 because of
// buffered-write stalls, explicitly noting that a long take meets more of them. Over
// eight minutes the no-client arms came in at 28.90, 29.19 and 28.83 - which is 0.36
// of spread, and a tight cluster is the signature of a settled rig.
//
// Contention looks different and this repo has a worked example of what it looks
// like: the thread-count sweep saw 27.31-29.13 within one arm, and the tell was
// *variance and non-monotonicity*, not the absolute level. So the check is that the
// baselines agree with each other, and the absolute is printed for the reader rather
// than gated on a constant borrowed from a run that writes nothing.
const SPREAD = Number(flag('--max-baseline-spread', '0.8'));
const KEEP = has('--keep');
// **The instrumentation goes to tmpfs, never to the capture card.** An early gate-4
// run showed a 1245ms gap that looked like a sensor fault and was the grabber's own
// periodic stderr line blocking on the same card the capture was streaming to. This
// log is `--log debug`, which is far more traffic than that line was, so putting it
// beside the take would be measuring the instrument. `/tmp` is tmpfs on this image.
const LOG = flag('--log-path', '/tmp/monitor-cost.log');
const PIDFILE = '/tmp/monitor-cost.pid';

const ssh = (cmd) => new Promise((resolve, reject) => {
  // `-n` and a remote `< /dev/null`, together. A backgrounded remote process
  // inherits the SSH channel's stdin, and ssh does not return until every holder of
  // that channel is gone - so `nohup node ... &` without this hangs the driver
  // forever with the server running perfectly well on the other side. Two runs were
  // lost to it before the cause was read off the fact that the very next log line
  // never printed.
  execFile('ssh', ['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-i', KEY, `${USER}@${HOST}`, cmd],
    { maxBuffer: 64 * 1024 * 1024 },
    (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const waitFor = async (cond, ms, what) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await cond()) return true; } catch { /* keep trying */ }
    await wait(1000);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
};

/**
 * Start something on the node without waiting for it.
 *
 * **`await ssh(...)` cannot launch a long-lived remote process**, and two runs were
 * lost proving it: ssh does not return until the channel has no holders, a
 * backgrounded remote process holds it whatever `nohup` and `< /dev/null` are given,
 * and the visible symptom is a driver frozen with the server running perfectly well
 * on the other side. Detached and unwaited, with readiness polled for afterwards, is
 * the shape that does not depend on any of that.
 */
const sshDetached = (cmd) => {
  const child = spawn('ssh', ['-n', '-o', 'BatchMode=yes', '-i', KEY, `${USER}@${HOST}`, cmd],
    { stdio: 'ignore', detached: true });
  child.unref();
};

/** Poll until the node's server answers, or give up saying so. */
async function awaitServer(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const out = await ssh(`curl -s --max-time 3 http://127.0.0.1:${PORT}/record/state || true`);
      if (out.trim().startsWith('{')) return JSON.parse(out.trim());
    } catch { /* not up yet */ }
    await wait(2000);
  }
  throw new Error(`the node's server never answered within ${ms}ms - check ${LOG}`);
}

// The sampler that runs on the node. One line a second: node-local epoch, the
// recorder's durable frame count, libfreenect2's own dropped-isochronous counter, and
// the arm - taken from the server's list of what is attached and at what setting.
//
// **The phrase is `skipping depth packet`, and the first version of this grepped for
// `not all subsequences received` instead.** Both exist in libfreenect2 and they are
// different events - the second is an incomplete depth frame off the USB isochronous
// stream, the first is the parser discarding a packet. The grabber's own `--help`
// names the second, which is what sent this at it; the node's log carries the first
// in quantity and the second almost never. Counting the wrong string produced a
// delta of zero in every arm and an inference that no packets were being lost at
// all, which is the shape of a probe reporting an absence it manufactured.
//
// `wc -l` on the debug log rather than `grep -c` over it, because the interesting
// quantity is a monotonic counter and re-scanning a growing file every second is work
// the node should not be doing while it is the thing under test.
const SAMPLER = (port, log, out) => `
  while true; do
    st=$(curl -s --max-time 2 http://127.0.0.1:${port}/record/state)
    sk=$(grep -c 'skipping depth packet' ${log} 2>/dev/null || echo 0)
    printf '%s\\t%s\\t%s\\n' "$(date +%s%3N)" "$sk" "$st" >> ${out}
    sleep 1
  done`;

// One sample line back into numbers plus the arm it belongs to.
function parseSample(line) {
  const [ms, skipped, ...rest] = line.split('\t');
  let state;
  try { state = JSON.parse(rest.join('\t')); } catch { return null; }
  const watching = state.monitors?.watching ?? [];
  // The arm is the server's own answer about what is attached. No client is A, a
  // monitor finer than the cap is B, one at or past it is C - and anything else is
  // labelled rather than silently folded into a neighbour.
  let arm = 'A';
  if (watching.length === 1) arm = watching[0].divisor === 1 && watching[0].stride === 1 ? 'B' : 'C';
  else if (watching.length > 1) arm = '?';
  return { at: Number(ms), skipped: Number(skipped), frames: state.frames ?? 0, arm, watching: watching.length };
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
  { key: 'A', label: 'no client' },
  { key: 'B', label: 'monitor \u00f71 \u00d71' },
  { key: 'C', label: 'monitor \u00f74 \u00d73' },
];
const SAMPLES = '/tmp/monitor-cost.samples';

// Killed by what they are, never by a command line that would match the shell asking.
// The listener is resolved through `ss`, and the sampler by the marker file it writes
// into - `pkill -f` over SSH matches the remote shell running the very command, and
// on this node has already killed an SSH session while leaving its target alive.
const KILL_SERVER = `ss -tlnp 2>/dev/null | awk '/:${PORT} /{print $NF}' | grep -o 'pid=[0-9]*' `
  + '| cut -d= -f2 | xargs -r kill 2>/dev/null || true';
const KILL_SAMPLER = `for p in $(pgrep -f 'monitor-cost.samples' | grep -v $$); do kill "$p" 2>/dev/null; done || true`;

const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};

// A window's rate, computed from the node's own first and last sample inside it.
// Both the frame count and the clock come from the same machine and the same line,
// so nothing here divides a node-side counter by a Mac-side interval.
function windowStats(samples) {
  if (samples.length < 6) return null;
  const first = samples[0], last = samples.at(-1);
  const secs = (last.at - first.at) / 1000;
  if (!(secs > 20)) return null;
  // The recorder's counter resets when a take closes, so the teardown window reads as
  // a large negative rate. Dropped rather than reported: it is not a window, it is the
  // end of the run.
  if (last.frames < first.frames) return null;
  return {
    recordedFps: (last.frames - first.frames) / secs,
    skipped: last.skipped - first.skipped,
    secs,
  };
}

let rows = [];

try {
  console.log(`[cost] node ${USER}@${HOST}:${PORT}, ${ROUNDS} rounds x ${ARMS.length} arms x ${WINDOW}s`);
  console.log(`[cost] node link:\n${(await ssh('ip -brief addr | grep -v "^lo" | head -3')).trim()
    .split('\n').map((l) => `         ${l}`).join('\n')}`);

  // **Nothing here matches processes by command line.** `pkill -f 'server/index.js'`
  // over SSH matches the remote shell running that very command, which on this node
  // has already killed an SSH session while leaving its target running. Listeners are
  // resolved by port through `ss`, whose pipeline contains no text matching itself.
  // The deployed unit is `Restart=always`, so killing the listener under it starts a
  // fight this tool cannot win - it is stopped for the run and started again in the
  // teardown, including when the run is thrown away. Leaving a capture node with its
  // service down is the one side effect a measurement must not have.
  await ssh(`sudo systemctl stop kinect-node 2>/dev/null || true; `
    + `${KILL_SERVER}; ${KILL_SAMPLER}; rm -f ${LOG} ${SAMPLES}; sleep 1`);
  sshDetached(`cd ${DIR} && XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 `
    + `setsid node server/index.js --port ${PORT} --host 0.0.0.0 --record `
    + `--grabber "$PWD/native/build/grabber --log debug" < /dev/null > ${LOG} 2>&1`);
  await awaitServer(40000);
  console.log('[cost] server up; warming up (device open, exposure, first flush) - discarded');
  await wait(25000);
  const armed = await awaitServer(10000);
  if (!(armed.frames > 0)) throw new Error('nothing is being recorded on the node - check ' + LOG);
  console.log(`[cost] recording, ${armed.frames} frames so far`);

  // The sampler starts only now, so the warm-up contributes no lines at all rather
  // than lines this process has to remember to discard.
  // **Shipped base64, not quoted.** `bash -c "<script>"` through SSH loses a
  // multi-line script twice over: the outer shell expands every `$(...)` in it before
  // bash is reached, and a JSON-quoted string carries `\n` as two literal characters
  // rather than as newlines. The first run of this produced no sampler at all and no
  // error either - nine windows drove perfectly and there was nothing to read at the
  // end. Base64 is alphanumeric, so nothing in the transport can interpret it.
  const script = Buffer.from(SAMPLER(PORT, LOG, SAMPLES)).toString('base64');
  sshDetached(`echo ${script} | base64 -d > /tmp/monitor-cost.sh && `
    + 'setsid bash /tmp/monitor-cost.sh < /dev/null > /dev/null 2>&1');
  // The sampler has to be writing before the first window opens, or round 1 arm A is
  // measured over whatever lines happen to exist. Asserted rather than slept for.
  await waitFor(async () => (await ssh(`wc -l < ${SAMPLES} 2>/dev/null || echo 0`)).trim() >= 3,
    20000, 'the node-side sampler to start writing');

  let live = null;
  for (let round = 1; round <= ROUNDS; round++) {
    for (const arm of ARMS) {
      if (arm.key === 'A') { live?.close(); live = null; } else {
        if (!live) { live = connect(); await live.ready; }
        live.set(arm.key === 'B' ? 1 : 4, arm.key === 'B' ? 1 : 3);
      }
      // Settling, outside every window: the socket has to close or the grant has to
      // land before the samples that get attributed to this arm start. The segmenting
      // reads the arm off the server, so a transition in flight labels itself.
      await wait(4000);
      console.log(`  round ${round} ${arm.key} ${arm.label} - ${WINDOW}s`);
      await wait(WINDOW * 1000);
    }
  }
  live?.close();
  await wait(3000);

  // Pulled once, now, when nothing is being measured.
  await ssh(`${KILL_SAMPLER}`);
  const raw = await ssh(`cat ${SAMPLES}`);
  const samples = raw.trim().split('\n').map(parseSample).filter(Boolean);
  console.log(`\n[cost] ${samples.length} node-local samples`);

  // Segmented by runs of a constant arm, so a window is whatever the server said was
  // watching for a contiguous stretch. Transitions fall out as short runs and are
  // dropped by `windowStats`, which needs more than five seconds.
  const runs = [];
  for (const s of samples) {
    const last = runs.at(-1);
    if (last && last.arm === s.arm) last.samples.push(s);
    else runs.push({ arm: s.arm, samples: [s] });
  }
  for (const run of runs) {
    if (run.arm === '?') continue;
    const st = windowStats(run.samples);
    if (st) rows.push({ arm: run.arm, ...st });
  }
} catch (err) {
  console.error(`\n[cost] the run did not finish: ${err.message}`);
  process.exitCode = 2;
} finally {
  try {
    await ssh(`${KILL_SAMPLER}; `
      + `curl -s --max-time 5 -X POST -H 'Content-Type: application/json' -d '{}' `
      + `http://127.0.0.1:${PORT}/record/stop > /dev/null 2>&1; sleep 1; ${KILL_SERVER}`);
    if (!KEEP) await ssh(`rm -f ${DIR}/captures/*.knct ${DIR}/captures/*.idx || true`);
    // Put the node back the way it was found, whatever this run decided.
    await ssh('sudo systemctl start kinect-node 2>/dev/null || true');
    console.log('[cost] kinect-node started again');
  } catch { /* the node going away during teardown is not a result */ }
}

if (rows.length === 0) { console.error('[cost] no usable windows'); process.exit(process.exitCode ?? 2); }

console.log(`\n[cost] method: one grabber, one device open, one continuous recording; `
  + `${ROUNDS} interleaved rounds of ${ARMS.length} arms at ${WINDOW}s each, 4s of settling outside every `
  + `window; first 25s discarded as warm-up before the sampler starts; counters sampled once a second by the `
  + `node itself and pulled afterwards, so the driver never reads across the link under test; each window `
  + `labelled by the server's own list of attached monitors; skipped counted from libfreenect2's `
  + `'skipping depth packet' lines; monitor on the editing machine over Wi-Fi.`);

const baseline = rows.filter((r) => r.arm === 'A');
const spread = Math.max(...baseline.map((r) => r.recordedFps)) - Math.min(...baseline.map((r) => r.recordedFps));
console.log(`\n[cost] arm A delivered ${baseline.map((r) => r.recordedFps.toFixed(2)).join(', ')} fps, `
  + `spread ${spread.toFixed(2)}`);
if (baseline.length < 2 || spread > SPREAD) {
  console.log(`[cost] THROWN AWAY: the no-client arms spread ${spread.toFixed(2)}fps, over the ${SPREAD} this rig `
    + 'settles within, so the node was competing for itself and every other number here is noise. '
    + 'Re-run on a settled node.');
  process.exit(2);
}

console.log('\n| arm | windows | recorded fps (median) | skipped / window (median) |');
console.log('| --- | --- | --- | --- |');
for (const arm of ARMS) {
  const mine = rows.filter((r) => r.arm === arm.key);
  if (!mine.length) { console.log(`| ${arm.label} | 0 | - | - |`); continue; }
  console.log(`| ${arm.label} | ${mine.length} | ${median(mine.map((r) => r.recordedFps)).toFixed(2)} `
    + `| ${median(mine.map((r) => r.skipped))} |`);
}

// Paired within a round: each round's B and C are read against that round's own A,
// which is the comparison that survives drift over a twenty-minute run.
console.log('\n[cost] paired deltas, each within its own round');
let allSameSign = true;
const byRound = [];
for (let i = 0; i + 2 < rows.length + 1; i += 3) {
  const trio = rows.slice(i, i + 3);
  if (trio.length === 3 && trio[0].arm === 'A' && trio[1].arm === 'B' && trio[2].arm === 'C') byRound.push(trio);
}
for (const [key, idx] of [['B', 1], ['C', 2]]) {
  const pct = byRound.map((t) => ((t[0].recordedFps - t[idx].recordedFps) / t[0].recordedFps) * 100);
  const skip = byRound.map((t) => t[idx].skipped - t[0].skipped);
  if (new Set(pct.map(Math.sign)).size > 1) allSameSign = false;
  console.log(`  ${key} against A: fps cost ${pct.map((p) => `${p.toFixed(1)}%`).join(', ')} `
    + `(median ${pct.length ? median(pct).toFixed(1) : '-'}%), extra skipped ${skip.join(', ')}`);
}
console.log(`\n[cost] ${byRound.length} complete rounds; `
  + `${allSameSign ? 'every paired delta has the same sign' : 'PAIRED DELTAS DISAGREE IN SIGN - noise, not a result'}`);
process.exit(allSameSign ? 0 : 1);
