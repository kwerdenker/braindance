// A take is a file. Start opens one, stop closes it and scans it, and that
// identity - take is file is gallery entry is hash - is what the project model,
// the frame API and the library all already assume.
//
// Two rules make the invariant everything downstream rests on hold: one take is
// one continuous stream, with one hello at its head and monotonic timestamps.
//
// **The take is fed parsed messages rather than raw chunks.** A chunk boundary
// falls anywhere, so a recorder that opened a file mid-chunk would cut a frame in
// half and a recorder that closed one mid-chunk would leave a header with no
// payload. Messages are already reassembled a few lines upstream, so recording
// whole ones costs nothing and the bytes written are the grabber's own.
//
// **A grabber restart ends the take and opens the next one.** The server respawns
// the grabber with backoff because the sensor dropping off the bus under load is a
// designed-for condition, and without this rule that would append a second hello
// and a timestamp discontinuity into the middle of a take file. Nothing is
// discarded, only split: a recording interrupted this way is two fully usable
// takes, which is what a raw-capture tool should do with good footage.

import { createWriteStream, openSync, readdirSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { encodeMessage, TYPE_HELLO } from './protocol.js';
import { buildIndex, forgetCapture } from './capture.js';
import { appendMarks, remaining, MIN_TAKE_SEC, durationLabel } from './library.js';

/**
 * `2026-07-31-take3` — the date it was shot, and which take of that day.
 *
 * Synchronous, and that is the point rather than an economy. Opening a take has to
 * complete inside the same turn as the hello that triggered it, or frames arriving
 * behind that hello are handed to a recorder with no file yet and dropped - so the
 * take would silently begin a few frames late, which is precisely the footage this
 * tool exists to keep. One `readdir` of a captures directory, once per take, is not
 * a cost worth paying for that.
 */
function nextTakeId(dir, atLeast = 0) {
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let files = [];
  try {
    files = readdirSync(dir);
  } catch { /* the directory is made on the way to opening the file, or cannot be listed */ }
  let highest = atLeast;
  for (const file of files) {
    const m = new RegExp(`^${day}-take(\\d+)\\.knct$`).exec(file);
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return { id: `${day}-take${highest + 1}`, n: highest + 1 };
}

// How many names a take will try before giving up. Bounded rather than open, so a
// directory that answers EEXIST to everything ends in a stated failure instead of a
// spin - and generous, because each attempt is one `open` and the case it exists for
// is a handful of names being taken, not thousands.
const MAX_NAME_ATTEMPTS = 64;

export class Recorder {
  constructor({ dir, onChange = () => {}, rateOf = () => undefined }) {
    this.dir = dir;
    this.onChange = onChange;
    this.rateOf = rateOf;
    // Armed and recording are different states and the split is why. A restart
    // closes the take while the operator's intention to be recording is unchanged,
    // so the next hello has to open take four without anyone pressing anything.
    this.armed = false;
    this.take = null;
    this.pendingMarks = [];
  }

  get state() {
    return {
      armed: this.armed,
      recording: Boolean(this.take),
      takeId: this.take?.id ?? null,
      startedAt: this.take?.startedAt ?? null,
      frames: this.take?.frames ?? 0,
      bytes: this.take?.bytes ?? 0,
    };
  }

  /**
   * Arms recording and opens a take if the sensor has already said hello.
   *
   * Refuses outright when the disk cannot hold a sensible minimum, because a take
   * that never started is a decision and a take that dies at eighty percent is a
   * loss - and with manual-only deletion the card genuinely does fill, unattended,
   * mid-shoot.
   */
  async start(helloPayload) {
    if (this.armed) return this.state;
    // The rate the library is reporting, not a constant. The refusal and the
    // readout have to divide by the same number or the monitor says one thing and
    // the recorder acts on another - and the rate genuinely varies, since a node
    // shooting at 15fps writes half of what one at 30 does.
    const left = await remaining(this.dir, this.rateOf());
    if (left.secondsLeft < MIN_TAKE_SEC) {
      throw new Error(
        `refusing to start a take: ${left.label} left at current settings, under the `
        + `${durationLabel(MIN_TAKE_SEC)} minimum - a take that dies partway through is a loss`,
      );
    }
    this.armed = true;
    if (helloPayload) this.open(helloPayload);
    this.onChange(this.state);
    return this.state;
  }

  /**
   * Opens the next take. The hello goes in first, so the file has exactly one.
   *
   * **Synchronous from end to end, and nothing here awaits.** This runs off the
   * hello, and the frames of that same take are already arriving behind it in the
   * same stream - so any await between "a hello was seen" and "`this.take` exists"
   * is a window in which `write` finds no take and returns, losing the opening
   * frames of the recording. `createWriteStream` returns a writable immediately and
   * buffers until the descriptor is there, so the bytes are safe without waiting
   * for the `open` event; what must not wait is the assignment below.
   */
  open(helloPayload) {
    if (this.take) return;

    // `wx`, so a take never appends to or truncates a file that is already there:
    // two takes in one file share a hash and a gallery entry, which the project
    // model cannot express. Opened with `openSync` rather than left to the stream,
    // because that puts the refusal *here* - in the same turn, before a hello has
    // been buffered and before frames start landing in a stream that will never have
    // a file behind it.
    //
    // **A name already taken is not a reason to stop recording.** It means something
    // else got there first - a second server on the same captures directory, most
    // likely - so the answer is the next name and not a disarmed recorder. A
    // recorder that quietly stops is the one failure this tool cannot have; refusing
    // to start is at least a decision somebody can see, and this is not even that.
    let take = null;
    let floor = 0;
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS && !take; attempt++) {
      const { id, n } = nextTakeId(this.dir, floor);
      const path = join(this.dir, `${id}.knct`);
      try {
        take = { id, path, fd: openSync(path, 'wx') };
      } catch (err) {
        if (err.code !== 'EEXIST') {
          // ENOSPC, EACCES, a captures directory that is not there: genuinely fatal
          // and nothing a different name would fix. Loud, and disarmed - continuing
          // to look armed while writing nothing is the failure this whole branch is
          // arranged to avoid.
          console.error(`[recorder] cannot open ${path}: ${err.message} - recording is off`);
          this.armed = false;
          this.onChange(this.state);
          return;
        }
        // Advanced rather than merely re-scanned. A directory that cannot be listed
        // at all answers the same name every time, so a retry that only re-scanned
        // would ask for the taken name until it ran out of attempts.
        console.warn(`[recorder] ${id} is already taken, trying the next name`);
        floor = n;
      }
    }
    if (!take) {
      console.error(`[recorder] no free take name after ${MAX_NAME_ATTEMPTS} tries - recording is off`);
      this.armed = false;
      this.onChange(this.state);
      return;
    }

    const stream = createWriteStream(null, { fd: take.fd, autoClose: true });
    // Past the open, an error is a write that failed - a full disk, a card pulled -
    // and there is no next name that helps. The bytes already written are still a
    // usable take because the format is append-only, so this ends the take and says
    // so rather than pretending it is still recording.
    stream.on('error', (err) => {
      console.error(`[recorder] take ${take.id} failed mid-write: ${err.message} - recording is off`);
      if (this.take?.stream === stream) {
        this.take = null;
        this.armed = false;
        this.onChange(this.state);
      }
    });
    stream.write(encodeMessage(TYPE_HELLO, Buffer.from(helloPayload)));
    this.take = { id: take.id, path: take.path, stream, startedAt: Date.now(), frames: 0, bytes: 0 };
    console.log(`[recorder] take ${take.id} open`);
    this.onChange(this.state);
  }

  /** One whole grabber message into the open take. */
  write(raw) {
    const take = this.take;
    if (!take) return;
    take.stream.write(raw);
    take.frames++;
    take.bytes += raw.length;
  }

  /**
   * Closes the take and scans it. The scan is what writes the sidecar index and
   * the content hash, which is what makes the take a gallery entry - so a take is
   * not finished until it has one.
   */
  async close(reason) {
    const take = this.take;
    if (!take) return null;
    this.take = null;
    take.stream.end();
    await once(take.stream, 'close');
    // Marks pressed during the take were held until the file existed under its
    // final name. A sidecar written beside a file that had not been closed yet
    // would be a sidecar for a take whose hash was not computed.
    if (this.pendingMarks.length) {
      await appendMarks(take.path, this.pendingMarks.splice(0));
    }
    forgetCapture(take.path);
    const index = await buildIndex(take.path);
    console.log(`[recorder] take ${take.id} closed (${reason}): ${index.frames.offset.length} frames, ${index.hash}`);
    this.onChange(this.state);
    return { id: take.id, path: take.path, frames: index.frames.offset.length, hash: index.hash, bytes: take.bytes };
  }

  async stop() {
    this.armed = false;
    const done = await this.close('stopped');
    this.onChange(this.state);
    return done;
  }

  /**
   * The grabber died or was restarted. The take ends here and the next hello opens
   * the next one, which preserves one-take-one-continuous-stream without throwing
   * away the footage that already landed.
   */
  async split() {
    if (!this.take) return null;
    return this.close('grabber restarted');
  }

  /**
   * A hello arrived. Opens a take if recording is armed and none is open.
   *
   * Called synchronously from the message loop and synchronous itself, so the very
   * next frame in the same chunk lands in the file. Deferring this by so much as a
   * microtask loses every frame the parser had already assembled behind the hello.
   */
  onHello(helloPayload) {
    if (this.armed && !this.take) this.open(helloPayload);
  }

  /**
   * Flags the moment while it is still happening. Stamped in **source
   * milliseconds** from the take's first frame, because a mark describes the
   * footage rather than any edit of it - it survives retiming and is shared by
   * every project built on that take.
   *
   * Stamped raw and never pre-rolled. People press a few hundred milliseconds
   * after the thing happens, so every mark lands slightly late, and a constant
   * baked in at capture time would be a guess: marks are approximate signposts you
   * scrub around, so one that is a few frames late has already done its job.
   */
  mark(sourceMs, label) {
    if (!this.take) throw new Error('nothing is recording, so there is no moment to flag');
    const rec = {
      id: `m${this.take.startedAt.toString(36)}-${this.pendingMarks.length + 1}`,
      sourceMs,
      label: label || `mark ${this.pendingMarks.length + 1}`,
      at: Date.now(),
    };
    this.pendingMarks.push(rec);
    return rec;
  }
}
