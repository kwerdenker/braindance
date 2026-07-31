#!/usr/bin/env node
// Differential test for Registration::apply: our build against a pristine
// upstream v0.2.1 build, on identical corpus input, compared exactly.
//
// The comparison is an exact differing-element count and a max absolute
// difference per plane, both asserted to be zero. It is deliberately not a mean
// difference: one wrong pixel in 217,088 is a mean around 1e-5, which no
// threshold anybody would write is going to catch, and this repo has already
// been bitten by a difference metric that could not see what it was looking for.
//
// Building the oracle is part of the run rather than a prerequisite, because a
// stale oracle prefix is the failure mode that turns this into a build compared
// against itself, and nothing about a stale .dylib looks wrong.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, rmSync, cpSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DW = 512, DH = 424, PIXELS = DW * DH;
const PLANE_BYTES = PIXELS * 4;
const FRAME_BYTES = PLANE_BYTES * 2;

const argv = process.argv.slice(2);
const arg = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const has = (name) => argv.includes(name);
const CORPUS = arg('--corpus', join(ROOT, 'captures', 'reg-corpus'));
const mutation = arg('--mutate', null);

// Build and tooling failures exit 2, never 1. A mutation run that fails to
// compile also "exits non-zero", and if that were indistinguishable from a
// caught mutation then a broken harness would report success for the rest of
// its life. Exit 1 in this tool always means assertions fired.
const sh = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  } catch (e) {
    console.error(`\nTOOLING FAILURE - this is not a caught mutation, the harness did not run.`);
    console.error(`  ${cmd} ${args.join(' ')}`);
    console.error((e.stderr || e.message || '').toString().trim().split('\n').slice(0, 6).join('\n'));
    process.exit(2);
  }
};

// --- mutations ------------------------------------------------------------
// Applied to OUR vendored registration.cpp, which is then rebuilt. Each must
// change output the check reads. A mutation whose text is not found exactly once
// is refused rather than run, because a replacement that matched nothing would
// build the unmutated source and be recorded as a miss.
const MUTATIONS = {
  // The occlusion tolerance. Moves which pixels survive the filter.
  'filter-tolerance': ['filter_tolerance(0.01f)', 'filter_tolerance(0.011f)'],
  // The scatter window's width. Changes how far occlusion reaches sideways.
  'filter-width': ['filter_width_half(2)', 'filter_width_half(1)'],
  // Makes the occlusion test never reject, which is the observable half of
  // "drop the filter" - the 10.99ms of the 13.13ms this whole exercise is about.
  //
  // It mutates the decision rather than the allocation on purpose. Disabling the
  // `if(enable_filter)` that *allocates* filter_map leaves the later branches
  // reading a null pointer, so the subject segfaulted instead of producing wrong
  // pixels, and a crash is not evidence the comparator can see anything.
  'filter-never-rejects': ['(z - min_z) / z > filter_tolerance ? 0 : *(rgb_data + c_off)',
                           '(false) ? 0 : *(rgb_data + c_off)'],
  // Moves the depth plane. Every other mutation here only disturbs `registered`,
  // which left the four `undistorted` assertions never once demonstrated to
  // fire - a set of probes that all agree about a quantity cannot measure it,
  // however many of them there are. One millimetre on one pixel of one frame.
  //
  // The anchor carries the trailing comment because `const float z =
  // depth_data[index]; *undistorted_data = z;` appears identically in both
  // apply() and undistortDepth(), and the tool refuses an ambiguous match
  // rather than silently mutating whichever came first.
  // Clips one element off the right end of every scatter run. This is aimed at
  // the threaded banding specifically: the failure mode there is a window that
  // straddles two threads' ranges being written by neither, or twice, and an
  // off-by-one in the clip is what that looks like in source.
  'band-off-by-one': ['const int b = (s + span) < hi ? (s + span) : hi;',
                      'const int b = (s + span - 1) < hi ? (s + span - 1) : hi;'],
  'depth-one-mm': [
    'const float z = depth_data[index];\n    *undistorted_data = z;\n\n    // checking for invalid depth value',
    'float z = depth_data[index];\n    { static int _n = 0; if (z > 0.0f && ++_n == 1000) z += 1.0f; }\n    *undistorted_data = z;\n\n    // checking for invalid depth value'],
  // One pixel, one least-significant bit, across the whole 32-frame corpus.
  // This is the comparator's sensitivity floor: if it cannot see this it cannot
  // see anything, and every clean pass it has ever reported was luck.
  //
  // It counts *surviving* pixels rather than flipping a fixed index, and the
  // first version did the latter - pixel 12345 - which the check did not catch.
  // That pixel takes the `c_off < 0` continue in all 32 frames, so the line
  // being mutated never ran for it and the mutation changed nothing. A probe in
  // a dead zone reads exactly like a check that is blind. Counting guarantees
  // the bit lands on a pixel that reached the assignment and was non-zero.
  'one-lsb': ['*registered_data = (z - min_z) / z > filter_tolerance ? 0 : *(rgb_data + c_off);',
              'unsigned int _v = (z - min_z) / z > filter_tolerance ? 0 : *(rgb_data + c_off); '
              + '{ static int _n = 0; if (_v != 0 && ++_n == 1000) _v ^= 1u; } *registered_data = _v;'],
};
if (mutation && !MUTATIONS[mutation]) {
  console.error(`unknown mutation '${mutation}'; have: ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

// --- build ----------------------------------------------------------------
function buildPrefix(srcDir, prefix, buildDir, label) {
  const openclOn = process.platform === 'darwin';
  // A CMake build directory remembers the source it was generated from and
  // refuses a different one. The mutant tree is a different path, so without
  // this the whole mutation run dies at configure time - which cost a suite run
  // that printed nothing and exited non-zero, the exact shape this repo records
  // as "did not run" rather than "caught something".
  const cache = join(buildDir, 'CMakeCache.txt');
  if (existsSync(cache)) {
    const home = readFileSync(cache, 'utf8').match(/^CMAKE_HOME_DIRECTORY:INTERNAL=(.*)$/m)?.[1];
    if (home && home !== srcDir) rmSync(buildDir, { recursive: true, force: true });
  }
  sh('cmake', ['-S', srcDir, '-B', buildDir,
    '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
    `-DCMAKE_INSTALL_PREFIX=${prefix}`,
    '-DENABLE_CXX11=ON', '-DENABLE_CUDA=OFF',
    `-DENABLE_OPENCL=${openclOn ? 'ON' : 'OFF'}`, `-DENABLE_OPENGL=${openclOn ? 'OFF' : 'ON'}`,
    '-DTurboJPEG_INCLUDE_DIRS=/opt/homebrew/opt/jpeg-turbo/include',
    '-DTurboJPEG_LIBRARIES=/opt/homebrew/opt/jpeg-turbo/lib/libturbojpeg.dylib']);
  sh('cmake', ['--build', buildDir, '--target', 'install', '-j8']);
  console.log(`built ${label}`);
}

function buildRunner(prefix, buildDir, label) {
  sh('cmake', ['-S', join(ROOT, 'native'), '-B', buildDir, `-DFREENECT2_ROOT=${prefix}`]);
  sh('cmake', ['--build', buildDir, '--target', 'reg-runner', '-j8']);
  console.log(`built ${label}`);
  return join(buildDir, 'reg-runner');
}

const V = join(ROOT, 'vendor');
mkdirSync(V, { recursive: true });

// The oracle: upstream's own registration.cpp dropped into the vendored tree.
// vendor-check asserts third_party/oracle/registration.cpp still hashes to
// upstream's blob, so "pristine" is a checked claim rather than a filename.
const oracleSrc = join(V, 'oracle-src');
rmSync(oracleSrc, { recursive: true, force: true });
cpSync(join(ROOT, 'third_party', 'libfreenect2'), oracleSrc, { recursive: true });
cpSync(join(ROOT, 'third_party', 'oracle', 'registration.cpp'), join(oracleSrc, 'src', 'registration.cpp'));
buildPrefix(oracleSrc, join(V, 'prefix-oracle'), join(V, 'build-oracle'), 'oracle libfreenect2 (upstream v0.2.1 registration)');

// The subject: our tree, optionally mutated into a copy so the real one is
// never left broken by a falsification run.
let subjectSrc = join(ROOT, 'third_party', 'libfreenect2');
if (mutation) {
  const [from, to] = MUTATIONS[mutation];
  const mutSrc = join(V, 'mutant-src');
  rmSync(mutSrc, { recursive: true, force: true });
  cpSync(subjectSrc, mutSrc, { recursive: true });
  const f = join(mutSrc, 'src', 'registration.cpp');
  const s = readFileSync(f, 'utf8');
  const hits = s.split(from).length - 1;
  if (hits !== 1) {
    console.error(`mutation '${mutation}' anchor matched ${hits} times, need exactly 1 - refusing to run an unmutated build`);
    process.exit(2);
  }
  const { writeFileSync } = await import('node:fs');
  writeFileSync(f, s.replace(from, to));
  subjectSrc = mutSrc;
  console.log(`mutation '${mutation}' applied`);
}
buildPrefix(subjectSrc, join(V, 'prefix-subject'), join(V, 'build-subject'), 'subject libfreenect2');

const oracleRunner = buildRunner(join(V, 'prefix-oracle'), join(V, 'runner-oracle'), 'oracle runner');
const subjectRunner = buildRunner(join(V, 'prefix-subject'), join(V, 'runner-subject'), 'subject runner');

// Guard against the whole thing being a tautology: the two runners must have
// loaded different libraries. Identical binaries would compare clean forever.
if (process.platform === 'darwin') {
  const libOf = (r) => sh('otool', ['-l', r]).match(/path ([^\s]*prefix[^\s]*)\s/)?.[1] ?? '?';
  const a = libOf(oracleRunner), b = libOf(subjectRunner);
  console.log(`oracle  links ${a}`);
  console.log(`subject links ${b}`);
  if (a === b) { console.log('FAIL  both runners link the same prefix - this is not a differential test'); process.exit(1); }
}

// --- run ------------------------------------------------------------------
const oracleOut = join(V, 'oracle.planes');
const subjectOut = join(V, 'subject.planes');
const runOpts = has('--persistent-subject') ? ['--persistent'] : [];
// The runner reports its timing on stderr, so it is read from there rather than
// from the return value. A non-zero exit is fatal here rather than a difference
// to report: a runner that died produced no planes to compare, and an empty
// comparison would otherwise read as agreement.
const runCapture = (bin, args, label) => {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.status !== 0 || r.signal) {
    // Exit 2, not 1. A runner that crashed produced no pixels to compare, so
    // calling this a caught mutation would credit the comparator with a
    // detection it never made - and under --mutate that is the difference
    // between "the check works" and "the check was never reached".
    console.error(`\nRUNTIME FAILURE - the ${label} runner ${r.signal ? `died on ${r.signal}` : `exited ${r.status}`}.`);
    console.error('This is not a caught mutation; no comparison was performed.');
    console.error((r.stderr || '').trim());
    process.exit(2);
  }
  return (r.stderr || '').trim();
};
const oStat = runCapture(oracleRunner, ['--corpus', CORPUS, '--out', oracleOut], 'oracle');
const sStat = runCapture(subjectRunner, ['--corpus', CORPUS, '--out', subjectOut, ...runOpts], 'subject');

// --- compare --------------------------------------------------------------
let checked = 0, failed = 0;
const fail = (m) => { failed++; console.log(`FAIL  ${m}`); };

const A = readFileSync(oracleOut), B = readFileSync(subjectOut);
checked++;
if (A.length !== B.length) fail(`output sizes differ: ${A.length} vs ${B.length}`);
if (A.length === 0) fail('oracle produced no output');

const frames = Math.floor(Math.min(A.length, B.length) / FRAME_BYTES);
checked++;
if (frames === 0) fail('no complete frames to compare');

// undistorted is float millimetres; registered is packed BGRX. Comparing the
// depth plane as floats gives a meaningful magnitude, and the colour plane as
// u32 gives an exact differing-pixel count - a "max abs diff" over packed bytes
// would be arithmetic on four unrelated channels.
let depthDiff = 0, depthMax = 0, colorDiff = 0, nan = 0;
for (let f = 0; f < frames; f++) {
  const base = f * FRAME_BYTES;
  for (let i = 0; i < PIXELS; i++) {
    const o = base + i * 4;
    const a = A.readFloatLE(o), b = B.readFloatLE(o);
    if (Number.isNaN(a) !== Number.isNaN(b)) { nan++; depthDiff++; }
    else if (!Number.isNaN(a) && a !== b) { depthDiff++; depthMax = Math.max(depthMax, Math.abs(a - b)); }
  }
  for (let i = 0; i < PIXELS; i++) {
    const o = base + PLANE_BYTES + i * 4;
    if (A.readUInt32LE(o) !== B.readUInt32LE(o)) colorDiff++;
  }
}

const total = frames * PIXELS;
console.log(`\ncorpus      ${CORPUS}`);
console.log(`frames      ${frames} (${total.toLocaleString()} pixels per plane)`);
console.log(`oracle      ${oStat.trim()}`);
console.log(`subject     ${sStat.trim()}`);
console.log(`undistorted ${depthDiff} differing (max abs ${depthMax}), ${nan} NaN-mismatched`);
console.log(`registered  ${colorDiff} differing`);

checked++; if (depthDiff !== 0) fail(`undistorted differs in ${depthDiff}/${total} elements, max abs ${depthMax}`);
checked++; if (depthMax !== 0) fail(`undistorted max abs difference is ${depthMax}, want exactly 0`);
checked++; if (colorDiff !== 0) fail(`registered differs in ${colorDiff}/${total} pixels`);
checked++; if (nan !== 0) fail(`${nan} pixels disagree about being NaN`);

const label = mutation ? `mutation '${mutation}'` : 'our build vs upstream v0.2.1';
console.log(`\n${label}: ${checked} assertions, ${failed} failed`);
if (mutation) {
  if (failed === 0) { console.log('NOT CAUGHT - identical output from a build that was deliberately broken'); process.exit(1); }
  console.log(`caught, as required (${failed} assertions fired)`);
  process.exit(0);
}
console.log(failed === 0 ? 'PASS - bit-identical' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
