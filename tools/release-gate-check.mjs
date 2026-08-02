#!/usr/bin/env node
// Proves this repo's own supply-chain gate is armed: that `.npmrc` names a minimum
// release age, and that the npm which would be doing the installing actually refuses
// on it. Needs no server, no browser and no sensor - but it does need the registry,
// for the reason the method note below gives.
//
//   node tools/release-gate-check.mjs [--mutate wrong-unit|no-gate|absent]
//
// **This file used to say npm fails open on a value it cannot parse, and that is not
// what npm does.** Measured on 11.12.1 and 11.16.0 with `min-release-age=2d`: both warn
// `invalid config` and then stop with `npm error Invalid time value`, exit 1, nothing
// installed. A wrong unit is a loud failure on these versions rather than a silent one,
// so the sentence that justified this check was describing a hazard that is not there.
// It is recorded rather than deleted because the same claim is in the skill this repo's
// author works from, and a correction nobody wrote down gets re-derived.
//
// What is actually silent is the other three, and they are what the rows below are for.
// An npm older than 11 does not know the key at all and installs ungated without a
// word. And a value npm *can* parse but nobody meant sails straight through: measured
// here, `0` puts the cutoff at this instant, `-1` puts it tomorrow, and `2000` puts it
// in February 2021 - none of them warns, and the first two are an open gate wearing a
// configured file. Reading `min-release-age` back catches none of it, because npm
// answers `null` for that key whether it took or not.
//
// **This check used to ask `npm config get before`, and that method was version-
// dependent in the direction that reads as a failure.** npm derives its cutoff from
// the age internally, and older builds exposed the derived date through `before`;
// npm 11.16 reports `null` there while still enforcing the gate perfectly (npm/cli#9199
// is the same reporting regression seen through `npm config ls`). Measured on this
// repo's own `.npmrc`: npm 11.12.1 answered a date and npm 11.16.0 answered `null`,
// and both refused the identical install. So the config reading was bookkeeping that
// had stopped tracking the resource, and a green CI on the old method would have meant
// nothing on a newer npm than the one it was written against.
//
// What is asked instead is the resource: npm is made to resolve a package under the
// gate, and its refusal is read. A gate that npm parsed names its cutoff in the error -
// `No matching version found for abbrev@99.99.99 with a date before 7/31/2026` - and
// that clause is absent both when the unit is wrong and when there is no gate at all,
// which is exactly the pair that has to be told apart. Measured identical on 11.12.1
// and 11.16.0, so it is a property of npm's behaviour rather than of its reporting.
//
// The version asked for deliberately does not exist. npm answers from the packument
// and never fetches a tarball, `--dry-run` means nothing is written, and the whole
// probe costs about 350ms. `abbrev` is npm's own package and among the smallest on the
// registry; any package would do, and a small one keeps the probe cheap.
//
// Both of npm's other config layers are masked with empty files, and that is the load-
// bearing part rather than tidiness. This machine carries the same gate in `~/.npmrc`,
// so an unmasked run inherits it and passes while proving nothing about the repo -
// which is the whole question, since the contributor cloning this is the person the
// file exists for. Writing this check the second time reproduced that exact mistake in
// a throwaway probe: with the layers unmasked, the *no gate* arm came back carrying a
// cutoff date, because it was reading the user config. The positive twin below is what
// makes the date mean something, and it is asserted rather than assumed.
//
// Mutation convention, stated because the suite has two and `docs/proof-tools.md`
// records that the disagreement runs the dangerous way: this file follows
// `vendor-check`. A caught mutation is exit **0** with the assertion count printed,
// and exit **1** is NOT CAUGHT. Read the count, never the code.
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

let failed = 0;
const ok = (label, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const bail = (why, extra = '') => {
  console.log(`DID NOT RUN - ${why}, so nothing below was measured`);
  if (extra) console.log(`  ${extra.split('\n').slice(0, 3).join('\n  ')}`);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(2);
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
// it fails the refusal rows below with no cutoff and names no cause. This row is the
// cause, which is why it is above them.
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

/**
 * Make npm resolve under whatever gate `from` carries, and hand back what it said.
 *
 * A `package.json` is written beside the `.npmrc` because npm walks up out of a bare
 * directory looking for one and would otherwise resolve against whatever project
 * happens to be above the temp directory - **but only where there is not one already,
 * and that guard is the whole of this comment.** Unmutated, `from` is the repository
 * itself, and the first version of this function wrote unconditionally: it replaced
 * this project's own `package.json` with a five-field stub, which `git add -A` then
 * committed. It was caught by `syntax-check`'s canary rather than by anything here,
 * because `node --check` stops rejecting broken files once the manifest loses its
 * `type` - so a destructive check surfaced two tools away as a checker that had gone
 * blind. A probe must not write into the tree it is asking about.
 */
const PROBE = 'abbrev@99.99.99';
function resolveUnderGate(from) {
  const manifest = join(from, 'package.json');
  if (!existsSync(manifest)) {
    writeFileSync(manifest, '{"name":"release-gate-probe","version":"1.0.0","private":true}\n');
  }
  try {
    execFileSync('npm', ['install', PROBE, '--dry-run', '--no-audit', '--no-fund', ...MASK],
      { cwd: from, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return '';
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

// Three outcomes, and telling the second from the third is the whole of this block.
// A registry this cannot reach answers nothing about the gate, and "untested" is not
// "passed" - the same reading library-check and vendor-check take for a claim they
// could not put a machine behind. But npm rejecting the *value* is a finding rather
// than a missing measurement, and the first draft of this block bailed on both, which
// exited 2 with zero assertions on the one mutation this file most exists to catch.
const said = resolveUnderGate(cwd);
const valueRejected = /invalid config|Invalid time value/i.test(said);
if (!valueRejected && !/notarget|No matching version/i.test(said)) {
  bail('npm could not resolve against the registry, so its refusal could not be read',
    said.trim() || 'no output at all');
}

// The cutoff npm names in the refusal. Its presence is the gate being parsed and
// applied; its absence is the wrong-unit and no-gate cases, which are the two this
// file exists to tell apart.
const stamp = valueRejected ? null : said.match(/with a date before ([^\n]+?)\.?\s*$/m)?.[1]?.trim() ?? null;
const when = stamp ? new Date(stamp) : null;
const valid = when !== null && !Number.isNaN(when.getTime());
ok('npm refuses on it, naming the cutoff it derived - so the value is one npm turned into a real date rather than one it could not use',
  valid, stamp ?? (valueRejected
    ? `npm rejected the value outright: ${said.match(/npm (?:warn|error) [^\n]*/i)?.[0]?.trim() ?? 'invalid config'}`
    : 'no cutoff named in the refusal'));

const hours = valid ? (Date.now() - when.getTime()) / 3_600_000 : 0;
ok('and the cutoff is at least 48 hours back, which is the window a compromised release is most likely to be caught in',
  valid && hours >= 47.5, valid ? `${hours.toFixed(1)}h` : 'no cutoff');
// An upper bound as well, because a gate nobody can install through gets turned off
// rather than fixed, and a fat-fingered 2000 is as broken as a missing one.
ok('and not so far back that ordinary dependency work is impossible, which is how a gate gets deleted instead of corrected',
  valid && hours <= 24 * 400, valid ? `${(hours / 24).toFixed(1)} days` : 'no cutoff');

// The positive twin. Without it a cutoff proves only that *somewhere* on this machine a
// gate exists, which is true here and false on the machine that matters - and a probe
// written without this masking really did read one out of `~/.npmrc`.
const bare = join(scratch, 'bare');
mkdirSync(bare, { recursive: true });
const elsewhere = resolveUnderGate(bare);
if (!/notarget|No matching version/i.test(elsewhere)) {
  bail('the ungated control could not reach the registry either, so the row above is unattributable',
    elsewhere.trim() || 'no output at all');
}
ok('and a directory with no .npmrc draws no cutoff at all, so the one above came from the file under test',
  !/with a date before/i.test(elsewhere),
  elsewhere.match(/with a date before ([^\n]+?)\.?\s*$/m)?.[1]?.trim() ?? 'none named');

rmSync(scratch, { recursive: true, force: true });

console.log(`\n${failed} failed`);
if (MUTATE) {
  if (failed === 0) { console.log(`NOT CAUGHT - ${MUTATE} passed a check that exists to reject it`); process.exit(1); }
  console.log(`caught, as required (${failed} assertions fired)`);
  process.exit(0);
}
process.exit(failed ? 1 : 0);
