// Proves that the same program time produces the same image.
//
// The claim step 1 makes is reproducibility, not speed, so an interleaved A/B is
// the wrong instrument: what discriminates is whether a rendered sequence can be
// replayed. So every input is pinned - a fixed run of real capture frames read
// out of a .knct, a fixed camera pose, colour off - and both feedback paths are
// left switched on, because they are the only things that could carry state
// between two runs. The Blackwall preset supplies that: fade and wake drive the
// surface memory, trails drive the afterimage, and glitch, scan, scanlines and
// grain all read the time uniform, so a clock that moved would show up in a hash.
//
// The input has to move across the run. A static scene makes the afterimage
// converge to its own input and return the same hash whether the accumulator ran
// or not, which is arithmetic rather than evidence - so the frames are sampled
// every fourth frame of the capture, about 130ms apart, where a hand crossing the
// sensor genuinely changes the depth plane.
//
//   node tools/determinism-check.mjs [--url http://localhost:8080]
//   node tools/determinism-check.mjs --clock [--before HEAD]
//
// --clock is the before-half, and it is a clock reading rather than a pixel hash.
// The pre-refactor page offers no way to ask for an image at a position and no
// readback inside its loop, so a hash comparison against it can only be had by
// instrumenting it - and instrumented code is not the code that shipped. What can
// be read without touching it is the quantity that actually differs: `uniforms.time`
// was `clock.getElapsedTime()`, wall clock since the page loaded. So --clock serves
// an untouched `git show <rev>:web/main.js` into the running server, loads it three
// times, and reads the time uniform at the same animation frame each load. Three
// different values is the before-evidence, and the same three reads against the
// working tree are the after.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MessageParser, TYPE_FRAME } from '../server/protocol.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const URL_BASE = flag('--url', 'http://localhost:8080');
const CAPTURE = flag('--capture', 'captures/sample.knct');
const CLOCK = argv.includes('--clock');
const BEFORE_REV = flag('--before', 'HEAD');
const HEADED = argv.includes('--headed');
const SOURCE_FRAMES = Number(flag('--frames', '12'));
const STRIDE = Number(flag('--stride', '4'));
// Images per source frame. More than one is the point: it is where a renderer
// driven by program time differs from one driven by however many display frames
// happened to fit between two arrivals.
const SUBSTEPS = Number(flag('--substeps', '4'));

// Playwright is not a dependency of this project - it is a tool the proofs reach
// for - so it is resolved from wherever it happens to be installed.
async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const roots = [];
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim());
  } catch { /* no global npm root: the local resolve below may still work */ }

  const candidates = [async () => import('playwright')];
  for (const root of roots) {
    for (const name of ['playwright', '@playwright/cli/node_modules/playwright']) {
      candidates.push(async () => import(pathToFileURL(require.resolve(join(root, name))).href));
    }
  }
  for (const load of candidates) {
    try {
      // Playwright is CommonJS, and whether the named exports survive the ESM
      // wrapper depends on how it was resolved, so take either shape.
      const mod = await load();
      const pw = mod.chromium ? mod : mod.default;
      if (pw?.chromium) return pw;
    } catch { /* try the next one */ }
  }
  throw new Error('playwright not found - install it globally or in this project');
}

// ------------------------------------------------------------------- fixture

// A pinned run is just capture frame payloads back to back, wire format unchanged
// apart from the colour block being dropped. Keeping the format means the page
// parses it with the same field offsets the socket path uses, and the payload is
// real sensor depth rather than a synthetic plane.
function buildFixture(path) {
  const parser = new MessageParser();
  const frames = [];
  for (const msg of parser.push(readFileSync(path))) {
    if (msg.type === TYPE_FRAME) frames.push(msg.payload);
  }
  if (frames.length < SOURCE_FRAMES * STRIDE) {
    throw new Error(`${path} has ${frames.length} frames, need ${SOURCE_FRAMES * STRIDE}`);
  }

  const out = [];
  for (let i = 0; i < SOURCE_FRAMES; i++) {
    const src = frames[i * STRIDE];
    const depthBytes = src.readUInt32LE(0);
    const payload = Buffer.alloc(16 + depthBytes);
    payload.writeUInt32LE(depthBytes, 0);
    payload.writeUInt32LE(0, 4); // colour dropped: JPEG decode is asynchronous
    src.copy(payload, 8, 8, 16); // the capture timestamp, verbatim
    src.copy(payload, 16, 16, 16 + depthBytes);
    out.push(payload);
  }
  return Buffer.concat(out);
}

// --------------------------------------------------------------- in-page runs

// Everything below runs in the browser. Pixels never cross back over the wire -
// only their digests - because a 640x400 frame is a megabyte and there are
// dozens of them per run.
const PAGE_HELPERS = `
  const sha256 = async (bytes) => {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  };
  const pinCamera = (cam) => {
    cam.position.set(0, 0.1, 1.6);
    cam.lookAt(0, 0, -2.2);
    cam.updateMatrixWorld(true);
  };
`;

async function gpuInfo(page) {
  return page.evaluate(() => {
    const gl = globalThis.__kinect.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      colorBufferFloat: !!gl.getExtension('EXT_color_buffer_float'),
      floatBlend: !!gl.getExtension('EXT_float_blend'),
      buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    };
  });
}

const runAfter = `async ({ substeps, tailOnly }) => {
  ${PAGE_HELPERS}
  const k = globalThis.__kinect;
  k.drive.reset();
  pinCamera(k.freeCamera);

  const times = k.drive.times();
  let positions = [];
  for (let i = 0; i < times.length - 1; i++) {
    for (let r = 0; r < substeps; r++) {
      positions.push(times[i] + (times[i + 1] - times[i]) * (r / substeps));
    }
  }
  // The control: land on the last position having rendered nothing in between.
  // The surface memory still sees every source frame, because the source hands
  // back each one it crossed - what it misses is the 43 renders the afterimage
  // needs to converge, which is precisely what a pre-roll is for.
  if (tailOnly) positions = positions.slice(-1);

  const out = [];
  for (const t of positions) {
    k.drive.stepTo(t);
    const pixels = k.drive.readPixels();
    out.push({ hash: await sha256(pixels), t, mixT: k.uniforms.mixT.value, time: k.uniforms.time.value });
  }
  return {
    out,
    drawRange: k.geometry.drawRange.count,
    damp: k.afterimage.uniforms.damp.value,
    passes: { afterimage: k.afterimage.enabled, bloom: k.bloom.enabled, grade: k.grade.enabled },
    ghosts: k.stateStats().ghostsDrawn,
  };
}`;


// ------------------------------------------------------------- the clock check

// Two readings per load, at fixed animation frames, so nothing about when the
// reading was taken varies between loads. The early one shows the value is not a
// property of the footage - it is different on every load. The late one shows why
// that matters: with no frame having arrived in between, the old clock has moved
// anyway, so the same position in a take renders differently depending only on
// how long the tab has been open.
const READ_AT = [120, 480];

const readClock = `(async () => {
  const marks = ${JSON.stringify(READ_AT)};
  const out = [];
  for (let frame = 0, i = 0; i < marks.length; i++) {
    for (; frame < marks[i]; frame++) await new Promise((r) => requestAnimationFrame(r));
    out.push(globalThis.__kinect.uniforms.time.value);
  }
  return out;
})()`;

async function clockCheck(context) {
  const before = execFileSync('git', ['show', `${BEFORE_REV}:web/main.js`], {
    encoding: 'utf8', maxBuffer: 1 << 26,
  });
  // Once step 1 is committed, HEAD is the refactored page and this mode would be
  // comparing it against itself. Refusing beats printing two matching columns
  // under a heading that says they should differ.
  if (before.includes('LiveTransport')) {
    throw new Error(
      `${BEFORE_REV}:web/main.js already contains the transport - pass an earlier `
      + 'rev with --before, e.g. --before HEAD~1',
    );
  }

  async function sample(label, source) {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const page = await context.newPage();
      // The frameless condition is enforced rather than hoped for. An earlier
      // version of this check only asserted "no frame ever arriving" in its own
      // header while leaving the socket to whatever the server happened to be
      // doing, and running it against a live --replay flipped its verdict between
      // consecutive runs on an unchanged tree. Intercepting the socket without
      // connecting it upstream means the page opens one, as it always does, and
      // no frame can reach it whatever the server is serving.
      await page.routeWebSocket(/.*/, () => { /* accepted, never connected */ });
      // The old page is served exactly as it was committed. Instrumenting it to
      // read pixels back would mean measuring code that never shipped.
      if (source) {
        await page.route('**/main.js', (route) => route.fulfill({
          contentType: 'text/javascript; charset=utf-8', body: source,
        }));
      }
      await page.goto(URL_BASE, { waitUntil: 'load' });
      await page.waitForFunction(() => !!globalThis.__kinect);

      // Proof that the interception held, independent of the reading it protects.
      // The sensor's hello carries fx as 366.031494 and both pages default the
      // uniform to exactly 366, so the default still standing means nothing came
      // over the socket. Without this the check would quietly go back to measuring
      // the server the day the pattern stops matching, which is the failure it was
      // just repaired for - and it would look like a pass.
      const focal = await page.evaluate('globalThis.__kinect.uniforms.focal.value.x');
      if (focal !== 366) {
        throw new Error(`websocket interception failed - intrinsics arrived (focal.x=${focal})`);
      }

      runs.push(await page.evaluate(readClock));
      await page.close();
    }
    for (const [i, mark] of READ_AT.entries()) {
      const values = runs.map((r) => r[i]);
      const spread = Math.max(...values) - Math.min(...values);
      console.log(`[clock] ${label} @frame ${String(mark).padStart(3)}  `
        + `${values.map((v) => v.toFixed(4)).join(', ')}   spread ${spread.toFixed(4)} s`);
    }
    const drift = runs.map((r) => r[1] - r[0]);
    return { runs, drift };
  }

  console.log(`[clock] uniforms.time read at animation frames ${READ_AT.join(' and ')}, `
    + 'three fresh loads each, no frame ever arriving');
  const oldPage = await sample(`before (${BEFORE_REV})`, before);
  const newPage = await sample('after  (worktree)  ', null);

  // Every load distinct at the first mark says the value is not a property of the
  // footage. Movement between the two marks, with no frame having arrived, says
  // what it is a property of instead.
  const distinct = new Set(oldPage.runs.map((r) => r[0].toFixed(6))).size === 3;
  const oldDrift = Math.min(...oldPage.drift);
  const newDrift = Math.max(...newPage.drift);
  console.log(`\n[clock] before: three loads agree at neither mark `
    + `- ${distinct ? 'confirmed' : 'NOT confirmed, values repeated'}; and the clock moved `
    + `${oldDrift.toFixed(2)}s between the marks on no frames at all, so the same position `
    + 'in a take renders differently with tab age');
  console.log('[clock] after:  program time does not advance without frames '
    + `- ${newDrift === 0 ? 'confirmed, zero movement between the marks on every load' : 'NOT confirmed'}`);

  const pass = distinct && oldDrift > 1 && newDrift === 0;
  console.log(`\n[clock] ${pass ? 'PASS' : 'FAIL'}`);
  return pass;
}

// ------------------------------------------------------------------ the check

const { chromium } = await loadPlaywright();
// The full chromium build rather than the headless shell: the shell can land on
// SwiftShader, which has no EXT_color_buffer_float, and a run that silently fell
// back to a software rasteriser would agree with itself for the wrong reason.
const browser = await chromium.launch({ channel: 'chromium', headless: !HEADED });
const context = await browser.newContext({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });

if (CLOCK) {
  const ok = await clockCheck(context);
  await browser.close();
  process.exit(ok ? 0 : 1);
}

const fixture = buildFixture(CAPTURE);
console.log(`[determinism] pinned ${SOURCE_FRAMES} frames from ${CAPTURE} `
  + `(every ${STRIDE}th, ${(fixture.length / 1e6).toFixed(1)} MB), ${SUBSTEPS} images each`);

async function openPage() {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.route('**/__pinned.bin', (route) => route.fulfill({
    status: 200,
    contentType: 'application/octet-stream',
    body: fixture,
  }));
  await page.goto(URL_BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => !!globalThis.__kinect);

  const gpu = await gpuInfo(page);
  if (/swiftshader|software|llvmpipe/i.test(gpu.renderer)) {
    throw new Error(`software rasteriser (${gpu.renderer}) - the result would prove nothing`);
  }
  if (!gpu.colorBufferFloat) throw new Error('no EXT_color_buffer_float: the surface memory is not running at float');

  // Blackwall, selected the way a user selects it, so no look value is invented
  // here. It is the one preset that switches on both accumulators at once.
  await page.click('#modes button[data-mode="4"]');

  await page.evaluate(async () => {
    const buffer = await (await fetch('/__pinned.bin')).arrayBuffer();
    if (globalThis.__kinect.drive) {
      globalThis.__kinect.drive.pin(buffer);
      return;
    }
    // The pre-refactor page has no pair source to install, so the frames are
    // split here and pushed in one at a time instead.
    const view = new DataView(buffer);
    const frames = [];
    for (let off = 0; off + 16 <= buffer.byteLength;) {
      const len = 16 + view.getUint32(off, true);
      frames.push(buffer.slice(off, off + len));
      off += len;
    }
    globalThis.__pinnedFrames = frames;
  });

  return { page, errors, gpu };
}

// Called immediately rather than handed over as a function: playwright evaluates
// a string as an expression, so a bare arrow would come back as undefined.
const runOn = (page, tailOnly = false) => page.evaluate(
  `(${runAfter})(${JSON.stringify({ substeps: SUBSTEPS, tailOnly })})`,
);

const first = await openPage();
console.log(`[determinism] ${first.gpu.renderer}`);
console.log(`[determinism] buffer ${first.gpu.buffer.join('x')}  `
  + `EXT_color_buffer_float=${first.gpu.colorBufferFloat}  EXT_float_blend=${first.gpu.floatBlend}`);

const runA = await runOn(first.page);
const runB = await runOn(first.page);

// The control. The same program position, reached without rendering the frames
// before it, must produce a different image - otherwise the feedback paths are
// contributing nothing and the agreement above is agreement about an easier
// problem. Repeating the run without a reset would be the more obvious control
// and is now a contract violation the pinned source refuses, correctly: there is
// no way to walk the accumulators backwards.
const runD = await runOn(first.page, true);

// A fresh page is a fresh GL context, fresh render targets and a fresh clock, so
// it is the run that would catch a result that only held because the page had
// been left sitting in the state a previous run put it in.
const second = await openPage();
const runC = await runOn(second.page);

await browser.close();

// ------------------------------------------------------------------- verdict

const hashes = (r) => r.out.map((f) => f.hash);
const compare = (x, y) => {
  const a = hashes(x), b = hashes(y);
  if (a.length !== b.length) return { same: false, at: -1, n: Math.min(a.length, b.length) };
  const at = a.findIndex((h, i) => h !== b[i]);
  return { same: at === -1, at, n: a.length };
};

const varied = new Set(hashes(runA)).size;
const p = runA.passes;
console.log(`\n[determinism] ${runA.out.length} images per run, `
  + `drawRange=${runA.drawRange} (ghost half ${runA.drawRange > 512 * 424 ? 'drawn' : 'OFF'})`);
console.log(`[determinism] surface memory ${runA.ghosts}% of pixels ghosting at the end of the run, `
  + `afterimage ${p.afterimage ? `on damp=${runA.damp}` : 'OFF'}, `
  + `bloom ${p.bloom ? 'on' : 'OFF'}, grade ${p.grade ? 'on' : 'OFF'}`);
console.log(`[determinism] distinct images within run 1: ${varied}/${runA.out.length}`
  + `${varied < runA.out.length / 2 ? '  <-- input barely moves, the run proves little' : ''}`);

{
  const drift = Math.max(...runA.out.map((f) => Math.abs(f.time - f.t)));
  const span = runA.out[runA.out.length - 1].t - runA.out[0].t;
  console.log(`[determinism] program time ${runA.out[0].t.toFixed(3)}s to `
    + `${runA.out[runA.out.length - 1].t.toFixed(3)}s (${span.toFixed(3)}s), `
    + `time uniform tracks it to ${drift}`);
}

const ab = compare(runA, runB);
const ac = compare(runA, runC);
const tailA = runA.out[runA.out.length - 1].hash;
const tailD = runD.out[runD.out.length - 1].hash;
const ad = { same: tailA === tailD, at: 0, n: 1 };
const show = (label, r) => console.log(
  `[determinism] ${label}: ${r.same ? 'IDENTICAL' : `DIFFER at image ${r.at} of ${r.n}`}`,
);
show('run 1 vs run 2 (same page)      ', ab);
show('run 1 vs run 3 (fresh page)     ', ac);
show('last image vs control (no pre-roll)', ad);
if (ad.same) console.log('               ^ the accumulators carry nothing: this run proves an easier claim');

if (!ab.same || !ac.same) {
  const i = Math.max(0, Math.min(ab.at === -1 ? ac.at : ab.at, runA.out.length - 1));
  console.log(`\n  first divergence, image ${i}:`);
  for (const [label, r] of [['run 1', runA], ['run 2', runB], ['run 3', runC]]) {
    const f = r.out[i];
    if (!f) continue;
    console.log(`    ${label}  hash ${f.hash.slice(0, 16)}…  time=${f.time.toFixed(4)}  mixT=${f.mixT.toFixed(4)}`);
  }
}

const pageErrors = [...first.errors, ...second.errors];
if (pageErrors.length) console.log(`\n[determinism] page errors:\n  ${pageErrors.join('\n  ')}`);

const pass = ab.same && ac.same && !ad.same
  && varied > runA.out.length / 2
  && p.afterimage && p.bloom && p.grade && runA.ghosts > 0;
console.log(`\n[determinism] ${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
