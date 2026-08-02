#!/usr/bin/env node
// Proves this repo's own supply-chain gate is armed: that `.npmrc` names a minimum
// release age, and that npm actually derives a cutoff from it. Needs no server, no
// browser, no sensor and no network - only the `npm` that would be doing the installing.
//
//   node tools/release-gate-check.mjs [--mutate wrong-unit|no-gate|absent]
//
// The reason this is a check rather than a line in a README is that npm fails **open**
// on a value it cannot parse. `min-release-age=2d` is a warning, not an error, and the
// install proceeds ungated - so a wrong unit reads exactly like a configured gate to
// anybody reading the file, and the only way to tell the two apart is to ask npm what it
// derived. Measured here: `2` gives a cutoff two days back, `2d` gives `Invalid Date`,
// and no gate at all gives `null`. Reading `min-release-age` back is not a check either
// way, because npm answers `null` for it whether it took or not.
//
// Both of npm's other config layers are masked with empty files, and that is the load-
// bearing part rather than tidiness. This machine carries the same gate in `~/.npmrc`,
// so an unmasked run reads a date and passes while proving nothing about the repo -
// which is the whole question, since the contributor cloning this is the person the file
// exists for. The `null` from a directory with no `.npmrc` is asserted alongside, or a
// date coming back means nothing.
// Mutation convention, stated because the suite has two and CLAUDE.md records that the
// disagreement runs the dangerous way: this file follows `vendor-check`. A caught
// mutation is exit **0** with the assertion count printed, and exit **1** is NOT CAUGHT.
// Read the count, never the code.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const MUTATE = argv.includes('--mutate') ? argv[argv.indexOf('--mutate') + 1] : null;

// Each mutation is a whole `.npmrc`, served from a copy of the repo, and each is a
// configuration somebody could plausibly commit: the duration string the other package
// managers in this family would want, the gate deleted, the file never written.
const MUTATIONS = {
  'wrong-unit': 'min-release-age=2d\n',
  'no-gate': '# nothing here\n',
  absent: null,
};
if (MUTATE && !(MUTATE in MUTATIONS)) {
  console.error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

// Two distinct empty files rather than /dev/null twice: npm refuses to load one path as
// both the user and the global config and dies before it resolves anything, which comes
// back as a message about double-loading rather than as an answer.
const scratch = mkdtempSync(join(tmpdir(), 'release-gate-'));
const MASK = ['--userconfig', join(scratch, 'user'), '--globalconfig', join(scratch, 'global')];
writeFileSync(MASK[1], '');
writeFileSync(MASK[3], '');

// The directory npm is asked from. Unmutated that is the repo itself; a mutation gets a
// directory holding nothing but the `.npmrc` under test, because the answer depends on
// that file and on nothing else in the tree.
let cwd = REPO;
if (MUTATE) {
  cwd = join(scratch, 'tree');
  mkdirSync(cwd, { recursive: true });
  if (MUTATIONS[MUTATE] !== null) writeFileSync(join(cwd, '.npmrc'), MUTATIONS[MUTATE]);
}

const npmGet = (key, from) => {
  try {
    return execFileSync('npm', ['config', 'get', key, ...MASK], {
      cwd: from, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    console.log('DID NOT RUN - npm could not answer, so nothing below was measured');
    console.log(`  ${(err.stderr || err.message || '').toString().trim().split('\n').slice(0, 3).join('\n  ')}`);
    rmSync(scratch, { recursive: true, force: true });
    process.exit(2);
  }
};

let failed = 0;
const ok = (label, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const gateFile = join(cwd, '.npmrc');
const source = existsSync(gateFile) ? readFileSync(gateFile, 'utf8') : null;
ok('the tree carries an .npmrc, so a contributor cloning it inherits the gate rather than this machine\'s user config',
  source !== null, gateFile);
ok('and it names min-release-age, which is the only key npm turns into a cutoff',
  /^\s*min-release-age\s*=/m.test(source ?? ''),
  // Matched on the setting rather than on the substring, or the detail column quotes
  // whichever comment line happens to mention the key and hides the value under test.
  (source ?? '').split('\n').find((l) => /^\s*min-release-age\s*=/.test(l)) ?? 'no such line');

// Asked of npm rather than compared against a version number, because the question is
// whether this npm has the feature and a hardcoded floor is a second thing to keep
// right. `npm config ls -l` enumerates every key it knows with its default, so
// `min-release-age = null` appearing at all is the capability - and an npm too old for
// it fails the derived-date rows below with a `null` that names no cause. This row is
// the cause, which is why it is above them.
const known = (() => {
  try {
    return /^\s*min-release-age\s*=/m.test(execFileSync('npm', ['config', 'ls', '-l', ...MASK],
      { cwd: scratch, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch { return false; }
})();
const npmVersion = (() => {
  try {
    return execFileSync('npm', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch { return 'unknown'; }
})();
ok('this npm knows min-release-age at all - it arrived in npm 11, and an older one ignores the file entirely while reporting nothing',
  known, `npm ${npmVersion}`);

// The positive twin. Without it a date proves only that *somewhere* on this machine a
// gate exists, which is true here and false on the machine that matters.
const elsewhere = npmGet('before', scratch);
ok('a directory with no .npmrc answers null, so the date below can only have come from the file under test',
  elsewhere === 'null', elsewhere);

const raw = npmGet('before', cwd);
const when = new Date(raw);
const valid = raw !== 'null' && !Number.isNaN(when.getTime());
ok('npm derives a real cutoff date from it - an unparseable value is a warning rather than an error, so the gate would be open with the file looking right',
  valid, raw);

const hours = valid ? (Date.now() - when.getTime()) / 3_600_000 : 0;
ok('and the cutoff is at least 48 hours back, which is the window a compromised release is most likely to be caught in',
  valid && hours >= 47.5, valid ? `${hours.toFixed(1)}h` : raw);
// An upper bound as well, because a gate nobody can install through gets turned off
// rather than fixed, and a fat-fingered 2000 is as broken as a missing one.
ok('and not so far back that ordinary dependency work is impossible, which is how a gate gets deleted instead of corrected',
  valid && hours <= 24 * 400, valid ? `${(hours / 24).toFixed(1)} days` : raw);

rmSync(scratch, { recursive: true, force: true });

console.log(`\n${failed} failed`);
if (MUTATE) {
  if (failed === 0) { console.log(`NOT CAUGHT - ${MUTATE} passed a check that exists to reject it`); process.exit(1); }
  console.log(`caught, as required (${failed} assertions fired)`);
  process.exit(0);
}
process.exit(failed ? 1 : 0);
