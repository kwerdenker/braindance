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

/**
 * How much of a take may sit in memory while the disk catches up.
 *
 * `stream.write` returning false used to be discarded outright, so a card that
 * stalls turned straight into unbounded heap - and the kill that follows loses every
 * frame buffered, which is enormously more than dropping a few would have cost.
 * Sixty-four megabytes is about 130 frames at the measured 486KB, four seconds at
 * full rate: long enough to ride out a stutter, short enough that the loss when it
 * is not a stutter is bounded and visible.
 *
 * Dropping rather than blocking, which is the same decision `broadcastFrame` makes
 * for a browser that falls behind. A take is append-only and every frame carries its
 * own stamp, so a take with a gap in it is still a valid take that replays at the
 * cadence it was shot at - where a recorder that blocked would stall the parse loop
 * and take the live monitor down with it.
 */
export const MAX_TAKE_BUFFER = 64 * 1024 * 1024;

/**
 * Moves a take's counters up to what has actually reached the file.
 *
 * `frames` and `bytes` used to count what `write` accepted. On a stalling card that
 * is what is sitting in memory rather than what is on disk, so the monitor read
 * perfectly healthy for exactly as long as the failure was invisible, and the OOM
 * kill then lost the difference. `bytesWritten` is the stream's own count of bytes
 * the descriptor took, and the queue of frame end-offsets turns that into a frame
 * count.
 *
 * **`write` runs this on every frame, and that is what bounds the queue to the
 * buffer ceiling rather than to the length of the take.** It used to run only when
 * something asked for state, so nothing removed an entry until an operator opened
 * the monitor - and the drain that finally ran was `shift()` in a loop, which is
 * quadratic in however many frames had piled up. Measured on 486KB frames,
 * interleaved, three repetitions per length, median: 48.9ms at 27,000 frames and
 * 3,677ms at 216,000, growing about 4.1x per doubling where a moving head index
 * over the same queue stayed under a quarter of a millisecond throughout. That
 * stall is synchronous, so nothing services stdin while it runs, backpressure
 * reaches the grabber, and the grabber then cannot service USB in time - 52 skipped
 * depth packets per 12s against 2, about 11% of a take, footage no download
 * recovers. Walking up to an unattended node and opening the monitor was the whole
 * of the trigger.
 *
 * So the head moves and the array does not. The consumed prefix is dropped in a
 * single copy, and only once it is at least as long as what remains, which copies
 * at most one element per element ever queued and leaves the array itself bounded
 * by the frames not yet durable instead of growing with the take.
 */
function settle(take) {
  const written = take.stream.bytesWritten;
  while (take.inFlightHead < take.inFlight.length && take.inFlight[take.inFlightHead] <= written) {
    take.inFlightHead++;
    take.frames++;
  }
  if (take.inFlightHead > 0 && take.inFlightHead * 2 >= take.inFlight.length) {
    take.inFlight.splice(0, take.inFlightHead);
    take.inFlightHead = 0;
  }
  take.bytes = written;
}

/**
 * Writes the marks pressed during a take into the sidecar beside it.
 *
 * The marks hang off **the take** rather than off the recorder, and that placement
 * is the whole of it. Held on the recorder they outlived the take that produced
 * them: a take that failed mid-write nulled itself without flushing, and the marks
 * were still in the list when the *next* take closed - so take one lost its mark and
 * take two got it, stamped in source milliseconds from a start it never had.
 */
async function flushMarks(take) {
  if (!take.pendingMarks.length) return;
  try {
    await appendMarks(take.path, take.pendingMarks.splice(0));
  } catch (err) {
    console.error(`[recorder] take ${take.id}: could not write its marks: ${err.message}`);
  }
}

export class Recorder {
  constructor({ dir, onChange = () => {}, rateOf = () => undefined, cannotRecord = () => null }) {
    this.dir = dir;
    this.onChange = onChange;
    this.rateOf = rateOf;
    // Why this server cannot record at all, as a sentence for the operator, or null
    // for one that can. Asked each time rather than fixed at construction, for the
    // same reason `rateOf` is: one of the two answers is not known at startup. A
    // replay server is decided by its flag, but a machine with no sensor on it is
    // only discovered by a grabber failing to find one, which happens seconds later
    // - and a constant captured before that would have the editing station claim it
    // could roll.
    this.cannotRecord = cannotRecord;
    // Armed and recording are different states and the split is why. A restart
    // closes the take while the operator's intention to be recording is unchanged,
    // so the next hello has to open take four without anyone pressing anything.
    this.armed = false;
    this.take = null;
  }

  get state() {
    const take = this.take;
    // Read through the settle, so the numbers the monitor shows are bytes that
    // reached the file rather than bytes this process is holding.
    if (take) settle(take);
    return {
      armed: this.armed,
      recording: Boolean(take),
      takeId: take?.id ?? null,
      startedAt: take?.startedAt ?? null,
      frames: take?.frames ?? 0,
      bytes: take?.bytes ?? 0,
      // Frames the disk could not take. Nonzero is a real loss and the surface says
      // so; the alternative was an unbounded queue and a kill.
      dropped: take?.dropped ?? 0,
      buffered: take ? take.stream.writableLength : 0,
      cannotRecord: this.cannotRecord(),
    };
  }

  /** The file a take is being written into right now, or null. */
  get openPath() {
    return this.take?.path ?? null;
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
    // A server with nothing to record from refuses at the door rather than arming
    // and waiting for a hello that means something else. On a replay server the
    // frames arrive from a file on a loop, so their stamps repeat - and one take is
    // one continuous stream with monotonic stamps, which the index, the retime curve
    // and `mixT` all rest on. What a recording of a replay would produce is a
    // near-copy of a take that already exists, under a new name and a different
    // hash, which is precisely the ambiguity reconciling by content hash exists to
    // remove.
    const blocked = this.cannotRecord();
    if (blocked) throw new Error(blocked);
    if (this.armed) return this.state;
    // The rate the library is reporting, not a constant. The refusal and the
    // readout have to divide by the same number or the monitor says one thing and
    // the recorder acts on another - and the rate genuinely varies, since a node
    // shooting at 15fps writes half of what one at 30 does.
    const left = await remaining(this.dir, this.rateOf());
    // A directory that is not there is a different refusal from a directory that is
    // full, and saying "0s left at current settings" for it would send the operator
    // to delete footage that does not exist.
    if (left.error) throw new Error(`refusing to start a take: ${left.error}`);
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
        const failed = this.take;
        this.take = null;
        this.armed = false;
        // The marks pressed during this take go into *this* take's sidecar, even
        // though it ended badly. Nulling the take without flushing them left them
        // sitting in a list that the next take then closed and wrote out, so take one
        // lost the moment somebody flagged and take two gained one at a source time
        // meaningless there. A take that lost its file is still a take with moments
        // in it.
        settle(failed);
        flushMarks(failed);
        this.onChange(this.state);
      }
    });
    const helloMessage = encodeMessage(TYPE_HELLO, Buffer.from(helloPayload));
    stream.write(helloMessage);
    this.take = {
      id: take.id,
      path: take.path,
      stream,
      startedAt: Date.now(),
      frames: 0,
      bytes: 0,
      dropped: 0,
      stalling: false,
      // Cumulative bytes handed to the stream, and the end offset of every frame not
      // yet known to have reached the file. The hello counts toward the offsets
      // because `bytesWritten` counts it too, and it is not a frame so it is not
      // queued. `inFlightHead` is how far into that queue the drain has got - see
      // `settle`, where moving it rather than the array is the whole of the fix.
      accepted: helloMessage.length,
      inFlight: [],
      inFlightHead: 0,
      // Marks live on the take, not on the recorder - see `flushMarks`.
      pendingMarks: [],
    };
    console.log(`[recorder] take ${take.id} open`);
    this.onChange(this.state);
  }

  /** One whole grabber message into the open take. */
  write(raw) {
    const take = this.take;
    if (!take) return;
    // Drained on the frame path rather than only when something asks for state, and
    // that placement is what makes the queue bounded by the ceiling below instead of
    // by the length of the take. `settle` carries the measurement and the mechanism.
    settle(take);
    // The return value of `write` used to be discarded and nothing read
    // `writableLength`, so a disk that could not keep up became heap that grew until
    // the process was killed - losing every buffered frame at once, having reported
    // itself healthy throughout. Past the ceiling this drops instead, loudly and
    // counted, which bounds the loss to what the gap costs and puts it on the
    // monitor while it is happening.
    if (take.stream.writableLength > MAX_TAKE_BUFFER) {
      take.dropped++;
      if (!take.stalling) {
        take.stalling = true;
        console.error(
          `[recorder] take ${take.id}: ${(take.stream.writableLength / 1e6).toFixed(0)}MB waiting on the disk, `
          + 'over the buffer ceiling - dropping frames until it catches up',
        );
        // Pushed at the transition rather than left to the panel's five-second poll.
        // Footage is being lost for every one of those five seconds, and a node with
        // nobody watching it is exactly where this starts - so the one moment worth
        // interrupting for is the moment it starts. The recovery deliberately does
        // not push: nothing is being lost while the disk catches up, so a readout
        // that stays red until the next poll costs nothing, where a readout that
        // stays green costs the take.
        this.onChange(this.state);
      }
      return;
    }
    if (take.stalling) {
      take.stalling = false;
      console.log(`[recorder] take ${take.id}: the disk caught up, ${take.dropped} frames dropped in the gap`);
    }
    take.stream.write(raw);
    take.accepted += raw.length;
    take.inFlight.push(take.accepted);
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
    try {
      await once(take.stream, 'close');
    } finally {
      // Marks pressed during the take were held until the file existed under its
      // final name. A sidecar written beside a file that had not been closed yet
      // would be a sidecar for a take whose hash was not computed.
      //
      // In a `finally`, because the close itself can reject - a card pulled between
      // `end()` and the flush - and the old shape then skipped the flush while having
      // already nulled the take, which is the same orphaning the mid-write handler
      // above had: the marks travelled forward into whichever take closed next.
      settle(take);
      await flushMarks(take);
    }
    forgetCapture(take.path);
    const index = await buildIndex(take.path);
    console.log(
      `[recorder] take ${take.id} closed (${reason}): ${index.frames.offset.length} frames, ${index.hash}`
      + (take.dropped ? `, ${take.dropped} frames dropped to a slow disk` : ''),
    );
    this.onChange(this.state);
    return {
      id: take.id,
      path: take.path,
      frames: index.frames.offset.length,
      hash: index.hash,
      bytes: take.bytes,
      dropped: take.dropped,
    };
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
    const take = this.take;
    if (!take) throw new Error('nothing is recording, so there is no moment to flag');
    const rec = {
      id: `m${take.startedAt.toString(36)}-${take.pendingMarks.length + 1}`,
      sourceMs,
      label: label || `mark ${take.pendingMarks.length + 1}`,
      at: Date.now(),
    };
    take.pendingMarks.push(rec);
    return rec;
  }
}
