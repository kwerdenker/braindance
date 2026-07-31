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
import { MAGIC, HEADER_BYTES, TYPE_HELLO, TYPE_FRAME } from './protocol.js';

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
      return cached;
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
  }

  get frameCount() {
    return this.index.frames.offset.length;
  }

  async readAt(position, bytes) {
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

  /** One frame's payload, byte for byte as the socket would have delivered it. */
  readFrame(n) {
    const { offset, length } = this.index.frames;
    return this.readAt(offset[n], length[n]);
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
 * Opens a capture once and keeps it open. The promise rather than the result is
 * memoised, so two requests arriving during a multi-gigabyte scan share it
 * instead of starting a second one.
 *
 * Nothing is ever evicted, which is fine while one take is open and a debt the
 * gallery has to settle. The scarce resource there is not memory - an index is
 * about twenty-five bytes a frame - it is file descriptors, since every capture
 * holds one against a soft limit of 256. A library listing a directory of takes
 * would hit EMFILE and then thrash, so the gallery wants cached indexes with the
 * handles evicted LRU and invalidated on a size or mtime change.
 */
export function openCapture(capturePath) {
  const path = resolve(capturePath);
  let pending = openCaptures.get(path);
  if (!pending) {
    pending = (async () => new Capture(path, await loadIndex(path), await open(path, 'r')))();
    // A failure must not be remembered, or a capture that appears a moment later
    // would keep reporting the error from before it existed.
    pending.catch(() => openCaptures.delete(path));
    openCaptures.set(path, pending);
  }
  return pending;
}
