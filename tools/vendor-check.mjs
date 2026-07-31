#!/usr/bin/env node
// Proves that third_party/libfreenect2 is upstream v0.2.1 plus exactly the edits
// we have declared, using only files in this repo - no network, no clone, no
// GitHub still being there in a year. That is the whole point: the old recipe
// ran `git clone --depth 1` against a branch name, which pins nothing, and was
// correct only because upstream has not committed since 2020.
//
// The check is deliberately two-sided. An undeclared edit failing is obvious;
// the one that matters more is a *declared* edit that has quietly reverted,
// because that is what a careless re-vendor looks like, and it would ship a
// driver missing the sub-9 fix while every file still "matched upstream".
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, cpSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'third_party', 'libfreenect2.manifest');

// The authoritative list of what we changed. UPSTREAM.md explains why in prose;
// this is what the check enforces, so the two cannot drift into disagreeing
// about anything that matters.
//
// Each entry pins the blob hash our patched file must have, and the first
// version of this tool did not - it asserted only that the file *differed* from
// upstream. Mutation testing killed that: reverting the sub-9 condition from
// `& 0x1ff` back to `== 0x3ff` left the patch's comment behind, so the file
// still differed and the check still passed while the fix it exists to protect
// was gone. "Differs from upstream" is not "contains our change", and pinning
// the exact content is the difference between the two.
const DECLARED_EDITS = new Map([
  ['src/depth_packet_stream_parser.cpp', {
    why: 'accept depth frames missing only the unused 10th sub-image',
    ours: 'ab437103d6d73daa220fdc2d42971ef06b998804',
  }],
]);

// git's blob hash, computed here rather than by shelling out to git-hash-object
// 140 times - and it means the check does not need a git repo to run in.
const blobHash = (buf) =>
  createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

const walk = (dir, base = dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p));
  }
  return out;
};

function parseManifest() {
  const m = new Map();
  for (const line of readFileSync(MANIFEST, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [hash, ...rest] = line.split(/\s+/);
    m.set(rest.join(' '), hash);
  }
  return m;
}

// --- mutations ------------------------------------------------------------
// Each must make the check fail, and must fail on the assertion it is aimed at
// rather than on a crash. A mutation that changes nothing reads as a check that
// found nothing, so each one alters bytes the check demonstrably reads.
const MUTATIONS = {
  'undeclared-edit': (tree) => {
    const f = join(tree, 'src', 'registration.cpp');
    writeFileSync(f, readFileSync(f, 'utf8').replace('filter_width_half(2)', 'filter_width_half(3)'));
  },
  'revert-local-edit': (tree) => {
    const f = join(tree, 'src', 'depth_packet_stream_parser.cpp');
    const s = readFileSync(f, 'utf8');
    if (!s.includes('(current_subsequence_ & 0x1ff) == 0x1ff')) throw new Error('anchor missing');
    writeFileSync(f, s.replace('(current_subsequence_ & 0x1ff) == 0x1ff', 'current_subsequence_ == 0x3ff'));
  },
  'extra-file': (tree) => writeFileSync(join(tree, 'src', 'sneaky.cpp'), '// not upstream\n'),
  'missing-file': (tree) => rmSync(join(tree, 'src', 'registration.cpp')),
  // Not a mutation of the vendored tree but of the harness oracle beside it -
  // the failure where somebody "refreshes" the oracle from our own optimised
  // source and registration-check quietly starts comparing a build to itself.
  'oracle-drift': (_tree, oracle) => {
    const f = join(oracle, 'registration.cpp');
    const s = readFileSync(f, 'utf8');
    if (!s.includes('filter_width_half(2)')) throw new Error('anchor missing');
    writeFileSync(f, s.replace('filter_width_half(2)', 'filter_width_half(4)'));
  },
};

// --- run ------------------------------------------------------------------
const argv = process.argv.slice(2);
const mutation = argv.includes('--mutate') ? argv[argv.indexOf('--mutate') + 1] : null;
if (mutation && !MUTATIONS[mutation]) {
  console.error(`unknown mutation '${mutation}'; have: ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

// Mutations run against a throwaway copy so a falsification run can never leave
// the real vendored tree altered - a proof tool that damages its subject would
// make every later run untrustworthy.
let tree = join(ROOT, 'third_party', 'libfreenect2');
let oracleDir = join(ROOT, 'third_party', 'oracle');
let scratch = null;
if (mutation) {
  scratch = mkdtempSync(join(tmpdir(), 'vendor-check-'));
  cpSync(tree, join(scratch, 'libfreenect2'), { recursive: true });
  cpSync(oracleDir, join(scratch, 'oracle'), { recursive: true });
  tree = join(scratch, 'libfreenect2');
  oracleDir = join(scratch, 'oracle');
  MUTATIONS[mutation](tree, oracleDir);
}

let checked = 0;
let failed = 0;
const fail = (msg) => { failed++; console.log(`FAIL  ${msg}`); };

const manifest = parseManifest();
const onDisk = new Set(walk(tree));

// 1. every upstream file is present and hashes as upstream, unless declared.
const actuallyDiffer = new Set();
const ourHashes = new Map();
for (const [path, upstreamHash] of manifest) {
  checked++;
  if (!onDisk.has(path)) { fail(`missing from our tree: ${path}`); continue; }
  const ours = blobHash(readFileSync(join(tree, path)));
  ourHashes.set(path, ours);
  if (ours !== upstreamHash) actuallyDiffer.add(path);
}

// 2. the differing set is exactly the declared set - both directions.
for (const path of actuallyDiffer) {
  checked++;
  if (!DECLARED_EDITS.has(path)) fail(`undeclared change to ${path} (hash differs from upstream v0.2.1)`);
}
for (const [path, { why, ours }] of DECLARED_EDITS) {
  checked++;
  if (!actuallyDiffer.has(path)) {
    fail(`declared edit has reverted: ${path} now matches upstream, so "${why}" is NOT in this tree`);
    continue;
  }
  // The content pin. Differing from upstream only says somebody touched the
  // file; this says they left it in the exact state we reviewed.
  checked++;
  const got = ourHashes.get(path);
  if (got !== ours) {
    fail(`${path} is neither upstream nor our reviewed version (want ${ours}, got ${got}) - "${why}" may be altered or gone`);
  }
}

// 3. nothing extra crept in.
for (const path of onDisk) {
  checked++;
  if (!manifest.has(path)) fail(`not part of upstream v0.2.1: ${path}`);
}

// 4. the harness oracle is still upstream, byte for byte.
//
// third_party/oracle/registration.cpp is the reference registration-check
// measures our build against, so it has to be upstream's file and not a copy of
// whatever we most recently wrote. Once registration is optimised, our own
// src/registration.cpp stops matching upstream by design - and at that moment
// the only thing standing between "differential test" and "a build compared
// against itself" is this assertion.
for (const [oraclePath, upstreamOf] of [['registration.cpp', 'src/registration.cpp']]) {
  checked++;
  const want = manifest.get(upstreamOf);
  const full = join(oracleDir, oraclePath);
  let got = null;
  try { got = blobHash(readFileSync(full)); } catch { /* reported below */ }
  if (got === null) fail(`harness oracle missing: ${oraclePath}`);
  else if (got !== want) {
    fail(`harness oracle has drifted from upstream ${upstreamOf} (want ${want}, got ${got}) - registration-check would be comparing our build against itself`);
  }
}

if (scratch) rmSync(scratch, { recursive: true, force: true });

const label = mutation ? `mutation '${mutation}'` : 'vendored tree';
console.log(`\n${label}: ${checked} assertions, ${failed} failed`);
if (mutation) {
  // Exit code alone cannot distinguish "the mutation was caught" from "the tool
  // crashed before asserting anything", and this repo has been bitten by exactly
  // that. So a mutation run reports on the assertion count.
  if (failed === 0) { console.log('NOT CAUGHT - the check passed a tree it should have rejected'); process.exit(1); }
  console.log(`caught, as required (${failed} assertion${failed === 1 ? '' : 's'} fired)`);
  process.exit(0);
}
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
