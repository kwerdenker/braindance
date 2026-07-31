// The encoder end of an export: raw RGBA frames arrive over a WebSocket and go
// straight into ffmpeg's stdin.
//
// Raw is the whole point rather than a first draft. RGBA is exactly ffmpeg's
// `rawvideo` input format, so there is no encode step in the browser, no decode
// step here, and no generation loss before the codec runs. 1080p RGBA is 8.3MB a
// frame, which only looks alarming until you notice the browser and the encoder
// are always on the same machine: this is loopback, loopback sustains gigabytes a
// second, and compressing first would spend CPU - the scarce resource in a
// slower-than-realtime render - to save bandwidth that was never scarce. The
// socket is created with permessage-deflate off for the same reason, explicitly
// rather than by relying on the library's default.
//
// Flow control is an ack per frame against a small window. The browser can render
// faster than ffmpeg encodes on a cheap look, and without a window the frames
// would queue in this process's memory - eight megabytes at a time - behind a
// stdin that is not draining. The window is small because there is nothing to
// hide: a render is tens of milliseconds and a loopback round trip is tens of
// microseconds.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, stat, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';

// Absolute rather than resolved off PATH: this is the encoder the export was
// measured against, and a different one found on a different PATH would be a
// different result reported under the same name.
const FFMPEG = process.env.FFMPEG ?? '/opt/homebrew/bin/ffmpeg';

// How many frames may be in flight. Four absorbs a hitch in the encoder without
// letting this process hold more than about 33MB of 1080p frames.
//
// That ceiling is a courtesy the client extends rather than a property this server
// enforces, and the difference matters the day a second client exists. Nothing
// below counts unacked frames: a browser that ignored the window could send all
// `frames` messages as fast as the socket takes them, and they would queue here
// behind a stdin that is not draining. The bound holds today because the only
// client is this server's own page, which waits. Enforcing it would mean pausing
// the socket past the window - `ws` can do it - and that is a change to make when
// something other than the page connects, not a claim to make now.
const ACK_WINDOW = 4;

// 4K RGBA is 33MB, so the ceiling is set well above the largest frame anything
// is going to ask for and below "whatever arrives".
export const MAX_FRAME_BYTES = 96 * 1024 * 1024;

const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The encode a request asks for. Two, and they are a codec choice rather than two
 * paths: the frames, the flow control and the file that comes out are the same
 * either way.
 *
 * `lossless` exists because it is the only way to prove the file contains the
 * frames the browser rendered. ffv1 in rgb24 decodes back to exactly the bytes
 * that went in, so a round trip is a byte comparison rather than an argument
 * about how much codec loss is acceptable - which makes orientation, channel
 * order, frame order and frame count one assertion instead of four proxies.
 */
const CODECS = {
  h264: { ext: 'mp4', args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'] },
  lossless: { ext: 'mkv', args: ['-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'rgb24'] },
};

// Distinguishes one export's scratch file from another's within this process. The
// name never reaches the file's bytes - `-fflags +bitexact` is what makes that
// true, and the determinism claim, which runs two exports through two sockets and
// compares the finished files, is what keeps it true.
let sequence = 0;

function ffmpegArgs({ width, height, fps, codec, into }) {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    // Bit-exact on both sides of the muxer: without it the container carries the
    // encoder's version string and a creation time, so the same frames would
    // produce a different file every run and "the same export twice" could not be
    // asked about the file at all.
    '-fflags', '+bitexact',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', '-',
    // readPixels reads the drawing buffer bottom-up, which is upside down to every
    // video format. Flipping here rather than in the browser keeps the CPU cost on
    // the side of the pipe that is not also rendering.
    '-vf', 'vflip',
    ...CODECS[codec].args,
    '-flags:v', '+bitexact',
    '-r', String(fps),
    '-y', into,
  ];
}

/**
 * One export, from the begin message to the file.
 *
 * Everything is validated against what the browser said it would send rather than
 * accepted as it arrives. A frame of the wrong length is the failure this has to
 * catch loudly - ffmpeg's rawvideo demuxer would happily read a short frame as
 * the head of the next one and produce a file that plays, scrolls diagonally, and
 * says nothing about why.
 */
export function handleExportSocket(ws, { outDir, log = console.log }) {
  let job = null;
  let child = null;
  let received = 0;
  let bytes = 0;
  let ended = false;
  let finished = false;
  const frameHashes = [];
  const streamHash = createHash('sha256');
  const stderr = [];
  let queue = Promise.resolve();

  const send = (msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  const fail = async (message) => {
    if (finished) return;
    finished = true;
    log(`[export] ${message}`);
    send({ error: message });
    if (child && child.exitCode === null) child.kill('SIGKILL');
    // A killed encoder leaves a file that opens and is not a video, so it goes -
    // but the only file this run may remove is the scratch file it wrote itself.
    // Reaching for `job.output` here was a real bug with an ordinary path into it:
    // the export name defaults to the take's id, so "tweak the look and export
    // again" reuses it, and a second run that died after a frame deleted the good
    // file from the first while leaving that run's sidecar behind - a job record
    // asserting a successful export of a path with nothing at it. It did not need
    // the encode to fail either: an ffmpeg that never spawned took the same branch
    // and deleted a file this run had not written a byte of.
    if (job) await unlink(job.temp).catch(() => {});
    ws.close();
  };

  const begin = async (msg) => {
    const width = Math.trunc(msg.width);
    const height = Math.trunc(msg.height);
    const fps = Number(msg.fps);
    const frames = Math.trunc(msg.frames);
    const codec = msg.codec ?? 'h264';

    if (!CODECS[codec]) throw new Error(`unknown codec ${msg.codec}`);
    if (!VALID_NAME.test(String(msg.name ?? ''))) throw new Error(`bad export name ${JSON.stringify(msg.name)}`);
    if (!(width > 0 && height > 0)) throw new Error(`bad output size ${width}x${height}`);
    // yuv420p subsamples chroma by two each way, so an odd dimension is not
    // encodable and ffmpeg would refuse after the first frame had already been
    // sent - which reads to the browser as the pipe dying for no reason.
    if (codec === 'h264' && (width % 2 || height % 2)) {
      throw new Error(`h264 needs even dimensions, got ${width}x${height}`);
    }
    if (!(fps > 0)) throw new Error(`bad output rate ${msg.fps}`);
    if (!(frames > 0)) throw new Error(`an export of ${frames} frames has nothing to encode`);
    const frameBytes = width * height * 4;
    if (frameBytes > MAX_FRAME_BYTES) {
      throw new Error(`a ${width}x${height} frame is ${frameBytes} bytes, past the ${MAX_FRAME_BYTES} ceiling`);
    }

    await mkdir(outDir, { recursive: true });
    const ext = CODECS[codec].ext;
    const output = join(outDir, `${msg.name}.${ext}`);
    // The encoder writes beside the output and never onto it. `finish` renames the
    // scratch file into place once ffmpeg has exited 0, so an export either
    // replaces the previous one entirely or leaves it exactly as it was - and a
    // failed run has nothing to reach for, which is what makes the "do not delete
    // what you did not write" rule in `fail` structural rather than remembered.
    // The extension is carried into the scratch name because it is how ffmpeg
    // picks the muxer; naming it `.part` alone would make the command line depend
    // on an `-f` this file has never needed.
    const temp = join(outDir, `${msg.name}.${process.pid}-${++sequence}.part.${ext}`);
    job = {
      width, height, fps, frames, codec, frameBytes, output, temp, began: Date.now(),
      project: msg.project ?? null,
      capture: msg.capture ?? null,
      renderer: msg.renderer ?? null,
    };

    const args = ffmpegArgs({ width, height, fps, codec, into: temp });
    log(`[export] ${FFMPEG} ${args.join(' ')}`);
    child = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
    child.on('error', (err) => fail(`ffmpeg could not start: ${err.message}`));
    child.stdin.on('error', () => { /* reported through the exit code instead */ });
    child.on('exit', (code, signal) => {
      if (finished) return;
      // Before the end message means it died mid-encode, and the stderr it wrote
      // is the only useful thing anyone will get.
      if (!ended || code !== 0) {
        fail(`ffmpeg exited ${code ?? signal}${stderr.length ? `: ${stderr.join('').trim()}` : ''}`);
        return;
      }
      finish().catch((err) => fail(String(err.message ?? err)));
    });

    send({ ready: { output, codec, width, height, fps, frames, window: ACK_WINDOW } });
  };

  const frame = (data) => {
    if (!job) throw new Error('a frame arrived before the export was described');
    if (ended) throw new Error('a frame arrived after the export ended');
    if (data.length !== job.frameBytes) {
      throw new Error(
        `frame ${received} is ${data.length} bytes, not the ${job.frameBytes} a `
        + `${job.width}x${job.height} RGBA frame is`,
      );
    }
    if (received >= job.frames) {
      throw new Error(`more frames arrived than the ${job.frames} this export declared`);
    }
    received++;
    bytes += data.length;
    streamHash.update(data);
    // Per frame as well as over the stream, because "the exported frame is the
    // frame the editor showed" is a claim about one frame at one program time and
    // a rolling hash cannot answer it. Cheap next to the encode, and it is the
    // only view anything downstream has of what actually left the browser.
    frameHashes.push(createHash('sha256').update(data).digest('hex'));

    const n = received;
    // Serialised behind the previous write so backpressure is honoured in order:
    // an ack out of order would let the browser run past the window.
    queue = queue.then(() => new Promise((resolve, reject) => {
      if (finished) {
        resolve();
        return;
      }
      const ok = child.stdin.write(data, (err) => (err ? reject(err) : null));
      const done = () => {
        send({ ack: n });
        resolve();
      };
      if (ok) done();
      else child.stdin.once('drain', done);
    })).catch((err) => fail(`writing frame ${n} to ffmpeg failed: ${err.message}`));
  };

  const end = async () => {
    if (!job) throw new Error('an export ended before it was described');
    if (received !== job.frames) {
      throw new Error(`the export declared ${job.frames} frames and sent ${received}`);
    }
    ended = true;
    await queue;
    child.stdin.end();
  };

  const finish = async () => {
    if (finished) return;
    const st = await stat(job.temp);
    // The renderer class travels with the job from the very first one. There is a
    // single render machine today so the field constrains nothing - but a job
    // record without it cannot be retrofitted once old jobs exist, and provenance
    // is exactly what is wanted on the day two workers disagree about an image.
    const record = {
      project: job.project ?? null,
      capture: job.capture ?? null,
      renderer: job.renderer ?? null,
      output: job.output,
      width: job.width,
      height: job.height,
      fps: job.fps,
      frames: job.frames,
      codec: job.codec,
      created: new Date(job.began).toISOString(),
    };
    // The sidecar is written beside the scratch file and renamed with it, so the
    // record and the video it describes become one outcome. Written before
    // anything moves and renamed after the video, because the failure to leave
    // room for is a record that outlives the file it names: that is the shape the
    // old code shipped, where a dead run deleted the video and left the previous
    // run's job.json asserting a successful export of a path with nothing at it.
    // Both renames are within `outDir`, so each is atomic; the window between them
    // is two syscalls on the same directory and the video is the one that lands
    // first.
    await writeFile(`${job.temp}.job.json`, `${JSON.stringify(record, null, 2)}\n`);
    // Past this line nothing may remove the scratch file, because the next two
    // statements are what turn it into the output. Before it, a throw in the stat
    // or the write still reaches `fail`, which cleans the scratch file up and
    // tells the browser.
    finished = true;
    await rename(job.temp, job.output);
    await rename(`${job.temp}.job.json`, `${job.output}.job.json`);
    const elapsed = Date.now() - job.began;
    log(`[export] ${job.output} ${job.frames} frames ${(st.size / 1e6).toFixed(1)}MB in ${(elapsed / 1000).toFixed(1)}s`);
    send({
      done: {
        output: job.output,
        bytes: st.size,
        frames: received,
        rawBytes: bytes,
        elapsedMs: elapsed,
        streamHash: `sha256:${streamHash.digest('hex')}`,
        frameHashes,
      },
    });
    ws.close();
  };

  ws.on('message', (data, isBinary) => {
    const run = async () => {
      if (isBinary) {
        frame(data);
        return;
      }
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.begin) {
        if (job) throw new Error('this socket already has an export running');
        await begin(msg.begin);
      } else if (msg.end) {
        await end();
      } else {
        throw new Error(`unknown export message ${Object.keys(msg).join(',')}`);
      }
    };
    run().catch((err) => fail(String(err.message ?? err)));
  });

  ws.on('close', () => {
    if (finished) return;
    fail(`the browser closed the export socket after ${received} of ${job?.frames ?? '?'} frames`);
  });
  ws.on('error', (err) => fail(`export socket error: ${err.message}`));
}
