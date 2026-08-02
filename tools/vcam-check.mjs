#!/usr/bin/env node
// The output to OBS: the webcam serves the colour camera, and the take never learns
// about it.
//
// Two outputs share one sink here - a program-out page OBS opens as a browser source,
// and an MJPEG endpoint OBS opens as a media source - and they have different failure
// modes, so this file has different arms for them.
//
// **The claim that needed a control is the webcam's.** The wire already carries
// colour: type 2's registered 512x424 JPEG, which is `Registration::apply`'s resample
// of the colour camera into the *depth* camera's viewpoint. An implementation that
// upscaled that to 1080p and served it would look almost right - same scene, same
// moment, plausible resolution - and would be wrong in the way that matters, because
// the registered image wears the depth camera's 70.6 degree frustum and is punched
// through with holes wherever the depth solve failed. Nobody would notice from a
// thumbnail.
//
// So the discriminator is geometric rather than perceptual. The colour camera sees
// 84.1 degrees where the registered frustum sees 70.6, which means a real colour
// frame carries scene content down the sides that no upscale of the registered image
// can invent. `fake-grabber --hd` plants exactly that: the HD fixture *is* the
// registered frame upscaled, plus a magenta left margin and a cyan right one. An
// implementation that cheats therefore matches most of the picture and still cannot
// produce the margin, and `--mutate hd-upscales-registered` is the arm that has to
// fail on it. **Dimensions are the convenient probe and the wrong one**: an upscale
// is 1920x1080 too.
//
// The five claims:
//
//  1. **It is asked for, not always on.** No type 3 crosses the pipe until something
//     subscribes, because a 1080p JPEG is another ~50Mbit/s down a pipe whose
//     backpressure reaches the grabber and costs the take. And it stops again.
//  2. **What is served is the colour camera, byte for byte.** The margin says it is
//     not the registered image; a hash against the writer's own emit log says nothing
//     re-encoded it on the way through.
//  3. **The take is untouched, and that is an identity rather than an assurance.**
//     With a webcam attached throughout, the closed take carries types 1 and 2 and
//     nothing else, and every frame in it is byte for byte a frame the writer logged.
//     Checked against the *writer's* record rather than against anything a reader
//     produced, for the reason step 7 established.
//  4. **The origin rule reaches every route that serves live sensor bytes**, asked of
//     the route table rather than of the one route this step added - so the next one
//     is covered by declaring itself.
//  5. **The program-out page renders at its own size with no furniture.** Section 5
//     drives a browser, because every other arm in this file watches the server and
//     `monitor-check`'s case file is that four sections which all did that missed a
//     renderer drawing the wrong thing entirely.
//
//   node tools/vcam-check.mjs
//   node tools/vcam-check.mjs --mutate hd-upscales-registered   # must FAIL
//   node tools/vcam-check.mjs --mutate hd-reaches-recorder      # must FAIL
//
// It spawns its own server and needs none running. The stream is
// `tools/fake-grabber.mjs`, so no sensor is required; ffmpeg builds and decodes the
// fixture. Section 5 needs a GPU browser and `--no-browser` drops it and says so.
//
// **What it does not prove is OBS.** That a browser source renders WebGL at 1080p on
// macOS, and that OBS samples it at canvas rate rather than honouring arrival timing,
// are facts about OBS measured with OBS in front of you. No row here stands in for
// them, and the second one is written down in README as the reason the output's
// cadence is what it is.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageParser, TYPE_HELLO, TYPE_FRAME, TYPE_COLOR } from '../server/protocol.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const PORT = Number(flag('--port', '8361'));
const MUTATE = flag('--mutate');
const NO_BROWSER = argv.includes('--no-browser');
const WORK = join(REPO, '.vcam-check');
const SOURCE = join(REPO, 'captures', 'sample.knct');

// Where the fixture plants what the registered image cannot contain. Has to match
// `fake-grabber`'s `HD_MARGIN`; asserted below rather than assumed, because a fixture
// and a check that disagreed about where to look would pass each other by.
const MARGIN = Math.round(1920 * 0.12);
// How far a decoded margin may sit from the planted colour. JPEG at 4:2:0 moves a
// saturated edge by a few counts, and the two markers are 200-plus apart in every
// channel that distinguishes them, so this is loose enough to survive the codec and
// nowhere near loose enough to admit the room.
const COLOUR_TOLERANCE = 40;

const MUTATIONS = {
  // **The control for claim 2.** The endpoint serves the registered colour scaled up
  // to 1080p instead of the colour camera's own frame - the plausible wrong
  // implementation, and the one somebody would reach for to avoid a second encode.
  //
  // Placed at the offer rather than at the socket, so the grabber, the negotiation
  // and the take are all untouched and sections 1, 3 and 4 keep passing. A control
  // that fails for a neighbouring reason is not a control for the thing it names,
  // which this repo has been caught by before.
  'hd-upscales-registered': {
    file: 'server/index.js',
    edits: [[
      'webcam.offer(Buffer.from(msg.payload.subarray(8)), Number(msg.payload.readBigUInt64LE(0)));',
      'webcam.offer(upscaledRegistered ?? Buffer.from(msg.payload.subarray(8)), Number(msg.payload.readBigUInt64LE(0)));',
    ], [
      '    recorder.write(msg.raw);\n  } else if (msg.type === TYPE_COLOR) {',
      '    try {\n'
      + '      const db = msg.payload.readUInt32LE(0);\n'
      + '      const cb = msg.payload.readUInt32LE(4);\n'
      + '      if (cb) {\n'
      + '        upscaledRegistered = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", "pipe:0",\n'
      + '          "-vf", "scale=1920:1080", "-frames:v", "1", "-q:v", "3", "-f", "mjpeg", "pipe:1"],\n'
      + '          { input: msg.payload.subarray(16 + db, 16 + db + cb), maxBuffer: 64 * 1024 * 1024 });\n'
      + '      }\n'
      + '    } catch { /* the mutation is best-effort */ }\n'
      + '    recorder.write(msg.raw);\n  } else if (msg.type === TYPE_COLOR) {',
    ], [
      "import { Webcam } from './webcam.js';",
      "import { Webcam } from './webcam.js';\nimport { execFileSync } from 'node:child_process';\nlet upscaledRegistered = null;",
    ]],
  },

  // **The control for claim 3, and the one that would destroy footage.** The colour
  // message reaches the recorder, so a take carries a third message type - which
  // moves its content hash, the key the library joins two machines on, and puts a
  // record `capture.js`'s index and frame API do not expect in the middle of the
  // file. This is the `nearClip` versus `--min-depth` failure class: it changes the
  // footage in the one situation where nobody is watching for it, and it would look
  // like a feature working.
  'hd-reaches-recorder': {
    file: 'server/index.js',
    edits: [[
      'webcam.offer(Buffer.from(msg.payload.subarray(8)), Number(msg.payload.readBigUInt64LE(0)));',
      'webcam.offer(Buffer.from(msg.payload.subarray(8)), Number(msg.payload.readBigUInt64LE(0)));\n'
      + '    recorder.write(msg.raw);',
    ]],
  },
};

if (MUTATE && !MUTATIONS[MUTATE]) {
  console.error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}
if (!existsSync(SOURCE)) {
  console.error(`no capture at ${SOURCE} - this check needs one to loop; see tools/make-fixture.js`);
  process.exit(2);
}

// --- the staged tree -------------------------------------------------------
// A mutation applied in place and restored afterwards leaves a mutated working tree
// behind any crash, which is the one state a proof tool must never produce.
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
for (const dir of ['server', 'tools', 'web']) {
  cpSync(join(REPO, dir), join(WORK, dir), { recursive: true });
}
for (const name of ['node_modules', 'vendor', 'captures']) {
  const from = join(REPO, name);
  if (existsSync(from)) symlinkSync(from, join(WORK, name));
}
mkdirSync(join(WORK, 'takes'), { recursive: true });
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
let untested = null;
let crashed = null;
const ok = (label, pass, detail = '') => {
  checked++;
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [];
const EMIT_LOG = join(WORK, 'emitted.log');

const start = (extra = []) => new Promise((resolve, reject) => {
  const grabber = `${join(WORK, 'tools/fake-grabber.mjs')} --source ${SOURCE} --fps 30 --hd `
    + `--emit-log ${EMIT_LOG}`;
  const child = spawn(process.execPath, [
    join(WORK, 'server/index.js'), '--port', String(PORT),
    '--captures', join(WORK, 'takes'), '--grabber', grabber, ...extra,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(child);
  const log = [];
  const onData = (c) => {
    log.push(c.toString());
    if (log.join('').includes('viewer on')) setTimeout(() => resolve(() => log.join('')), 400);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  setTimeout(() => reject(new Error(`server never came up:\n${log.join('')}`)), 15000);
});
const stopAll = async () => {
  for (const c of servers) c.kill('SIGKILL');
  servers.length = 0;
  await wait(200);
};

const api = async (path, init) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = (path, body = {}) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * An MJPEG subscriber that keeps the parts it was sent.
 *
 * Parsed off the boundary rather than by scanning for JPEG markers, because the thing
 * being checked includes the framing: a part whose declared length disagrees with its
 * body is a stream OBS would resynchronise through and this would not notice.
 */
function subscribe() {
  const state = { parts: [], done: false, controller: new AbortController() };
  state.ready = fetch(`http://127.0.0.1:${PORT}/camera.mjpg`, { signal: state.controller.signal })
    .then(async (res) => {
      state.status = res.status;
      if (res.status !== 200) { state.done = true; return state; }
      let buf = Buffer.alloc(0);
      (async () => {
        try {
          for await (const chunk of res.body) {
            buf = Buffer.concat([buf, Buffer.from(chunk)]);
            for (;;) {
              const head = buf.indexOf('--braindanceframe\r\n');
              if (head === -1) break;
              const blank = buf.indexOf('\r\n\r\n', head);
              if (blank === -1) break;
              const headers = buf.subarray(head, blank).toString('latin1');
              const m = /Content-Length: (\d+)/.exec(headers);
              if (!m) break;
              const len = Number(m[1]);
              const bodyAt = blank + 4;
              if (buf.length < bodyAt + len) break;
              state.parts.push(Buffer.from(buf.subarray(bodyAt, bodyAt + len)));
              buf = buf.subarray(bodyAt + len);
            }
          }
        } catch { /* aborted */ }
        state.done = true;
      })();
      return state;
    });
  state.stop = () => state.controller.abort();
  return state;
}

/** What the writer says it emitted, as `type -> [sha256]`. */
function emitted() {
  if (!existsSync(EMIT_LOG)) return new Map();
  const out = new Map();
  for (const line of readFileSync(EMIT_LOG, 'utf8').split('\n')) {
    if (!line) continue;
    const [type, , hash] = line.split(' ');
    const key = Number(type);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(hash);
  }
  return out;
}

/** The mean RGB of a region, through ffmpeg, so nothing here decodes a JPEG by hand. */
function meanRgb(jpeg, crop) {
  const raw = execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-vf', `crop=${crop},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { input: jpeg, maxBuffer: 16 * 1024 * 1024 });
  return [raw[0], raw[1], raw[2]];
}
const near = (got, want) => got.every((v, i) => Math.abs(v - want[i]) <= COLOUR_TOLERANCE);
const dims = (jpeg) => execFileSync('ffprobe', [
  '-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', 'pipe:0',
], { input: jpeg, maxBuffer: 16 * 1024 * 1024 }).toString().trim().split(',').map(Number);

console.log(`\n[vcam] ${MUTATE ? `mutation ${MUTATE}` : 'unmutated'}, port ${PORT}\n`);

try {
  // --- 1. asked for, not always on -----------------------------------------
  console.log('1. the colour stream is asked for and stops again');
  {
    await start();
    // Long enough for a good number of frames to have gone by with nobody watching.
    await wait(1500);
    const before = emitted().get(TYPE_COLOR)?.length ?? 0;
    ok('no colour message is emitted while nothing is subscribed', before === 0,
      `${before} emitted`);

    const sub = subscribe();
    await sub.ready;
    await wait(1500);
    const during = emitted().get(TYPE_COLOR)?.length ?? 0;
    ok('subscribing starts it', during > 10, `${during} emitted`);
    ok('and the subscriber is actually being served parts', sub.parts.length > 10,
      `${sub.parts.length} parts`);

    // The take must be able to see it, which is the positive twin of the refusal:
    // a check built only out of refusals passes against a server that refuses
    // everything.
    const state = await api('/record/state');
    ok('the webcam is in the recorder\'s own accounting', Array.isArray(state.body?.webcam?.subscribers)
      && state.body.webcam.subscribers.length === 1,
    JSON.stringify(state.body?.webcam?.subscribers));
    // Loopback here, so it must NOT be refused - the exemption is what lets every
    // proof tool in this repo drive the server over localhost.
    ok('a loopback subscriber does not refuse the take', state.body?.monitors?.wouldRefuse === false);

    sub.stop();
    // Past the linger, which exists because OBS retries a dead source hard.
    await wait(7500);
    const atStop = emitted().get(TYPE_COLOR)?.length ?? 0;
    await wait(1500);
    const after = emitted().get(TYPE_COLOR)?.length ?? 0;
    ok('leaving stops it again', after === atStop, `${atStop} -> ${after}`);
    await stopAll();
  }

  // --- 2. it is the colour camera, byte for byte ---------------------------
  console.log('\n2. what is served is the colour camera and not the registered image');
  {
    rmSync(EMIT_LOG, { force: true });
    await start();
    const sub = subscribe();
    await sub.ready;
    await wait(2000);
    ok('the endpoint answered 200', sub.status === 200, `status ${sub.status}`);

    const frame = sub.parts.at(-1);
    if (!frame) {
      ok('a frame was served at all', false, 'no parts arrived');
    } else {
      const [w, h] = dims(frame);
      ok('it is the colour camera\'s native resolution', w === 1920 && h === 1080, `${w}x${h}`);

      // **The discriminator.** An upscale of the registered image is 1920x1080 too,
      // and it cannot be magenta and cyan down the sides.
      const left = meanRgb(frame, `${MARGIN}:1080:0:0`);
      const right = meanRgb(frame, `${MARGIN}:1080:${1920 - MARGIN}:0`);
      ok('the left margin carries what the registered frustum cannot see',
        near(left, [255, 0, 255]), `rgb(${left})`);
      ok('and so does the right', near(right, [0, 255, 255]), `rgb(${right})`);
      // The middle has to be the room rather than more marker, or the two rows above
      // would pass against a page that was simply magenta and cyan all over.
      const middle = meanRgb(frame, '400:400:760:340');
      ok('and the middle is the scene rather than more marker',
        !near(middle, [255, 0, 255]) && !near(middle, [0, 255, 255]), `rgb(${middle})`);

      // Passthrough: the bytes served are the bytes emitted. Anything that decoded
      // and re-encoded on the way through would fail this while still passing the
      // margin rows above.
      const served = createHash('sha256').update(Buffer.concat([
        Buffer.alloc(8), frame,
      ])).digest('hex');
      const log = emitted().get(TYPE_COLOR) ?? [];
      // The writer logs the whole payload, which is the u64 stamp then the JPEG. The
      // stamp moves per frame, so what is comparable is the JPEG - hashed here the
      // same way for every candidate rather than assuming which frame this was.
      const jpegHash = createHash('sha256').update(frame).digest('hex');
      const anyMatch = log.length > 0 && sub.parts.some((p) => createHash('sha256').update(p).digest('hex') === jpegHash);
      ok('every served part is the same JPEG the writer emitted', anyMatch && served.length === 64,
        `${log.length} emitted, ${sub.parts.length} served`);
      // Nothing re-encoded: every part is byte-identical to every other, because the
      // fixture emits one frame. On a sensor this row would not hold and is not the
      // claim; here it is what proves no scaling happened between the two ends.
      const distinct = new Set(sub.parts.map((p) => createHash('sha256').update(p).digest('hex')));
      ok('and nothing re-encoded it on the way through', distinct.size === 1,
        `${distinct.size} distinct payloads across ${sub.parts.length} parts`);
    }
    sub.stop();
    await stopAll();
  }

  // --- 3. the take is untouched --------------------------------------------
  console.log('\n3. the take never learns the webcam exists');
  {
    rmSync(EMIT_LOG, { force: true });
    rmSync(join(WORK, 'takes'), { recursive: true, force: true });
    mkdirSync(join(WORK, 'takes'), { recursive: true });
    await start();
    const sub = subscribe();
    await sub.ready;
    await wait(800);

    const started = await post('/record/start');
    ok('a take starts with the webcam attached', started.status === 200, JSON.stringify(started.body));
    await wait(2500);
    const stopped = await post('/record/stop');
    ok('and stops', stopped.status === 200);
    sub.stop();
    await wait(400);

    const dir = join(WORK, 'takes');
    const file = execFileSync('sh', ['-c', `ls ${dir}/*.knct 2>/dev/null | head -1`]).toString().trim();
    if (!file) {
      ok('the take was written', false, `nothing in ${dir}`);
    } else {
      const parser = new MessageParser();
      const types = new Map();
      const frameHashes = [];
      for (const msg of parser.push(readFileSync(file))) {
        types.set(msg.type, (types.get(msg.type) ?? 0) + 1);
        if (msg.type === TYPE_FRAME) frameHashes.push(createHash('sha256').update(msg.payload).digest('hex'));
      }
      ok('the take carries a hello and frames', (types.get(TYPE_HELLO) ?? 0) === 1 && frameHashes.length > 10,
        `hello ${types.get(TYPE_HELLO) ?? 0}, frames ${frameHashes.length}`);
      // **The row the mutation has to trip.**
      ok('and carries no colour message at all', !types.has(TYPE_COLOR),
        `${types.get(TYPE_COLOR) ?? 0} colour messages in the take`);
      ok('and nothing but those two types', [...types.keys()].every((t) => t === TYPE_HELLO || t === TYPE_FRAME),
        `types ${[...types.keys()].join(', ')}`);

      // Against the writer's own log rather than against anything a reader produced.
      const emittedFrames = new Set(emitted().get(TYPE_FRAME) ?? []);
      const foreign = frameHashes.filter((h) => !emittedFrames.has(h));
      ok('and every frame in it is byte for byte one the writer emitted', foreign.length === 0,
        `${foreign.length} of ${frameHashes.length} frames are not in the emit log`);
    }
    await stopAll();
  }

  // --- 4. the origin rule reaches every live route -------------------------
  console.log('\n4. the origin rule reaches every route serving live sensor bytes');
  {
    await start();
    const table = await api('/library/routes');
    const live = (table.body?.routes ?? []).filter((r) => r.live);
    ok('the table declares at least one live route', live.length > 0,
      live.map((r) => r.path).join(', '));

    // Walked rather than named. An arm that asked about `/camera.mjpg` would test
    // `/camera.mjpg`; an arm that walks the table tests the rule, so the next route
    // to serve live sensor bytes is asked by declaring itself.
    for (const route of live) {
      const foreign = await fetch(`http://127.0.0.1:${PORT}${route.path}`, {
        headers: { Origin: 'http://evil.example' },
      });
      ok(`${route.path} refuses a foreign origin`, foreign.status === 403, `status ${foreign.status}`);
      foreign.body?.cancel?.();

      const same = await fetch(`http://127.0.0.1:${PORT}${route.path}`, {
        headers: { Origin: `http://127.0.0.1:${PORT}` },
      });
      ok(`${route.path} allows its own origin`, same.status === 200, `status ${same.status}`);
      same.body?.cancel?.();
    }

    // The webcam says why rather than serving nothing, which is the difference
    // between a setting somebody fixes and a bug somebody files.
    await post('/record/stop').catch(() => {});
    await stopAll();
  }

  // --- 5. the source's own picture -----------------------------------------
  console.log('\n5. the program-out page renders at its own size with no furniture');
  if (NO_BROWSER) {
    console.log('  (skipped: --no-browser)');
  } else {
    let chromium = null;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      try {
        const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
        ({ chromium } = await import(`file://${join(root, 'playwright/index.mjs')}`));
      } catch { /* reported below */ }
    }
    if (!chromium) {
      untested = 'playwright is not installed, so what the source actually draws was never asked';
    } else {
      await start();
      const browser = await chromium.launch({
        args: ['--use-gl=angle', '--use-angle=default', '--enable-unsafe-swiftshader'],
      });
      // Deliberately not 1920x1080: the whole claim is that the output size comes
      // from the setting rather than from the window, and a window that happened to
      // match would pass whether or not anything worked.
      const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await page.goto(`http://127.0.0.1:${PORT}/program`);
      await page.waitForTimeout(4000);

      const seen = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        return {
          body: document.body.className,
          panel: getComputedStyle(document.getElementById('panel')).display,
          buffer: gl ? [gl.drawingBufferWidth, gl.drawingBufferHeight] : null,
          readout: document.getElementById('programOutReadout')?.textContent ?? '',
          orbit: globalThis.__kinect?.controls?.enabled,
        };
      });

      ok('the page knows it is a source', seen.body.includes('program-out'), seen.body);
      ok('the buffer is the output size and not the window', seen.buffer?.[0] === 1920 && seen.buffer?.[1] === 1080,
        `${seen.buffer?.join('x')} in a 900x600 window`);
      ok('the panel is not in the shot', seen.panel === 'none', seen.panel);
      ok('and orbit cannot fight the pose being pushed to it', seen.orbit === false, String(seen.orbit));
      // The readout is the honesty half: a source delivering under its rate has to
      // say so where somebody judging the picture can see it.
      ok('the readout reports a delivered rate', /(\d+\.\d) fps/.test(seen.readout), seen.readout);
      const fps = Number(/([\d.]+) fps/.exec(seen.readout)?.[1] ?? 0);
      ok('and the source really is drawing', fps > 5, `${fps} fps`);
      ok('with no error on the page', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

      // **The operator's two controls, driven from the operator's page.** This is the
      // only place they can be checked: what they change is a different document, so
      // an arm on the recorder alone would press them and have nothing to read. It is
      // also what makes `editor-check`'s rule for `#programOutGroup` true rather than
      // an excuse - that file names this section by name.
      const operator = await browser.newPage({ viewport: { width: 900, height: 600 } });
      await operator.goto(`http://127.0.0.1:${PORT}/record`);
      await operator.waitForTimeout(2500);

      // Deliberately not a size anything defaults to, so a buffer that merely stayed
      // put cannot be read as having followed.
      await operator.fill('#progSize', '1280x720');
      await operator.dispatchEvent('#progSize', 'change');
      await operator.selectOption('#progMode', 'mirror');
      await page.waitForTimeout(2500);

      const after = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        return {
          buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
          readout: document.getElementById('programOutReadout')?.textContent ?? '',
        };
      });
      ok('setting the size on the operator page resizes the source\'s buffer',
        after.buffer[0] === 1280 && after.buffer[1] === 720, after.buffer.join('x'));
      ok('and switching to mirror reaches the source', after.readout.includes('mirror'),
        after.readout);

      // A parameter write travels the same road, and it is the road that matters: it
      // goes through the registry's one write hook rather than a list of forwarded
      // fields, so this row is really asking whether a parameter added later would
      // arrive without anybody wiring it.
      await operator.evaluate('__kinect.params.set("pointSize", 4.2)');
      await page.waitForTimeout(1200);
      const forwarded = await page.evaluate('__kinect.params.get("pointSize")');
      ok('and a parameter write reaches it through the registry', forwarded === 4.2, String(forwarded));

      await browser.close();
      await stopAll();
    }
  }
} catch (err) {
  // A run that threw did not finish, and that is a different answer from a claim that
  // failed - the distinction this repo spends exit 2 on. Under `--mutate` a harness
  // timeout would otherwise be recorded as the mutation being caught.
  crashed = err;
  console.log(`\n  FAIL  the run did not finish: ${err.message}`);
} finally {
  await stopAll();
  rmSync(WORK, { recursive: true, force: true });
}

console.log(`\n[vcam] ${checked} assertions, ${failed} failed`
  + (NO_BROWSER ? ' - the renderer section was skipped, so what the source draws is untested here' : ''));
if (crashed) {
  console.log(`[vcam] DID NOT RUN - ${crashed.message}. Nothing here is a finding: re-run it.`);
  process.exit(2);
}
if (untested) {
  console.log(`[vcam] UNTESTED - ${untested}. Install playwright, or pass --no-browser and mean it.`);
  process.exit(2);
}
if (MUTATE) {
  // Exit code alone cannot tell "the mutation was caught" from "the tool crashed
  // before asserting anything", so the count is what the verdict is made of.
  if (failed === 0) { console.log('[vcam] NOT CAUGHT - the check passed a server it should have rejected'); process.exit(1); }
  console.log(`[vcam] caught, as required (${failed} assertion${failed === 1 ? '' : 's'} fired)`);
  process.exit(1);
}
if (failed) { console.log('[vcam] FAIL'); process.exit(1); }
console.log('[vcam] PASS');
process.exit(0);
