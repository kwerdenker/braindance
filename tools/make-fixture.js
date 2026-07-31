// Builds an arbitrarily long .knct fixture out of a short real capture.
//
// The repo's only capture is 284 frames — about 9.4 seconds — which proves a
// renderer but cannot prove anything the index and the frame API exist for. The
// spec sizes those against a five-minute take (4.4GB at the measured 14.6 MB/s),
// so a fixture of that order has to come from somewhere, and synthesising depth
// planes would test the reader against data no sensor ever produced.
//
// So the sample is looped. Every frame carries real depth and a real JPEG; only
// the timestamps are rewritten, advancing monotonically across the seam by the
// median gap so the loop point is not a discontinuity the index would trip on.
//
//   node tools/make-fixture.js <source.knct> <out.knct> [--loops 32]
//   node tools/make-fixture.js <source.knct> <out.knct> [--minutes 5]

import { createWriteStream, openSync, readSync, closeSync, statSync } from 'node:fs';
import { MessageParser, encodeMessage, TYPE_HELLO, TYPE_FRAME } from '../server/protocol.js';

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const [SRC, OUT] = positional;
if (!SRC || !OUT) {
  console.error('usage: make-fixture.js <source.knct> <out.knct> [--loops N | --minutes M]');
  process.exit(1);
}

// Read the source once into frame records. The source is small by construction —
// this tool exists precisely because the interesting file is the one it writes.
function readSource(path) {
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const n = readSync(fd, buf, off, Math.min(1 << 24, size - off), off);
    if (n <= 0) break;
    off += n;
  }
  closeSync(fd);

  const parser = new MessageParser();
  let hello = null;
  const frames = [];
  for (const msg of parser.push(buf)) {
    if (msg.type === TYPE_HELLO) hello ??= Buffer.from(msg.payload);
    else if (msg.type === TYPE_FRAME) frames.push(Buffer.from(msg.payload));
  }
  return { hello, frames };
}

const { hello, frames } = readSource(SRC);
if (!hello) throw new Error(`${SRC} has no hello message`);
if (frames.length === 0) throw new Error(`${SRC} has no frames`);

// Gaps come from the source's own stamps, so the fixture inherits the sensor's
// real arrival spacing rather than a uniform 33ms that never happens.
const stamps = frames.map((f) => Number(f.readBigUInt64LE(8)));
const gaps = stamps.slice(1).map((t, i) => t - stamps[i]).filter((g) => g > 0 && g < 2000);
const median = gaps.length ? gaps.slice().sort((a, b) => a - b)[gaps.length >> 1] : 33;
const loopMs = stamps[stamps.length - 1] - stamps[0] + median;

const minutes = flag('--minutes');
const loops = minutes
  ? Math.max(1, Math.ceil((Number(minutes) * 60_000) / loopMs))
  : Number(flag('--loops', '32'));

const out = createWriteStream(OUT);
const write = (chunk) => new Promise((resolve) => {
  if (out.write(chunk)) resolve();
  else out.once('drain', resolve);
});

await write(encodeMessage(TYPE_HELLO, hello));

// One scratch buffer per frame, rewritten in place: the payload is identical to
// the source apart from its u64 stamp at offset 8.
let written = 0;
let t = 0;
for (let loop = 0; loop < loops; loop++) {
  for (let i = 0; i < frames.length; i++) {
    const payload = frames[i];
    const gap = i === 0 ? (loop === 0 ? 0 : median) : stamps[i] - stamps[i - 1];
    t += Math.max(0, gap);
    payload.writeBigUInt64LE(BigInt(t), 8);
    await write(encodeMessage(TYPE_FRAME, payload));
    written++;
  }
}

await new Promise((resolve) => out.end(resolve));

const size = statSync(OUT).size;
console.log(
  `[fixture] ${written} frames, ${(size / 1e9).toFixed(2)} GB, ` +
  `${(t / 1000).toFixed(1)}s of source time (${loops} loops of ${frames.length}, median gap ${median}ms)`,
);
