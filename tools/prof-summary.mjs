#!/usr/bin/env node
// Summarises `grabber --profile` output: one line per segment, plus the two
// numbers that decide whether the run is worth reading at all.
//
// Delivered fps is a health number, not a result. The loop idles 55% of every
// interval, so a run that does not sustain ~30.0 was competing for the machine
// and its per-segment timings are noise dressed up as a measurement. A threading
// A/B on this rig once came back at 22.75fps with registration p50 swinging
// 11.50/13.65/8.30ms across three rounds of one arm, which read as a wildly
// variable optimisation and was Spotlight indexing a corpus.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args[0];
const warmup = Number(args[1] ?? 60);
const json = args.includes('--json');

const rows = readFileSync(file, 'utf8')
  .split('\n')
  .filter((l) => l.startsWith('[prof] ') && !l.includes('arrival_us'))
  .map((l) => l.slice(7).split(',').map(Number));

const kept = rows.slice(warmup);
if (kept.length === 0) {
  console.error(`no rows left after discarding ${warmup} of ${rows.length} in ${file}`);
  process.exit(2);
}

const col = (i) => kept.map((r) => r[i]);
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const ms = (v) => v / 1000;
const f2 = (v) => v.toFixed(2);

const arr = col(1);
const gaps = arr.slice(1).map((v, i) => v - arr[i]);
const spanS = (arr[arr.length - 1] - arr[0]) / 1e6;
const fps = kept.length / spanS;

const NAMES = [['wait', 3], ['acq', 4], ['reg', 5], ['conv', 6], ['enc', 7], ['asm', 8], ['write', 9]];
const seg = {};
let serial = 0;
for (const [name, i] of NAMES) {
  const c = col(i);
  seg[name] = { p50: ms(pct(c, 50)), p90: ms(pct(c, 90)), p99: ms(pct(c, 99)) };
  if (name !== 'wait') serial += seg[name].p50;
}

if (json) {
  console.log(JSON.stringify({ file, frames: kept.length, warmup, windowS: spanS, fps, seg, serial }));
} else {
  console.log(`file        ${file.split('/').pop()}`);
  console.log(`frames      ${kept.length} kept (${rows.length} total, ${warmup} warmup discarded)`);
  console.log(`window      ${f2(spanS)}s`);
  console.log(`delivered   ${f2(fps)} fps${fps < 29.5 ? '   <-- BELOW 29.5, the machine was contended; do not read the segments below' : ''}`);
  console.log(`colour      ${col(2).filter(Boolean).length} frames carried a new colour image`);
  console.log(`gap         p50 ${f2(ms(pct(gaps, 50)))} ms   p90 ${f2(ms(pct(gaps, 90)))} ms   max ${f2(ms(Math.max(...gaps)))} ms`);
  console.log('');
  console.log('segment      p50        p90        p99');
  for (const [name] of NAMES) {
    const s = seg[name];
    console.log(`${name.padEnd(12)} ${f2(s.p50).padStart(6)} ms ${f2(s.p90).padStart(6)} ms ${f2(s.p99).padStart(6)} ms`);
  }
  console.log(`${'TOTAL serial'.padEnd(12)} ${f2(serial).padStart(6)} ms  (sum of per-segment p50)`);
}
