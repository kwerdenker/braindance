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
import { Readable } from 'node:stream';
import { basename, join, resolve } from 'node:path';
import { cachedIndex, forgetCapture, indexPathFor, captureIdFor, readHelloOnce } from './capture.js';

// A capture is addressed by id, and an id arrives off a URL or out of a node's
// manifest, so it is checked against this before it is ever joined to a path. The
// leading character rules out `..` on its own; the rest rules out a separator.
export const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
 * Appends records. Append-only is what makes this safe without a lock: a crash
 * keeps every mark written before it, and two writers interleave into a log the
 * resolver can still read.
 */
export async function appendMarks(capturePath, records) {
  const lines = records.map((rec) => `${JSON.stringify(rec)}\n`).join('');
  if (lines) await appendFile(marksPathFor(capturePath), lines);
}

// ------------------------------------------------------------------- manifest

/**
 * One take as the gallery sees it. Read through `cachedIndex`, which holds no
 * descriptor, so a directory of two hundred takes costs two hundred sidecar reads
 * and nothing that stays open.
 */
async function describeTake(dir, file) {
  const path = join(dir, file);
  const id = captureIdFor(path);
  const st = await stat(path);
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
    marks,
  };
}

/**
 * Every take in a directory. Failures are per take rather than per listing: one
 * capture with a desynced stream must not take the gallery down with it, because
 * the gallery is where you would go to delete it.
 */
export async function scanTakes(dir) {
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
      takes.push(await describeTake(dir, file));
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
      return body.takes.filter((t) => VALID_ID.test(t.id));
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
  for (const take of localTakes) {
    byHash.set(take.hash, { ...take, state: 'local', local: take, remote: null });
  }
  for (const take of nodeTakes ?? []) {
    const held = byHash.get(take.hash);
    if (held) {
      held.state = 'both';
      held.remote = take;
      continue;
    }
    byHash.set(take.hash, { ...take, state: 'remote', local: null, remote: take });
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
  const fs = await statfs(dir);
  const freeBytes = fs.bavail * fs.bsize;
  const secondsLeft = bytesPerSec > 0 ? freeBytes / bytesPerSec : Infinity;
  return { freeBytes, bytesPerSec, secondsLeft, label: durationLabel(secondsLeft) };
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
export async function downloadTake(node, take, dir) {
  if (!VALID_ID.test(take.id)) throw new Error(`the node offered an unusable id: ${take.id}`);
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
  await pipeline(Readable.fromWeb(res.body), createWriteStream(temp));

  // The same streaming scan step 2 built, against the file that actually landed.
  // Re-deriving the hash from the node's answer would only be restating it.
  const got = await hashFile(temp);
  if (got !== take.hash) {
    await unlink(temp).catch(() => {});
    throw new Error(
      `${take.id} arrived as ${got}, not the ${take.hash} the node advertised: `
      + 'discarded rather than filed under a hash it does not have',
    );
  }
  await rename(temp, target);
  forgetCapture(target);

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
 */
export async function removeTake(dir, id, { hash, verifiedElsewhere = null }) {
  if (!VALID_ID.test(id)) throw new Error(`unusable take id ${id}`);
  const path = join(dir, `${id}.knct`);
  const index = await cachedIndex(path);
  if (index.hash !== hash) {
    throw new Error(
      `${id} is ${index.hash} here, not the ${hash} this removal named: `
      + 'the library moved underneath the request and nothing was removed',
    );
  }
  if (verifiedElsewhere !== null && verifiedElsewhere !== index.hash) {
    throw new Error(
      `refusing to reclaim ${id}: the copy that is supposed to survive reports `
      + `${verifiedElsewhere}, not ${index.hash} - that is a different take, and this `
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
  return { removed: `${id}.knct`, hash: index.hash };
}

// ------------------------------------------------- projects and the preset library

/**
 * A directory of JSON documents with a version on every one. Projects and presets
 * are the same storage problem - small JSON, named by the user, content-hashed so
 * a provenance stamp can point at a revision - so they are one class rather than
 * two that drift.
 */
export class DocumentStore {
  constructor(dir, kind) {
    this.dir = dir;
    this.kind = kind;
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
   * Writes a document, stamping the format version on the way in.
   *
   * Written aside and renamed, for the same reason step 2's sidecar is: a crash
   * partway through a write must not leave a file that parses and describes
   * something that was never saved.
   */
  async write(name, body) {
    await mkdir(this.dir, { recursive: true });
    const path = this.pathFor(name);
    const text = `${JSON.stringify({ ...body, version: PROJECT_VERSION }, null, 2)}\n`;
    await writeFile(`${path}.tmp`, text);
    await rename(`${path}.tmp`, path);
    return { name, rev: `sha256:${createHash('sha256').update(text).digest('hex')}`, bytes: text.length };
  }

  async remove(name) {
    await unlink(this.pathFor(name));
    return { removed: name };
  }
}

export const captureDirOf = (dir) => resolve(dir);
