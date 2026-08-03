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

import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MessageParser, TYPE_HELLO, TYPE_FRAME, TYPE_COLOR, encodeMessage } from '../server/protocol.js';

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
// Where this writer records what it actually put on stdout: one line per message,
// `type length sha256-of-payload`.
//
// **It exists so the take can be checked against the writer rather than against the
// reader**, which is the distinction step 7 learned the hard way - a check that
// polls the library to find out what was recorded makes the library scan the take
// being written, and then measures an artifact its own question created. Nothing
// here observes the server at all; it is the emitter's own record of what left, and
// a take is correct exactly when its bytes are these bytes.
//
// This is what makes "a monitor never costs the take fidelity" an identity rather
// than an assurance: with a viewer attached at a divisor, a recorder handed the
// decimated buffer produces frames whose payload hashes are simply not in this file.
const EMIT_LOG = flag('--emit-log', '');
// Whether this writer can produce type 3, the native-resolution colour the webcam
// output reads. Off by default so nothing that already drives this file starts
// needing ffmpeg; `vcam-check` is the only caller that asks for it.
//
// **The synthesised HD frame is the registered one upscaled, plus a marker in the
// outer margin, and both halves of that are the point.** The webcam's whole claim is
// that it serves the colour camera rather than the registered image the point cloud
// is textured with, and the two are hard to tell apart by eye: same scene, same
// moment, different projection. So the discriminator has to be geometric. The colour
// camera sees 84.1 degrees where the registered frustum sees 70.6, which means a real
// colour frame carries scene content down the sides that no upscale of the registered
// image can invent. This fixture plants exactly that: everything inside the middle is
// the upscale, so an implementation that cheats by scaling type 2 matches almost the
// whole picture and still cannot produce the margin. `vcam-check` asserts the margin
// and nothing but the margin, and `--mutate hd-upscales-registered` is the arm that
// has to fail on it.
const HD = argv.includes('--hd');
// Where the marker lives, as a fraction of width taken off each side. 0.12 is wide
// enough to survive 4:2:0 chroma subsampling and JPEG ringing at the boundary, and
// narrow enough that the middle is still most of the picture.
const HD_MARGIN = 0.12;

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

// Built once at startup rather than per frame: this is a fixture standing in for a
// sensor, and re-encoding 1080p thirty times a second would make the fixture the
// thing under measurement. The real grabber does encode per frame, on its own thread,
// and `grabber --profile` is where that cost is read.
let hdFrame = null;
if (HD) {
  const first = frames[0];
  const depthBytes = first.readUInt32LE(0);
  const colorBytes = first.readUInt32LE(4);
  if (!colorBytes) {
    process.stderr.write(`[fake-grabber] ${SOURCE} carries no colour, so there is no HD frame to build from\n`);
    process.exit(1);
  }
  const registered = first.subarray(16 + depthBytes, 16 + depthBytes + colorBytes);
  const margin = Math.round(1920 * HD_MARGIN);
  try {
    hdFrame = execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', 'pipe:0',
      '-vf', `scale=1920:1080,`
        + `drawbox=x=0:y=0:w=${margin}:h=1080:color=magenta@1.0:t=fill,`
        + `drawbox=x=${1920 - margin}:y=0:w=${margin}:h=1080:color=cyan@1.0:t=fill`,
      '-frames:v', '1', '-q:v', '3', '-f', 'mjpeg', 'pipe:1',
    ], { input: registered, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    process.stderr.write(`[fake-grabber] cannot build the HD fixture frame: ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`[fake-grabber] HD fixture ready: ${hdFrame.length} bytes, `
    + `${margin}px magenta left margin and cyan right\n`);
}
// Off until asked, exactly as the real grabber is, so a check that never sends the
// command sees no type 3 - which is what makes "it is emitted only on request" a
// thing the fixture can be wrong about rather than a claim in a comment.
let hdOn = false;

// One command per line on stdin, the real grabber's channel and the real grabber's
// vocabulary. `low-light` is accepted and ignored because there is no device here to
// apply it to, and refusing it would make this fixture reject a command the server
// legitimately sends.
let stdinPending = '';
process.stdin.on('data', (chunk) => {
  stdinPending += chunk.toString('utf8');
  let nl;
  while ((nl = stdinPending.indexOf('\n')) !== -1) {
    const line = stdinPending.slice(0, nl).replace(/\r$/, '');
    stdinPending = stdinPending.slice(nl + 1);
    if (line === 'hd-color on' || line === 'hd-color off') {
      if (!HD) {
        process.stderr.write('[fake-grabber] refusing hd colour: started without --hd\n');
        continue;
      }
      hdOn = line === 'hd-color on';
      process.stderr.write(`[fake-grabber] hd colour ${hdOn ? 'on' : 'off'}\n`);
    }
  }
});
process.stdin.resume();

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

// Appended synchronously and before the bytes go out, so a writer killed mid-take
// has logged everything the reader could possibly have received and never less. The
// other order would let a frame reach the recorder that this file does not vouch
// for, and the check reading it would report a take carrying a frame nobody emitted.
// The fourth column is the hash of the *body* a reader downstream receives, which for
// a colour message is the JPEG without the stamp in front of it. It exists because the
// payload hash cannot serve that purpose: the stamp moves per frame, so a check
// comparing what the webcam served against what this file logged would never find a
// match and had been hashing served parts against each other instead - an assertion
// whose two sides came out of the same object, true whenever a part arrived at all.
//
// Passed in by the caller rather than sliced out of `payload` here, because the wire
// layout belongs at the call site: `note` would otherwise have to know that type 3
// puts a u64 before its JPEG and type 2 does not. Callers with no separate body write
// a `-`, which has no space in it, so both readers' positional destructuring holds.
const note = (type, payload, body = null) => {
  if (!EMIT_LOG) return;
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  appendFileSync(EMIT_LOG, `${type} ${payload.length} ${sha(payload)} ${body ? sha(body) : '-'}\n`);
};

const encode = () => {
  const payload = Buffer.from(frames[n % frames.length]);
  // Only the u64 at payload offset 8 moves - the same edit `make-fixture` performs -
  // so the depth and the JPEG are real bytes off a real sensor.
  payload.writeBigUInt64LE(BigInt(origin + Math.round((n * 1000) / FPS)), 8);
  n++;
  note(TYPE_FRAME, payload);
  return encodeMessage(TYPE_FRAME, payload);
};

// Type 3 rides the same tick as the frame rather than a clock of its own. A real
// sensor's colour camera runs at its own rate - 30 healthy, 15 in dim light - and
// nothing downstream may assume the two are locked, but a fixture that drifted them
// apart would be simulating a sensor rather than framing bytes, which is the line
// this file has always drawn.
const encodeHd = () => {
  const payload = Buffer.alloc(8 + hdFrame.length);
  payload.writeBigUInt64LE(BigInt(origin + Math.round((n * 1000) / FPS)), 0);
  hdFrame.copy(payload, 8);
  // The JPEG on its own as well as the payload, because the JPEG is what the webcam
  // hands a subscriber and so the only thing the two ends can be compared on.
  note(TYPE_COLOR, payload, hdFrame);
  return encodeMessage(TYPE_COLOR, payload);
};

const emit = () => {
  // The frame first, so a reader that stops at the first message still sees the
  // stream the recorder is about.
  const parts = [encode()];
  if (hdOn && hdFrame) parts.push(encodeHd());
  process.stdout.write(parts.length === 1 ? parts[0] : Buffer.concat(parts));
};

// The hello and the burst leave in **one write**, so they arrive in one chunk and
// the reader's parser hands them to the recorder inside a single turn. Written
// separately they cross a pipe boundary, the reader gets a `data` event carrying the
// hello and at most a fragment of the first frame, and a recorder that opened its
// file a turn late would look correct for a reason that has nothing to do with its
// ordering. This is what makes the property measurable rather than incidental.
note(TYPE_HELLO, hello);
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
