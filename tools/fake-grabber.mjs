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
// The capture format's generation, read from where the band that reads it lives rather
// than copied. This file is a second producer of the record `native/grabber.cpp` writes,
// and a second producer with its own literal is the drift the number exists to catch -
// it would go on stamping last year's generation into every take the suite plants while
// the check reading them was updated.
import { CAPTURE_FORMAT } from '../web/format.js';

const argv = process.argv.slice(2);

// **One table of every argument this fixture knows, and the only enumeration of them.**
// `--no-color` was dropped in silence for the whole life of this file, because `flag()`
// scanned argv for the names it happened to care about and nothing anywhere said an
// argument had gone unread. The server hands it over a two-hop chain - `--no-color` on a
// server's command line initialises `camera.color` false, and `buildArgs` appends
// `--no-color` to the grabber's argv from that - so eight servers were running in a
// colour-off configuration and being answered with full JPEGs under a hello declaring
// `"color":true`, which is a stream the real sensor cannot produce under the arguments it
// was given. The server treats the mirror image of that state, a hello claiming colour
// over a take carrying no JPEG, as corruption worth nulling a hello for.
//
// Whether an entry takes a following value lives here too, so `--pipeline gl` reads as an
// argument and its value rather than as a flag followed by an unknown token.
//
// `ignored` marks an argument this fixture reads and deliberately does nothing with, in
// the register of the `low-light` note on the stdin handler below: there is no device here
// to apply it to, and refusing it would make this fixture reject a spawn the server
// legitimately performs.
const ARGUMENTS = {
  '--source': { value: true },
  '--fps': { value: true },
  '--die-after': { value: true },
  '--burst': { value: true },
  '--frames': { value: true },
  '--tag': { value: true },
  '--emit-log': { value: true },
  '--hd': { value: false },
  // The two the server appends out of `camera`, and the reason this table exists.
  '--no-color': { value: false },
  '--no-low-light': { value: false },
  // `buildArgs` appends this whenever the server was given a pipeline, so it arrives on a
  // perfectly legitimate spawn. There is no depth processor here to pick.
  '--pipeline': { value: true, ignored: true },
  // These four reach a real grabber only through the operator's own `--grabber` string,
  // which for this fixture is always this fixture's own flags. They are named for that
  // reason and for no other - not because anything here could honour them.
  '--log': { value: true, ignored: true },
  '--quality': { value: true, ignored: true },
  '--min-depth': { value: true, ignored: true },
  '--max-depth': { value: true, ignored: true },
};

// Both readers go through the table rather than beside it, so this file holds one list of
// arguments and a second one cannot drift out of step with it. A name absent from the
// table is a mistake in this file rather than in the argv, so it throws.
const argument = (name) => {
  if (!Object.hasOwn(ARGUMENTS, name)) throw new Error(`[fake-grabber] ${name} is read but missing from ARGUMENTS`);
  return ARGUMENTS[name];
};
const flag = (name, fallback = null) => {
  argument(name);
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const given = (name) => { argument(name); return argv.includes(name); };

// **Reported, never refused**, and that direction is the whole of the decision. `buildArgs`
// appends `--pipeline` on a server that was given one, so a fixture that rejected an
// argument it did not recognise would break a spawn the server is entitled to make; but an
// argument silently dropped is how the colour-off half of the live path stayed unreachable
// by every proof tool in this repo. So it says so and streams on.
//
// This closes the class rather than the instance: a third flag added to `buildArgs` next
// year is reported by existing, instead of being swallowed the way `--no-color` was. It is
// a report and not a driver - it proves this fixture noticed a flag, never that it acted on
// one, and the behavioural claims belong to the rows that watch the stream.
for (let i = 0; i < argv.length; i++) {
  const known = Object.hasOwn(ARGUMENTS, argv[i]) ? ARGUMENTS[argv[i]] : null;
  if (!known) {
    process.stderr.write(`[fake-grabber] ignoring ${argv[i]}, which this fixture does not know\n`);
    continue;
  }
  if (known.value) i++;
}

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
const HD = given('--hd');
// **The colour camera, which the server switches off at boot with `--no-color` and mid-shoot
// from the editor's checkbox.** A real grabber parses both of these off argv and reports both
// in its handshake, so a fixture that ignored them answered a colour-off configuration with a
// stream no sensor could have produced.
const COLOR = !given('--no-color');
const LOW_LIGHT = !given('--no-low-light');
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

// **Colour comes off the frames themselves, once, here.** A hello saying `"color":false`
// over payloads still carrying JPEGs would be the same lie one layer down, and it is the
// lie the viewer cannot detect: `handleFrame` only reaches `pumpColorDecode` when a frame
// declares `colorBytes > 0`, so the frames are what decide whether the colour path runs at
// all.
//
// Both edits are needed or nothing parses - `server/capture.js` refuses a frame whose two
// declared lengths do not describe it - so the count is zeroed *and* the bytes are dropped.
//
// **The depth stays real recorded sensor depth**, which is the whole value of this fixture:
// synthesising depth to make the flag easy would trade away the one property that makes a
// browser-driven suite worth running at all.
//
// After the HD build and before anything emits, in that order and no other. The build above
// reads the source's colour block and exits 1 when the first frame carries none, and
// `encode()` below has to read the truncated array.
if (!COLOR) {
  for (let i = 0; i < frames.length; i++) {
    const payload = frames[i];
    const depthBytes = payload.readUInt32LE(0);
    const trimmed = Buffer.from(payload.subarray(0, 16 + depthBytes));
    trimmed.writeUInt32LE(0, 4);
    frames[i] = trimmed;
  }
  process.stderr.write(`[fake-grabber] colour off: ${frames.length} frames carry depth only, `
    + `${frames[0].length} bytes each\n`);
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
      // Mirrors `requestHdColor`, which returns early whenever `camera.color` is false and
      // so never sends either command to a colour-off grabber. Refused here as well rather
      // than trusted, because type 3 is the *colour camera's* own picture and a colour-off
      // grabber has no colour camera to photograph with - a fixture that answered anyway
      // would be manufacturing the one thing this flag is supposed to remove. Both
      // directions, because the server gates both.
      if (!COLOR) {
        process.stderr.write('[fake-grabber] refusing hd colour: colour is off on this grabber\n');
        continue;
      }
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
//
// The format number is stamped for the same reason and in the same place. The sample
// this loops its depth out of predates both fields, so a hello copied through unedited
// would make every take the suite records generation zero - which is a real shape and
// the wrong one to write here, because a *writer* that declares nothing is exactly the
// second producer this repo's own README nearly taught somebody to build.
//
// The colour flags are stamped on the same principle and are the half of this that is
// easy to get backwards. **`lowLight` is the conjunction, not the negation of its own
// flag**: `native/grabber.cpp` reports `(wantColor && lowLight) ? "true" : "false"`, so a
// grabber given `--no-color` alone - which is exactly what the server produces, since
// `camera.lowLight` stays true and `--no-low-light` is therefore never appended - says
// `"lowLight":false`. A fixture that only watched for `--no-low-light` would still say
// `true`, reproducing this same defect one field over while looking fixed.
//
// **It is written only when something settles it**, because the sample's hello carries nine
// keys and `lowLight` is not among them: it predates the field the same way it predates
// `format`. Adding a further key to a colour-on hello would move every take's content hash -
// the key the library joins two machines on - across eight servers this change is not about,
// so the colour-on stream stays byte-identical to what the format stamp left it.
const lowLightSettled = !COLOR || !LOW_LIGHT || 'lowLight' in sourceHello;
const hello = Buffer.from(JSON.stringify({
  ...sourceHello,
  format: CAPTURE_FORMAT,
  ...(COLOR ? {} : { color: false }),
  ...(lowLightSettled ? { lowLight: COLOR && LOW_LIGHT && (sourceHello.lowLight ?? true) } : {}),
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
