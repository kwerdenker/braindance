// Proves that one registry drives the renderer, and that the panel is a view on it.
//
// Four claims, and they fail for different reasons, so they are checked apart.
//
// A parameter has to *land*. Setting it through the registry must reach the place
// the renderer actually reads - a uniform, a pass property, a pass `enabled` flag,
// the draw range, the drawing buffer - and several parameters do more than set a
// uniform, so the side effects are checked as side effects rather than assumed to
// come along. The landing sites are written out here rather than asked of the
// page, because a registry reporting its own values back would agree with itself
// whatever it did with them.
//
// The panel has to be a *view*. Both directions: a slider event has to move the
// registry, and a registry write has to move the slider and its readout. And the
// HTML has to carry no parameter data at all - no value, min, max, step or checked
// on a registry-owned input - or the range lives in two places again and step 6's
// headless renderer reads the copy that is wrong.
//
// The values have to *round-trip through an image*. Serialise the registry, render
// a pinned run and hash it, restore from the serialised set, render again: the
// same pixels. That is the property steps 5, 6 and 7 all rest on, so it gets a
// falsification control - every parameter is left out of the restore in turn, and
// omitting one has to change the image. Without that, the equality above would
// pass just as well against a registry wired to nothing.
//
// And nothing may have *moved*. The two built-in mode presets and the boot state
// are compared against the committed page rather than against a table typed in
// here, by serving `git show <rev>:web/{index.html,main.js}` into a second load.
// A table would only restate what the new code does.
//
//   node server/index.js --port 8080 --replay captures/sample.knct &
//   node tools/registry-check.mjs --url http://localhost:8080

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { MessageParser, TYPE_FRAME } from '../server/protocol.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

// Everything the check reads about the repo is resolved against this file rather
// than against the working directory: the panel it inspects, the capture it pins,
// and the tree `git show` reads the before-arm out of. A tool that only runs from
// one directory is a tool that gets run from the wrong one.
const REPO = fileURLToPath(new URL('..', import.meta.url));

const URL_BASE = flag('--url', 'http://localhost:8080');
const CAPTURE = flag('--capture') ?? join(REPO, 'captures/sample.knct');
// The literal commit rather than HEAD: once step 3 is committed, HEAD is the
// registry and the before-arm would be comparing the tree against itself.
const BEFORE_REV = flag('--before', '057dc4b');
const HEADED = argv.includes('--headed');
const SOURCE_FRAMES = Number(flag('--frames', '6'));
const STRIDE = Number(flag('--stride', '4'));
const SUBSTEPS = Number(flag('--substeps', '3'));

const VIEW = { width: 640, height: 400 };
const POINTS = 512 * 424;
// THREE.NormalBlending and THREE.AdditiveBlending, by value, because the check
// reads the material rather than the registry.
const NORMAL_BLENDING = 1;
const ADDITIVE_BLENDING = 2;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (x) => JSON.stringify(x);

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
      const mod = await load();
      const pw = mod.chromium ? mod : mod.default;
      if (pw?.chromium) return pw;
    } catch { /* try the next one */ }
  }
  throw new Error('playwright not found - install it globally or in this project');
}

// ------------------------------------------------------------------- fixture

// Capture frame payloads back to back, wire format unchanged apart from the colour
// block being dropped, so the page parses them with the same field offsets the
// socket path uses and the depth is real sensor depth.
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

// ------------------------------------------------------- where each value lands
//
// Written out independently of the registry. If `apply` stopped reaching one of
// these, every other check here would still pass and this one would not.

const LANDING = {
  pointSize: 'k.uniforms.pointSize.value',
  opacity: 'k.uniforms.opacity.value',
  exposure: 'k.uniforms.exposure.value',
  additive: '[k.material.blending, k.material.depthWrite, k.uniforms.softEdge.value]',
  near: 'k.uniforms.nearClip.value',
  far: 'k.uniforms.farClip.value',
  interpolate: 'k.uniforms.interpolate.value',
  snapDelta: 'k.uniforms.snapDelta.value',
  fade: '[k.uniforms.fadeTime.value, k.geometry.drawRange.count]',
  wake: '[k.uniforms.wakeTime.value, k.geometry.drawRange.count]',
  warp: 'k.uniforms.warp.value',
  warpSpeed: 'k.uniforms.warpSpeed.value',
  glitch: 'k.uniforms.glitch.value',
  spin: 'k.controls.autoRotate',
  scan: 'k.uniforms.scanAmount.value',
  rim: 'k.uniforms.rimAmount.value',
  bloom: '[k.bloom.strength, k.bloom.enabled]',
  trails: '[k.afterimage.uniforms.damp.value, k.afterimage.enabled]',
  rgbSplit: '[k.grade.uniforms.rgbSplit.value, k.grade.enabled]',
  scanlines: '[k.grade.uniforms.scanlines.value, k.grade.enabled]',
  grain: '[k.grade.uniforms.grain.value, k.grade.enabled]',
  denoise: 'k.uniforms.denoise.value',
  edgeTol: 'k.uniforms.edgeTol.value',
  renderScale: 'k.renderer.getContext().drawingBufferWidth',
  camera: '[...k.programCamera.position.toArray(), ...k.programCamera.quaternion.toArray(), k.programCamera.fov]',
};

// What that landing site must read, given the value the registry was handed. The
// ones taking `all` are the parameters that share a side effect with another.
const EXPECT = {
  pointSize: (v) => v,
  opacity: (v) => v,
  exposure: (v) => v,
  additive: (v) => [v ? ADDITIVE_BLENDING : NORMAL_BLENDING, !v, v ? 1 : 0],
  near: (v) => v,
  far: (v) => v,
  interpolate: (v) => (v ? 1 : 0),
  snapDelta: (v) => v,
  fade: (v, all) => [v / 1000, v > 0 || all.wake > 0 ? POINTS * 2 : POINTS],
  wake: (v, all) => [v / 1000, all.fade > 0 || v > 0 ? POINTS * 2 : POINTS],
  warp: (v) => v,
  warpSpeed: (v) => v,
  glitch: (v) => v,
  spin: (v) => v,
  scan: (v) => v,
  rim: (v) => v,
  bloom: (v) => [v, v > 0],
  trails: (v) => [v, v > 0],
  rgbSplit: (v, all) => [v, v > 0 || all.scanlines > 0 || all.grain > 0],
  scanlines: (v, all) => [v, all.rgbSplit > 0 || v > 0 || all.grain > 0],
  grain: (v, all) => [v, all.rgbSplit > 0 || all.scanlines > 0 || v > 0],
  denoise: (v) => (v ? 1 : 0),
  edgeTol: (v) => v,
  // three floors width * pixelRatio, and the context runs at deviceScaleFactor 1.
  renderScale: (v) => Math.floor(VIEW.width * (v / 100)),
  camera: (v) => [...v.position, ...v.quaternion, v.fov],
};

// A scrambled but valid set: every value off its default and on its own step grid,
// every boolean flipped. This is what gets serialised, restored and hashed.
const SCRAMBLE = {
  pointSize: 9.5,
  opacity: 0.62,
  exposure: 2.05,
  additive: true,
  near: 0.35,
  far: 4.2,
  interpolate: false,
  snapDelta: 410,
  fade: 260,
  wake: 830,
  warp: 0.075,
  warpSpeed: 1.45,
  glitch: 0.31,
  spin: true,
  scan: 0.72,
  rim: 0.28,
  bloom: 1.35,
  trails: 0.44,
  rgbSplit: 2.3,
  scanlines: 0.61,
  grain: 0.37,
  denoise: false,
  edgeTol: 340,
  renderScale: 85,
  // A unit quaternion, 30 degrees about Y, so the read-back is exact.
  camera: { position: [0.4, 0.9, 1.1], quaternion: [0, 0.25881904510252074, 0, 0.9659258262890683], fov: 42 },
};

// The closed list of parameters allowed to leave the image untouched when they are
// dropped from a restore, with the reason each one cannot reach the pixels here.
// Anything else landing in that bucket is a failure, which is what stops the sweep
// growing holes as later steps add parameters.
const NO_PIXEL_EFFECT = {
  spin: 'auto-orbit only advances when the animation loop calls controls.update, '
    + 'and a pinned run has replaced the loop',
  camera: 'the placeholder recomputes the program pose from t inside the render, '
    + 'so a pose written before it does not survive it - step 5 keyframes it',
};

// ---------------------------------------------------------------- page helpers

const PAGE_HELPERS = `
  const k = globalThis.__kinect;
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

const landingReader = `(() => {
  const k = globalThis.__kinect;
  return { ${Object.entries(LANDING).map(([n, e]) => `${n}: (${e})`).join(', ')} };
})()`;

const readLanding = (page) => page.evaluate(landingReader);

// Everything the two arms of the before/after comparison can both answer. No
// `k.params` here: the committed page has none, and a snapshot that only the new
// page could produce would compare nothing.
const snapshot = `(() => {
  const k = globalThis.__kinect;
  return {
    landing: ${landingReader},
    mode: k.uniforms.mode.value,
    fog: k.scene.fog.color.getHex(),
    dom: Object.fromEntries([...document.querySelectorAll('#panel input')]
      .map((el) => [el.id, el.type === 'checkbox' ? el.checked : el.value])),
    readouts: Object.fromEntries([...document.querySelectorAll('#panel .row')]
      .map((r) => [r.querySelector('input').id, r.querySelector('output').textContent])),
    pressed: [...document.querySelectorAll('#modes button')].map((b) => b.getAttribute('aria-pressed')),
  };
})()`;

// ------------------------------------------------------------------- the pages

const { chromium } = await loadPlaywright();
// The full chromium build rather than the headless shell: the shell can land on
// SwiftShader, and a run that quietly fell back to a software rasteriser would
// agree with itself for the wrong reason.
const browser = await chromium.launch({ channel: 'chromium', headless: !HEADED });
const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });

const fixture = buildFixture(CAPTURE);

async function openPage({ source = null, pin = false } = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`${msg.text()} @ ${JSON.stringify(msg.location())}`); });
  // A console error names no URL, so the response is recorded alongside it - a
  // 404 on the module and a 404 on the tab icon read identically otherwise, and
  // one of those is the check silently measuring a page that never loaded.
  page.on('response', (res) => { if (!res.ok()) errors.push(`${res.status()} ${res.url()}`); });

  // No frame may arrive. The look values under test do not depend on the stream,
  // and letting the server decide whether one lands would make a verdict that
  // flips between runs on an unchanged tree.
  await page.routeWebSocket(/.*/, () => { /* accepted, never connected */ });

  // The tab icon, answered rather than left to 404. The server has never served
  // one, and the console error it produces is indistinguishable from a real
  // failure to load - which would either be ignored by hand here, hiding the real
  // ones with it, or left to fail the run for a reason that is not about the page.
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));

  if (source) {
    // The panel and the module are served as one pair. The committed page reads
    // its ranges out of its own HTML, so pairing the old module with the new
    // markup would boot it on whatever a range input defaults to and the
    // comparison would be against a page that never existed.
    await page.route((url) => url.pathname === '/' || url.pathname === '/index.html',
      (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: source.html }));
    await page.route('**/main.js', (route) => route.fulfill({
      contentType: 'text/javascript; charset=utf-8', body: source.js,
    }));
  }
  if (pin) {
    await page.route('**/__pinned.bin', (route) => route.fulfill({
      status: 200, contentType: 'application/octet-stream', body: fixture,
    }));
  }

  await page.goto(URL_BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => !!globalThis.__kinect);

  // Proof the interception held, independent of the readings it protects. The
  // sensor's hello carries fx as 366.031494 and the uniform defaults to exactly
  // 366, so the default still standing means nothing came over the socket.
  const focal = await page.evaluate('globalThis.__kinect.uniforms.focal.value.x');
  if (focal !== 366) throw new Error(`websocket interception failed - intrinsics arrived (focal.x=${focal})`);

  return { page, errors };
}

// =============================================================== 1. before/after

console.log(`[registry] nothing moved: boot state and both mode presets against ${BEFORE_REV}`);

const beforeSource = {
  js: execFileSync('git', ['show', `${BEFORE_REV}:web/main.js`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }),
  html: execFileSync('git', ['show', `${BEFORE_REV}:web/index.html`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }),
};
// Once step 3 is committed, a bare --before HEAD would serve the registry into
// both arms and print two matching columns under a heading that says they came
// from different code. Refusing beats that.
if (beforeSource.js.includes('const PARAMS')) {
  throw new Error(`${BEFORE_REV}:web/main.js already contains the registry - pass an earlier rev with --before`);
}

// Each mode, then Blackwall and out of it twice, because the interesting case is
// the transition rather than the state: entering writes twelve values and leaving
// writes them back.
const MODE_WALK = [4, 0, 1, 2, 3, 4, 2];

// The program pose at a few positions, read in the same task as the render so the
// live loop cannot re-render at 0 underneath the reading. Nothing draws the
// program camera yet, which is exactly why this is worth comparing: the pose moved
// from a mutation to a value the registry applies, and three orients cameras down
// -Z where it orients everything else down +Z - so a slip here would be invisible
// until step 5 drew the frustum from the top-down view.
const readPoses = `(() => {
  const k = globalThis.__kinect;
  const out = {};
  for (const t of [0.7, 1.9]) {
    k.renderProgramFrame(t);
    out[t] = {
      position: k.programCamera.position.toArray(),
      quaternion: k.programCamera.quaternion.toArray(),
      fov: k.programCamera.fov,
    };
  }
  return out;
})()`;

async function walkModes(opts) {
  const { page, errors } = await openPage(opts);
  const out = { boot: await page.evaluate(snapshot) };
  for (const [i, mode] of MODE_WALK.entries()) {
    await page.click(`#modes button[data-mode="${mode}"]`);
    out[`${i}:mode${mode}`] = await page.evaluate(snapshot);
  }
  const poses = await page.evaluate(readPoses);
  return { out, poses, errors, page };
}

const beforeArm = await walkModes({ source: beforeSource });
await beforeArm.page.close();
const afterArm = await walkModes({});
await afterArm.page.close();

for (const stage of Object.keys(beforeArm.out)) {
  const a = beforeArm.out[stage];
  const b = afterArm.out[stage];
  const differing = Object.keys(a).filter((field) => !eq(a[field], b[field]));
  const detail = differing.map((field) => {
    const keys = typeof a[field] === 'object' && a[field]
      ? Object.keys(a[field]).filter((sub) => !eq(a[field][sub], b[field][sub]))
      : [];
    return keys.length
      ? `${field}{${keys.map((s) => `${s}: ${show(a[field][s])} -> ${show(b[field][s])}`).join(', ')}}`
      : `${field}: ${show(a[field])} -> ${show(b[field])}`;
  }).join('; ');
  check(differing.length === 0, `${stage.padEnd(10)} identical to ${BEFORE_REV}`, detail);
}

check(eq(beforeArm.poses, afterArm.poses),
  `the program pose at ${Object.keys(afterArm.poses).join('s and ')}s is identical to ${BEFORE_REV}`,
  eq(beforeArm.poses, afterArm.poses) ? '' : `${show(beforeArm.poses)} -> ${show(afterArm.poses)}`);
console.log(`  pose at 0.7s ${show(afterArm.poses['0.7'].position.map((x) => +x.toFixed(6)))} `
  + `q ${show(afterArm.poses['0.7'].quaternion.map((x) => +x.toFixed(6)))}`);

{
  const blackwall = afterArm.out['0:mode4'];
  const neutral = afterArm.out['1:mode0'];
  console.log('\n  Blackwall writes: '
    + Object.entries(blackwall.dom)
      .filter(([id, v]) => neutral.dom[id] !== v)
      .map(([id, v]) => `${id}=${v}`).join(' '));
  console.log('  neutral restores: '
    + Object.entries(neutral.dom)
      .filter(([id, v]) => blackwall.dom[id] !== v)
      .map(([id, v]) => `${id}=${v}`).join(' '));
}

if (beforeArm.errors.length || afterArm.errors.length) {
  console.log(`  page errors: ${[...beforeArm.errors, ...afterArm.errors].join(' | ')}`);
  failures++;
}

// ============================================================ the working page

const main = await openPage({ pin: true });
const { page } = main;

const declared = await page.evaluate(`(() => {
  const k = globalThis.__kinect;
  return Object.fromEntries(k.params.names().map((n) => [n, k.params.spec(n)]));
})()`);

// =========================================================== 2. the declaration

console.log('\n[registry] the declaration');
{
  const names = Object.keys(declared);
  check(eq(names.sort(), Object.keys(LANDING).sort()),
    `every declared parameter has a landing site here (${names.length})`,
    show(names.filter((n) => !(n in LANDING))));

  const kinds = { scalar: [], step: [], pose: [] };
  const tags = { look: [], composition: [], view: [] };
  let bad = [];
  for (const [name, spec] of Object.entries(declared)) {
    if (!kinds[spec.kind]) bad.push(`${name} kind=${spec.kind}`);
    else kinds[spec.kind].push(name);
    if (!tags[spec.tag]) bad.push(`${name} tag=${spec.tag}`);
    else tags[spec.tag].push(name);
    // Every checkbox holds until the next key, because lerping a boolean is
    // meaningless - so a boolean declared scalar is a keyframe bug waiting for
    // step 5 rather than a cosmetic slip.
    if (typeof spec.default === 'boolean' && spec.kind !== 'step') bad.push(`${name} is boolean but kind=${spec.kind}`);
    // Keyed off the type of the default rather than off the kind: `normalise`
    // sends every non-boolean, non-pose value down the scalar branch, so a
    // future numeric step-kind parameter declared without a range would clamp
    // against undefined and store NaN.
    if (typeof spec.default === 'number' && !(spec.min < spec.max && spec.step > 0)) {
      bad.push(`${name} is numeric but has no usable range`);
    }
  }
  check(bad.length === 0, 'every parameter carries a usable kind, tag and range', bad.join('; '));
  check(kinds.scalar.length > 0 && kinds.step.length > 0 && kinds.pose.length > 0,
    'all three interpolation kinds are in use',
    `scalar ${kinds.scalar.length}, step ${kinds.step.length} (${kinds.step.join(',')}), pose ${kinds.pose.join(',')}`);
  console.log(`        look ${tags.look.length}: ${tags.look.join(' ')}`);
  console.log(`        composition ${tags.composition.length}: ${tags.composition.join(' ')}`);
  console.log(`        view ${tags.view.length}: ${tags.view.join(' ')}`);

  // The mode is a property of the clip and must not be a parameter with an
  // interpolation kind: a mode key would rewrite twelve other tracks at the
  // instant it fired.
  check(!('mode' in declared), 'the mode is not a registry parameter');
  const modeIsClipState = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const before = k.mode();
    k.setMode(3);
    const after = [k.mode(), k.uniforms.mode.value];
    k.setMode(before);
    return after;
  })()`);
  check(eq(modeIsClipState, [3, 3]), 'the mode is clip state, written by a user action', show(modeIsClipState));
}

// ================================== 2b. the write path refuses what it cannot hold

// `params.apply(JSON.parse(projectFile))` is the path this registry advertises, so
// the values that arrive there are the ones worth being hostile about. A coercion
// that turns a truncated or hand-edited project into a plausible-looking look is
// worse than a throw, because nothing downstream can tell it happened.
console.log('\n[registry] bad values are refused rather than coerced');
{
  // Each case is JS source evaluated in the page rather than a value serialised
  // into it. That is not fussiness: JSON.stringify turns NaN and undefined into
  // null, so a table of literals would quietly test null three times over while its
  // labels claimed otherwise - an instrument lying about what it just proved.
  const REJECT = [
    ['camera', '{ position: [1, 2], quaternion: [0, 0, 0, 1], fov: 50 }', 'a short position'],
    ['camera', '{ position: [1, 2, 3], quaternion: [0, 0, 0], fov: 50 }', 'a short quaternion'],
    ['camera', '{ position: [1, 2, 3], quaternion: [0, 0, 0, 1] }', 'no fov at all'],
    ['camera', "{ position: ['1', '2', '3'], quaternion: [0, 0, 0, 1], fov: 50 }", 'strings for a position'],
    ['camera', '{ position: [1, 2, NaN], quaternion: [0, 0, 0, 1], fov: 50 }', 'a NaN component'],
    ['camera', '{ position: [1, 2, 3], quaternion: [0, 0, 0, 1], fov: NaN }', 'a NaN fov'],
    ['camera', 'null', 'null for a pose'],
    ['bloom', 'null', 'null for a scalar'],
    ['bloom', "''", 'an empty string for a scalar'],
    ['bloom', "'1.5'", 'a numeric string for a scalar'],
    ['bloom', 'NaN', 'NaN for a scalar'],
    ['bloom', 'undefined', 'a missing value for a scalar'],
    ['additive', 'null', 'null for a step'],
    ['additive', "'false'", 'the string "false" for a step'],
    ['additive', '1', 'a number for a step'],
    ['additive', 'undefined', 'a missing value for a step'],
  ];
  const ACCEPT = [
    ['camera', JSON.stringify(SCRAMBLE.camera)],
    ['bloom', '1.5'],
    ['additive', 'true'],
  ];
  const asCases = (rows) => rows
    .map(([name, expr]) => `{ name: ${JSON.stringify(name)}, value: ${expr} }`)
    .join(', ');

  const outcome = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    const out = { rejected: [], leaked: [], accepted: [], camera: null };
    for (const { name, value } of [${asCases(REJECT)}]) {
      const before = JSON.stringify(k.params.get(name));
      let threw = false;
      try { k.params.set(name, value); } catch { threw = true; }
      out.rejected.push(threw);
      // A refusal that had already written half of itself would be worse than the
      // coercion it replaced, so the stored value has to be untouched.
      if (JSON.stringify(k.params.get(name)) !== before) out.leaked.push(name);
    }
    for (const { name, value } of [${asCases(ACCEPT)}]) {
      let ok = false;
      try { k.params.set(name, value); ok = true; } catch (e) { ok = String(e); }
      out.accepted.push(ok);
    }
    out.camera = [...k.programCamera.position.toArray(), k.programCamera.fov, k.programCamera.projectionMatrix.elements[0]];
    k.params.reset();
    return out;
  })()`);

  const missed = REJECT.filter((_, i) => !outcome.rejected[i]).map(([n, , why]) => `${n}: ${why}`);
  check(missed.length === 0, `all ${REJECT.length} malformed values throw`, missed.join('; '));
  check(outcome.leaked.length === 0, 'and a refusal writes nothing at all', outcome.leaked.join(' '));
  check(outcome.accepted.every((x) => x === true), 'while well-formed values still go through',
    outcome.accepted.filter((x) => x !== true).join('; '));
  // NaN reaching the pose is the specific failure this guards: it never throws, it
  // just poisons the projection matrix, and live viewing hides it because the next
  // frame rewrites the pose from program time.
  check(outcome.camera.every(Number.isFinite), 'and nothing left NaN on the camera', show(outcome.camera));
}

console.log('\n[registry] a serialised project is document state, never view state');
{
  const sets = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    return {
      byDefault: Object.keys(k.params.values()),
      everything: Object.keys(k.params.values(k.params.names())),
      look: k.params.names('look'),
      view: k.params.names('view'),
      composition: k.params.names('composition'),
    };
  })()`);
  const leaked = sets.view.filter((n) => sets.byDefault.includes(n));
  check(leaked.length === 0,
    'values() leaves view state out, so an undo snapshot cannot swallow it', leaked.join(' '));
  check(sets.composition.every((n) => sets.byDefault.includes(n))
    && sets.look.every((n) => sets.byDefault.includes(n)),
    `and carries all ${sets.look.length} look and ${sets.composition.length} composition parameters`);
  check(sets.everything.length === sets.byDefault.length + sets.view.length,
    'while view state is still reachable by naming it', `${sets.everything.length} named explicitly`);
}

// ================================================== 3. the HTML holds no data

console.log('\n[registry] the panel carries no parameter data of its own');
{
  const html = readFileSync(join(REPO, 'web/index.html'), 'utf8');
  const owned = new Set(Object.keys(declared));
  const offenders = [];
  for (const tag of html.match(/<input[^>]*>/g) ?? []) {
    const id = tag.match(/id="([^"]+)"/)?.[1];
    if (!id || !owned.has(id)) continue;
    const carried = ['value', 'min', 'max', 'step'].filter((a) => tag.includes(`${a}="`));
    if (/\schecked[\s>]/.test(tag)) carried.push('checked');
    if (carried.length) offenders.push(`${id}[${carried.join(',')}]`);
  }
  check(offenders.length === 0, 'no registry-owned input declares a range or a default in the markup', offenders.join(' '));

  const stamped = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const out = {};
    for (const name of k.params.names()) {
      const el = document.getElementById(name);
      if (!el) { out[name] = null; continue; }
      out[name] = el.type === 'checkbox'
        ? { checked: el.checked }
        : { min: el.min, max: el.max, step: el.step, value: el.value,
            out: el.parentElement.querySelector('output')?.textContent };
    }
    return out;
  })()`);
  const wrong = [];
  for (const [name, spec] of Object.entries(declared)) {
    const el = stamped[name];
    if (spec.tag === 'composition') {
      if (el !== null) wrong.push(`${name} is composition but has a control`);
      continue;
    }
    if (el === null) { wrong.push(`${name} has no control`); continue; }
    if ('checked' in el) {
      if (el.checked !== spec.default) wrong.push(`${name} checked=${el.checked} want ${spec.default}`);
      continue;
    }
    if (el.min !== String(spec.min) || el.max !== String(spec.max) || el.step !== String(spec.step)) {
      wrong.push(`${name} range ${el.min}..${el.max}/${el.step} want ${spec.min}..${spec.max}/${spec.step}`);
    }
    if (el.value !== String(spec.default)) wrong.push(`${name} value=${el.value} want ${spec.default}`);
    if (el.out !== String(spec.default)) wrong.push(`${name} readout=${el.out} want ${spec.default}`);
  }
  check(wrong.length === 0, 'every control has its range, default and readout stamped from the registry', wrong.join('; '));
}

// ========================================================== 4. every value lands

console.log('\n[registry] every parameter round-trips to where the renderer reads it');
{
  const probe = async (values) => page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    k.params.apply(${JSON.stringify(values)});
    return { values: k.params.values(k.params.names()), landing: ${landingReader} };
  })()`);

  const wrong = [];
  for (const [name, value] of Object.entries(SCRAMBLE)) {
    const { values, landing } = await probe({ [name]: value });
    if (!eq(values[name], value)) {
      wrong.push(`${name} stored ${show(values[name])} not ${show(value)}`);
      continue;
    }
    const want = EXPECT[name](values[name], values);
    if (!eq(landing[name], want)) wrong.push(`${name} landed ${show(landing[name])} want ${show(want)}`);
  }
  check(wrong.length === 0, `all ${Object.keys(SCRAMBLE).length} parameters land one at a time`, wrong.join('; '));

  // The whole set at once, so a parameter that only lands when nothing else moved
  // does not slip through.
  const { values, landing } = await probe(SCRAMBLE);
  const together = Object.keys(SCRAMBLE)
    .filter((n) => !eq(landing[n], EXPECT[n](values[n], values)))
    .map((n) => `${n}=${show(landing[n])}`);
  check(together.length === 0, 'and all of them at once', together.join('; '));
}

console.log('\n[registry] the side effects that are not a uniform write');
{
  const setAndRead = async (values) => page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    k.params.apply(${JSON.stringify(values)});
    return {
      drawRange: k.geometry.drawRange.count,
      bloom: k.bloom.enabled, trails: k.afterimage.enabled, grade: k.grade.enabled,
      blending: k.material.blending, depthWrite: k.material.depthWrite, softEdge: k.uniforms.softEdge.value,
      buffer: [k.renderer.getContext().drawingBufferWidth, k.renderer.getContext().drawingBufferHeight],
    };
  })()`);

  // The ghost half of the geometry is drawn when either persistence term can shed
  // and left out of the draw range when neither can, so the matrix is the test.
  const range = [];
  for (const [fade, wake, want] of [[0, 0, POINTS], [10, 0, POINTS * 2], [0, 10, POINTS * 2], [120, 550, POINTS * 2]]) {
    const r = await setAndRead({ fade, wake });
    if (r.drawRange !== want) range.push(`fade=${fade} wake=${wake} -> ${r.drawRange} want ${want}`);
  }
  check(range.length === 0, 'fade and wake move the draw range together', range.join('; '));

  const gates = [];
  for (const [values, want] of [
    [{ bloom: 0, trails: 0, rgbSplit: 0, scanlines: 0, grain: 0 }, { bloom: false, trails: false, grade: false }],
    [{ bloom: 0.05 }, { bloom: true, trails: false, grade: false }],
    [{ trails: 0.01 }, { bloom: false, trails: true, grade: false }],
    [{ rgbSplit: 0.05 }, { bloom: false, trails: false, grade: true }],
    [{ scanlines: 0.01 }, { bloom: false, trails: false, grade: true }],
    [{ grain: 0.01 }, { bloom: false, trails: false, grade: true }],
  ]) {
    const r = await setAndRead(values);
    const got = { bloom: r.bloom, trails: r.trails, grade: r.grade };
    if (!eq(got, want)) gates.push(`${show(values)} -> ${show(got)} want ${show(want)}`);
  }
  check(gates.length === 0, 'a zero value switches its pass off rather than running it as a no-op', gates.join('; '));

  const blend = [];
  for (const on of [true, false]) {
    const r = await setAndRead({ additive: on });
    const want = { blending: on ? ADDITIVE_BLENDING : NORMAL_BLENDING, depthWrite: !on, softEdge: on ? 1 : 0 };
    const got = { blending: r.blending, depthWrite: r.depthWrite, softEdge: r.softEdge };
    if (!eq(got, want)) blend.push(`additive=${on} -> ${show(got)} want ${show(want)}`);
  }
  check(blend.length === 0, 'additive drives blending, depth write and the sprite falloff together', blend.join('; '));

  const scales = [];
  for (const v of [40, 100, 200]) {
    const r = await setAndRead({ renderScale: v });
    const want = [Math.floor(VIEW.width * v / 100), Math.floor(VIEW.height * v / 100)];
    if (!eq(r.buffer, want)) scales.push(`renderScale=${v} -> ${show(r.buffer)} want ${show(want)}`);
  }
  check(scales.length === 0, 'render scale resizes the drawing buffer', scales.join('; '));

  await page.evaluate('globalThis.__kinect.params.reset()');
}

// ============================================================ 5. the UI is a view

console.log('\n[registry] the panel is a view, in both directions');
{
  // Direction one: the control moves, the registry follows. The event is the one a
  // drag produces - `input` on a range, `change` on a checkbox - so this exercises
  // the listener the user reaches, not a function the check picked.
  const fromControl = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    const wrong = [];
    for (const name of k.params.names()) {
      const el = document.getElementById(name);
      if (!el) continue;
      const spec = k.params.spec(name);
      if (el.type === 'checkbox') {
        el.checked = !spec.default;
        el.dispatchEvent(new Event('change'));
        if (k.params.get(name) !== !spec.default) wrong.push(name + ' -> ' + k.params.get(name));
        continue;
      }
      const target = ${JSON.stringify(SCRAMBLE)}[name];
      el.value = String(target);
      el.dispatchEvent(new Event('input'));
      if (k.params.get(name) !== target) wrong.push(name + ' -> ' + k.params.get(name));
    }
    return wrong;
  })()`);
  check(fromControl.length === 0, 'moving a control writes the registry', fromControl.join('; '));

  // Direction two: the registry moves, the control and its readout follow. This is
  // the direction a keyframe, a preset and a restored project all arrive from, and
  // a panel that did not follow would show the previous look while rendering the
  // new one.
  const fromRegistry = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    const wrong = [];
    for (const name of k.params.names()) {
      const el = document.getElementById(name);
      if (!el) continue;
      const value = ${JSON.stringify(SCRAMBLE)}[name];
      k.params.set(name, value);
      if (el.type === 'checkbox') {
        if (el.checked !== value) wrong.push(name + ' checkbox=' + el.checked);
        continue;
      }
      if (el.value !== String(value)) wrong.push(name + ' slider=' + el.value + ' want ' + value);
      const out = el.parentElement.querySelector('output');
      if (out && out.textContent !== String(value)) wrong.push(name + ' readout=' + out.textContent);
    }
    return wrong;
  })()`);
  check(fromRegistry.length === 0, 'writing the registry moves the control and its readout', fromRegistry.join('; '));

  // Out of range and off the step grid, from both sides. The registry has to do the
  // clamping and snapping itself rather than lean on the DOM for it, or a value set
  // headlessly by step 6 lands on the uniform unsnapped while the same value set
  // through a slider lands snapped, and the panel and the image disagree.
  const clamped = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    const wrong = [];
    for (const name of k.params.names()) {
      const el = document.getElementById(name);
      if (!el || el.type === 'checkbox') continue;
      const spec = k.params.spec(name);
      // Below, above, a value that rounds down, and a tie that has to round up -
      // the tie is the one where the registry's arithmetic and the browser's
      // step alignment could part company without either looking wrong.
      for (const raw of [spec.min - 1000, spec.max + 1000, spec.min + spec.step * 0.4, spec.min + spec.step * 6.5]) {
        const stored = k.params.set(name, raw);
        if (stored < spec.min || stored > spec.max) wrong.push(name + ' ' + raw + ' -> ' + stored);
        else if (el.value !== String(stored)) wrong.push(name + ' ' + raw + ' -> registry ' + stored + ', slider ' + el.value);
      }
    }
    return wrong;
  })()`);
  check(clamped.length === 0, 'out-of-range and off-grid values clamp and snap the same way the slider does', clamped.join('; '));

  await page.evaluate('globalThis.__kinect.params.reset()');
}

// ================================================ 6. presets are user actions only

console.log('\n[registry] a preset can only be applied by a user action');
{
  const guard = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    k.setMode(0);

    // Outside evaluation it has to work, or the check below would pass on a
    // preset path that was simply broken.
    let outside = 'applied';
    try { k.applyPreset(k.presets.BLACKWALL); } catch (e) { outside = String(e); }
    const applied = k.params.get('bloom');
    k.params.reset();

    // Inside one, it has to refuse. The probe rides three's own pre-render hook,
    // which fires from inside renderProgramFrame, so this is the timeline calling
    // rather than the check pretending to be it.
    const seen = {};
    k.scene.onBeforeRender = () => {
      k.scene.onBeforeRender = () => {};
      try { k.applyPreset(k.presets.BLACKWALL); seen.preset = 'applied'; }
      catch (e) { seen.preset = 'refused'; }
      try { k.setMode(4); seen.mode = 'applied'; }
      catch (e) { seen.mode = 'refused'; }
      // An ordinary parameter write must stay legal: that is exactly what step 5's
      // tracks do every frame, and what the camera already does.
      try { k.params.set('bloom', 0.25); seen.param = 'written'; }
      catch (e) { seen.param = String(e); }
    };
    k.drive.stepTo(0);
    k.scene.onBeforeRender = () => {};

    return { outside, applied, seen, bloomAfter: k.params.get('bloom'), modeAfter: k.mode() };
  })()`);

  check(guard.outside === 'applied' && guard.applied === 0.5,
    'applying a preset outside evaluation writes it', `bloom=${guard.applied}`);
  check(guard.seen.preset === 'refused', 'applying a preset during evaluation is refused', show(guard.seen.preset));
  check(guard.seen.mode === 'refused', 'selecting a mode during evaluation is refused', show(guard.seen.mode));
  check(guard.seen.param === 'written' && guard.bloomAfter === 0.25,
    'an ordinary parameter write during evaluation still works', `bloom=${guard.bloomAfter}`);
  check(guard.modeAfter === 0, 'the refused mode change left the clip alone', `mode=${guard.modeAfter}`);

  // What a preset carries is the look tag and nothing else, so the tag has to be
  // the thing that selects it rather than a label beside a hand-written list.
  const selection = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    const chosen = k.params.names('look');
    k.params.set('camera', ${JSON.stringify(SCRAMBLE.camera)});
    k.params.set('renderScale', 60);
    const captured = k.params.values(chosen);

    // Move everything, then apply the captured look back. A preset that moved the
    // camera would not be a preset, it would be a saved project.
    k.params.apply(${JSON.stringify(SCRAMBLE)});
    k.applyPreset(captured);
    return {
      chosen,
      captured: Object.keys(captured),
      camera: k.params.get('camera'),
      renderScale: k.params.get('renderScale'),
      bloom: k.params.get('bloom'),
      near: k.params.get('near'),
    };
  })()`);

  check(!selection.captured.includes('camera') && !selection.captured.includes('spin')
    && !selection.captured.includes('renderScale'),
    'the default preset selection is the look tag, so composition and view stay out',
    `${selection.captured.length} parameters`);
  check(selection.captured.includes('near') && selection.captured.includes('far'),
    'and the depth clip is in it, as a look control whose default selection can be unpicked');
  check(eq(selection.camera, SCRAMBLE.camera),
    'applying a look leaves the camera exactly where it was', show(selection.camera.position));
  check(selection.renderScale === 85, 'and leaves view state to the viewer', `renderScale=${selection.renderScale}`);
  check(selection.bloom === 0 && selection.near === 0.05,
    'while the look values it does carry are written', `bloom=${selection.bloom} near=${selection.near}`);

  await page.evaluate('globalThis.__kinect.params.reset()');
}

// ============================================ 7. the render path writes the camera

console.log('\n[registry] the camera pose goes in through the registry, not around it');
{
  const camera = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const wild = ${JSON.stringify(SCRAMBLE.camera)};
    k.params.set('camera', wild);
    const written = [k.params.get('camera'), k.programCamera.position.toArray()];

    k.drive.reset();
    k.drive.stepTo(0.4);
    const stored = k.params.get('camera');
    const onCamera = {
      position: k.programCamera.position.toArray(),
      quaternion: k.programCamera.quaternion.toArray(),
      fov: k.programCamera.fov,
    };
    k.drive.stepTo(0.9);
    const later = k.params.get('camera');
    return { written, stored, onCamera, later };
  })()`);

  check(eq(camera.written[0], SCRAMBLE.camera) && eq(camera.written[1], SCRAMBLE.camera.position),
    'a pose written through the registry reaches the camera object');
  // The load-bearing one. If the render path posed the camera directly, the
  // registry would still be holding the wild pose while the camera had moved -
  // so agreement here is what says the write goes through the registry.
  check(eq(camera.stored, camera.onCamera),
    'after a render the registry holds the pose the camera is actually at',
    `${show(camera.stored.position)} vs ${show(camera.onCamera.position)}`);
  check(!eq(camera.stored.position, SCRAMBLE.camera.position),
    'and it is the pose program time asked for, not the one the check wrote');
  check(!eq(camera.stored.position, camera.later.position),
    'and it moves with program time', `${show(camera.stored.position)} -> ${show(camera.later.position)}`);
}

// ============================== 8. serialise, restore, and the same pixels back

console.log('\n[registry] serialise, restore, and the image comes back byte for byte');

// Blackwall, selected the way a user selects it, because scan and rim only reach
// the shader in that branch and a sweep run in RGB would find them inert. The
// parameter values on top of it are the scrambled set, so nothing here depends on
// the preset's own numbers.
await page.click('#modes button[data-mode="4"]');
await page.evaluate(async () => {
  const buffer = await (await fetch('/__pinned.bin')).arrayBuffer();
  globalThis.__kinect.drive.pin(buffer);
});

const positions = await page.evaluate(`(() => {
  const times = globalThis.__kinect.drive.times();
  const out = [];
  for (let i = 0; i < times.length - 1; i++) {
    for (let r = 0; r < ${SUBSTEPS}; r++) out.push(times[i] + (times[i + 1] - times[i]) * (r / ${SUBSTEPS}));
  }
  return out;
})()`);

const runWith = `async ({ values, positions }) => {
  ${PAGE_HELPERS}
  k.params.reset();
  k.params.apply(values);
  k.drive.reset();
  pinCamera(k.freeCamera);
  const out = [];
  for (const t of positions) {
    k.drive.stepTo(t);
    out.push(await sha256(k.drive.readPixels()));
  }
  return out;
}`;
const run = (values) => page.evaluate(`(${runWith})(${JSON.stringify({ values, positions })})`);

const serialised = await page.evaluate(`(() => {
  const k = globalThis.__kinect;
  k.params.reset();
  k.params.apply(${JSON.stringify(SCRAMBLE)});
  return JSON.parse(JSON.stringify(k.params.values(k.params.names())));
})()`);

const defaults = await page.evaluate(
  "(() => { const k = globalThis.__kinect; k.params.reset(); return JSON.parse(JSON.stringify(k.params.values(k.params.names()))); })()");

const scrambledRun = await run(SCRAMBLE);
const defaultRun = await run(defaults);
const restoredRun = await run(serialised);

console.log(`  ${positions.length} images per run over `
  + `${positions[0].toFixed(3)}s to ${positions[positions.length - 1].toFixed(3)}s, `
  + `${new Set(scrambledRun).size} of them distinct`);

check(eq(scrambledRun, restoredRun),
  'the restored set reproduces the run exactly',
  eq(scrambledRun, restoredRun) ? '' : `first divergence at image ${scrambledRun.findIndex((h, i) => h !== restoredRun[i])}`);
// Strictly equal, not merely the same size: every value here is already on its
// own step grid, so anything the registry did to one of them on the way in and
// back out is a normalisation bug rather than a rounding it was asked for.
check(eq(serialised, JSON.parse(JSON.stringify(SCRAMBLE))),
  `the serialised set is the scrambled set, value for value (${Object.keys(serialised).length} parameters)`,
  Object.keys(SCRAMBLE).filter((n) => !eq(serialised[n], SCRAMBLE[n]))
    .map((n) => `${n}: ${show(serialised[n])} not ${show(SCRAMBLE[n])}`).join('; '));
// The blunt control: if the registry were not driving the renderer at all, the
// defaults would render the same images as the scrambled set and the equality
// above would be arithmetic rather than evidence.
check(!eq(scrambledRun, defaultRun), 'and the defaults do not - the registry is what the image depends on');
check(new Set(scrambledRun).size > positions.length / 2, 'the input moves across the run');

console.log('\n[registry] the falsification control: each parameter left out of the restore in turn');
{
  const noEffect = [];
  const changed = [];
  for (const name of Object.keys(serialised)) {
    const partial = { ...serialised };
    delete partial[name];
    const hashes = await run(partial);
    if (eq(hashes, scrambledRun)) noEffect.push(name);
    else changed.push(name);
  }
  console.log(`  omitting any of these changed the image: ${changed.join(' ')}`);
  const unexplained = noEffect.filter((n) => !(n in NO_PIXEL_EFFECT));
  for (const name of noEffect.filter((n) => n in NO_PIXEL_EFFECT)) {
    console.log(`  ${name} left the image unchanged, as declared: ${NO_PIXEL_EFFECT[name]}`);
  }
  check(unexplained.length === 0,
    `every parameter outside the declared exceptions changes the image when it is dropped`,
    unexplained.length ? `unexplained: ${unexplained.join(' ')}` : '');
  check(changed.length > 0 && noEffect.length === Object.keys(NO_PIXEL_EFFECT).length,
    `${changed.length} of ${Object.keys(serialised).length} parameters are proven to reach the pixels`);
}

// ------------------------------------------------------------------- verdict

if (main.errors.length) {
  console.log(`\n[registry] page errors:\n  ${main.errors.join('\n  ')}`);
  failures++;
}

await browser.close();
console.log(`\n[registry] ${failures ? `FAIL (${failures})` : 'PASS'}`);
process.exit(failures ? 1 : 0);
