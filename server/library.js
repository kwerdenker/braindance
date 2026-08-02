// The library: one manifest over a captures directory, the marks that hang off
// each take, the projects and presets beside them, and the reconciliation with a
// capture node that makes "local", "remote" and "both" mean something.
//
// Three properties shape everything in this file.
//
// **Reconciliation is by content hash and never by filename, size or date.** That
// is the payoff for hash-referencing captures in step 2: two machines holding the
// same bytes under different names are holding the same take by definition, and
// two different takes that happen to share a name are two takes. Nothing here
// compares a name to decide identity.
//
// **Nothing is ever deleted automatically.** There is no eviction policy, no LRU
// over footage, no reclaim-when-low. `reclaim` and `delete` are different actions
// rather than one action with two buttons: reclaim removes a copy while a
// hash-verified one survives elsewhere, and this file *verifies* that rather than
// believing a manifest that said `both` a moment ago. Delete removes the last copy
// and is the only irreversible action in the tool.
//
// **Nothing reads a capture whole.** `fs.readFileSync` refuses at 2 GiB and a take
// is routinely larger, so the manifest reads indexes, the download streams, and
// the hash of a downloaded take comes from the same streaming scan step 2 built.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, readFile, writeFile, appendFile, stat, unlink, rename, mkdir, statfs } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { basename, join, resolve } from 'node:path';
import { cachedIndex, forgetCapture, indexPathFor, captureIdFor, readHelloOnce } from './capture.js';

// A capture is addressed by id, and an id arrives off a URL or out of a node's
// manifest, so it is checked against this before it is ever joined to a path. The
// leading character rules out `..` on its own; the rest rules out a separator. An
// underscore is allowed so the editor's reserved auto-save name `__working__` is
// a valid document name.
export const VALID_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

// The shape a content hash has, and the reason it is checked at all: a node's
// manifest is JSON from another machine, and `downloadTake` puts eight characters
// of the hash it advertises into a filename whenever the plain name is taken. A
// node offering `sha256:/../../x` therefore names a path outside the captures
// directory and truncates whatever is at the other end of it - so the hash is held
// to this before it can reach `join`, on the same reading as `VALID_ID` beside it
// and through the same two doors: the manifest filters, and the one path-forming
// function asserts.
export const VALID_HASH = /^sha256:[0-9a-f]{64}$/;

// One constant, shared with the page rather than restated here. See web/format.js
// for what version 1 means and why it is a version rather than an authored buffer
// height; re-exported so callers on this side have one import to reach for.
import { PROJECT_VERSION } from '../web/format.js';

export { PROJECT_VERSION };

// What a take costs to record, used for the remaining-time report. Measured on
// this sensor: 424KB of depth plus 51KB of colour per frame at 30fps.
const FRAME_BYTES = 486 * 1024;
const NOMINAL_FPS = 30;
// A take that cannot fit this is refused before it starts. A take that never
// started is a decision; a take that dies at eighty percent is a loss.
export const MIN_TAKE_SEC = 120;

const isKnct = (name) => name.toLowerCase().endsWith('.knct');

// ---------------------------------------------------------------------- marks

/**
 * Marks live in an append-only sidecar beside the take, never inside it. The
 * capture stays byte-identical to what the grabber produced, and - the deciding
 * reason - a mark set while recording is the same object as a mark added while
 * editing, which an in-band marker could never be once the take is gigabytes long.
 *
 * Two machines can hold the same take and different marks, so the log is the merge
 * algorithm rather than needing one: concatenate both files and keep, per mark id,
 * the record with the highest `at`. A deletion is a tombstone record like any
 * other, so it cannot be resurrected by an older log arriving late.
 */
export const marksPathFor = (capturePath) => `${capturePath.replace(/\.knct$/i, '')}.marks.jsonl`;

export async function readMarkLog(capturePath) {
  let text;
  try {
    text = await readFile(marksPathFor(capturePath), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      // A record with no id cannot participate in last-write-wins, and one with no
      // `at` cannot be ordered against anything. Both are a writer this build does
      // not know rather than a mark, and skipping them keeps a single bad line from
      // costing every mark in the file.
      if (typeof rec?.id === 'string' && Number.isFinite(rec?.at)) out.push(rec);
    } catch { /* a torn final line from a writer that died mid-append */ }
  }
  return out;
}

/** The log resolved to what a reader should see: one record per id, no tombstones. */
export function resolveMarks(log) {
  const byId = new Map();
  for (const rec of log) {
    const held = byId.get(rec.id);
    // `>=` rather than `>`, so two records written in the same millisecond resolve
    // to the later line. Concatenation order is the tiebreak and the local log is
    // concatenated last, which makes the machine you are standing at win a tie it
    // could not otherwise resolve.
    if (!held || rec.at >= held.at) byId.set(rec.id, rec);
  }
  return [...byId.values()]
    .filter((rec) => !rec.deleted && Number.isFinite(rec.sourceMs))
    .sort((a, b) => a.sourceMs - b.sourceMs);
}

export async function readMarks(capturePath) {
  return resolveMarks(await readMarkLog(capturePath));
}

/**
 * How many times anything in this process has written a mark log, ever.
 *
 * **A counter, because contents can be put back and a counter cannot.** The route
 * sweep in `library-check` asserts that no route answering GET changes anything, and
 * it did that by reading the stores before and after - which a handler that writes and
 * restores inside the same request defeats by construction, since both readings are
 * taken outside it. Restoring the bytes is easy and restoring the modification time is
 * one `utimes` away. What no restore can undo is that the write happened, so the sweep
 * asserts on this and the snapshot becomes the second opinion rather than the only one.
 *
 * Monotonic and never reset. A counter something can set back is the contents problem
 * again with an extra step.
 */
let markWrites = 0;
export const markWriteCount = () => markWrites;

/**
 * Appends records. Append-only is what makes this safe without a lock: a crash
 * keeps every mark written before it, and two writers interleave into a log the
 * resolver can still read.
 */
export async function appendMarks(capturePath, records) {
  const lines = records.map((rec) => `${JSON.stringify(rec)}\n`).join('');
  // Counted before the await, so a write that fails partway still counts as having
  // touched the log - which is the honest answer for an append that may have landed.
  if (lines) markWrites++;
  if (lines) await appendFile(marksPathFor(capturePath), lines);
}

// ------------------------------------------------------------------- manifest

/**
 * One take as the gallery sees it. Read through `cachedIndex`, which holds no
 * descriptor, so a directory of two hundred takes costs two hundred sidecar reads
 * and nothing that stays open.
 */
async function describeTake(dir, file, recording) {
  const path = join(dir, file);
  const id = captureIdFor(path);
  const st = await stat(path);

  // **The take being written is described without being scanned.** Its size and its
  // modification time move continuously, which is exactly the staleness test
  // `cachedIndex` uses - so every `/library/*` request re-ran a full read plus
  // sha256 over the in-progress take, and the gallery on the node's own panel is the
  // caller. On a 4.4 GB take that is minutes of disk contention against the
  // recorder's own writes, which is what turns a slow card into dropped frames.
  //
  // What is left out is everything a scan produces. A hash over a file still growing
  // would name bytes that no longer describe it a moment later, and a frame count
  // taken mid-write is a number that was true once - so this reports null rather
  // than a figure that reads like a fact, and says the take is recording, which is
  // what the tile actually has to draw.
  if (recording) {
    return {
      id,
      file,
      bytes: st.size,
      hash: null,
      frames: null,
      durationSec: 0,
      capturedAt: st.mtimeMs,
      dateSource: 'mtime',
      truncated: false,
      hasHello: null,
      hello: null,
      openable: false,
      recording: true,
      // Cheap and it is the one thing that is true mid-take: marks pressed in the
      // room land in the sidecar, and the sidecar is beside the take rather than in
      // it. Held marks are still on the recorder until it closes, so this is the
      // ones already flushed.
      marks: await readMarks(path),
    };
  }

  const index = await cachedIndex(path);
  const stamps = index.frames.stampMs;
  const hello = await readHelloOnce(path, index);
  const marks = await readMarks(path);

  // The wall-clock capture date. The frame stamps are `steady_clock`, monotonic
  // since boot, which is the right choice for frame spacing and useless for
  // sorting a library - so the grabber puts a wall clock in its hello and this
  // reads it. A take recorded before that field existed falls back to the file's
  // own modification time, and says which it used rather than presenting a guess
  // as a record.
  const fromHello = Number.isFinite(hello?.startedAt) && hello.startedAt > 0;
  return {
    id,
    file,
    bytes: st.size,
    hash: index.hash,
    frames: stamps.length,
    // Zero for a take with fewer than two frames, which is a real state: a take
    // stopped immediately after starting is a file the library still has to list.
    durationSec: stamps.length > 1 ? (stamps[stamps.length - 1] - stamps[0]) / 1000 : 0,
    capturedAt: fromHello ? hello.startedAt : st.mtimeMs,
    dateSource: fromHello ? 'hello' : 'mtime',
    // Computed by the scan since step 2 and read by nobody until now. A take whose
    // writer died mid-frame is perfectly usable up to the cut, and the gallery
    // saying so is the difference between a known short take and a mystery.
    truncated: Boolean(index.truncated),
    // A take with no hello cannot be opened for editing at all - its intrinsics
    // are unknown, and unprojecting on the boot defaults is an error nothing on
    // screen can show. The tile has to say that rather than offering an Open
    // button that throws.
    hasHello: Boolean(index.hello),
    // The intrinsics, so a poster can unproject the take rather than draw a picture
    // of the sensor's grid. Only these four: a gallery has no use for the serial or
    // the firmware, and shipping a node's whole hello to every browser that lists a
    // directory is more of that node's record than the listing needs.
    hello: hello ? { fx: hello.fx, fy: hello.fy, cx: hello.cx, cy: hello.cy } : null,
    // Two frames is the floor for a pair source, so a shorter take lists and
    // refuses to open. Named here rather than discovered in the editor.
    openable: Boolean(index.hello) && stamps.length >= 2,
    recording: false,
    marks,
  };
}

/**
 * Every take in a directory. Failures are per take rather than per listing: one
 * capture with a desynced stream must not take the gallery down with it, because
 * the gallery is where you would go to delete it.
 */
export async function scanTakes(dir, recordingPath = null) {
  let files;
  try {
    files = (await readdir(dir)).filter(isKnct).sort();
  } catch {
    return { takes: [], unreadable: [] };
  }
  const takes = [];
  const unreadable = [];
  for (const file of files) {
    try {
      takes.push(await describeTake(dir, file, recordingPath !== null && join(dir, file) === recordingPath));
    } catch (err) {
      unreadable.push({ id: captureIdFor(file), file, error: err.message });
    }
  }
  takes.sort((a, b) => b.capturedAt - a.capturedAt);
  return { takes, unreadable };
}

// --------------------------------------------------------------- the node link

/**
 * A capture node, named on the command line as `--node http://host:port`.
 *
 * The link is plain HTTP, always initiated by this side, and the node runs the
 * identical server with no `--node` of its own - so a node has no idea it is being
 * read and holds no state about whoever is reading it. What this side asks for is
 * a manifest, a marks log, and a take's bytes; what it can ask the node to do is
 * remove a copy it has verified survives here.
 *
 * What is trusted, stated rather than assumed. The node's hash is trusted only to
 * decide *what to fetch* - never that a fetched file is what it claimed. A
 * download is re-scanned locally with the same streaming hash step 2 built, and a
 * mismatch discards the file rather than filing it under the hash the node named.
 * The node's ids are checked against `VALID_ID` before they reach a path on this
 * side. There is no authentication and no transport security: this is a link
 * between two machines on one network, and saying so is better than implying a
 * boundary that is not there.
 */
export class NodeLink {
  constructor(url, name) {
    this.url = url.replace(/\/$/, '');
    this.name = name;
    this.lastError = null;
  }

  async fetchJson(path, init) {
    const res = await fetch(`${this.url}${path}`, init);
    if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
    return res.json();
  }

  /** The node's own takes, or null if it cannot be reached. Never throws upward. */
  async takes() {
    try {
      const body = await this.fetchJson('/library/takes');
      this.lastError = null;
      // The hash is filtered beside the id because it is the other field of a node's
      // that reaches a path here. **A take still being shot advertises no hash at
      // all** - `describeTake` reports null on purpose, and `reconcile` keys those by
      // side and name - so null is a take the gallery has to be able to list and
      // refuse to download. What must not pass is a string that is not a hash.
      return body.takes.filter((t) => VALID_ID.test(t.id) && (t.hash === null || VALID_HASH.test(t.hash)));
    } catch (err) {
      this.lastError = err.message;
      return null;
    }
  }
}

/**
 * The one library, spanning both machines. Joined by hash, which is what lets this
 * say exactly what is only over there with no guessing from names, sizes or dates -
 * and what makes a take downloaded under a different filename resolve to one entry
 * rather than two.
 */
export function reconcile(localTakes, nodeTakes) {
  const byHash = new Map();
  // A take still being written has no hash yet, on purpose - see `describeTake`.
  // Two of those would collide onto one key and become one entry, so an unhashed
  // take is keyed by where it is and what it is called. That is not identity and it
  // is not meant to be: a take mid-write cannot be reconciled with anything, because
  // the bytes it would be reconciled on do not exist yet.
  const keyOf = (take, side) => take.hash ?? `${side}:${take.id}`;
  for (const take of localTakes) {
    byHash.set(keyOf(take, 'local'), { ...take, state: 'local', local: take, remote: null });
  }
  for (const take of nodeTakes ?? []) {
    const held = byHash.get(keyOf(take, 'remote'));
    if (held) {
      held.state = 'both';
      held.remote = take;
      continue;
    }
    byHash.set(keyOf(take, 'remote'), { ...take, state: 'remote', local: null, remote: take });
  }
  const out = [...byHash.values()];
  out.sort((a, b) => b.capturedAt - a.capturedAt);
  return out;
}

// ------------------------------------------------------------- remaining time

/**
 * How much recording time is left, reported as time rather than as bytes.
 * "1h 47m left at current settings" is actionable where "94 GB free" is
 * arithmetic the operator has to do under pressure, and time is the honest unit
 * anyway since the rate depends on capture rate and compression.
 */
export async function remaining(dir, bytesPerSec = FRAME_BYTES * NOMINAL_FPS) {
  let fs;
  try {
    fs = await statfs(dir);
  } catch (err) {
    // A directory that is not there answers `ENOENT: no such file or directory,
    // statfs '/...'`, and that used to reach the operator raw through
    // `/record/state` and `/library/all` - so a node whose captures directory is
    // missing booted disarmed with nothing on screen saying why. The boot creates
    // the directory now; this is what is left when it could not, and it says the
    // thing rather than the errno.
    return {
      freeBytes: 0,
      bytesPerSec,
      secondsLeft: 0,
      label: 'no room reported',
      error: `there is no captures directory at ${dir}: ${err.message}`,
    };
  }
  const freeBytes = fs.bavail * fs.bsize;
  const secondsLeft = bytesPerSec > 0 ? freeBytes / bytesPerSec : Infinity;
  return { freeBytes, bytesPerSec, secondsLeft, label: durationLabel(secondsLeft), error: null };
}

export function durationLabel(sec) {
  if (!Number.isFinite(sec)) return 'unbounded';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(Math.floor(sec % 60)).padStart(2, '0')}s`;
  return `${Math.floor(sec)}s`;
}

// -------------------------------------------------------- download and removal

/**
 * Pulls a take from the node into `dir`, then proves it arrived intact.
 *
 * The verification is the point rather than a courtesy. Written to a temporary
 * name and renamed only once the local streaming scan agrees with the hash the
 * node advertised, so a truncated transfer or a take that changed underneath the
 * node's manifest never lands in the library at all - and never lands under a hash
 * that would then reconcile against a project file.
 */
/**
 * What each download in flight has moved so far, keyed by take id.
 *
 * A take is gigabytes and the link is a room's wifi, so this is minutes of work
 * behind a single POST that answers when it is finished. Without this the gallery
 * can only print the word "downloading" for four minutes, which is the same thing
 * it would print if the node had silently stopped sending - and an operator who
 * cannot tell those apart restarts a transfer that was working.
 *
 * The count comes off the stream rather than off `stat` of the `.part` file: the
 * write is buffered, so the file lags what has actually arrived, and the verifying
 * phase has no file growth at all while still taking real time on a 2.5 GB take.
 */
export const downloadsInFlight = new Map();

export async function downloadTake(node, take, dir) {
  if (!VALID_ID.test(take.id)) throw new Error(`the node offered an unusable id: ${take.id}`);
  // Asserted here rather than filtered, unlike the manifest's: the hash goes into a
  // filename on the collision branch below, and a download with nothing to verify
  // against is not a download this function can perform at all - the verification is
  // the whole of it.
  if (!VALID_HASH.test(take.hash ?? '')) {
    throw new Error(`the node offered ${take.id} with an unusable hash: ${JSON.stringify(take.hash ?? null)}`);
  }
  // A filename is not an identity, and this is where that stops being a slogan.
  // Two machines can hold genuinely different takes under one name - the library
  // already lists them as two entries, because it joins on the hash - and writing
  // the node's at the local one's name would destroy footage to satisfy a
  // convention this design does not use. So a collision takes the hash into the
  // name and the two coexist, which is what the reconciliation was already saying.
  let target = join(dir, `${take.id}.knct`);
  try {
    const local = await cachedIndex(target);
    if (local.hash !== take.hash) target = join(dir, `${take.id}-${take.hash.slice(7, 15)}.knct`);
  } catch { /* nothing at that name, or nothing readable: the plain name is free */ }
  const temp = `${target}.part`;
  const res = await fetch(`${node.url}/capture/${encodeURIComponent(take.id)}/file`);
  if (!res.ok) throw new Error(`downloading ${take.id}: ${res.status} ${res.statusText}`);

  // Registered only once the node has actually answered, so a transfer that was
  // refused never appears as one that stalled at zero.
  const progress = { id: take.id, phase: 'transferring', received: 0, bytes: take.bytes, startedAt: Date.now() };
  downloadsInFlight.set(take.id, progress);
  try {
    const counted = new Transform({
      transform(chunk, _enc, done) {
        progress.received += chunk.length;
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counted, createWriteStream(temp));

    // The same streaming scan step 2 built, against the file that actually landed.
    // Re-deriving the hash from the node's answer would only be restating it.
    // Named as its own phase because it is not instant at this size and a progress
    // readout stuck at 100% is the same silence this was built to remove.
    progress.phase = 'verifying';
    const got = await hashFile(temp);
    if (got !== take.hash) {
      throw new Error(
        `${take.id} arrived as ${got}, not the ${take.hash} the node advertised: `
        + 'discarded rather than filed under a hash it does not have',
      );
    }
    await rename(temp, target);
    forgetCapture(target);
  } catch (err) {
    // **Every failure takes the `.part` with it, not only the hash mismatch.** A
    // transfer that dropped mid-stream left gigabytes at a name nothing in the tool
    // can see or act on: `scanTakes` filters on `.knct`, so no tile lists it and no
    // removal offers to remove it, while `remaining` counts the space as gone - and
    // the recorder divides that by the capture rate and starts refusing takes over a
    // file no surface mentions. The mismatch was cleaned up because it was the one
    // failure somebody had in mind; the link going away mid-download is the ordinary
    // one, since the link is a room's wifi and the take is minutes of it.
    await unlink(temp).catch(() => {});
    throw err;
  } finally {
    // In a `finally` because a failed download must not leave the gallery showing a
    // transfer that is no longer happening - and the hash mismatch above throws.
    downloadsInFlight.delete(take.id);
  }

  // Marks come with the take. They are outside the hash by design - mutable, and
  // editable from either machine - so they are merged rather than compared, and
  // the merge is the same union the sync below performs.
  try {
    const log = await node.fetchJson(`/capture/${encodeURIComponent(take.id)}/marks/log`);
    await appendMarks(target, log.log ?? []);
  } catch { /* a node that went away mid-download still leaves a verified take */ }
  return target;
}

/** The content hash of a file, streamed. Nothing here ever holds a capture whole. */
export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) {
    hash.update(chunk);
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Removes a copy of a take from this machine.
 *
 * `verifiedElsewhere` decides which of the two actions this is, and it is a hash
 * rather than a flag on purpose. A reclaim that trusted a manifest saying `both`
 * would remove footage on the strength of a listing taken some time ago, against a
 * copy that may since have been truncated - which is the one failure this tool
 * cannot afford. So the caller hands in the hash the surviving copy actually
 * reported, and this compares it to the take's own.
 *
 * **The take's own hash is re-derived here rather than read off the sidecar.** It
 * used to come from `cachedIndex`, which is the manifest's cache - and the reclaim
 * path above already re-hashes for the exact reason this one did not, that a listing
 * may since have been truncated. So the irreversible action was carrying the weaker
 * check: a same-size, same-modification-time substitution is invisible to the
 * sidecar, the listing keeps reporting the old hash, and a delete built on that
 * listing removed a file whose bytes nobody had looked at. That substitution is what
 * `library-check` already constructs as the falsification control for reclaim, so
 * the technique that would have caught this was sitting in the tool. Delete is the
 * one thing here that cannot be undone; it pays for the read.
 */
export async function removeTake(dir, id, { hash, verifiedElsewhere = null }) {
  if (!VALID_ID.test(id)) throw new Error(`unusable take id ${id}`);
  const path = join(dir, `${id}.knct`);
  const actual = await hashFile(path);
  if (actual !== hash) {
    throw new Error(
      `${id} is ${actual} here, not the ${hash} this removal named: `
      + 'the library moved underneath the request and nothing was removed',
    );
  }
  if (verifiedElsewhere !== null && verifiedElsewhere !== actual) {
    throw new Error(
      `refusing to reclaim ${id}: the copy that is supposed to survive reports `
      + `${verifiedElsewhere}, not ${actual} - that is a different take, and this `
      + 'would be deleting the last copy of both',
    );
  }
  await unlink(path);
  // The sidecars go with it, except the marks. A take deleted here may still exist
  // on the node, and marks are the one thing that is genuinely shared and genuinely
  // editable from either side - so throwing the log away would silently undo a
  // correction someone made on this machine.
  await unlink(indexPathFor(path)).catch(() => {});
  forgetCapture(path);
  return { removed: `${id}.knct`, hash: actual };
}

// ------------------------------------------------- projects and the preset library

/**
 * A directory of JSON documents with a version on every one. Projects and presets
 * are the same storage problem - small JSON, named by the user, content-hashed so
 * a provenance stamp can point at a revision - so they are one class rather than
 * two that drift.
 */
export class DocumentStore {
  constructor(dir, kind, version = PROJECT_VERSION) {
    this.dir = dir;
    this.kind = kind;
    this.version = version;
    // Every write and every removal this store has ever done. Monotonic, never
    // reset, and the reason it exists is `markWriteCount` above: a handler that
    // writes and puts the bytes back is invisible to a before-and-after reading of
    // the contents, and this is the quantity no restore can undo.
    this.writes = 0;
  }

  pathFor(name) {
    if (!VALID_ID.test(name)) throw new Error(`unusable ${this.kind} name ${JSON.stringify(name)}`);
    return join(this.dir, `${name}.json`);
  }

  async list() {
    let files;
    try {
      files = (await readdir(this.dir)).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return [];
    }
    const out = [];
    for (const file of files) {
      const path = join(this.dir, file);
      try {
        const text = await readFile(path, 'utf8');
        const st = await stat(path);
        out.push({
          name: basename(file, '.json'),
          // Hashed over **the bytes on disk**, never over a re-serialisation. Key
          // order in JSON is insertion order, so a document parsed and stringified
          // again can hash differently while meaning the same thing - and a
          // provenance stamp that drifted on a round-trip would report a look as
          // having changed when nothing did.
          rev: `sha256:${createHash('sha256').update(text).digest('hex')}`,
          bytes: st.size,
          savedAt: st.mtimeMs,
          body: JSON.parse(text),
        });
      } catch { /* a document this build cannot read is not a reason to hide the rest */ }
    }
    return out;
  }

  async read(name) {
    const text = await readFile(this.pathFor(name), 'utf8');
    return { name, rev: `sha256:${createHash('sha256').update(text).digest('hex')}`, body: JSON.parse(text) };
  }

  /**
   * Writes a document, after checking this build can interpret it.
   *
   * **A version that is present and is not this one is refused, never restamped.**
   * This used to spread `{ ...body, version: PROJECT_VERSION }`, which took a
   * `version: 2` document, wrote `version: 1` over the top and kept every v2 field
   * underneath - so a project from a future build landed in the store looking like
   * one this build authored, and the loader that refuses four kinds of bad version
   * never saw a wrong one. That is precisely the failure the version field was
   * chosen over an authored buffer height to prevent: a version answers "can this
   * build faithfully interpret this document", and a writer that answers it by
   * overwriting the question is not answering it.
   *
   * An **absent** version is stamped rather than refused, because for a document
   * this build authored the store is the writer of record - a preset is saved as a
   * mode and a set of values and gets its version here. What that admits is an
   * unversioned blob becoming a version 1 document, and the load path is the second
   * gate on that: it refuses seventeen malformed shapes field by field.
   *
   * Written aside and renamed, for the same reason step 2's sidecar is: a crash
   * partway through a write must not leave a file that parses and describes
   * something that was never saved.
   */
  async write(name, body) {
    if (body?.version !== undefined && body.version !== this.version) {
      throw new Error(
        `this ${this.kind} says version ${JSON.stringify(body.version)}, and this build writes `
        + `version ${this.version}: refused rather than restamped, because a document this build `
        + 'cannot faithfully interpret is exactly what the version field exists to catch',
      );
    }
    // Counted past both refusals and before anything touches the disk. A version this
    // build cannot interpret and a name that is not a name both wrote nothing, so
    // neither counts; a write that fails partway may well have landed, so it does.
    // `pathFor` moved above the `mkdir` for the same reason it moved above the count -
    // an unusable name should not leave a directory behind either.
    const path = this.pathFor(name);
    // Captured here, on the same tick as the increment. Reading `this.writes` again
    // further down would be reading it across an await, where another request has
    // already incremented it - two writers then compute the same scratch name and the
    // race this number exists to prevent comes straight back. Measured: 2 of 12
    // concurrent puts still failed with the read moved below the mkdir.
    const seq = ++this.writes;
    await mkdir(this.dir, { recursive: true });
    const text = `${JSON.stringify({ ...body, version: this.version }, null, 2)}\n`;
    // The scratch name carries the write's own number, and that is load-bearing rather
    // than tidy. With a fixed `${path}.tmp` two overlapping writes to one document share
    // the file: the first rename moves it away and the second finds nothing, so the
    // later write fails with an ENOENT the route reports as a 409. Auto-save made that
    // reachable from ordinary use - it fires on every committed interaction, and a
    // handful of quick ones overlap - and measured here it was 4 of 8 concurrent puts.
    // `seq` is the write's own number, taken on the tick it was counted, so every
    // in-flight write in this process holds a distinct one; nothing here needs a clock
    // or a random suffix to get it.
    const scratch = `${path}.${seq}.tmp`;
    await writeFile(scratch, text);
    await rename(scratch, path);
    return { name, rev: `sha256:${createHash('sha256').update(text).digest('hex')}`, bytes: text.length };
  }

  async remove(name) {
    // Below `pathFor` for the reason `write` is: a name that cannot name a document
    // removed nothing, so it must not count as a write.
    const path = this.pathFor(name);
    this.writes++;
    await unlink(path);
    return { removed: name };
  }
}

export const captureDirOf = (dir) => resolve(dir);
