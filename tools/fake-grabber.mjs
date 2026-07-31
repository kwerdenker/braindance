#!/usr/bin/env node
// A grabber with no Kinect behind it: real KNCT framing, real sensor depth read
// out of a capture, on stdout, at a cadence this file controls.
//
// It exists because the half of step 7 that touches footage had nothing exercising
// it. Takes-as-files, the restart-splits-the-take rule, the refusal to append to an
// existing file, the one-hello-per-take invariant and the mark button are all
// behaviours of the *writer*, and the writer only runs when something is streaming
// into it. The Kinect is on the capture node and this machine has none, so the
// alternative to this file is a step whose footage path is argued for rather than
// measured.
//
// What it is faithful about is what the recorder can tell apart: the framing, the
// hello at the head with a wall clock in it, monotonic timestamps, and depth
// payloads of exactly the length a frame declares. It is not a sensor simulator -
// the depth is looped out of a capture and the cadence is a flag.
//
//   tools/fake-grabber.mjs --source captures/sample.knct --fps 60 --frames 40
//   tools/fake-grabber.mjs --die-after 12      # exits, so the server respawns it

import { readFileSync } from 'node:fs';
import { MessageParser, TYPE_HELLO, TYPE_FRAME, encodeMessage } from '../server/protocol.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const SOURCE = flag('--source', 'captures/sample.knct');
const FPS = Number(flag('--fps', '60'));
// How many frames before this process exits of its own accord. The server treats a
// grabber that died as an expected condition and respawns it, which is exactly the
// path the restart-splits-the-take rule lives on - so the way to exercise that rule
// is to have the writer really go away.
const DIE_AFTER = Number(flag('--die-after', '0'));
// Frames written back to back immediately behind the hello, before the cadence
// starts. This is what makes "no frame is lost between the hello and the first
// recorded frame" observable at all: spaced by a timer, every frame is its own turn
// of the event loop and a recorder that opened its file one turn late would still
// catch all but the first - so the property would hold by accident of timing rather
// than by construction. A burst is also what a real device does on connect.
const BURST = Number(flag('--burst', '0'));
const FRAMES = Number(flag('--frames', '0'));
// A distinguishing number in the hello, so a check can tell one spawn's take from
// the next one's rather than assuming the file boundary fell where it meant it to.
const TAG = flag('--tag', '');

const parser = new MessageParser();
const frames = [];
let sourceHello = null;
for (const msg of parser.push(readFileSync(SOURCE))) {
  if (msg.type === TYPE_HELLO) sourceHello ??= JSON.parse(msg.payload.toString('utf8'));
  else if (msg.type === TYPE_FRAME) frames.push(Buffer.from(msg.payload));
}
if (!sourceHello || frames.length === 0) {
  process.stderr.write(`[fake-grabber] ${SOURCE} carries no hello or no frames\n`);
  process.exit(1);
}

// The wall clock goes in the hello and nowhere else, the same as the real grabber:
// every frame stamp below is a monotonic clock, which is right for frame spacing and
// useless for sorting a library.
const hello = Buffer.from(JSON.stringify({
  ...sourceHello,
  startedAt: Date.now(),
  ...(TAG ? { tag: TAG } : {}),
}));
// The reader can go away first - the server is killed, or it restarts this writer
// while a frame is in the pipe - and an unhandled EPIPE on stdout would exit with a
// stack trace that reads as the grabber having failed. A real grabber sees the same
// thing and it is not an error.
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); });
// Monotonic and strictly ascending, because the index, the retime curve and `mixT`
// all rest on it. Started from the process clock rather than from zero so two takes
// recorded in one session do not both begin at the same stamp.
const origin = Math.round(performance.now());
let n = 0;
process.stderr.write(`[fake-grabber] streaming ${frames.length} looped frames at ${FPS}fps${TAG ? ` tag=${TAG}` : ''}\n`);

const encode = () => {
  const payload = Buffer.from(frames[n % frames.length]);
  // Only the u64 at payload offset 8 moves - the same edit `make-fixture` performs -
  // so the depth and the JPEG are real bytes off a real sensor.
  payload.writeBigUInt64LE(BigInt(origin + Math.round((n * 1000) / FPS)), 8);
  n++;
  return encodeMessage(TYPE_FRAME, payload);
};

const emit = () => process.stdout.write(encode());

// The hello and the burst leave in **one write**, so they arrive in one chunk and
// the reader's parser hands them to the recorder inside a single turn. Written
// separately they cross a pipe boundary, the reader gets a `data` event carrying the
// hello and at most a fragment of the first frame, and a recorder that opened its
// file a turn late would look correct for a reason that has nothing to do with its
// ordering. This is what makes the property measurable rather than incidental.
const opening = [encodeMessage(TYPE_HELLO, hello)];
for (let i = 0; i < BURST; i++) opening.push(encode());
process.stdout.write(Buffer.concat(opening));

const tick = () => {
  emit();

  if (DIE_AFTER > 0 && n >= DIE_AFTER) {
    process.stderr.write(`[fake-grabber] exiting after ${n} frames\n`);
    // Flushed before exiting, or the last messages die in the pipe and the take
    // this was meant to end cleanly ends mid-frame instead - which would have the
    // check measuring a truncation it did not ask for.
    process.stdout.write('', () => process.exit(0));
    return;
  }
  if (FRAMES > 0 && n >= FRAMES) return;
  setTimeout(tick, 1000 / FPS);
};

if (DIE_AFTER > 0 && n >= DIE_AFTER) {
  process.stderr.write(`[fake-grabber] exiting after ${n} frames\n`);
  process.stdout.write('', () => process.exit(0));
} else if (!(FRAMES > 0 && n >= FRAMES)) {
  setTimeout(tick, 1000 / FPS);
}
process.on('SIGTERM', () => process.exit(0));
