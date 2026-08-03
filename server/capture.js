// Random access into a .knct capture: a sidecar index built by one streaming
// scan, and a reader that preads the frames a playhead actually asks for.
//
// Every read in here is incremental, and that is the point of the module rather
// than a detail of it. `fs.readFileSync` refuses any file of 2 GiB or more with
// ERR_FS_FILE_TOO_LARGE - bracketed exactly on Node v26.0.0, where 2,147,483,647
// bytes reads and 2,147,483,648 throws - so at the measured 14.6 MB/s no take
// longer than about two and a half minutes could be opened that way at all.
// Hashing a capture by reading it whole would put that identical throw back
// inside the code written to escape it, so the scan feeds the hash chunk by chunk
// and never holds a payload, and a frame run streams its slice rather than
// buffering it.
//
// The index is a sidecar rather than a footer so the capture stays append-only
// and a writer that died mid-take is still usable: the scan indexes every whole
// message that landed and reports the trailing partial one, instead of refusing
// the file over bytes nobody needs.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { basename, resolve } from 'node:path';
import { MAGIC, HEADER_BYTES, TYPE_HELLO, TYPE_FRAME, MAX_PAYLOAD_BYTES } from './protocol.js';
// The depth grid every frame in this format carries, and the only reason it is
// named on the server at all: the decimation below has to know the shape of the
// array it is sampling down, and a divisor applied to a flat byte count would
// take every k-th sample along one axis and none along the other. Checked against
// the frame's own declared length before anything is sampled, so a capture whose
// grid is not this one is refused rather than shredded.
//
// Imported rather than declared, and not re-exported: nothing outside this file
// reached for the pair even while it was exported, so the `export ... from` that
// `server/library.js` needs for `VALID_ID` - where the constant is both imported and
// passed on, because `export ... from` puts nothing in local scope - would be a door
// nobody uses. A second grabber or a different device changes `web/format.js` and
// `native/grabber.cpp`, and nothing in between.
import { DEPTH_H, DEPTH_W } from '../web/format.js';

export const INDEX_VERSION = 2;

// Large enough that neither sha256 nor the filesystem is paying per-call
// overhead, small enough that the scan's working set does not track file size.
const SCAN_CHUNK = 4 * 1024 * 1024;


// What a frame run is read in. Bounded on purpose: a run can be the whole take,
// and the point of this module is that no read is ever the size of the file.
const RUN_CHUNK = 1024 * 1024;

// The framing header plus the u32 depth length, u32 colour length and u64
// timestamp that open every frame payload (`web/main.js:844-847`). Assembling
// exactly this much per message is what lets the scan record a timestamp without
// ever holding the payload it came from.
const STAMP_BYTES = 16;
const PREFIX_BYTES = HEADER_BYTES + STAMP_BYTES;

/**
 * One frame's payload sampled down by a depth divisor, or the payload itself at a
 * divisor of 1.
 *
 * Decimation is a **network** concession and never a compute one, which is why it
 * lives here rather than in any one consumer: the monitor asks for it because a
 * radio link cannot carry 14.6 MB/s, the editor asks for it when the take is on the
 * other end of that link, the gallery asks for it to skim a take that has not been
 * downloaded, and the live socket asks for it because a full-rate monitor costs the
 * take frames. One mechanism, four callers.
 *
 * **The fourth caller is why this is a function and not a method.** The first three
 * hold a `Capture` - a file on disk with an index over it - and the socket holds a
 * buffer that has not been written yet. Reaching for a `Capture` there was never
 * possible, so the alternative to this was a second copy of the loop on the live
 * path, drifting from this one about what a `÷4` frame is until a monitor and a
 * gallery tile disagreed about the same take.
 *
 * What comes back is still a KNCT frame - same sixteen-byte payload header, same
 * field offsets, same decoder - carrying a `ceil(DEPTH_W/k) x ceil(DEPTH_H/k)` grid
 * sampled nearest-neighbour. **The colour block is copied through untouched**, and
 * that is deliberate rather than an omission: at a divisor of 4 the depth falls from
 * 424KB to 27KB while the JPEG stays at about 52KB, so colour is what a decimated
 * frame mostly is, and a version that dropped it would be a different mechanism
 * wearing this one's measured numbers.
 *
 * **What goes to disk is unaffected, and on the live path that is a property rather
 * than an observation.** The recorder is handed the grabber's own framed bytes
 * before this is ever called, so no divisor any monitor asks for can reach the
 * take - which is the `nearClip` versus `--min-depth` failure by another name, and
 * the one this design cannot afford, since it destroys footage in the situation
 * where nobody is watching for it. `monitor-check` asserts the identity rather than
 * trusting this paragraph.
 *
 * `what` names the frame in a refusal, because the two callers identify frames
 * differently - by index in a take, or as whatever just arrived on the wire.
 */
export function decimatePayload(payload, depthDivisor, what = 'frame') {
  const k = Math.trunc(depthDivisor);
  if (!(k > 1)) return payload;

  const depthBytes = payload.readUInt32LE(0);
  const colorBytes = payload.readUInt32LE(4);
  // The frame's own two lengths have to add up to the frame. Only the depth length
  // was checked, so a colour length that overstated the payload sized `out` larger
  // than the copy that follows fills it - and `allocUnsafe` hands back whatever was
  // in that memory, so the tail of the served frame was this process's own recycled
  // heap. Checked here rather than in the scan because this is the path that builds a
  // new buffer from the two numbers; at divisor 1 the payload is returned exactly as
  // it arrived, which is what the format promises.
  if (16 + depthBytes + colorBytes !== payload.length) {
    throw new Error(
      `${what} declares ${depthBytes} depth and ${colorBytes} colour bytes, which is not the `
      + `${payload.length - 16} it carries: refusing rather than sampling past the frame`,
    );
  }
  if (depthBytes !== DEPTH_W * DEPTH_H * 2) {
    throw new Error(
      `${what} carries ${depthBytes} depth bytes, not the ${DEPTH_W}x${DEPTH_H} grid `
      + 'this divisor samples: refusing rather than sampling a shape nobody declared',
    );
  }
  const w = Math.ceil(DEPTH_W / k);
  const h = Math.ceil(DEPTH_H / k);
  const out = Buffer.allocUnsafe(16 + w * h * 2 + colorBytes);
  out.writeUInt32LE(w * h * 2, 0);
  out.writeUInt32LE(colorBytes, 4);
  // The capture timestamp, verbatim. A decimated frame is the same moment as the
  // frame it came from, and a stamp rewritten here would put a second timeline into a
  // format that has one.
  payload.copy(out, 8, 8, 16);
  for (let y = 0; y < h; y++) {
    const src = 16 + y * k * DEPTH_W * 2;
    const dst = 16 + y * w * 2;
    for (let x = 0; x < w; x++) out.writeUInt16LE(payload.readUInt16LE(src + x * k * 2), dst + x * 2);
  }
  payload.copy(out, 16 + w * h * 2, 16 + depthBytes);
  return out;
}

/** `captures/take3.knct` → `captures/take3.idx`, beside the take it describes. */
export const indexPathFor = (capturePath) => `${capturePath.replace(/\.knct$/i, '')}.idx`;

/** The name a capture is addressed by over HTTP: its file name, no extension. */
export const captureIdFor = (capturePath) => basename(capturePath).replace(/\.knct$/i, '');

/**
 * One sequential pass that produces the index and the content hash together.
 * Doing them separately would mean reading multiple gigabytes twice for a result
 * one read already has in hand.
 */
export async function buildIndex(capturePath) {
  // Stamped before the read rather than after it. If the capture is written to
  // while the scan is walking it, a pre-scan mtime is the one that no longer
  // matches on the next load, so the stale index rebuilds instead of being
  // trusted; an after-scan stamp would certify exactly the race it missed.
  const before = await stat(capturePath);
  const hash = createHash('sha256');
  const offset = [];
  const stampMs = [];
  const length = [];
  let hello = null;

  const prefix = Buffer.alloc(PREFIX_BYTES);
  let filled = 0; // bytes of `prefix` assembled for the message in hand
  let need = HEADER_BYTES; // grows to take in the stamp once the length is known
  let skip = 0; // payload bytes still to walk past
  let pending = null; // the message whose payload is being walked
  let msgOffset = 0;
  let base = 0; // absolute offset of the chunk being walked

  // A message enters the index only once every one of its bytes has been read.
  // That ordering is what makes a take cut short mid-frame index cleanly - the
  // partial tail is simply never committed - rather than leaving a final entry
  // whose declared length runs off the end of the file.
  const commit = () => {
    const payloadOffset = msgOffset + HEADER_BYTES;
    if (pending.type === TYPE_HELLO) {
      // Only the first: a second hello means two takes were concatenated, which
      // the recorder's one-take-one-file rule exists to prevent.
      hello ??= { offset: payloadOffset, length: pending.len };
    } else if (pending.type === TYPE_FRAME) {
      offset.push(payloadOffset);
      length.push(pending.len);
      stampMs.push(Number(prefix.readBigUInt64LE(HEADER_BYTES + 8)));
    }
    pending = null;
    filled = 0;
    need = HEADER_BYTES;
  };

  for await (const chunk of createReadStream(capturePath, { highWaterMark: SCAN_CHUNK })) {
    hash.update(chunk);
    let i = 0;
    while (i < chunk.length) {
      if (skip > 0) {
        const n = Math.min(skip, chunk.length - i);
        i += n;
        skip -= n;
        if (skip === 0) commit();
        continue;
      }

      if (filled === 0) msgOffset = base + i;
      // A header, or the stamp behind it, can land either side of a chunk
      // boundary, so `prefix` carries the split ones across.
      const n = Math.min(need - filled, chunk.length - i);
      chunk.copy(prefix, filled, i, i + n);
      filled += n;
      i += n;
      if (filled < need) continue;

      if (need === HEADER_BYTES) {
        const magic = prefix.readUInt32LE(0);
        if (magic !== MAGIC) {
          throw new Error(
            `stream desync at ${msgOffset}: expected magic KNCT, got 0x${magic.toString(16)}`,
          );
        }
        const type = prefix.readUInt32LE(4);
        const len = prefix.readUInt32LE(8);
        // The same ceiling the live parser holds, applied to a file. The scan itself
        // only walks past a payload so a huge length costs it nothing here - what it
        // costs is later, because this number is written into the sidecar and every
        // read of that frame allocates a buffer of it. A capture whose framing has
        // gone is better refused at the scan, where the message names an offset, than
        // turned into an index that describes bytes the file does not contain.
        if (len > MAX_PAYLOAD_BYTES) {
          throw new Error(
            `message at ${msgOffset} declares ${len} payload bytes, past the ${MAX_PAYLOAD_BYTES} `
            + 'this format allows: the stream is desynced rather than carrying a large frame',
          );
        }
        // A frame carries its own lengths and stamp in its first sixteen bytes,
        // so one shorter than that is malformed rather than merely small, and
        // indexing it would put a fabricated zero timestamp into the pacing.
        if (type === TYPE_FRAME && len < STAMP_BYTES) {
          throw new Error(`frame at ${msgOffset} is ${len} bytes, too short to carry its header`);
        }
        pending = { type, len };
        need = HEADER_BYTES + Math.min(len, STAMP_BYTES);
        if (filled < need) continue;
      }

      skip = pending.len - (filled - HEADER_BYTES);
      if (skip === 0) commit();
    }
    base += chunk.length;
  }

  const index = {
    version: INDEX_VERSION,
    capture: basename(capturePath),
    // The byte count the hash actually covers, and the modification time it
    // covered it at. Together they are the staleness check.
    bytes: base,
    mtimeMs: before.mtimeMs,
    hash: `sha256:${hash.digest('hex')}`,
    truncated: filled > 0 || skip > 0,
    hello,
    frames: { offset, stampMs, length },
  };

  const sidecar = indexPathFor(capturePath);
  try {
    // Written aside and renamed, so a crash partway through cannot leave a
    // sidecar that parses and lies about where the frames are.
    await writeFile(`${sidecar}.tmp`, JSON.stringify(index));
    await rename(`${sidecar}.tmp`, sidecar);
  } catch (err) {
    // A capture on read-only media is still perfectly readable; it just pays for
    // the scan again next time rather than failing to open at all.
    console.error(`[capture] could not write ${sidecar}: ${err.message}`);
  }
  return index;
}

/**
 * Whether a sidecar's numbers describe the file it sits beside, closely enough to
 * read from.
 *
 * The staleness test below says only that this sidecar was written for a file of
 * this size at this modification time. Everything in it then reaches `readAt`,
 * which allocates a buffer of the declared length and preads at the declared
 * offset - so a length nobody checked is a `Buffer.allocUnsafe` of whatever the
 * sidecar likes, and an offset nobody checked reads from wherever it likes. A
 * sidecar is an ordinary small file beside the take, rewritten by any scan and
 * writable by anything that can write the captures directory, which is a much
 * lower bar than producing a multi-gigabyte capture - so it is checked rather than
 * trusted for having the right size stamped in it.
 *
 * The bounds are the ones the scan itself enforces while building an index, which
 * is what makes this a check on the file rather than a second opinion about the
 * format: a payload fits the ceiling, a frame carries at least its own sixteen-byte
 * header, and each frame's bytes lie inside the capture and after the frame before
 * it. Failing any of them is treated exactly as a sidecar that is absent or not
 * JSON - the take is scanned again, which is slow and correct.
 */
function indexDescribes(cached, size) {
  const frames = cached?.frames;
  if (!frames || !Array.isArray(frames.offset) || !Array.isArray(frames.length) || !Array.isArray(frames.stampMs)) {
    return false;
  }
  if (frames.length.length !== frames.offset.length || frames.stampMs.length !== frames.offset.length) return false;
  // A payload begins after a header at the very least, ends inside the file, and is
  // no longer than the format allows.
  const spans = (offset, length, least) => Number.isSafeInteger(offset) && Number.isSafeInteger(length)
    && offset >= HEADER_BYTES && length >= least && length <= MAX_PAYLOAD_BYTES && offset + length <= size;
  if (cached.hello !== null && !spans(cached.hello?.offset, cached.hello?.length, 0)) return false;
  let after = 0;
  for (let i = 0; i < frames.offset.length; i++) {
    if (!spans(frames.offset[i], frames.length[i], STAMP_BYTES)) return false;
    // Ordered and non-overlapping, because that is what appending messages to a file
    // produces. Two entries pointing at one span is a sidecar describing some other
    // arrangement of bytes than the one the take has.
    if (frames.offset[i] < after) return false;
    if (!Number.isFinite(frames.stampMs[i])) return false;
    after = frames.offset[i] + frames.length[i];
  }
  return true;
}

/** The sidecar if it still describes this file, otherwise a fresh scan. */
export async function loadIndex(capturePath) {
  const st = await stat(capturePath);
  try {
    // The sidecar is three orders of magnitude smaller than the take - tens of
    // bytes per frame against half a megabyte - so this is the one read here
    // that can safely be a whole-file read.
    const cached = JSON.parse(await readFile(indexPathFor(capturePath), 'utf8'));
    // Byte length catches an appended or truncated capture, which invalidates
    // every offset past the change. Modification time has to sit beside it,
    // because a same-size substitution would otherwise be waved through to the
    // content hash - and the hash it would be waved through to is the stale one
    // in this very sidecar. Re-hashing gigabytes on project load is exactly what
    // the design refuses, so deferring here would defer to a lie, and the
    // gallery's reconciliation-by-hash would inherit it.
    if (cached.version === INDEX_VERSION && cached.bytes === st.size && cached.mtimeMs === st.mtimeMs) {
      // Size and modification time say this sidecar was written for this file. What
      // it *contains* is a separate question, and the offsets and lengths in it are
      // what every later read allocates and preads on - so they are checked before
      // the sidecar is accepted rather than when a frame is asked for, by which time
      // the number has already reached `allocUnsafe`.
      if (indexDescribes(cached, st.size)) return cached;
      console.error(`[capture] the sidecar for ${basename(capturePath)} does not describe it - scanning again`);
    }
  } catch {
    // Absent, unreadable or not JSON all mean the same thing: scan it again.
  }
  return buildIndex(capturePath);
}

/** An open capture: its index in memory, its bytes still on disk. */
export class Capture {
  constructor(path, index, handle) {
    this.path = path;
    this.index = index;
    this.handle = handle;
    // How many callers are mid-read on this handle. The eviction below only ever
    // closes a capture nobody is holding, because a descriptor closed underneath a
    // frame run would fail inside a stream whose errors nobody is positioned to
    // catch - which is the same reason the run reads off the retained handle in
    // the first place.
    this.leases = 0;
    this.usedAt = 0;
    // Set when this capture has been dropped from the map while a reader still holds
    // it. Nothing can reach it again, so the last lease to be released is the only
    // thing left that can close it - see `forgetCapture`.
    this.doomed = false;
  }

  get frameCount() {
    return this.index.frames.offset.length;
  }

  /**
   * Holds this capture open for the life of the process.
   *
   * The replay loop is the one reader that does not come and go: it opens a take
   * once and preads a frame out of it every few tens of milliseconds forever, with
   * nothing bracketing the read that a lease could hang off. Without this it is not
   * merely evictable, it is the *first* thing evicted - `leases` stays zero and
   * `usedAt` never moves, so it sorts to the front of the queue below - and a
   * library of twenty-five takes skimmed while a replay is running closes the
   * replay's own descriptor underneath it. The reads then fail into the tick's
   * catch, the viewer goes to `lost`, and the loop retries forever against a closed
   * handle with one line in the log.
   */
  retain() {
    this.leases++;
    this.usedAt = ++useClock;
    return this;
  }

  async readAt(position, bytes) {
    // The one allocation both readers reach, so the bound is asserted here as well
    // as where the numbers came from. The scan enforces the format's ceiling while
    // building an index and `indexDescribes` enforces it on a sidecar read back off
    // disk, and this is the line those two are protecting - a guard at the
    // allocation is the one that cannot be reached around by a third caller.
    if (!Number.isSafeInteger(position) || position < 0
      || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_PAYLOAD_BYTES) {
      throw new Error(
        `refusing to read ${bytes} bytes at ${position} in ${this.path}: that is not a span `
        + `a payload of at most ${MAX_PAYLOAD_BYTES} bytes can occupy`,
      );
    }
    const buf = Buffer.allocUnsafe(bytes);
    let got = 0;
    // A positioned read of a regular file normally returns everything asked for,
    // but nothing promises it, and a short read here would ship a frame with a
    // tail of whatever was in memory.
    while (got < bytes) {
      const { bytesRead } = await this.handle.read(buf, got, bytes - got, position + got);
      if (bytesRead === 0) throw new Error(`short read at ${position + got} in ${this.path}`);
      got += bytesRead;
    }
    return buf;
  }

  /** The hello payload, or null for a capture whose writer died before one. */
  readHello() {
    const h = this.index.hello;
    return h ? this.readAt(h.offset, h.length) : Promise.resolve(null);
  }

  /**
   * One frame's payload, byte for byte as the socket would have delivered it -
   * or, with a depth divisor above 1, the same frame sampled down.
   *
   * The sampling itself is `decimatePayload` below, which this shares with the live
   * socket rather than reimplementing: a stored frame and a frame still in flight
   * are the same sixteen bytes of header over the same grid, so two copies of this
   * loop would be two things to keep agreeing about what a `÷4` frame is.
   */
  async readFrame(n, depthDivisor = 1) {
    const { offset, length } = this.index.frames;
    const payload = await this.readAt(offset[n], length[n]);
    return decimatePayload(payload, depthDivisor, `frame ${n}`);
  }

  /**
   * The byte span of frames a..b as they sit in the file, framing included, with
   * an inclusive end for `createReadStream`. A run of bare payloads would have no
   * boundaries to parse back, and the KNCT headers that supply them are already
   * interleaved between the payloads - so the file's own slice is both the honest
   * answer and a single contiguous read.
   */
  frameRunSpan(a, b) {
    const { offset, length } = this.index.frames;
    return { start: offset[a] - HEADER_BYTES, end: offset[b] + length[b] - 1 };
  }

  /**
   * A run can be the whole take, so it streams in bounded chunks rather than
   * landing in memory. It reads off the same retained handle every other call
   * here uses, and that is the load-bearing part rather than an implementation
   * detail: reopening by path would answer from whatever file sits at that name
   * now, so a take deleted underneath a running server would fail inside a
   * stream whose errors nobody is positioned to catch, and a take re-recorded
   * under the same name would serve the new file's bytes at the old file's
   * offsets while `readFrame` still served the old ones. One handle, one answer.
   */
  createFrameRunStream(a, b) {
    const { start, end } = this.frameRunSpan(a, b);
    const { handle, path } = this;
    let pos = start;
    return new Readable({
      highWaterMark: RUN_CHUNK,
      read() {
        if (pos > end) {
          this.push(null);
          return;
        }
        const want = Math.min(RUN_CHUNK, end - pos + 1);
        const buf = Buffer.allocUnsafe(want);
        handle.read(buf, 0, want, pos).then(
          ({ bytesRead }) => {
            if (bytesRead === 0) {
              this.destroy(new Error(`short read at ${pos} in ${path}`));
              return;
            }
            pos += bytesRead;
            this.push(bytesRead === want ? buf : buf.subarray(0, bytesRead));
          },
          (err) => this.destroy(err),
        );
      },
    });
  }

  close() {
    return this.handle.close();
  }
}

const openCaptures = new Map();

/**
 * How many captures may hold a descriptor at once. This is the debt step 2 named
 * and left for the gallery, and the scarce resource is descriptors rather than
 * memory: an index is about twenty-five bytes a frame, but every open capture
 * holds one fd against a soft limit of 256, and a library skimming a directory of
 * takes touches every one of them. Unbounded, that is EMFILE followed by thrash.
 *
 * Deliberately far below the limit rather than near it, because this process also
 * holds the listener, every live socket, the replay handle and whatever ffmpeg is
 * doing. A capture reopened after eviction costs one `open` and a sidecar read
 * that the index cache below already answers.
 */
export const MAX_OPEN_CAPTURES = 24;

// The index without the descriptor. A manifest wants offsets, stamps and a hash
// for every take in a directory and wants to hold none of them open afterwards,
// so it comes through here rather than through `openCapture` - and the sidecar
// read `loadIndex` performs is itself short-lived, which is the whole property.
// Cached in process on the same staleness test the sidecar uses, so listing a
// directory twice does not stat and parse every take twice.
const indexCache = new Map();

// Scans in flight, keyed by path. The promise rather than the result, for the same
// reason `openCapture` memoises one: a take being written moves its size and its
// modification time continuously, so every request that reaches the staleness test
// above fails it, and the gallery on the node's own panel polls. Without this, each
// poll started its own full read plus sha256 of the same multi-gigabyte file, in
// parallel, against the disk the recorder is writing to.
const indexPending = new Map();

export async function cachedIndex(capturePath) {
  const path = resolve(capturePath);
  const st = await stat(path);
  const held = indexCache.get(path);
  if (held && held.bytes === st.size && held.mtimeMs === st.mtimeMs) return held;
  const running = indexPending.get(path);
  if (running) return running;
  const started = loadIndex(path);
  indexPending.set(path, started);
  started.then(
    (index) => {
      // Only if this scan is still the one in flight. `forgetCapture` clears the
      // entry when the file changes underneath, and a scan that finished after that
      // is describing bytes that are already gone - caching it would put the state
      // this whole module invalidates for straight back into the map.
      if (indexPending.get(path) === started) {
        indexCache.set(path, index);
        indexPending.delete(path);
      }
    },
    () => { if (indexPending.get(path) === started) indexPending.delete(path); },
  );
  return started;
}

/**
 * A take's hello, read and the descriptor closed again before this returns.
 *
 * A manifest wants the sensor record of every take in a directory, and routing
 * that through `openCapture` would leave one descriptor per take held for the
 * length of a listing - the exact shape of the EMFILE the cap above exists to
 * stop, arrived at from the other side. The hello is a few hundred bytes at an
 * offset the index already recorded, so three syscalls per take is the whole cost.
 */
export async function readHelloOnce(capturePath, index) {
  const h = index.hello;
  if (!h) return null;
  const handle = await open(resolve(capturePath), 'r');
  try {
    const buf = Buffer.allocUnsafe(h.length);
    let got = 0;
    while (got < h.length) {
      const { bytesRead } = await handle.read(buf, got, h.length - got, h.offset + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    try {
      return JSON.parse(buf.subarray(0, got).toString('utf8'));
    } catch {
      // A hello that is not JSON is a take from a writer this build does not know.
      // The gallery still lists it; it just has nothing to say about the sensor.
      return null;
    }
  } finally {
    await handle.close();
  }
}

/**
 * Drops a take's cached index, for a file this process just changed underneath.
 *
 * **The descriptor goes with it, whenever the last reader lets go.** This used to
 * close only when the lease count was already zero, and then drop the map entry
 * anyway - so a delete, a reclaim or a take closing while a gallery tile was mid-skim
 * left a `FileHandle` that nothing could reach and nothing would ever close.
 * `withCapture`'s `finally` only decremented. On Node 26 that is fatal rather than
 * untidy: a `FileHandle` collected unclosed throws `ERR_INVALID_STATE` from the
 * garbage collector, at the top level, where there is nothing to catch it - measured
 * on v26.0.0, process gone, taking the listener, every socket and whatever the
 * recorder's write stream still had buffered. The gallery leases per pointer move
 * and Delete is a button on the same tile, so the two are one gesture apart.
 */
export function forgetCapture(capturePath) {
  const path = resolve(capturePath);
  indexCache.delete(path);
  indexPending.delete(path);
  const pending = openCaptures.get(path);
  openCaptures.delete(path);
  pending?.then((capture) => {
    capture.doomed = true;
    if (capture.leases === 0) capture.close().catch(() => {});
  }, () => {});
}

/**
 * Opens a capture once and keeps it open until something else needs the
 * descriptor. The promise rather than the result is memoised, so two requests
 * arriving during a multi-gigabyte scan share it instead of starting a second one.
 *
 * Eviction is least-recently-used and only ever takes a capture with no lease
 * out - see `Capture.leases`. That means the map can exceed the cap while enough
 * requests are genuinely in flight, which is the honest behaviour: refusing to
 * open the file a request is asking for would trade EMFILE for a 500, and the
 * bound this exists to enforce is on descriptors left lying about rather than on
 * descriptors in use.
 */
export function openCapture(capturePath) {
  const path = resolve(capturePath);
  let pending = openCaptures.get(path);
  if (!pending) {
    pending = (async () => new Capture(path, await cachedIndex(path), await open(path, 'r')))();
    // A failure must not be remembered, or a capture that appears a moment later
    // would keep reporting the error from before it existed.
    pending.catch(() => openCaptures.delete(path));
    pending.then((capture) => {
      settledValue.set(pending, capture);
      // Swept again now this one has a descriptor, and that second pass is what
      // makes the cap hold at all. The pass below runs while this promise is still
      // unresolved, and an unresolved entry is not a candidate - so under concurrent
      // opens every pass looked at a map of promises, evicted nothing, and nothing
      // ever looked again once they landed. The bound then failed silently, which is
      // the worst way for a descriptor cap to fail: EMFILE arrives much later, in
      // whatever else was next to ask the kernel for a file.
      evictIdle();
    }, () => {});
    openCaptures.set(path, pending);
    evictIdle();
  }
  return pending;
}

function evictIdle() {
  if (openCaptures.size <= MAX_OPEN_CAPTURES) return;
  // Resolved entries only. A capture still opening has no descriptor yet and no
  // `usedAt` to rank by, and awaiting one here would make an eviction sweep wait
  // on the multi-gigabyte scan it is trying to make room for.
  //
  // And a `usedAt` of zero is a capture that has resolved but that nobody has
  // touched yet: `withCapture` takes its lease in the continuation *after* the one
  // this sweep now runs from, so for that moment a freshly opened capture has no
  // lease and the oldest `usedAt` there is - it would sort to the front of the queue
  // and be closed into the read it was opened for. It becomes a candidate the moment
  // something actually uses it.
  //
  // Which is a rule about callers as much as about this loop: a caller that opens a
  // capture and then neither leases it through `withCapture` nor `retain`s it holds a
  // descriptor for the life of the process, because nothing will ever move its
  // `usedAt` off zero. Both of today's callers do one or the other - every request
  // goes through `withCapture` and the replay retains - and a third that did neither
  // would be the leak this cap exists to prevent, arrived at from inside.
  const settled = [];
  for (const [path, pending] of openCaptures) {
    const capture = pendingValue(pending);
    if (capture && capture.leases === 0 && capture.usedAt > 0) settled.push([path, capture]);
  }
  settled.sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [path, capture] of settled) {
    if (openCaptures.size <= MAX_OPEN_CAPTURES) break;
    openCaptures.delete(path);
    capture.close().catch(() => {});
  }
}

// A promise's resolved value, or null if it has not settled. There is no way to
// ask a promise this, so the value is recorded on it as it resolves.
const settledValue = new WeakMap();
const pendingValue = (pending) => settledValue.get(pending) ?? null;

/**
 * Runs `fn` against an open capture with a lease held for exactly as long as it
 * takes. Every reader goes through here rather than calling `openCapture`
 * directly, because a lease released early is a descriptor closed under a read
 * and a lease never released is the unbounded map this replaced.
 */
export async function withCapture(capturePath, fn) {
  const capture = await openCapture(capturePath);
  capture.leases++;
  capture.usedAt = ++useClock;
  try {
    return await fn(capture);
  } finally {
    capture.leases--;
    // The last lease on a capture nobody can reach any more is what closes it. Not
    // an optimisation: an unclosed `FileHandle` is a process death on Node 26 - see
    // `forgetCapture` for the measurement - and this is the only place left holding
    // a reference to one.
    if (capture.doomed && capture.leases === 0) await capture.close().catch(() => {});
  }
}

let useClock = 0;

/** How many descriptors this module is holding. Read by the proof tool. */
export const openCaptureCount = () => openCaptures.size;
