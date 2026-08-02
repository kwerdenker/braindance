#!/usr/bin/env node
// Builds the two native artifacts the server needs: libfreenect2 out of
// `third_party/libfreenect2` into the gitignored `vendor/prefix`, and the grabber out of
// `native/` into `native/build`. Neither needs the network.
//
//   node tools/build-native.mjs [--preset macos|linux] [--jobs N] [--clean]
//
// This exists because the version of it that lived in README.md was thirteen lines of
// cmake flags a reader had to retype correctly, with the platform differences described
// in a paragraph underneath rather than applied. Two copies of a build - one in prose and
// one in whatever people actually ran - is the drift this repo rejects everywhere else,
// so the README now names this file and carries no flags of its own. The reasoning that
// used to sit under that code block is here instead, beside the line it governs.
//
// **A build script that exits 0 without a working binary is the failure mode this whole
// suite is about**, and "the file exists" does not rule it out - a grabber left over from
// a previous checkout, or one linked against a prefix that is no longer there, both exist.
// So the last thing this does is run the grabber it just built. dyld resolves the rpath
// before `main`, so `--help` coming back clean is a statement about the library too: point
// the rpath at nothing and it fails there rather than at the first sensor.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`usage: node tools/build-native.mjs [--preset macos|linux] [--jobs N] [--clean]

  --preset overrides the platform detection. macos builds depth on OpenCL and leaves
           OpenGL off; linux is the other way round and covers the Raspberry Pi.
  --jobs   parallel compile jobs. Defaults to this machine's core count, capped at 8.
  --clean  removes vendor/build, vendor/prefix and native/build first. The vendored
           library is a one-time build, so the ordinary run reuses it.`);
  process.exit(0);
}

// Two presets rather than three, and the Pi rides with linux. The reason the Pi needs
// OpenGL is that its V3D has no OpenCL at all - a fact about that GPU rather than about
// Linux - so a desktop Linux box with a real OpenCL runtime arguably wants the macOS
// arrangement instead. Nobody here has measured that, and the grabber's `--pipeline` is
// guarded by whichever backend the library was actually compiled with rather than falling
// through silently, so the wrong guess is a refusal rather than a slow build. An untested
// third preset would still be a configuration this repo ships without having run it, so
// the README's two are what this offers until somebody measures the third.
const PRESETS = {
  macos: {
    cmake: ['-DENABLE_OPENCL=ON', '-DENABLE_OPENGL=OFF'],
    // OpenGL is off deliberately rather than incidentally: it drives libfreenect2's own
    // viewer, which nothing here uses, and it is the most deprecated path on the platform.
    why: 'depth on OpenCL, OpenGL off (it only drives libfreenect2\'s own viewer)',
  },
  linux: {
    cmake: ['-DENABLE_OPENCL=OFF', '-DENABLE_OPENGL=ON'],
    why: 'depth on OpenGL, OpenCL off (the Pi\'s V3D has no OpenCL)',
  },
};

const detect = () => {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  return null;
};

const preset = flag('--preset') ?? detect();
if (!preset || !PRESETS[preset]) {
  const named = flag('--preset');
  console.error(named
    ? `unknown preset ${named} - this ships ${Object.keys(PRESETS).join(' and ')}`
    : `no preset for platform ${process.platform} - pass --preset ${Object.keys(PRESETS).join('|')} if one of them fits`);
  process.exit(2);
}

const JOBS = Number(flag('--jobs')) || Math.min(cpus().length || 4, 8);

// Where everything lands. `vendor` and `native/build` are both gitignored; the prefix is
// what the grabber's rpath points at, so moving either of these means editing
// native/CMakeLists.txt to match.
const VENDOR_BUILD = join(REPO, 'vendor/build');
const VENDOR_PREFIX = join(REPO, 'vendor/prefix');
const NATIVE_BUILD = join(REPO, 'native/build');
const GRABBER = join(NATIVE_BUILD, 'grabber');

// **A missing dependency has to be named here rather than discovered in cmake's output.**
// The one this bites on is TurboJPEG: cmake reports it as a package it could not find,
// which reads as a problem with the source tree rather than as one `brew install` away.
// `brew --prefix` rather than a literal `/opt/homebrew` because that path is
// Apple-Silicon-only - Intel Macs put it at `/usr/local`, and a hardcoded prefix fails
// with a message that never mentions the prefix.
const brewPrefix = (formula) => {
  const r = spawnSync('brew', ['--prefix', formula], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout?.trim()) return null;
  const path = r.stdout.trim();
  return existsSync(path) ? path : null;
};

const have = (bin, args = ['--version']) => spawnSync(bin, args, { stdio: 'ignore' }).status === 0;

if (!have('cmake')) {
  console.error(`cmake is not on PATH - ${preset === 'macos' ? 'brew install cmake' : 'sudo apt install cmake'}`);
  process.exit(2);
}

const vendorFlags = [
  // CMake 4 dropped compatibility with pre-3.5 policies and libfreenect2 v0.2.1 predates
  // that floor, so without this the configure step stops before it reports anything about
  // the tree it was given.
  '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
  `-DCMAKE_INSTALL_PREFIX=${VENDOR_PREFIX}`,
  '-DENABLE_CXX11=ON',
  '-DENABLE_CUDA=OFF',
  ...PRESETS[preset].cmake,
];

if (preset === 'macos') {
  const missing = ['libusb', 'jpeg-turbo'].filter((f) => !brewPrefix(f));
  if (missing.length) {
    console.error(`missing Homebrew packages: ${missing.join(', ')} - brew install ${missing.join(' ')}`);
    process.exit(2);
  }
  // Pointed at explicitly because libfreenect2's finder does not look inside Homebrew's
  // opt paths. On Linux both flags come off entirely and pkg-config finds it.
  const jpeg = brewPrefix('jpeg-turbo');
  vendorFlags.push(
    `-DTurboJPEG_INCLUDE_DIRS=${join(jpeg, 'include')}`,
    `-DTurboJPEG_LIBRARIES=${join(jpeg, 'lib/libturbojpeg.dylib')}`,
  );
}

const run = (bin, args) => {
  console.log(`[build-native] ${bin} ${args.join(' ')}`);
  execFileSync(bin, args, { cwd: REPO, stdio: 'inherit' });
};

console.log(`[build-native] preset ${preset} - ${PRESETS[preset].why}`);
console.log(`[build-native] ${JOBS} parallel jobs`);

if (argv.includes('--clean')) {
  for (const dir of [VENDOR_BUILD, VENDOR_PREFIX, NATIVE_BUILD]) rmSync(dir, { recursive: true, force: true });
  console.log('[build-native] removed vendor/build, vendor/prefix and native/build');
}

try {
  run('cmake', ['-S', 'third_party/libfreenect2', '-B', 'vendor/build', ...vendorFlags]);
  run('cmake', ['--build', 'vendor/build', '--target', 'install', `-j${JOBS}`]);
  run('cmake', ['-S', 'native', '-B', 'native/build']);
  run('cmake', ['--build', 'native/build', `-j${JOBS}`]);
} catch {
  // execFileSync already put the compiler's own output on this terminal, so repeating the
  // exception here would bury it. Exit 2 on the same reading the proof tools use: the
  // build did not run to completion, which is a different answer from one that produced a
  // binary this script then rejected.
  console.error('[build-native] FAILED - the build did not complete; its output is above');
  process.exit(2);
}

// Everything above can succeed and still leave nothing usable, so the claim is closed by
// running the artifact rather than by stat-ing it. `--help` returns before any device
// enumeration, so this stays true on a machine with no sensor - which is most of them,
// the library and the editor being documented to run on an editing station.
if (!existsSync(GRABBER)) {
  console.error(`[build-native] FAILED - cmake reported success but ${GRABBER} does not exist`);
  process.exit(1);
}

const probe = spawnSync(GRABBER, ['--help'], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.error('[build-native] FAILED - the grabber was built but will not run:');
  console.error((probe.stderr || probe.stdout || `exit ${probe.status}`).trim());
  console.error('a dyld failure here means the binary is not resolving vendor/prefix');
  process.exit(1);
}

// Read back out of the binary's own usage text rather than out of the flags passed in,
// because those two disagreeing is the whole point of asking. The grabber prints the
// pipelines its libfreenect2 was compiled with, so a prefix built for the other preset -
// or an older one still sitting in vendor/ - shows up here as a backend that is missing.
//
// Both streams, because the grabber writes its usage to *stderr* - reading stdout alone
// matched nothing and reported `unknown` on a perfectly good build, which is this repo's
// own rule about a counter grepping a phrase the system never emits, reproduced inside
// the tool written to respect it. It survived the first run because the shell that
// checked it merged the two streams with `2>&1`.
const offers = /this build offers ([a-z ]+)/.exec(`${probe.stderr}${probe.stdout}`)?.[1]?.trim();
console.log(`[build-native] grabber runs and reports depth pipelines: ${offers ?? 'unknown'}`);
console.log(`[build-native] OK - ${GRABBER}`);
console.log('[build-native] node tools/vendor-check.mjs proves the tree is upstream v0.2.1 plus the declared edits');
