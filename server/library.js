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

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, readFile, writeFile, appendFile, stat, unlink, rename, link, mkdir, statfs } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { basename, dirname, join, resolve } from 'node:path';
import { cachedIndex, forgetCapture, indexPathFor, captureIdFor, readHelloOnce } from './capture.js';

// A capture is addressed by id, and an id arrives off a URL or out of a node's
// manifest, so it is checked against this before it is ever joined to a path. The
// rule itself lives in `web/format.js` beside the document version, because the
// gallery's rename box has to hold a typed name to the same rule this file holds a
// request to - see the comment there for why that is one constant rather than two.
// Imported as well as re-exported: this file asserts it a dozen times itself, and
// `export ... from` puts nothing in local scope.
export { VALID_ID };

// The shape a content hash has, and the reason it is checked at all: a node's
// manifest is JSON from another machine, and `downloadTake` puts eight characters
// of the hash it advertises into a filename whenever the plain name is taken. A
// node offering `sha256:/../../x` therefore names a path outside the captures
// directory and truncates whatever is at the other end of it - so the hash is held
// to this before it can reach `join`, on the same reading as `VALID_ID` beside it
// and through the same two doors: the manifest filters, and the one path-forming
// function asserts.
export const VALID_HASH = /^sha256:[0-9a-f]{64}$/;

// Two constants, shared with the page rather than restated here. See web/format.js
// for what version 1 means and why it is a version rather than an authored buffer
// height; re-exported so callers on this side have one import to reach for.
import { PROJECT_VERSION, VALID_ID } from '../web/format.js';

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

/**
 * The ids a download has claimed, which is a different question from the one
 * `downloadsInFlight` answers.
 *
 * **Two structures because they are two facts, not one fact written twice.** The map
 * above is a *report*: what to tell the gallery about a transfer the node has actually
 * answered, which is why it is filled in after the fetch rather than before - a
 * request the node refused should never appear as one stalled at zero. This set is a
 * *claim*, taken before anything is awaited, and it exists because the report cannot
 * do a guard's job: by the time the map has an entry there have been two awaits, and a
 * second request arriving in that gap finds it empty and proceeds.
 *
 * Guarding at all is what the surface could not do. The page held down whichever
 * surface the press came from, which is right for that surface and says nothing about
 * the other one - close the viewer mid-transfer and the grid tile behind it is live,
 * and a duplicate is one tap away. Both requests would then write one `${target}.part`
 * and overwrite one progress entry, so the two verifications race over bytes neither
 * wrote alone. A rule that has to hold across every surface belongs on the one thing
 * every surface goes through.
 */
const downloadClaims = new Set();

export async function downloadTake(node, take, dir) {
  if (!VALID_ID.test(take.id)) throw new Error(`the node offered an unusable id: ${take.id}`);
  // Asserted here rather than filtered, unlike the manifest's: the hash goes into a
  // filename on the collision branch below, and a download with nothing to verify
  // against is not a download this function can perform at all - the verification is
  // the whole of it.
  if (!VALID_HASH.test(take.hash ?? '')) {
    throw new Error(`the node offered ${take.id} with an unusable hash: ${JSON.stringify(take.hash ?? null)}`);
  }
  // Claimed here, with nothing awaited between the reading and the taking, which is
  // the only placement that makes this a guard - see `downloadClaims` above.
  //
  // **Case-folded, because what has to be exclusive is the pathname and not the id.**
  // `Take-1` and `take-1` are two ids and one file on a case-insensitive volume, which
  // is the default on APFS and on NTFS - so two downloads keyed by exact id both pass
  // this, then unlink, open, write, hash and install against one `.part` and one
  // target. One can verify and link its inode while the other is still writing
  // through it, and the take that lands no longer hashes to what it advertised.
  //
  // This over-serialises on a case-sensitive volume: two genuinely different takes
  // whose names differ only by case cannot download at once, and the second is asked
  // to wait rather than refused outright. That is the direction to be wrong in - the
  // cost is a retry, where the other way round the cost is a corrupted take that
  // still lists at full size. Folding rather than probing the volume, because a probe
  // is a fact about the filesystem at one moment and this needs to hold for the ones
  // already in flight.
  const claim = take.id.toLowerCase();
  if (downloadClaims.has(claim)) {
    throw new Error(`${take.id} is already downloading: wait for that transfer rather than starting a second one`);
  }
  downloadClaims.add(claim);
  try {
    return await downloadClaimed(node, take, dir);
  } finally {
    downloadClaims.delete(claim);
  }
}

async function downloadClaimed(node, take, dir) {
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
  // **The pathname is claimed as well as the id, because the id does not determine
  // it.** The line above rewrites `target` when the plain name is occupied, so a take
  // called `foo` can end up writing `foo-1a2b3c4d.knct.part` - which is exactly the
  // `.part` a *different* remote take whose literal id is `foo-1a2b3c4d` uses. Two
  // different ids, two granted claims, one temporary file: the writers share an inode
  // and one can verify and install what the other is still writing. Folding the id was
  // right and insufficient; what has to be exclusive is the path.
  //
  // Taken here with nothing awaited between resolving `target` and adding it, which is
  // what makes it a claim rather than a reading - the same placement rule as the id
  // claim, applied at the point the real answer is finally known.
  const pathClaim = `path:${target.toLowerCase()}`;
  if (downloadClaims.has(pathClaim)) {
    throw new Error(
      `${take.id} would write ${basename(target)}, which another download is already writing: `
      + 'wait for that transfer rather than racing it',
    );
  }
  downloadClaims.add(pathClaim);
  try {
    return await downloadToPath(node, take, dir, target);
  } finally {
    downloadClaims.delete(pathClaim);
  }
}

async function downloadToPath(node, take, dir, targetIn) {
  let target = targetIn;
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
    // **The `.part` is unlinked before it is opened, and that is about an inode rather
    // than about tidiness.** The install below claims its name with `link` and then
    // drops `temp`, so a process killed between those two calls leaves `.part` and a
    // perfectly good installed take as two names for one inode. `createWriteStream`
    // truncates by default, so the next attempt at this download would open `.part`
    // and take the installed take to zero with it - and then, if the transfer dropped,
    // the cleanup below would remove only `.part` and leave the library holding a
    // corrupted file it still lists at full size. Unlinking first breaks the shared
    // inode instead of writing through it: the installed take keeps its own link and
    // all of its bytes, and this download starts on a genuinely new file.
    //
    // `renameTake` admits the same two-step window on purpose, and its answer is right
    // for it - a take under both names is two entries with one hash, which the
    // reconciliation folds and an operator can see and remove. This one is not
    // visible: `scanTakes` filters on `.knct`, so nothing lists a `.part` and nothing
    // offers to remove it, which is why it needs closing here rather than reporting.
    // **Only an absent file is safe to carry on past.** The whole point of this unlink
    // is that `temp` may be a second name for a take already in the library, so a
    // failure to remove it and then opening it anyway is precisely the truncation this
    // is here to prevent - a swallowed error would have made the guard cosmetic under
    // exactly the conditions it exists for. ENOENT is the normal case and means the
    // name was free.
    try {
      await unlink(temp);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new Error(
          `refusing to download ${take.id}: ${basename(temp)} is in the way and could not be removed `
          + `(${err.code}), and opening it would truncate whatever else is linked to it`,
        );
      }
    }
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
    // **Linked and unlinked rather than renamed, for the reason `renameTake` states
    // fifty lines down and this call did not honour.** `rename(2)` replaces an
    // existing file without a word, and the name this is about to claim was chosen
    // minutes ago, before a transfer long enough for the directory to have moved
    // underneath it. A local take renamed onto this name in that window - which the
    // gallery now offers, because a node-only name is correctly not a local clash -
    // was replaced by the arriving remote take and lost its only directory entry.
    // Footage destroyed by a transfer nobody would think of as a write to another
    // take.
    //
    // EEXIST is not a refusal, because refusing here would throw away a download that
    // has already succeeded. It is the same answer the collision check at the top of
    // this function gives, arrived at from the other side: the two takes coexist, and
    // the one that turned up second wears the hash in its name.
    //
    // **A list rather than one fallback, because the first version of this had a
    // fallback that could be the name that just failed.** If the plain name was taken
    // before the download began, the collision check at the top already moved `target`
    // to the hashed one - so a rename onto *that* during the transfer gave EEXIST, and
    // reassigning the hashed name retried the identical `link` and discarded gigabytes
    // that had arrived and verified. Every candidate here is tried with `link`, which
    // is the same atomic claim used above, so the loop cannot be a check-then-act
    // however many names it walks.
    const suffixed = join(dir, `${take.id}-${take.hash.slice(7, 15)}.knct`);
    const candidates = [target, suffixed].filter((p, i, all) => all.indexOf(p) === i);
    for (let n = 2; n <= 9; n++) candidates.push(join(dir, `${take.id}-${take.hash.slice(7, 15)}-${n}.knct`));
    let claimed = null;
    for (const candidate of candidates) {
      try {
        await link(temp, candidate);
        claimed = candidate;
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    if (!claimed) {
      throw new Error(
        `${take.id} arrived and verified, but every name it could take in ${dir} is occupied `
        + `(tried ${candidates.length}): move something out of the way and download it again`,
      );
    }
    target = claimed;
    await unlink(temp);
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

/**
 * Renames a take, and everything filed beside it.
 *
 * **A take's id is its filename, so renaming one is the only operation here that
 * changes a take's identity to a reader that goes by name.** Nothing in this program
 * does: projects reference their footage by content hash, the reconciliation joins on
 * the hash, and the menu resumes on the hash - all of which is what makes this safe to
 * offer at all. What moves is the label an operator reads on a tile, which is the one
 * thing a hash cannot be.
 *
 * **The hash is checked against the sidecar rather than re-derived, and that is the
 * opposite of what `removeTake` does one function up.** Delete pays for a full
 * streaming sha256 because it is irreversible: a same-size, same-modification-time
 * substitution is invisible to the sidecar, and a delete built on a listing that had
 * gone stale removes a file whose bytes nobody looked at. A rename undone is a rename
 * back. So this pays the cheap check that catches the case that actually happens - the
 * library moved between the tile being drawn and the button being pressed, which
 * changes size or modification time and therefore fails the sidecar's own staleness
 * test - and does not read four gigabytes off a card to relabel a file.
 *
 * **The take being recorded is refused, and that refusal is load-bearing rather than
 * tidy.** `scanTakes` decides which take is open by comparing paths against
 * `recorder.openPath`, so a take renamed mid-shoot stops matching: `describeTake`
 * drops out of the unscanned branch and starts a full read plus sha256 of a file the
 * recorder is still writing to, on the disk it is writing to, on every `/library/*`
 * request. That is exactly the contention section 11 of `library-check` exists to
 * keep closed, reached by a door the caller cannot see from the rename's own answer -
 * which is why the refusal is asserted here as well as at the route.
 *
 * The three files move in an order chosen for what a failure partway leaves behind.
 * Marks first and the capture second, with the marks put back if the capture will not
 * move, because marks are the one artifact here that cannot be regenerated - they are
 * what somebody pressed in the room. The index last and its failure swallowed, because
 * a `.idx` is a cache of a scan and the next reader rebuilds it; the stale one at the
 * old name is unlinked rather than left to be found beside some later take.
 */
export async function renameTake(dir, id, requested, { hash, recordingPath = null }) {
  if (!VALID_ID.test(id)) throw new Error(`unusable take id ${id}`);
  // Somebody who typed the extension meant the take rather than a file called
  // `x.knct.knct`, so the suffix is taken off rather than refused. It is the one
  // transformation applied to a typed name: every other character is held to the rule
  // and reported back, because a name silently corrected is a name the operator did
  // not choose.
  const to = String(requested ?? '').trim().replace(/\.knct$/i, '');
  if (!VALID_ID.test(to)) {
    throw new Error(
      `${JSON.stringify(to)} cannot be a take name: it has to start with a letter, a digit or an `
      + 'underscore and carry only letters, digits, dots, dashes and underscores',
    );
  }
  if (to === id) throw new Error(`${id} is already its name, so there is nothing to rename`);

  const from = join(dir, `${id}.knct`);
  const target = join(dir, `${to}.knct`);
  // The second door. `VALID_ID` already forbids a separator and a leading dot, and
  // the one path-forming function asserts anyway - the same reading as `VALID_HASH`'s
  // and for the same reason: a filter somewhere else is a thing that can be moved.
  const root = resolve(dir);
  for (const path of [from, target]) {
    if (resolve(path) !== join(root, basename(path))) {
      throw new Error(`refusing to rename outside ${root}`);
    }
  }
  if (recordingPath !== null && resolve(from) === resolve(recordingPath)) {
    throw new Error(`${id} is being recorded right now: stop the take before renaming it`);
  }

  const index = await cachedIndex(from);
  if (index.hash !== hash) {
    throw new Error(
      `${id} is ${index.hash} here, not the ${hash} this rename named: `
      + 'the library moved underneath the request and nothing was renamed',
    );
  }

  // Every name the new id would claim, not only the capture's. A stray marks log at
  // the target with no take beside it is somebody's footage annotations waiting for a
  // take to come back, and renaming over it would destroy them to satisfy a name.
  for (const path of [target, marksPathFor(target), indexPathFor(target)]) {
    try {
      await stat(path);
      throw new Error(`${to} is taken: ${basename(path)} is already in ${root}`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  // **Linked and then unlinked, never renamed, and that is the difference between a
  // refusal and destroyed footage.** The `stat` loop above is check-then-act: two
  // renames onto one name both pass it, and `rename(2)` replaces an existing file
  // without a word, so the second one silently overwrites a take. Reachable from two
  // tabs. `link(2)` fails with EEXIST atomically instead, so the loser is refused by
  // the kernel rather than by a reading taken a moment earlier - the stat stays
  // because it is what produces a sentence naming the file in the way, where EEXIST
  // alone would only produce an errno.
  //
  // What the two-step admits is a window where the take has both names, if this
  // process dies between the link and the unlink. That is two library entries with
  // one hash, which the reconciliation already treats as one take and an operator can
  // see and remove - the opposite kind of failure from the one being closed, and the
  // right way round.
  const linkInto = async (source, dest) => {
    try {
      await link(source, dest);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      if (err.code === 'EEXIST') throw new Error(`${to} is taken: ${basename(dest)} appeared in ${root} while this rename was running`);
      throw err;
    }
  };
  const marksMoved = await linkInto(marksPathFor(from), marksPathFor(target));
  try {
    if (!await linkInto(from, target)) throw new Error(`${id} is no longer in ${root}`);
  } catch (err) {
    if (marksMoved) await unlink(marksPathFor(target)).catch(() => {});
    throw err;
  }
  try {
    await unlink(from);
  } catch (err) {
    // **ENOENT is not a failure to undo, it is the old name already being gone - and
    // undoing it here destroys the take.** The link above returning true proves `from`
    // existed at that moment, so the only way it can be missing now is a concurrent
    // operation having removed it, and `removeTake` is the one that does: it streams a
    // sha256 of the whole capture before unlinking, which is a window long enough to
    // hold this entire rename. Delete unlinks the old name, this unlink reports ENOENT,
    // and the rollback below then unlinks `target` - which by then is the capture's last
    // directory entry, so two individually safe actions destroy the footage between
    // them. The take is already where this rename wanted it, so there is nothing to put
    // back: the operation has succeeded and says so.
    //
    // This is the reading the block above already argues for. Its answer to the process
    // dying mid-rename is that a capture reachable under two names is "the opposite kind
    // of failure from the one being closed, and the right way round", and the same
    // ordering holds here: a delete that returns while the take survives under its new
    // name is a surprising answer, and a rollback that unlinks the only remaining entry
    // is unrecoverable. Two concurrent renames of one take land in the same place, both
    // linking their own target and the loser finding the source gone - which now leaves
    // two names for one capture that the reconciliation joins by hash, rather than one
    // rename silently deleting the other's result.
    if (err.code !== 'ENOENT') {
      // Every other errno does mean the capture has both names and this could not drop
      // the old one, so the rename is undone rather than left half-done: a second entry
      // nobody asked for is worse than a name that did not change.
      await unlink(target).catch(() => {});
      if (marksMoved) await unlink(marksPathFor(target)).catch(() => {});
      throw err;
    }
  }
  if (marksMoved) await unlink(marksPathFor(from)).catch(() => {});
  // The sidecar validates on the capture's size and modification time, both of which
  // `rename` preserves, so moving it is what stops the next reader re-scanning the
  // whole take for a fact that was already on disk.
  await rename(indexPathFor(from), indexPathFor(target))
    .catch(() => unlink(indexPathFor(from)).catch(() => {}));
  forgetCapture(from);
  forgetCapture(target);
  return { renamed: `${id}.knct`, id: to, file: `${to}.knct`, hash: index.hash, marks: marksMoved };
}

// ------------------------------------------------------------ showing a take in situ

/**
 * How each platform is asked to show a file where it lives.
 *
 * One entry per platform rather than a chain of `process.platform ===`, so a platform
 * this does not know is a sentence rather than a spawn of something that is not there.
 * The argument shape is the platform's, and `--reveal-with` substitutes **only the
 * program** - a proof tool pointing this at a script that records its argv is then
 * measuring the arguments the real file manager would have received, rather than a
 * second code path written to be measurable.
 */
export const REVEAL = {
  darwin: { program: 'open', label: 'Finder', args: (path) => ['-R', path] },
  // No `-R` equivalent exists across the desktops `xdg-open` fronts, so the
  // containing directory is opened and the take is one glance rather than selected.
  linux: { program: 'xdg-open', label: 'the file manager', args: (path) => [dirname(path)] },
  win32: { program: 'explorer', label: 'Explorer', args: (path) => [`/select,${path}`] },
};

export const revealSupport = () => {
  const shape = REVEAL[process.platform];
  return shape ? { supported: true, label: shape.label } : { supported: false, label: null };
};

/**
 * Opens the platform's file manager on a take.
 *
 * **This is the only route in the program that starts a process on the operator's
 * behalf, so what bounds it is written here rather than assumed from the caller.** The
 * id is held to `VALID_ID` and the path is asserted to be a direct child of the
 * captures directory, so nothing a caller types decides what is opened; the program is
 * a fixed string per platform or the one `--reveal-with` names, so nothing a caller
 * types decides what is run; and `spawn` is given an argument array with no shell, so
 * a filename cannot be a command however it is spelt. Who may ask at all - a browser
 * on this machine and not one across the link - is the route's question rather than
 * this function's, because the answer is about the socket the request arrived on.
 *
 * Resolved on the spawn rather than on the exit. `open -R` returns immediately and
 * `xdg-open` may not return until the file manager closes, so waiting for an exit code
 * would hang one platform to learn nothing on another - and the failure worth
 * reporting, a file manager that is not installed, arrives as an `error` event either
 * way.
 */
export async function revealTake(dir, id, { program = null } = {}) {
  if (!VALID_ID.test(id)) throw new Error(`unusable take id ${id}`);
  const shape = REVEAL[process.platform];
  if (!shape) {
    throw new Error(`no file manager is known for ${process.platform}, so there is nothing to open a take in`);
  }
  const root = resolve(dir);
  const path = join(root, `${id}.knct`);
  if (resolve(path) !== join(root, `${id}.knct`)) throw new Error(`refusing to reveal outside ${root}`);
  await stat(path);
  const args = shape.args(path);
  const bin = program ?? shape.program;
  return new Promise((settle, fail) => {
    const child = spawn(bin, args, { stdio: 'ignore', detached: true });
    child.on('error', (err) => fail(new Error(`${bin} could not be started: ${err.message}`)));
    child.on('spawn', () => {
      // Detached and unreferenced, so a file manager left open does not keep this
      // process alive - the server outliving a request is the point, the request
      // outliving the file manager is not.
      child.unref();
      settle({ revealed: `${id}.knct`, path, program: bin, args, label: shape.label });
    });
  });
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
