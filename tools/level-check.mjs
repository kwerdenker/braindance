#!/usr/bin/env node
// Levelling: the room is rotated into its own frame, and everything downstream of the
// rotation comes level with it.
//
// A sensor is a thing somebody bolted to something and nothing measures the angle it
// ended up at - libfreenect2's device API offers two sets of camera intrinsics and no
// accelerometer - so a cloud from a dashboard mount arrives canted with no gravity
// vector anywhere to straighten it by. `tilt` and `roll` are a human saying which way
// is up, and they turn the cloud rather than the camera. That choice is what this tool
// is mostly about, because it is the choice with consequences: rotating the world
// levels the turntable, the top-down, auto-orbit's axis and the exported frame at
// once, and every one of those is a separate way for the feature to be half-built.
//
// **Five claims, and two of them are invariants rather than behaviours.**
//
//  1. The world actually turns. A picture at a non-zero cant differs from the picture
//     at none. Dull, and it is here because every other section is a comparison that
//     a build ignoring the parameters entirely would satisfy by drawing the same
//     thing twice. `tilt-ignored` is its control and it exists to catch this file
//     passing itself.
//  2. **The crop and the region stay in sensor metres.** They are tested on the
//     undisplaced position in the vertex shader, before the model matrix, so a box
//     shrunk onto a subject stays on that subject when the room is levelled under it.
//     Asserted as an identity rather than by reading the shader: rotating the world
//     and the camera by the same quaternion is a no-op, so the two pictures have to
//     be **bit-identical**. Move the crop test to the far side of the rotation and
//     the surviving set changes, which no camera move can undo - `crop-follows-tilt`.
//  3. The top-down is a top-down of the room and not a slanted section of it. This
//     was the second visible symptom of the same bug and it had no check at all: the
//     inset drew the sensor's own axes, so the box in the corner of a canted take was
//     labelled TOP-DOWN and was not one. Measured two-sided - a plane levelled flat
//     has a fat plan and the same plane stood on its edge has a thin one - because a
//     one-sided "it changed" row passes on any change at all.
//  4. **The sensor view stays literal.** It means exactly what the sensor shot, so it
//     has to be posed in the sensor's frame rather than the levelled one: its picture
//     at any cant is the same picture it gives at none. That is what forces the free
//     camera's up onto the sensor's, which is why navigation's controls are rebuilt
//     rather than written to - see `setNavigationUp` in `web/main.js`.
//  5. **Floor selection reads the chosen geometry.** Three planted surfaces with three
//     different normals must produce three different and individually correct
//     answers. One arm would not do: a button that wrote zeros is right about a
//     level room, and a button that read the pair in the wrong order is right about
//     every surface that leans only one way. `level-writes-zero` and
//     `level-order-swapped` are the two controls, and the third arm leans both ways
//     precisely so the order has a consequence. A split frame then makes the selected
//     point consequential, and the reset control proves the neutral way back.
//
// **The frames are planted, so this needs no sensor and no capture.** The depth
// texture is written directly with an analytic plane - `z = c / (u . n)` along each
// pixel's own ray - which is what lets section 5 know the answer it is grading. A
// fixture take would have given a surface nobody knows the normal of, and the fit
// would then only ever have been asserted against itself.
//
//   node tools/level-check.mjs
//   node tools/level-check.mjs --mutate tilt-ignored             # must FAIL
//   node tools/level-check.mjs --mutate crop-follows-tilt        # must FAIL
//   node tools/level-check.mjs --mutate plan-ignores-tilt        # must FAIL
//   node tools/level-check.mjs --mutate plan-skips-vertical-crop # must FAIL
//   node tools/level-check.mjs --mutate region-follows-tilt      # must FAIL
//   node tools/level-check.mjs --mutate sensor-view-ignores-tilt # must FAIL
//   node tools/level-check.mjs --mutate level-writes-zero        # must FAIL
//   node tools/level-check.mjs --mutate level-order-swapped      # must FAIL
//   node tools/level-check.mjs --mutate level-selection-ignores-point # must FAIL
//   node tools/level-check.mjs --mutate reset-keeps-roll          # must FAIL
//
// It spawns its own server and needs none running. `--port` takes one nothing else
// holds; the default is not in any other tool's range, but two worktrees running this
// at once still collide and get each other's server, which is `library-check`'s
// lesson written down again. A GPU browser is required outright rather than optional:
// every claim here is about a picture, so there is no useful subset to run without
// one, and a missing playwright exits **2** - untested is not passed.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const PORT = Number(flag('--port', '8377'));
const MUTATE = flag('--mutate');
const WORK = join(REPO, '.level-check');
const RECORDER_URL = `http://127.0.0.1:${PORT}/record`;

// --- mutations -------------------------------------------------------------
// Each names source text and must match exactly once. A replacement matching nothing
// would run an unmutated build and be recorded as this check having missed a bug it
// was never shown.
const MUTATIONS = {
  // The parameters are accepted, stored, drawn on their sliders - and never reach the
  // cloud. This is the whole feature absent behind a working panel, and it is the
  // control for section 1 rather than for any of the comparisons, because every
  // comparison below is satisfied by a build that draws the same picture twice.
  'tilt-ignored': { file: 'web/main.js', edits: [[
    '  cloud.quaternion.copy(worldTilt);',
    '  cloud.quaternion.identity();',
  ]] },
  // The crop moves to the far side of the levelling: the six faces stop being a place
  // in the room and become a place relative to however the room is currently turned.
  // Section 2's identity is what sees it - the surviving set changes, and no camera
  // move can put a discarded point back.
  'crop-follows-tilt': { file: 'web/main.js', edits: [[
    '  if (pos.x < cropL || pos.x > cropR || pos.y < cropB || pos.y > cropT) {',
    '  vec3 cropAt = (modelMatrix * vec4(pos, 1.0)).xyz;\n'
    + '  if (cropAt.x < cropL || cropAt.x > cropR || cropAt.y < cropB || cropAt.y > cropT) {',
  ]] },
  // The picture levels and the box in the corner does not, which is exactly the state
  // this feature was built to end. Nothing outside section 3 can see it.
  'plan-ignores-tilt': { file: 'web/main.js', edits: [[
    '      planVec.set(wx, wy, -z).applyQuaternion(worldTilt);',
    '      planVec.set(wx, wy, -z);',
  ]] },
  // The plan culls on x alone, which is what it did while a top-down had no y to
  // care about. Levelling turns sensor y into the plan's own x and z, so points the
  // renderer discarded reappear inside the footprint - and only section 3's extent,
  // measured with a crop that bites vertically, can see it.
  'plan-skips-vertical-crop': { file: 'web/main.js', edits: [[
    '      if (wy < uniforms.cropB.value || wy > uniforms.cropT.value) continue;\n',
    '',
  ]] },
  // The sensor view keeps navigation's own pole and its own axis, so on a levelled
  // take the one button that means "exactly what the sensor shot" shows a rolled
  // picture through a frustum fitted to an unrolled one. The fov rows in
  // `sensor-view-check` cannot see this: the angles it reports are unchanged.
  'sensor-view-ignores-tilt': { file: 'web/main.js', edits: [[
    '  setNavigationUp(new THREE.Vector3(0, 1, 0).applyQuaternion(worldTilt));\n'
    + '  controls.target.set(0, 0, -SENSOR_VIEW_DISTANCE).applyQuaternion(worldTilt);',
    '  controls.target.set(0, 0, -SENSOR_VIEW_DISTANCE);',
  ]] },
  // The button reports success and writes a level room. Plausible on any take that
  // was nearly level to start with, which is why section 5 plants surfaces that are
  // not.
  'level-writes-zero': { file: 'web/main.js', edits: [[
    '  writeFromControl(\'roll\', roll);\n  writeFromControl(\'tilt\', tilt);',
    '  writeFromControl(\'roll\', 0);\n  writeFromControl(\'tilt\', 0);',
  ]] },
  // The mode and cursor work, but the click coordinate is discarded and both sides
  // of a frame containing different planes level on the same centre patch. The split
  // plant in section 5 is what gives this a visible consequence.
  'level-selection-ignores-point': { file: 'web/main.js', edits: [[
    '      const d = Math.hypot(\n'
    + '        (levelVec.x * 0.5 + 0.5) * size.w - stageX,\n'
    + '        (0.5 - levelVec.y * 0.5) * size.h - stageY,\n'
    + '      );',
    '      const d = Math.hypot(levelVec.x * 0.5 * size.w, levelVec.y * 0.5 * size.h);',
  ]] },
  // The same discarded coordinate one link earlier, in the handler rather than in the
  // function behind it. `levelAtStagePoint` still reads the point it is handed and
  // still fits the plane under it correctly; what is lost is the press's own position
  // on the way in. That distinction is the whole reason this mutation exists beside the
  // one above: every arm that calls the hook directly passes its own coordinate and so
  // cannot see the handler at all, and a single-plane frame answers the same whatever
  // point reaches it. Only an off-centre press on the split plant, driven through
  // `#camLevel` and `#stage`, has an answer that differs here.
  'pointer-levels-the-centre': { file: 'web/main.js', edits: [[
    '  const result = levelAtStagePoint(view.x, view.y);',
    '  const result = levelAtStagePoint(stageSize().w / 2, stageSize().h / 2);',
  ]] },
  // The button takes tilt back to neutral and leaves roll behind. Reading both
  // parameters and both sliders through the real control catches the half-reset.
  'reset-keeps-roll': { file: 'web/main.js', edits: [[
    '  return writeWorldRotation(0, 0);',
    '  return writeWorldRotation(0, params.get(\'roll\'));',
  ]] },
  // The region is read after the model rotation instead of on the undisplaced
  // sensor-space position, so a region placed on a subject slides off it the moment
  // the room is levelled underneath. Section 2 is the only thing that can see it, and
  // only because that section now switches a region effect on: with `regionPush`,
  // `regionNoise` and `regionMask` all at zero the shader never evaluates the region
  // coordinate at all, and this mutation and the fix draw the same picture.
  'region-follows-tilt': { file: 'web/main.js', edits: [[
    '  vec3 p0 = pos;',
    '  vec3 p0 = (modelMatrix * vec4(pos, 1.0)).xyz;',
  ]] },
  // The pair is composed the other way round, `Rz(roll) * Rx(tilt)`. Every surface
  // that leans along one axis alone is levelled correctly by both orders, so this is
  // invisible to two of section 5's three arms by construction - and the third leans
  // both ways for exactly that reason.
  'level-order-swapped': { file: 'web/main.js', edits: [[
    "const tiltEuler = new THREE.Euler(0, 0, 0, 'XYZ');",
    "const tiltEuler = new THREE.Euler(0, 0, 0, 'ZYX');",
  ]] },
};
if (MUTATE && !MUTATIONS[MUTATE]) {
  console.error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

// --- the staged tree -------------------------------------------------------
// A mutation applied in place and restored afterwards leaves a mutated working tree
// behind any crash, which is the one state a proof tool must never produce. `web/` is
// copied rather than linked for the same reason: through a symlink every mutation
// here would rewrite the repo's own source.
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
for (const dir of ['server', 'tools', 'web']) cpSync(join(REPO, dir), join(WORK, dir), { recursive: true });
// **`native/` is deliberately not among these, and that is load-bearing rather than an
// omission.** Every frame this tool grades is one it planted, and a live socket wipes a
// plant in well under a second - measured on a page with the sensor attached, a sentinel
// written into all 217k samples was gone within 500ms, because an arriving frame swaps
// the two depth textures and the plant is left in the one nothing reads. The staged tree
// having no grabber binary is what makes the server it spawns quiet, so the plane the
// fit is graded against is still the plane on screen.
//
// It held by accident until a Kinect was first attached to this machine, and nothing in
// this file would have noticed the difference. So the assertion in section 1 checks the
// plant is still there rather than trusting this list, and adding `native` to the line
// below fails that row instead of quietly changing what this tool proves.
//
// Verified rather than reasoned about, by doing exactly that. With `native` staged the
// checksum row fires - 1726596637 against an expected 95354338 - and nine rows fail
// behind it, the fits reading tilt -3.5 roll -32 off surface A where the planted answer
// is 73.5 and 0. Which is the point of the row rather than a bonus: without it those
// nine are a check that has gone mysteriously wrong, and on a stiller scene some of them
// would have passed.
for (const name of ['node_modules', 'vendor', 'captures']) {
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
      console.error(`mutation ${MUTATE} matched ${hits} times in ${spec.file}, expected exactly 1 - refusing to run an unmutated build`);
      process.exit(2);
    }
    source = source.replace(from, to);
  }
  writeFileSync(path, source);
}

// --- harness ---------------------------------------------------------------
let checked = 0;
let failed = 0;
// A claim that could not be tested here at all, which is a third answer and not a
// quiet pass.
let untested = null;
// A run that threw rather than a claim that failed. Kept apart from `failed` so the
// verdict cannot count its own timeout as a mutation being caught.
let crashed = null;
const ok = (label, pass, detail = '') => {
  checked++;
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const servers = [];
const start = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(WORK, 'server/index.js'), '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(child);
  const log = [];
  const onData = (c) => {
    log.push(c.toString());
    if (log.join('').includes('viewer on')) setTimeout(resolve, 200);
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

// The three surfaces every section plants. Each is a unit normal in sensor metres and
// the depth at which its centre ray crosses. **A is deliberately blind to the order
// the pair composes in**: it leans along one axis only, so its roll comes out at zero
// and `Rx * Rz` and `Rz * Rx` are the same rotation. B and C lean both ways and are
// the two that can see `level-order-swapped`. The blind arm is kept rather than
// replaced, because a set of arms that all see a mutation says nothing about which
// property is load-bearing - and the file says which is which here rather than
// leaving it to be rediscovered from a confusing sweep.
const SURFACES = [
  { name: 'A, tipped away from the sensor and not rolled', n: [0, 0.3, -1], z: 2.0 },
  { name: 'B, rolled in its bracket as well', n: [0.45, 0.89, -0.35], z: 2.2 },
  { name: 'C, leaning hard along both axes at once', n: [0.6, 0.6, -0.53], z: 2.0 },
];

// How far off the vertical a levelled normal is allowed to land, as the length of its
// horizontal component. Snapping two angles to the sliders' half-degree step can leave
// about 0.0062 radians behind in the worst case, so this is a shade over twice the
// quantisation and is a bound rather than a number chosen to fit: the clean run's worst
// arm sits at 0.0035 and the mutation it has to catch misses by 0.19. An earlier
// version at 0.02 let surface C through `level-order-swapped` by 0.0005, which is a row
// that would have gone green or red depending on the machine.
const LEVEL_TOLERANCE = 0.012;

const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

console.log(`[level] ${MUTATE ? `MUTATED: ${MUTATE} (${MUTATIONS[MUTATE].file})` : 'unmutated tree'}\n`);

try {
  let chromium;
  try {
    ({ chromium } = await import(join(REPO, 'node_modules/playwright/index.mjs')));
  } catch {
    untested = 'playwright is not installed, and every claim here is about a picture';
    throw new Error(untested);
  }

  await start();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(RECORDER_URL, { waitUntil: 'networkidle' });
  await page.waitForFunction('Boolean(globalThis.__kinect)', null, { timeout: 20000 });

  // The panel overlaps the picture's left edge and its own hover state is a change in
  // the region a comparison would read - `sensor-view-check` records a run that passed
  // a repaint row on a button highlight. Taken out of the document rather than
  // hit-tested around, because nothing here needs to press anything on it.
  await page.evaluate(() => { document.getElementById('panel').style.display = 'none'; });

  /**
   * Plants one analytic plane over the depth image, or a different one on each half.
   *
   * The look is flattened first and that is not tidiness. Fade, wake and noise are
   * temporal, so a picture compared against another picture would be comparing two
   * moments of an accumulator rather than two geometries, and the identity in section
   * 2 would be false for a reason that has nothing to do with levelling.
   */
  const plant = (surface, rightSurface = null) => page.evaluate((surfaceSpecs) => {
    const k = globalThis.__kinect;
    for (const [name, value] of Object.entries({
      fade: 0, wake: 0, noise: 0, additive: false, spin: false, denoise: false,
    })) k.params.set(name, value);
    const DW = 512;
    const DH = 424;
    const fx = k.uniforms.focal.value.x;
    const fy = k.uniforms.focal.value.y;
    const cx = k.uniforms.center.value.x;
    const cy = k.uniforms.center.value.y;
    const planes = surfaceSpecs.filter(Boolean).map(({ n: n0, z: zc }) => {
      const len = Math.hypot(n0[0], n0[1], n0[2]);
      const n = n0.map((v) => v / len);
      // `c` is fixed by where the centre ray is wanted, so every surface lands at a
      // sane depth whatever way it leans.
      return { n, c: zc * -n[2] };
    });
    const data = k.uniforms.depthCurr.value.image.data;
    data.fill(0);
    for (let row = 0; row < DH; row++) {
      for (let col = 0; col < DW; col++) {
        const { n, c } = planes.length > 1 && col >= DW / 2 ? planes[1] : planes[0];
        const ux = (col + 0.5 - cx) / fx;
        const uy = -(row + 0.5 - cy) / fy;
        const den = ux * n[0] + uy * n[1] - n[2];
        if (Math.abs(den) < 1e-6) continue;
        const z = c / den;
        // The renderer's own depth gate, so a planted sample that would be discarded
        // is never written in the first place.
        if (!(z >= k.uniforms.nearClip.value && z <= k.uniforms.farClip.value)) continue;
        data[row * DW + col] = Math.round(z * 1000);
      }
    }
    k.uniforms.depthCurr.value.needsUpdate = true;
    k.resetAccumulators();
    return planes.map(({ n }) => n);
  }, [surface, rightSurface]).then((normals) => (rightSurface ? normals : normals[0]));

  /**
   * Whether the planted frame is still the one the page is drawing.
   *
   * A sparse fingerprint taken at plant time and compared later, rather than the whole
   * grid shipped in and out of the page twice. The texture identity goes with it and is
   * the cheaper half of the answer: an arriving frame *swaps* the two depth textures, so
   * `depthCurr` stops being the object the plant was written into. Both are asserted,
   * because a build that wrote arrivals in place rather than swapping would keep the
   * identity and lose the samples.
   */
  const plantFingerprint = () => page.evaluate(() => {
    const k = globalThis.__kinect;
    const texture = k.uniforms.depthCurr.value;
    const data = texture.image.data;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 97) { sum = (sum + data[i] * (i + 1)) % 2147483647; n++; }
    globalThis.__levelPlant = { sum, n, texture };
    return { sum, n };
  });

  const plantHeld = () => page.evaluate(() => {
    const k = globalThis.__kinect;
    const texture = k.uniforms.depthCurr.value;
    const data = texture.image.data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 97) sum = (sum + data[i] * (i + 1)) % 2147483647;
    const was = globalThis.__levelPlant;
    return { sameTexture: texture === was.texture, sum, expected: was.sum };
  });

  const setTilt = (tilt, roll) => page.evaluate(([t, r]) => {
    const k = globalThis.__kinect;
    k.params.set('tilt', t);
    k.params.set('roll', r);
    return { tilt: k.params.get('tilt'), roll: k.params.get('roll'), q: k.worldTilt() };
  }, [tilt, roll]);

  const levelAt = (x, y = 0.5) => page.evaluate(([xFraction, yFraction]) => {
    const k = globalThis.__kinect;
    const stage = k.renderer.domElement.getBoundingClientRect();
    return k.levelAtStagePoint(stage.width * xFraction, stage.height * yFraction);
  }, [x, y]);

  const landNormal = (normal) => page.evaluate((n) => {
    const k = globalThis.__kinect;
    const v = k.freeCamera.position.clone().fromArray(n);
    const q = k.freeCamera.quaternion.clone().fromArray(k.worldTilt());
    return v.applyQuaternion(q).toArray();
  }, normal);

  /**
   * The rendered frame, and only the rendered frame.
   *
   * Two shots with a gap, and they have to agree before either is used. A picture that
   * is still moving makes every comparison below meaningless in the direction that
   * reads as a pass - two arms that differ get called a difference, when what happened
   * is that the accumulators had not settled.
   */
  const picture = async () => {
    await page.evaluate(() => globalThis.__kinect.keyframes.chrome.set(false));
    await wait(260);
    const first = await page.locator('#stage').screenshot();
    await wait(160);
    const second = await page.locator('#stage').screenshot();
    return { hash: hash(second), stable: Buffer.compare(first, second) === 0 };
  };

  // --- 1. the world turns ---------------------------------------------------
  console.log('1. the parameters reach the cloud');
  await plant(SURFACES[2]);
  await plantFingerprint();
  await setTilt(0, 0);
  const flat = await picture();
  ok('a picture of a planted surface is stable enough to compare', flat.stable);
  // **Everything below this row is graded against a surface this tool chose, so this
  // row is what says the surface on screen is still that one.** With a sensor attached
  // and a grabber in the staged tree, a live socket wipes a plant in under half a second
  // and every later section would go on passing while measuring the room. Taken after a
  // full `picture()` rather than immediately, because the window that matters is the one
  // a comparison spans.
  const held = await plantHeld();
  ok('and it is still the planted surface after a settle, not a frame off the wire',
    held.sameTexture && held.sum === held.expected,
    held.sameTexture ? `checksum ${held.sum} vs ${held.expected}` : 'the depth texture was swapped under it');
  await setTilt(18, -24);
  const canted = await picture();
  ok('and cants when the two parameters move', flat.hash !== canted.hash,
    `${flat.hash} then ${canted.hash}`);

  // --- 2. the crop is a place in the room -----------------------------------
  console.log('\n2. the crop and the region stay in sensor metres');
  // A box that actually bites. Left open, every point survives either way round and
  // the identity below is true for a build with no crop at all.
  await page.evaluate(() => {
    const k = globalThis.__kinect;
    k.params.set('left', -0.4);
    k.params.set('right', 0.5);
    k.params.set('bottom', -0.35);
    k.params.set('top', 0.45);
  });
  /**
   * A region that actually bites, which this section claimed in its heading and did
   * not do.
   *
   * The crop faces alone cannot prove the region is in sensor space: the shader gates
   * the whole region evaluation behind `regionPush`, `regionNoise` and `regionMask`
   * being non-zero, so with all three at their defaults the region coordinate is never
   * read, and a build that evaluated it after the model rotation drew a pixel-identical
   * picture and passed this section. `region-follows-tilt` is the control for that, and
   * it fails only because this is here.
   *
   * A mask rather than a push, because a push moves points and a mask removes them: the
   * surviving set is what the identity below compares, and a point shoved a little way
   * along its own radius can still land on the pixel it left. The box is centred on the
   * planted surface's own centre ray at two metres, so it takes a bite out of the
   * middle of the plane rather than clipping a corner nothing would miss.
   */
  const armRegion = () => page.evaluate(() => {
    const k = globalThis.__kinect;
    k.params.set('regionZ', -2);
    k.params.set('regionW', 0.25);
    k.params.set('regionH', 0.25);
    k.params.set('regionD', 0.25);
    k.params.set('regionRound', 0.05);
    k.params.set('regionSoft', 0.05);
    k.params.set('regionMask', 1);
  });
  /** Poses the program camera, optionally carried by the world's own rotation. */
  const poseProgram = (carry) => page.evaluate((withTilt) => {
    const k = globalThis.__kinect;
    const cam = k.programCamera;
    cam.up.set(0, 1, 0);
    cam.position.set(0.35, 0.45, 1.5);
    cam.lookAt(0, 0, -2);
    const position = cam.position.clone();
    const quaternion = cam.quaternion.clone();
    if (withTilt) {
      const q = cam.quaternion.clone().fromArray(k.worldTilt());
      position.applyQuaternion(q);
      quaternion.premultiply(q);
    }
    k.params.set('camera', { position: position.toArray(), quaternion: quaternion.toArray(), fov: 50 });
    k.setViewCamera(k.programCamera);
  }, carry);

  await setTilt(0, 0);
  await poseProgram(false);
  const bare = await picture();
  ok('the same surface through a fixed pose is stable', bare.stable);
  await armRegion();
  const still = await picture();
  // The row that stops the region rows below being vacuous. A region whose box missed
  // the planted plane, or whose mask was left at zero, would satisfy every identity in
  // this section by changing nothing - which is exactly the state this section was in.
  ok('switching the region on takes points out of the picture, so it is in the proof at all',
    bare.hash !== still.hash, `${bare.hash} then ${still.hash}`);
  ok('and the picture with the region on is stable enough to compare', still.stable);
  await setTilt(22, 31);
  await poseProgram(true);
  const carried = await picture();
  ok('turning the world and the camera by the same rotation changes nothing at all',
    still.hash === carried.hash, `${still.hash} then ${carried.hash}`);
  // Without this row the identity above is satisfied by a build where the camera is
  // not carried either - two pictures that are the same because nothing moved.
  await poseProgram(false);
  const notCarried = await picture();
  ok('and leaving the camera behind does change it, so the identity is not vacuous',
    still.hash !== notCarried.hash, `${still.hash} then ${notCarried.hash}`);
  await page.evaluate(() => {
    const k = globalThis.__kinect;
    k.setViewCamera(k.freeCamera);
    // The region goes back with the crop. Section 3 measures the plan cloud's extent
    // and section 5 fits a plane through the planted samples, and a mask still eating
    // the middle of that surface would be measuring a hole in both.
    k.params.reset([
      'left', 'right', 'bottom', 'top',
      'regionZ', 'regionW', 'regionH', 'regionD', 'regionRound', 'regionSoft', 'regionMask',
    ]);
  });

  // --- 3. the top-down is a top-down of the room ----------------------------
  console.log('\n3. the top-down draws the levelled frame');
  /**
   * The plan cloud's own bounding box in the inset, in pixels.
   *
   * Filtered by colour rather than by area: the path and the frustum are drawn in the
   * same box in teal and orange, and a bounding box that swallowed either would be
   * measuring the furniture. The cloud is the only near-neutral thing in there.
   */
  // Read off the overlay's own backing store rather than out of a screenshot: it is a
  // 2D canvas, so the pixels are there for the asking, and going through a PNG would
  // have added a decoder this repo does not otherwise depend on.
  const planExtent = async () => {
    await page.evaluate(() => globalThis.__kinect.keyframes.chrome.set(true));
    await wait(220);
    return page.evaluate(() => {
      const canvas = document.getElementById('chrome');
      const r = globalThis.__kinect.keyframes.chrome.inset();
      // The overlay is drawn through a device-pixel-ratio transform, so the inset's
      // CSS rectangle has to be taken back into the buffer's own scale.
      const scale = canvas.width / r.stage.w;
      const x0 = Math.round(r.x * scale);
      const y0 = Math.round(r.y * scale);
      const w = Math.round(r.w * scale);
      const h = Math.round(r.h * scale);
      const px = canvas.getContext('2d').getImageData(x0, y0, w, h).data;
      let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity; let n = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const red = px[i]; const green = px[i + 1]; const blue = px[i + 2];
          if (px[i + 3] < 40) continue;
          // Bright and near-neutral. The plan cloud is drawn at (232, 236, 241), the
          // path in teal and the frustum in orange, and a box that swallowed either of
          // those would be measuring the furniture.
          if (red < 90 || Math.abs(red - green) > 26 || Math.abs(green - blue) > 26) continue;
          n++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      return n === 0 ? { n: 0 } : { n, w: maxX - minX + 1, h: maxY - minY + 1, scale };
    });
  };

  // Back to no cant before planting, or the surface is levelled from wherever the
  // previous section left the room and the crosshair is looking at nothing.
  await setTilt(0, 0);
  await plant(SURFACES[1]);
  const level = await levelAt(0.5);
  ok('the planted surface can be levelled on', level.ok === true, level.reason ?? '');
  if (level.ok) {
    const flatPlan = await planExtent();
    ok('a surface levelled flat covers the top-down in two directions',
      flatPlan.n > 200 && Math.min(flatPlan.w, flatPlan.h) > 8,
      `${flatPlan.n} plan points, ${flatPlan.w}x${flatPlan.h}px`);
    // **The vertical crop, which this plan ignored on purpose until levelling existed.**
    // While the top-down was drawn about the sensor's own axes, sensor y ran straight up
    // the axis a top-down projects away, so a point cropped by `bottom`/`top` could not
    // have landed on a pixel this view has and culling on x alone was free. Levelling
    // mixes y into the plan's own x and z, and a point the renderer threw away now lands
    // inside the footprint looking like geometry. Measured with the room still levelled
    // flat, because that is the pose where the whole surface is in the box and a strip
    // taken out of it is a change this extent can actually see.
    await page.evaluate(() => {
      const k = globalThis.__kinect;
      k.params.set('bottom', -0.25);
      k.params.set('top', 0.25);
    });
    const croppedPlan = await planExtent();
    ok('and closing the crop in sensor y takes points out of it, which a plan culling on x alone cannot do',
      croppedPlan.n > 0 && croppedPlan.n * 1.2 < flatPlan.n,
      `${flatPlan.n} plan points with the crop open, ${croppedPlan.n} with bottom/top closed`);
    await page.evaluate(() => globalThis.__kinect.params.reset(['bottom', 'top']));
    // A further quarter turn about x stands the same surface on its edge: whatever was
    // carried onto +Y goes to -Z, which is horizontal, so its top-down collapses to a
    // line. Two-sided on purpose - the fat reading alone passes on a plan that ignores
    // the levelling entirely, because a canted plane fills a box too.
    await setTilt(level.tilt - 90, level.roll);
    const edgePlan = await planExtent();
    const flatMinor = Math.min(flatPlan.w, flatPlan.h);
    const edgeMinor = Math.min(edgePlan.w ?? 0, edgePlan.h ?? 0);
    ok('and standing it on its edge collapses that box to a line',
      edgePlan.n > 0 && edgeMinor * 3 < flatMinor,
      `${flatMinor}px across flat, ${edgeMinor}px on edge`);
  }
  await page.evaluate(() => globalThis.__kinect.keyframes.chrome.set(false));

  // --- 4. the sensor view stays literal -------------------------------------
  console.log('\n4. the sensor view is posed in the sensor frame');
  await plant(SURFACES[2]);
  await setTilt(0, 0);
  await page.evaluate(() => globalThis.__kinect.sensorView());
  const sensorFlat = await picture();
  ok('the sensor view of a planted surface is stable', sensorFlat.stable);
  await setTilt(26, -37);
  await page.evaluate(() => globalThis.__kinect.sensorView());
  const sensorCanted = await picture();
  ok('and is the same picture at any cant, because it means what the sensor shot',
    sensorFlat.hash === sensorCanted.hash, `${sensorFlat.hash} then ${sensorCanted.hash}`);
  const restored = await page.evaluate(() => {
    const k = globalThis.__kinect;
    const sensorUp = k.freeCamera.up.toArray();
    k.params.set('tilt', 4);
    return { sensorUp, afterLevelling: k.freeCamera.up.toArray() };
  });
  ok('the sensor view takes navigation onto the sensor pole',
    Math.abs(restored.sensorUp[1] - 1) > 1e-3, restored.sensorUp.map((v) => v.toFixed(3)).join(', '));
  ok('and touching either levelling parameter puts the pole back on the room',
    Math.abs(restored.afterLevelling[1] - 1) < 1e-9,
    restored.afterLevelling.map((v) => v.toFixed(3)).join(', '));

  // --- 5. selecting a floor reads the chosen geometry ------------------------
  console.log('\n5. floor selection derives the pair from the chosen surface');
  const answers = [];
  for (const surface of SURFACES) {
    await setTilt(0, 0);
    const planted = await plant(surface);
    const result = await levelAt(0.5);
    if (!result.ok) {
      ok(`surface ${surface.name} could be levelled on`, false, result.reason);
      continue;
    }
    // Where the planted normal ends up under the pair the button wrote, computed from
    // the quaternion the page is carrying rather than recomposed here from the two
    // angles - recomposing would agree with the implementation by construction and
    // could never see the order being read backwards.
    const landed = await landNormal(planted);
    answers.push({ surface, result, landed });
    ok(`surface ${surface.name}: the pair it wrote carries that surface's normal onto the vertical`,
      Math.hypot(landed[0], landed[2]) < LEVEL_TOLERANCE,
      `lands at ${landed.map((v) => v.toFixed(4)).join(', ')}, wrote tilt ${result.tilt} roll ${result.roll}`);
  }
  const pairs = answers.map((a) => `${a.result.tilt}/${a.result.roll}`);
  // The rule this repo keeps relearning: a set of arms that agree about a quantity
  // cannot measure it however many of them there are.
  ok('and the three surfaces are three different answers rather than one constant',
    new Set(pairs).size === answers.length, pairs.join(', '));
  ok('the fit reports how flat the surface it read actually was',
    answers.every((a) => Number.isFinite(a.result.rms) && a.result.samples >= 32),
    answers.map((a) => `${a.result.samples} samples at ${(a.result.rms * 1000).toFixed(2)}mm`).join(', '));

  // Two surfaces in one picture make the selected coordinate load-bearing. A full
  // frame of one plane proves the normal fit but cannot distinguish a selected point
  // from the old hard-coded centre, however many different full frames are tried.
  const [leftNormal, rightNormal] = await plant(SURFACES[0], SURFACES[2]);
  const selected = [];
  for (const [side, x, normal] of [['left', 0.35, leftNormal], ['right', 0.65, rightNormal]]) {
    await setTilt(0, 0);
    await page.evaluate(() => globalThis.__kinect.sensorView());
    const result = await levelAt(x);
    const landed = result.ok ? await landNormal(normal) : [Infinity, Infinity, Infinity];
    selected.push(result);
    ok(`selecting the ${side} side reads the plane on that side`,
      result.ok && Math.hypot(landed[0], landed[2]) < LEVEL_TOLERANCE,
      result.ok
        ? `lands at ${landed.map((v) => v.toFixed(4)).join(', ')}, wrote ${result.tilt}/${result.roll}`
        : result.reason);
  }
  ok('and the two selected points produce different rotations',
    selected.every((result) => result.ok)
      && `${selected[0].tilt}/${selected[0].roll}` !== `${selected[1].tilt}/${selected[1].roll}`,
    selected.map((result) => (result.ok ? `${result.tilt}/${result.roll}` : result.reason)).join(', '));

  // **Through the two-step control and not through the hook**, and that is the whole
  // reason these rows exist rather than being one more call like the arms above. `editor-check`
  // names this tool as `camLevel`'s driver, and a driver that reached past the control
  // into the function behind it would be the exact failure that file was written
  // about: the suite testing the model while the control it is named after was never
  // pressed, which is how the in and out markers spent their whole life detached from
  // the document with every proof tool green.
  // **And the press has to be off the centre, on the split plant.** A frame of one plane
  // answers the same whatever point reaches the fit, so a gesture on one only ever proves
  // that pressing did *something* - the handler could drop `view.x`/`view.y` on the floor
  // and hand the middle of the frame to an otherwise correct hook, and a single-plane
  // press could not tell. The arms above cannot see it either, because each one passes its
  // own coordinate straight to `levelAtStagePoint` and so starts one link past the thing
  // that would be broken. Two planes and a named side is what gives the coordinate a
  // consequence: `pointer-levels-the-centre` is the control, and it presses the seam
  // between the two planted planes, where the answer belongs to neither side.
  await setTilt(0, 0);
  const [pressLeftNormal, pressRightNormal] = await plant(SURFACES[0], SURFACES[2]);
  await page.evaluate(() => globalThis.__kinect.sensorView());
  await page.evaluate(() => { document.getElementById('panel').style.display = ''; });
  await page.locator('#camLevel').click();
  const armed = await page.evaluate(() => ({
    active: globalThis.__kinect.levelSelection(),
    pressed: document.getElementById('camLevel').getAttribute('aria-pressed'),
    label: document.getElementById('camLevel').textContent,
    note: document.getElementById('levelNote').textContent,
    rotation: [globalThis.__kinect.params.get('tilt'), globalThis.__kinect.params.get('roll')],
  }));
  ok('pressing select floor visibly arms one selection without changing the room',
    armed.active && armed.pressed === 'true' && /cancel/.test(armed.label)
      && armed.rotation[0] === 0 && armed.rotation[1] === 0,
    `${armed.label}, rotation ${armed.rotation.join('/')}; ${armed.note}`);
  // Taken from the element rather than written down, because `#stage` is letterboxed to
  // the export aspect and a hard-coded pixel would silently stop naming a side the day
  // that aspect changes.
  const stageBox = await page.locator('#stage').boundingBox();
  const pressSide = async (xFraction) => {
    await page.locator('#stage').click({
      position: { x: stageBox.width * xFraction, y: stageBox.height * 0.5 },
    });
    return page.evaluate(() => {
      const k = globalThis.__kinect;
      return {
        tilt: k.params.get('tilt'),
        roll: k.params.get('roll'),
        note: document.getElementById('levelNote').textContent,
        slider: document.getElementById('tilt').value,
        active: k.levelSelection(),
        pressed: document.getElementById('camLevel').getAttribute('aria-pressed'),
      };
    });
  };
  const pressed = await pressSide(0.35);
  ok('clicking the picture through the armed control levels the room and spends the mode',
    (pressed.tilt !== 0 || pressed.roll !== 0) && !pressed.active && pressed.pressed === 'false',
    `tilt ${pressed.tilt} roll ${pressed.roll}, armed ${pressed.active}`);
  ok('and the slider beside it follows, because the panel is a view on the registry',
    Number(pressed.slider) === pressed.tilt, `slider reads ${pressed.slider}`);
  ok('and the selection says what it read rather than only that it worked',
    /samples/.test(pressed.note), pressed.note);
  // Graded against the plane that was actually under the press, and read before the next
  // `setTilt` moves the rotation this is measured through.
  const pressedLeftLanded = await landNormal(pressLeftNormal);
  ok('and the press read the plane under the point pressed, not the middle of the frame',
    Math.hypot(pressedLeftLanded[0], pressedLeftLanded[2]) < LEVEL_TOLERANCE,
    `lands at ${pressedLeftLanded.map((v) => v.toFixed(4)).join(', ')}, wrote ${pressed.tilt}/${pressed.roll}`);

  await setTilt(0, 0);
  await page.locator('#camLevel').click();
  const pressedRight = await pressSide(0.65);
  const pressedRightLanded = await landNormal(pressRightNormal);
  ok('and pressing the other side of the same frame reads the other plane',
    !pressedRight.active && Math.hypot(pressedRightLanded[0], pressedRightLanded[2]) < LEVEL_TOLERANCE,
    `lands at ${pressedRightLanded.map((v) => v.toFixed(4)).join(', ')}, wrote ${pressedRight.tilt}/${pressedRight.roll}`);
  // The two rows above could both pass on a build that levelled correctly on whichever
  // single plane it always picked, if the two planted normals happened to be close. This
  // is the row that says the two presses were answered differently at all.
  ok('so two presses through one control are two rotations, and the coordinate reached the fit',
    `${pressed.tilt}/${pressed.roll}` !== `${pressedRight.tilt}/${pressedRight.roll}`,
    `${pressed.tilt}/${pressed.roll} then ${pressedRight.tilt}/${pressedRight.roll}`);

  await page.locator('#camLevel').click();
  await page.keyboard.press('Escape');
  const cancelled = await page.evaluate(() => ({
    active: globalThis.__kinect.levelSelection(),
    note: document.getElementById('levelNote').textContent,
  }));
  ok('Escape leaves a selection mode without spending it',
    !cancelled.active && /cancelled/.test(cancelled.note), cancelled.note);

  await setTilt(12.5, -6);
  await page.locator('#camLevelReset').click();
  const reset = await page.evaluate(() => ({
    tilt: globalThis.__kinect.params.get('tilt'),
    roll: globalThis.__kinect.params.get('roll'),
    sliders: [document.getElementById('tilt').value, document.getElementById('roll').value],
    note: document.getElementById('levelNote').textContent,
  }));
  ok('reset rotation takes both axes and both sliders back to neutral',
    reset.tilt === 0 && reset.roll === 0 && reset.sliders.every((value) => Number(value) === 0),
    `rotation ${reset.tilt}/${reset.roll}, sliders ${reset.sliders.join('/')}; ${reset.note}`);
  await page.evaluate(() => { document.getElementById('panel').style.display = 'none'; });

  // --- 6. which side of the document boundary it falls on --------------------
  console.log('\n6. the cant is the take\'s and the pole is the viewer\'s');
  const boundary = await page.evaluate(() => {
    const k = globalThis.__kinect;
    k.params.set('tilt', 12.5);
    k.params.set('roll', -6);
    const document = k.params.values();
    const view = k.params.values(k.params.names('view'));
    return {
      inDocument: 'tilt' in document && 'roll' in document,
      values: [document.tilt, document.roll],
      leakedToView: 'tilt' in view || 'roll' in view,
      tags: [k.params.spec('tilt').tag, k.params.spec('roll').tag],
      ranges: [k.params.spec('tilt'), k.params.spec('roll')].map((s) => [s.min, s.max]),
    };
  });
  ok('both are document state, so a project carries the cant it was levelled at',
    boundary.inDocument && !boundary.leakedToView, `${boundary.values.join(', ')} tagged ${boundary.tags.join('/')}`);
  // The plane fit's two `atan2`s cannot leave these, so the button can never write a
  // value its own slider would clamp - which would be a silent disagreement between
  // the two ways of saying the same thing.
  ok('and the sliders reach everywhere the plane fit can land',
    boundary.ranges[0][0] <= -90 && boundary.ranges[0][1] >= 90
    && boundary.ranges[1][0] <= -180 && boundary.ranges[1][1] >= 180,
    JSON.stringify(boundary.ranges));
  ok('the page reported no error through any of it', pageErrors.length === 0,
    pageErrors.slice(0, 2).join(' | '));

  await browser.close();
} catch (err) {
  crashed = err;
  console.log(`\n  FAIL  the run did not finish: ${err.message}`);
} finally {
  await stopAll();
  rmSync(WORK, { recursive: true, force: true });
}

console.log(`\n[level] ${checked} assertions, ${failed} failed`);
if (crashed && !untested) {
  console.log(`[level] DID NOT RUN - ${crashed.message}. Nothing here is a finding: re-run it.`);
  process.exit(2);
}
if (untested) {
  console.log(`[level] UNTESTED - ${untested}.`);
  process.exit(2);
}
if (MUTATE) {
  // Exit code alone cannot tell a caught mutation from a tool that crashed before
  // asserting anything, and this repo has been bitten by exactly that twice.
  if (failed === 0) { console.log('[level] NOT CAUGHT - the check passed a build it should have rejected'); process.exit(1); }
  console.log(`[level] caught, as required (${failed} assertion${failed === 1 ? '' : 's'} fired)`);
  process.exit(1);
}
if (failed) { console.log('[level] FAIL'); process.exit(1); }
console.log('[level] PASS');
process.exit(0);
