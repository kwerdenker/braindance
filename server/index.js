// Bridges the native Kinect grabber to the browser: spawns (or replays) the
// framed binary stream and fans it out over WebSocket, while serving the viewer.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, mkdirSync, readdirSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, normalize, extname, sep, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { MessageParser, encodeMessage, TYPE_HELLO, TYPE_FRAME } from './protocol.js';
import { openCapture, withCapture, captureIdFor, openCaptureCount } from './capture.js';
import { handleExportSocket, MAX_FRAME_BYTES } from './export.js';
import {
  VALID_ID, DocumentStore, NodeLink, appendMarks, downloadTake, hashFile, markWriteCount,
  readMarkLog, readMarks, reconcile, remaining, removeTake, resolveMarks, scanTakes,
} from './library.js';
import { Recorder } from './recorder.js';
import { requireMutation, originAllowed } from './http-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const PORT = Number(flag('--port', '8080'));
// Loopback unless somebody says otherwise, and saying otherwise is a flag rather
// than a default, because this server has no authentication of any kind: the
// recorder's arm, start and stop are reachable by anything that can route to the
// port. A capture node genuinely has to be reachable - the whole two-machine
// design is a browser on the Mac driving a node over Wi-Fi - so `--host 0.0.0.0`
// is a supported and expected thing to type. What it must not be is what happens
// when nobody thought about it.
//
// The origin checks are the other half and they are not a substitute for this one.
// Host equality cannot survive DNS rebinding in general: a name the attacker
// controls, resolving to the node's LAN address, makes `Origin` and `Host` the
// same string, so the request is genuinely same-origin by every test a server can
// run on itself. That is an argument for not being on the network by default, not
// a hole in the guard - the guard stops the ordinary drive-by, and the bind
// address stops the thing that has to be routable to be attacked at all.
const LOOPBACK = '127.0.0.1';
const HOST = flag('--host', LOOPBACK);
const REPLAY = flag('--replay');
// Recording is a runtime action now rather than a path on the command line: a
// take is a file, start opens one and stop closes it, so `--record` only says
// whether the first take should arm itself as soon as the sensor says hello.
const RECORD = has('--record');
// The capture node this library reconciles against, if any. A node is an ordinary
// instance of this server with no `--node` of its own - it never learns it is
// being read - so the link is one-directional and always initiated from here.
const NODE_URL = flag('--node');
const NODE_NAME = flag('--node-name', 'node');
const HERE_NAME = flag('--name', NODE_URL ? 'mac' : 'node');
// No fallback on purpose. Which depth processors exist is a property of the
// libfreenect2 this grabber was built against - macOS has OpenCL and no OpenGL,
// the Pi's V3D the reverse - and the grabber already picks the fastest one its
// own build contains. Defaulting to 'cl' here would hand the Pi a processor that
// is not compiled in, which the grabber now rejects rather than silently falling
// back, so the capture node would never start.
const PIPELINE = flag('--pipeline');
const NO_COLOR = has('--no-color');

// A browser that falls behind must never build a queue - a stale point cloud
// reads as "the Kinect is slow". Drop frames instead.
const MAX_BUFFERED = 4 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
};

const WEB_DIR = join(ROOT, 'web');
const THREE_DIR = join(ROOT, 'node_modules/three');
// The grabber binary. A flag because the one on this machine is not the only one
// that matters: a cross-built grabber lands outside the tree, and the recorder's
// own proof needs a writer it can start, stop and kill on demand without a sensor
// in the room.
// Space-separated, so the flag can carry the writer's own arguments. A real
// grabber takes its settings from the flags below; a stand-in needs to be told what
// to stream and when to die, and threading that through a second flag would be a
// second way to say one thing.
const [GRABBER_BIN, ...GRABBER_ARGS] = (flag('--grabber') ?? '').split(' ').filter(Boolean);

// Where takes live. A flag rather than a constant because a capture node and an
// editing machine are the same program, and the only way to run both on one host -
// which is how the reconciliation is tested at all - is to give them separate
// directories. On a real node and a real Mac this is the default either way.
const CAPTURES_DIR = resolve(flag('--captures', join(ROOT, 'captures')));
const EXPORTS_DIR = join(ROOT, 'exports');

// A bare startsWith would also match a sibling like `web-private`, so the
// separator has to be part of the comparison.
const isInside = (dir, candidate) => candidate === dir || candidate.startsWith(dir + sep);

// A capture is addressed by id - its file name without the extension - resolved
// inside the captures directory. Ids arrive off the URL, so anything that could
// name a path rather than a take is rejected outright rather than normalised and
// hoped about; the leading character rules out `..` on its own. The pattern lives
// in the library module because a node's manifest is a second door ids come
// through, and one rule is the whole of the safety property.
// `--replay` may name a file anywhere, so the replayed take registers its own id.
const captureAliases = new Map();

// The node keeps its own preset library on disk, refreshed when an editing
// machine connects. It has to: the node serves its own recorder page and may well
// be shooting with nothing connected to it, and a scheme that pushed presets over
// a socket per session would leave a standalone node with an empty selector -
// which is exactly the shoot where the operator cannot go and fix it.
const PROJECTS = new DocumentStore(resolve(flag('--projects', join(ROOT, 'projects'))), 'project');
const PRESETS = new DocumentStore(resolve(flag('--presets', join(ROOT, 'presets'))), 'preset');
const node = NODE_URL ? new NodeLink(NODE_URL, NODE_NAME) : null;

function capturePathFor(id) {
  if (captureAliases.has(id)) return captureAliases.get(id);
  return VALID_ID.test(id) ? join(CAPTURES_DIR, `${id}.knct`) : null;
}

// The frame API: the browser asks for a frame or a run, the server preads it out
// of the capture and returns the bytes unchanged. Two response shapes, because
// the two calls want different things. A single frame is the payload alone -
// byte for byte what `broadcastFrame` puts on the socket - so the pulled and the
// pushed path hand the same decoder the same input. A run is the file's own
// slice, framing included, because payloads concatenated have no boundaries left
// to parse back and the headers that supply them are already interleaved.
/**
 * Opening a capture, and the two ways it fails.
 *
 * Every reader here holds a lease for exactly as long as its handler runs - see
 * `withCapture` - which is what keeps a descriptor from being evicted underneath a
 * read in progress.
 */
/**
 * The take the recorder has open is not readable through this API until it closes.
 *
 * One rule rather than one exclusion in the manifest, and this is the stronger half
 * of it: the manifest describing the open take without scanning it stops the
 * *gallery* from re-hashing a growing file, but `GET /capture/:id/index` and
 * `GET /capture/:id/frame/0` reach the same scan by a shorter road - and a scan is a
 * full read plus sha256 against the disk the recorder is writing to. It also cannot
 * answer honestly: an index over a file that is still growing describes bytes that
 * were true when the read started, and the hash it carries names a take that no
 * longer exists a frame later.
 */
function beingRecorded(path) {
  return path !== null && path === recorder.openPath;
}

async function withOpenCapture(res, id, fn) {
  const path = capturePathFor(id);
  if (!path) {
    res.writeHead(404).end('unknown capture');
    return;
  }
  if (beingRecorded(path)) {
    sendJson(res, { error: `${id} is being recorded right now: it has no settled index or hash until the take closes` }, 409);
    return;
  }
  await withCapture(path, fn).catch((err) => {
    if (res.headersSent) return;
    if (err.code === 'ENOENT') res.writeHead(404).end('unknown capture');
    else res.writeHead(500).end(`capture unreadable: ${err.message}`);
  });
}

// The sensor's own intrinsics, as the grabber reported them when the take was
// recorded. The timeline path has no socket to hear them on, and unprojecting a take
// on the boot defaults is wrong in a way nothing on screen can show - every point
// translates together, so both arms of every comparison are wrong identically. Step
// 2's scan already recorded where the hello sits, so this is one positioned read.
const serveHello = (req, res, [id]) => withOpenCapture(res, id, async (capture) => {
  const payload = await capture.readHello();
  if (!payload) {
    res.writeHead(404).end('this capture carries no hello');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME['.json'],
    'Content-Length': payload.length,
    'Cache-Control': 'no-cache',
  });
  res.end(payload);
});

const serveIndex = (req, res, [id]) => withOpenCapture(res, id, (capture) => {
  const body = Buffer.from(JSON.stringify(capture.index));
  res.writeHead(200, {
    'Content-Type': MIME['.json'],
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
});

const inCapture = (capture, n) => Number.isInteger(n) && n >= 0 && n < capture.frameCount;

const serveFrame = (req, res, [id, index], query) => withOpenCapture(res, id, async (capture) => {
  const n = Number(index);
  if (!inCapture(capture, n)) {
    res.writeHead(404).end('no such frame');
    return;
  }
  // The depth divisor. A network concession and never a compute one - the node
  // sustains full rate, and this exists because a radio link cannot carry
  // 14.6 MB/s. Absent or 1 returns the payload byte for byte, so the editor's path
  // is exactly what it was; above 1 the frame comes back sampled down and still a
  // KNCT frame, which is what lets the monitor, the editor over a slow link and the
  // gallery's skim all be one mechanism rather than three.
  const divisor = Number(query.get('decimate') ?? 1);
  if (!Number.isInteger(divisor) || divisor < 1 || divisor > 16) {
    res.writeHead(400).end('decimate must be a whole number from 1 to 16');
    return;
  }
  let payload;
  try {
    payload = await capture.readFrame(n, divisor);
  } catch (err) {
    // A frame whose declared lengths do not describe the bytes it carries is
    // refused rather than sampled past - the alternative is a response whose tail
    // is this process's own recycled heap.
    res.writeHead(422).end(err.message);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': payload.length,
    'Cache-Control': 'no-cache',
    // Said rather than left to be inferred: a decimated frame carries a different
    // grid, and a client that guessed it from the byte count would have to know the
    // divisor it asked for was honoured.
    'X-Depth-Divisor': String(divisor),
  });
  res.end(payload);
});

const serveFrameRun = (req, res, [id, from, to]) => withOpenCapture(res, id, async (capture) => {
  const a = Number(from);
  const b = Number(to);
  if (!inCapture(capture, a) || !inCapture(capture, b) || a > b) {
    res.writeHead(404).end('no such range');
    return;
  }
  const { start, end } = capture.frameRunSpan(a, b);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': end - start + 1,
    'Cache-Control': 'no-cache',
  });
  // `pipeline` rather than `pipe`, because the headers are already out by the time
  // anything can go wrong. A bare pipe leaves a read error as an unhandled stream
  // event, which takes the whole process down - replay, socket fan-out and static
  // server with it - and leaves a client that walked away mid-run holding a reader
  // nobody stops. This tears down both ends either way; the response is truncated
  // against its declared length, which is the only honest signal left once a 200
  // has been sent.
  //
  // Awaited, and that is load-bearing rather than tidy: the caller holds a lease on
  // this capture for exactly as long as this function runs, and a descriptor evicted
  // while a run was still reading off it would fail inside a stream whose errors
  // nobody is positioned to catch.
  await new Promise((done) => {
    pipeline(capture.createFrameRunStream(a, b), res, (err) => {
      if (err) console.error(`[server] frame run ${id} ${a}-${b} failed: ${err.message}`);
      done();
    });
  });
});

// The whole take, streamed, for a download across the link. Streamed rather than
// read: a take is routinely past the 2 GiB that `readFileSync` refuses, and this is
// the one route whose whole purpose is to move that much.
function serveTakeFile(req, res, [id]) {
  const path = capturePathFor(id);
  // A take still being written has no length that will still be true when the
  // transfer ends, and the download on the other side verifies against a hash this
  // one cannot produce yet - so it is refused here rather than moving gigabytes that
  // will be discarded on arrival.
  if (beingRecorded(path)) {
    sendJson(res, { error: `${id} is being recorded right now: it is still growing, so there is no whole file to send` }, 409);
    return;
  }
  let stat;
  try {
    stat = statSync(path ?? '');
  } catch {
    res.writeHead(404).end('unknown capture');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  pipeline(createReadStream(path), res, (err) => {
    if (err) console.error(`[server] serving ${id} failed: ${err.message}`);
  });
}

// Marks are a sidecar beside the take rather than anything inside it, so they are
// answered without opening the capture at all - which is what lets the gallery draw
// a scrub bar for two hundred takes without holding two hundred descriptors. A take
// whose bytes have gone still has its marks.
//
// A write is an append and never a rewrite, which is what makes moving, renaming and
// deleting a mark all the same operation: a later record with the same id supersedes
// an earlier one, and a deletion is a tombstone. That is also the whole of the
// two-machine merge - concatenate and resolve - so there is one rule here rather
// than one for editing and one for syncing.
const takeIsHere = (path) => {
  try {
    statSync(path ?? '');
    return true;
  } catch {
    return false;
  }
};

async function serveMarks(req, res, [id], query, { log = false } = {}) {
  const path = capturePathFor(id);
  if (!takeIsHere(path)) {
    res.writeHead(404).end('unknown capture');
    return;
  }
  const entries = await readMarkLog(path);
  sendJson(res, log ? { log: entries } : { marks: resolveMarks(entries) });
}

async function serveMarkWrite(req, res, [id]) {
  const path = capturePathFor(id);
  // A take that is not here has no moments to flag. Without this the route accepted
  // any id matching `VALID_ID` and *created* the sidecar - so a caller could write
  // `nosuchtake.marks.jsonl` into the captures directory, with attacker-chosen JSON
  // up to four megabytes a request and tombstones that would delete real marks the
  // moment a take of that name ever existed. Marks hang off a take, so the take is
  // the thing that has to exist first.
  if (!takeIsHere(path)) {
    sendJson(res, { error: `no take ${id} here, so there is nothing to mark` }, 404);
    return;
  }
  const body = await readBody(req);
  const now = Date.now();
  const records = (body.marks ?? []).map((m) => ({
    ...m,
    // Stamped here when the caller did not, because `at` is what orders two
    // machines' edits and a record without one cannot participate in the merge at
    // all - the resolver drops it rather than guessing.
    at: Number.isFinite(m.at) ? m.at : now,
  }));
  await appendMarks(path, records);
  sendJson(res, { marks: resolveMarks(await readMarkLog(path)) });
}

// ------------------------------------------------------------------ the library

/**
 * How many file descriptors this process is holding, as the kernel sees it.
 *
 * `/dev/fd` is the calling process's own descriptor table on Darwin and Linux both,
 * so this needs no external tool and no permission. The listing itself opens one,
 * which is a constant every reading pays equally and so cancels out of a comparison.
 * Returns null where the path does not exist, so a platform that cannot answer says
 * so rather than reporting zero.
 */
function realDescriptorCount() {
  try {
    return readdirSync('/dev/fd').length;
  } catch {
    return null;
  }
}

const sendJson = (res, body, status = 200) => {
  const text = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Content-Length': text.length,
    'Cache-Control': 'no-cache',
  });
  res.end(text);
};

// Bounded on purpose. Every body this server accepts is a project, a preset or a
// handful of marks - tens of kilobytes of JSON - and a request that keeps sending
// is a request nobody meant.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function readBody(req) {
  return new Promise((done, fail) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        fail(new Error(`body over ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        done({});
        return;
      }
      try {
        done(JSON.parse(text));
      } catch (err) {
        fail(new Error(`body is not JSON: ${err.message}`));
      }
    });
    req.on('error', fail);
  });
}

/**
 * This machine's own takes, which is also what a node answers when asked.
 *
 * The take being written is named on the way in so the manifest can describe it
 * without scanning it - see `describeTake`. A gallery polling a node that is
 * shooting is the ordinary case, not an unusual one.
 */
const localTakes = () => scanTakes(CAPTURES_DIR, recorder.openPath);

/**
 * The one library, spanning both machines and joined by content hash.
 *
 * A node that cannot be reached is reported as unreachable rather than as having
 * no takes. Those are different facts and conflating them would make a dropped
 * Wi-Fi link look like an operator who deleted everything - and the tile that then
 * offered a Delete on the last copy would be offering it on the wrong belief.
 */
async function serveLibrary(req, res) {
  const here = await localTakes();
  const there = node ? await node.takes() : null;
  const takes = reconcile(here.takes, there);
  sendJson(res, {
    here: HERE_NAME,
    node: node ? { name: node.name, url: node.url, reachable: there !== null, error: node.lastError } : null,
    takes,
    unreadable: here.unreadable,
    storage: await remaining(CAPTURES_DIR, recordingRate()),
    recording: recorder.state,
  });
}

/**
 * The two removals, which are genuinely different actions rather than one action
 * with two buttons.
 *
 * Reclaim is recoverable because a hash-verified copy exists elsewhere, and the
 * verification happens *here, now*, against the machine that is supposed to be
 * keeping the copy - not against a manifest taken some time ago. Delete is the
 * last copy and is the only irreversible action in this tool, so it refuses when a
 * second copy exists rather than quietly doing a reclaim under the wrong name.
 */
async function serveRemoval(req, res, [id], kind) {
  const body = await readBody(req);
  const here = await localTakes();
  const mine = here.takes.find((t) => t.id === id);
  // The take the recorder has open is not a candidate for either action. It has no
  // hash yet - the bytes are still arriving - so neither removal can verify anything
  // about it, and unlinking the file underneath a running write stream loses the
  // shoot in progress rather than a take somebody finished with.
  if (mine?.recording) {
    sendJson(res, { error: `${id} is being recorded right now: stop the take before removing it` }, 409);
    return;
  }
  const there = node ? await node.takes() : null;
  const theirs = (there ?? []).find((t) => t.hash === (mine?.hash ?? body.hash));

  if (kind === 'reclaim') {
    // Reclaim removes the node's copy, which is the case the operator who just
    // filled a card actually has. The surviving copy is the local one, and it is
    // re-hashed rather than trusted: a local file truncated since the last listing
    // would otherwise be treated as the copy that makes this recoverable.
    if (!mine) {
      sendJson(res, { error: `${id} is not on this machine, so there is nothing here to keep` }, 409);
      return;
    }
    if (!theirs) {
      sendJson(res, { error: `${id} is not on ${node?.name ?? 'any node'}: there is nothing to reclaim` }, 409);
      return;
    }
    const verified = await hashFile(join(CAPTURES_DIR, mine.file));
    if (verified !== mine.hash) {
      sendJson(res, {
        error: `refusing to reclaim ${id}: the copy here hashes ${verified}, not the ${mine.hash} `
          + 'the library listed, so it is not the verified copy this reclaim rests on',
      }, 409);
      return;
    }
    try {
      const done = await node.fetchJson(`/library/delete/${encodeURIComponent(theirs.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash: theirs.hash, confirm: true, verifiedElsewhere: verified }),
      });
      sendJson(res, { reclaimed: done, keptHere: verified });
    } catch (err) {
      sendJson(res, { error: `the node refused the reclaim: ${err.message}` }, 502);
    }
    return;
  }

  // Delete. The confirm is required rather than implied, and it names the hash, so
  // a request built against one listing cannot remove a take that changed since.
  if (body.confirm !== true) {
    sendJson(res, { error: 'delete needs an explicit confirm: this is the only irreversible action here' }, 400);
    return;
  }
  if (!mine) {
    sendJson(res, { error: `${id} is not on this machine` }, 404);
    return;
  }
  // `verifiedElsewhere` is what a reclaim arriving from the other machine carries,
  // and it turns this same route into the recoverable action. Without it this is a
  // delete, and a delete of something that exists in two places is refused - the
  // operator asked for the wrong one of two different actions.
  if (!body.verifiedElsewhere && theirs) {
    sendJson(res, {
      error: `${id} exists on ${node.name} as well: reclaim removes a copy, delete removes the last one`,
    }, 409);
    return;
  }
  try {
    const done = await removeTake(CAPTURES_DIR, id, {
      hash: body.hash,
      verifiedElsewhere: body.verifiedElsewhere ?? null,
    });
    sendJson(res, done);
  } catch (err) {
    sendJson(res, { error: err.message }, 409);
  }
}

async function serveRemoteFrame(req, res, [id, n], query) {
  if (!node || !VALID_ID.test(id) || !/^\d+$/.test(n)) {
    res.writeHead(404).end('not found');
    return;
  }
  const divisor = Number(query.get('decimate') ?? 1);
  if (!Number.isInteger(divisor) || divisor < 1 || divisor > 16) {
    res.writeHead(400).end('decimate must be a whole number from 1 to 16');
    return;
  }
  const upstream = await fetch(`${node.url}/capture/${encodeURIComponent(id)}/frame/${n}?decimate=${divisor}`);
  if (!upstream.ok) {
    res.writeHead(upstream.status).end('the node could not serve that frame');
    return;
  }
  const body = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
    'X-Depth-Divisor': String(divisor),
  });
  res.end(body);
}

async function serveDownload(req, res, [id]) {
  if (!node) {
    sendJson(res, { error: 'no capture node is linked, so there is nothing to download from' }, 409);
    return;
  }
  const there = await node.takes();
  if (there === null) {
    sendJson(res, { error: `${node.name} is unreachable: ${node.lastError}` }, 502);
    return;
  }
  const take = there.find((t) => t.id === id);
  if (!take) {
    sendJson(res, { error: `${node.name} has no take ${id}` }, 404);
    return;
  }
  // A take the node is still shooting has no hash to verify the transfer against,
  // and the download is verified or it is discarded. Refused here with the reason
  // rather than pulled and thrown away several gigabytes later.
  if (take.recording) {
    sendJson(res, { error: `${node.name} is still recording ${id}: it has no hash to check the copy against yet` }, 409);
    return;
  }
  try {
    const path = await downloadTake(node, take, CAPTURES_DIR);
    sendJson(res, { downloaded: basename(path), hash: take.hash, bytes: take.bytes });
  } catch (err) {
    sendJson(res, { error: err.message }, 502);
  }
}

/**
 * A store of small JSON documents - projects, and the preset library the recorder
 * and the editor share. One handler for both because they are the same storage
 * problem, and two would drift.
 */
const listDocuments = async (res, store) => sendJson(res, { [`${store.kind}s`]: await store.list() });

async function readDocument(res, store, name) {
  try {
    sendJson(res, await store.read(name));
  } catch {
    sendJson(res, { error: `no ${store.kind} named ${name}` }, 404);
  }
}

async function writeDocument(req, res, store, name) {
  if (req.method === 'DELETE') {
    try {
      sendJson(res, await store.remove(name));
    } catch {
      // Removing what is not there is a 404 rather than the uncaught ENOENT that
      // used to come back as a 500 with a path in it.
      sendJson(res, { error: `no ${store.kind} named ${name}` }, 404);
    }
    return;
  }
  try {
    sendJson(res, await store.write(name, await readBody(req)));
  } catch (err) {
    // A document this build cannot faithfully interpret is a refusal with a reason
    // rather than a 500 - see `DocumentStore.write` on why the version is checked
    // rather than restamped.
    sendJson(res, { error: err.message }, 409);
  }
}

/**
 * The library routes. Everything here is HTTP, deliberately: the frame API is
 * HTTP for the reasons step 2 settled, and a second socket would be a second
 * endpoint to keep honest for a request pattern that is one call per gesture.
 */

/**
 * Two machines can hold the same take and different marks, and the merge needs no
 * algorithm because the log is append-only and every record carries an id: pull
 * the node's log, append it, and let the resolver keep the highest `at` per id. A
 * deletion is a tombstone like any other, so it cannot be resurrected by an older
 * log arriving late.
 */
async function serveMarkSync(req, res, [id]) {
  if (!node) {
    sendJson(res, { error: 'no capture node is linked' }, 409);
    return;
  }
  const path = capturePathFor(id);
  if (!path) {
    sendJson(res, { error: `unusable take id ${id}` }, 400);
    return;
  }
  try {
    // The node's *name* for this take, resolved by hash. Asking it for the log
    // under the name this machine uses would return nothing whenever the two
    // machines named the same footage differently - which is the case the whole
    // library is built to handle, so the one place that reached for a filename
    // would be the one place the design does not hold.
    const here = (await localTakes()).takes.find((t) => t.id === id);
    const theirTakes = await node.takes();
    const match = here && (theirTakes ?? []).find((t) => t.hash === here.hash);
    if (!match) {
      sendJson(res, { merged: 0, marks: await readMarks(path), note: `${node.name} does not hold this take` });
      return;
    }
    const theirs = await node.fetchJson(`/capture/${encodeURIComponent(match.id)}/marks/log`);
    const mine = await readMarkLog(path);
    // Appended rather than rewritten. Both logs stay whole, which is what makes
    // this safe to run twice and safe to run from both machines.
    const known = new Set(mine.map((r) => `${r.id}@${r.at}`));
    const fresh = (theirs.log ?? []).filter((r) => !known.has(`${r.id}@${r.at}`));
    await appendMarks(path, fresh);
    sendJson(res, { merged: fresh.length, marks: await readMarks(path) });
  } catch (err) {
    sendJson(res, { error: err.message }, 502);
  }
}

/**
 * Record control.
 *
 * The spec puts this on the existing WebSocket, so that any connected client can
 * arm or stop the take it is watching and every monitor sees the state change.
 * The second half still holds - the state is broadcast to every socket below - but
 * the control itself is an HTTP call, because the socket's connection handler is
 * being changed elsewhere and two edits crossing in that region is how a security
 * fix gets buried inside a gallery commit. The property the spec cares about is
 * that a phone watching the monitor can start the take and press mark, and a POST
 * from that phone does that.
 */
/**
 * Record control.
 *
 * The spec puts this on the existing WebSocket, so that any connected client can arm
 * or stop the take it is watching and every monitor sees the state change. The
 * second half still holds - the state is broadcast to every socket below - but the
 * control itself is an HTTP call, because the socket's connection handler is being
 * changed elsewhere and two edits crossing in that region is how a security fix gets
 * buried inside a gallery commit. The property the spec cares about is that a phone
 * watching the monitor can start the take and press mark, and a POST from that phone
 * does that.
 *
 * All three are `write` entries in the table above, which is what puts them behind
 * the one gate. `GET /record/stop` used to end a shoot and disarm the node, which is
 * the silent-stop failure this design spent a round closing, reached from outside
 * the process by anything that could persuade a browser to load a URL.
 */
const shooting = (run) => async (req, res, args, query) => {
  try {
    await run(req, res, args, query);
  } catch (err) {
    sendJson(res, { error: err.message }, 409);
  }
};

const serveRecordStart = shooting(async (req, res) => sendJson(res, await recorder.start(helloJson)));
const serveRecordStop = shooting(async (req, res) => sendJson(res, { stopped: await recorder.stop() }));
const serveRecordMark = shooting(async (req, res) => {
  const body = await readBody(req);
  // The moment the operator pressed, in source milliseconds from the take's first
  // frame. Supplied by the caller when it knows - the monitor does, since it is
  // holding the frame - and taken from the take's own elapsed wall clock when it
  // does not. In the body and only in the body: this used to accept a `?sourceMs=`
  // query as well, which was a second way to say one thing and reachable at all only
  // because the route took a GET.
  const sourceMs = Number(body.sourceMs ?? NaN);
  const at = Number.isFinite(sourceMs) ? sourceMs : Date.now() - (recorder.state.startedAt ?? Date.now());
  sendJson(res, recorder.mark(at, body.label));
});

/**
 * The table, as data, for the proof tool to walk.
 *
 * Derived from `ROUTES` itself rather than restated, so there is no second list to
 * fall behind the first - which is the whole reason this exists rather than a
 * comment naming the routes that change something.
 */
function serveRoutes(req, res) {
  sendJson(res, {
    routes: ROUTES.map((r) => ({
      path: r.path,
      read: Boolean(r.read),
      // A route that changes something is a route with a write, and this is that
      // fact rather than a label beside it.
      mutates: Boolean(r.write),
      methods: r.write?.methods ?? [],
    })),
  });
}

/**
 * How many times this process has written each store, ever.
 *
 * **Read by the proof tool, and it is a different kind of evidence from the contents.**
 * The route sweep asserts that nothing answering GET changes anything, and it did that
 * by reading the stores either side of the drive - which a handler that writes and then
 * restores inside the same request defeats by construction, because both readings are
 * taken outside it. Putting the bytes back is easy and putting the modification time
 * back is one `utimes` call. A monotonic count of writes is the one quantity a restore
 * cannot undo, so the sweep asserts on this and compares contents as the second opinion.
 *
 * The general form is the mirror of the descriptor rule beside it: there, the resource
 * was true and the bookkeeping lied; here the contents lie and the bookkeeping is the
 * only honest witness. Which one to trust is decided by what the failure can forge.
 */
const serveWriteCounts = (req, res) => sendJson(res, {
  projects: PROJECTS.writes, presets: PRESETS.writes, marks: markWriteCount(),
});
const serveRemaining = async (req, res) => sendJson(res, await remaining(CAPTURES_DIR, recordingRate()));
const serveDescriptors = (req, res) => sendJson(res, { open: openCaptureCount(), real: realDescriptorCount() });
const serveRecordState = async (req, res) => sendJson(res, {
  ...recorder.state, storage: await remaining(CAPTURES_DIR, recordingRate()),
});

async function serveLocalTakes(req, res) {
  const here = await localTakes();
  sendJson(res, { here: HERE_NAME, ...here, storage: await remaining(CAPTURES_DIR, recordingRate()) });
}

/**
 * The HTTP surface, as one table, walked by one dispatcher.
 *
 * **The table is the dispatch, which is what stops it drifting from the behaviour.**
 * The routes used to be a ladder of `if (seg[1] === ...)` with the guard written
 * into whichever branches somebody remembered, and what that produced was six routes
 * that changed something while dispatching on the path alone - `GET /record/stop`
 * ending a shoot, `GET /library/reclaim/:id` destroying the node's copy. Fixing them
 * one at a time would leave the seventh route somebody adds next month outside
 * whatever list was written today.
 *
 * So a route is not a branch, it is an entry: a pattern, a `read` handler for GET
 * and HEAD, and a `write` handler for everything else. **Having a `write` is how a
 * route declares that it changes something**, and the dispatcher below puts every
 * `write` through `requireMutation` - method, origin and content type - in one
 * place. There is no way to add a route that mutates without either registering it
 * as a write, in which case it is guarded, or hiding the mutation inside a `read`,
 * which `library-check` probes for directly by driving every read route and
 * asserting the library did not move.
 *
 * The table is served at `/library/routes` so the check can enumerate rather than
 * name: an arm that lists the six routes a reviewer happened to poke is an arm that
 * tests those six, and an arm that walks this table tests the rule.
 */
const ROUTES = [
  // ---- a capture, read
  { path: '/capture/:id/hello', pattern: /^\/capture\/([^/]+)\/hello$/, read: serveHello },
  { path: '/capture/:id/index', pattern: /^\/capture\/([^/]+)\/index$/, read: serveIndex },
  { path: '/capture/:id/file', pattern: /^\/capture\/([^/]+)\/file$/, read: serveTakeFile },
  { path: '/capture/:id/frame/:n', pattern: /^\/capture\/([^/]+)\/frame\/(\d+)$/, read: serveFrame },
  { path: '/capture/:id/frames/:a-:b', pattern: /^\/capture\/([^/]+)\/frames\/(\d+)-(\d+)$/, read: serveFrameRun },
  { path: '/capture/:id/marks/log', pattern: /^\/capture\/([^/]+)\/marks\/log$/, read: (req, res, args, query) => serveMarks(req, res, args, query, { log: true }) },
  // ---- a capture, written
  { path: '/capture/:id/marks', pattern: /^\/capture\/([^/]+)\/marks$/, read: serveMarks, write: { methods: ['POST'], run: serveMarkWrite } },

  // ---- the library, read
  { path: '/library/takes', pattern: /^\/library\/takes$/, read: serveLocalTakes },
  { path: '/library/all', pattern: /^\/library\/all$/, read: serveLibrary },
  { path: '/library/remaining', pattern: /^\/library\/remaining$/, read: serveRemaining },
  // Read by the proof tool, because the descriptor bound this build introduces has
  // to be measurable rather than asserted in a comment.
  //
  // **Two numbers, and the second one is the point.** `open` is the capture module's
  // own bookkeeping, and the bug that dropped a capture from the map while leaving
  // its descriptor open made that number *fall* while the real count rose - so an
  // arm reading only `open` would have watched a descriptor leak and recorded it as
  // a descriptor being released. `real` is what the kernel says this process holds,
  // which is the quantity the claim is actually about. The general form of that is
  // worth stating once: an assertion about a resource should read the resource, not
  // the bookkeeping that claims to track it.
  { path: '/library/descriptors', pattern: /^\/library\/descriptors$/, read: serveDescriptors },
  { path: '/library/routes', pattern: /^\/library\/routes$/, read: serveRoutes },
  { path: '/library/writes', pattern: /^\/library\/writes$/, read: serveWriteCounts },
  // A frame of a take that is only on the node, fetched through here rather than by
  // the browser reaching across. One origin for the page, and the node stays a
  // machine this server talks to rather than one every browser on the network does -
  // which is also what keeps the decimation decision on the side that knows how the
  // link is behaving.
  { path: '/library/remote-frame/:id/:n', pattern: /^\/library\/remote-frame\/([^/]+)\/([^/]+)$/, read: serveRemoteFrame },

  // ---- the library, written
  { path: '/library/download/:id', pattern: /^\/library\/download\/([^/]+)$/, write: { methods: ['POST'], run: serveDownload } },
  { path: '/library/delete/:id', pattern: /^\/library\/delete\/([^/]+)$/, write: { methods: ['POST'], run: (req, res, args) => serveRemoval(req, res, args, 'delete') } },
  { path: '/library/reclaim/:id', pattern: /^\/library\/reclaim\/([^/]+)$/, write: { methods: ['POST'], run: (req, res, args) => serveRemoval(req, res, args, 'reclaim') } },
  { path: '/library/sync-marks/:id', pattern: /^\/library\/sync-marks\/([^/]+)$/, write: { methods: ['POST'], run: serveMarkSync } },

  // ---- documents
  { path: '/projects', pattern: /^\/projects\/?$/, read: (req, res) => listDocuments(res, PROJECTS) },
  { path: '/presets', pattern: /^\/presets\/?$/, read: (req, res) => listDocuments(res, PRESETS) },
  {
    path: '/projects/:name',
    pattern: /^\/projects\/([^/]+)$/,
    read: (req, res, args) => readDocument(res, PROJECTS, args[0]),
    write: { methods: ['PUT', 'POST', 'DELETE'], run: (req, res, args) => writeDocument(req, res, PROJECTS, args[0]) },
  },
  {
    path: '/presets/:name',
    pattern: /^\/presets\/([^/]+)$/,
    read: (req, res, args) => readDocument(res, PRESETS, args[0]),
    write: { methods: ['PUT', 'POST', 'DELETE'], run: (req, res, args) => writeDocument(req, res, PRESETS, args[0]) },
  },

  // ---- recording
  { path: '/record/state', pattern: /^\/record\/state$/, read: serveRecordState },
  { path: '/record/start', pattern: /^\/record\/start$/, write: { methods: ['POST'], run: serveRecordStart } },
  { path: '/record/stop', pattern: /^\/record\/stop$/, write: { methods: ['POST'], run: serveRecordStop } },
  { path: '/record/mark', pattern: /^\/record\/mark$/, write: { methods: ['POST'], run: serveRecordMark } },
];

// The namespaces the table owns, taken from the table. Every `path` starts with a
// slash and a literal segment, so the first segment is the namespace; anything
// else in the table would be a route with no namespace to own, which is a bug in
// the entry rather than something to tolerate here.
//
// Derived once at module load rather than per request - it cannot change, and a
// `Set` lookup is what the request path pays instead of a regex.
export const OWNED_NAMESPACES = new Set(ROUTES.map((r) => {
  const first = r.path.split('/')[1];
  if (!first || first.startsWith(':')) {
    throw new Error(`route ${r.path} has no namespace segment, so nothing can own it`);
  }
  return first;
}));

/**
 * One dispatcher, and the only place a mutating route is let through.
 *
 * Returns false for a path no entry claims, so the static file server downstream
 * still gets its turn. A path that exists but not in this direction - a GET of a
 * write-only route, most of all - answers 405 and names what it does take, without
 * running anything.
 */
async function serveRoute(req, res, urlPath, query) {
  const reading = req.method === 'GET' || req.method === 'HEAD';
  const offered = new Set();
  for (const r of ROUTES) {
    const m = r.pattern.exec(urlPath);
    if (!m) continue;
    const args = m.slice(1).map((a) => decodeURIComponent(a));
    if (reading && r.read) {
      await r.read(req, res, args, query);
      return true;
    }
    if (!reading && r.write) {
      // The one gate, applied here rather than inside ten handlers. A route reaches
      // its handler only by having a `write`, and a `write` reaches its handler only
      // through this line.
      if (!requireMutation(req, res, r.write.methods)) return true;
      await r.write.run(req, res, args, query);
      return true;
    }
    if (r.read) offered.add('GET');
    for (const method of r.write?.methods ?? []) offered.add(method);
  }
  if (offered.size === 0) return false;
  res.setHeader('Allow', [...offered].join(', '));
  sendJson(res, {
    error: `${req.method} is not how ${urlPath} is called: it takes ${[...offered].join(' or ')}`,
  }, 405);
  return true;
}



const httpServer = createServer((req, res) => {
  let urlPath;
  let query;
  try {
    const url = new URL(req.url, 'http://localhost');
    urlPath = decodeURIComponent(url.pathname);
    query = url.searchParams;
  } catch {
    // A malformed percent escape such as /%zz throws here, and an exception
    // thrown out of this handler ends the process - taking replay, the socket
    // fan-out and the viewer with it over a request nobody meant.
    res.writeHead(400).end('bad request');
    return;
  }

  // The table first, the file tree second. `serveRoute` answers false only for a
  // path no entry claims at all, which is what leaves the viewer, three and the
  // exports directory reachable below.
  let handledByTable = true;
  try {
    handledByTable = ROUTES.some((r) => r.pattern.test(urlPath));
  } catch {
    handledByTable = false;
  }
  if (handledByTable) {
    serveRoute(req, res, urlPath, query)
      .then((handled) => {
        if (!handled) res.writeHead(404).end('not found');
      })
      .catch((err) => {
        console.error('[server] request failed:', err.message);
        if (!res.headersSent) sendJson(res, { error: err.message }, 500);
        else res.end();
      });
    return;
  }

  // A path under a namespace the table owns but matching no entry is a 404 rather
  // than a file lookup: without this `/library/../web/main.js` and friends would
  // fall through to the static server, and more plainly a typo'd route would answer
  // with a directory listing's 404 instead of the API's.
  //
  // The set is derived from ROUTES rather than written out, because the five names
  // it used to spell were a list somebody had to remember to extend. `jobs` is what
  // made that concrete: step 8 adds a namespace, and a literal that did not mention
  // it sends `/jobs/../web/main.js` to the static server while every other namespace
  // gets the API's 404. Fixing the instance would have left the next one outside the
  // list, which is the failure this repo already closed once for the route table's
  // own dispatch - so the namespaces are the table's first segments, and a route
  // added later is covered by existing rather than by being noticed.
  if (OWNED_NAMESPACES.has(urlPath.split('/')[1])) {
    res.writeHead(404).end('not found');
    return;
  }

  let filePath;
  if (urlPath.startsWith('/vendor/three/')) {
    filePath = join(THREE_DIR, urlPath.slice('/vendor/three/'.length));
  } else if (urlPath.startsWith('/exports/')) {
    // Served so a finished export can be played back where it was made, in the
    // browser, rather than only inspected with a probe. A video that decodes is
    // the last thing an export has to prove and the only one a metadata check
    // cannot make.
    filePath = join(EXPORTS_DIR, urlPath.slice('/exports/'.length));
  } else {
    filePath = join(WEB_DIR, urlPath === '/' ? 'index.html' : urlPath);
  }

  const resolved = normalize(filePath);
  if (!isInside(WEB_DIR, resolved) && !isInside(THREE_DIR, resolved) && !isInside(EXPORTS_DIR, resolved)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const stat = statSync(resolved);
    if (!stat.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[extname(resolved)] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(resolved).pipe(res);
  } catch {
    res.writeHead(404).end('not found');
  }
});

// Two sockets on one port, routed here rather than by handing each server the
// http server. `ws` aborts an upgrade whose path it does not recognise, so two
// servers attached that way would each destroy the other's handshakes - the
// second one to see the event would 400 a socket the first had already taken.
const wss = new WebSocketServer({ noServer: true });
// Compression off, said rather than inherited: an export is raw RGBA over
// loopback precisely so no CPU is spent on bytes that were never scarce, and a
// deflate negotiated by default would undo that decision silently.
const exportWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES });

httpServer.on('upgrade', (req, socket, head) => {
  // The same origin rule the mutating routes stand behind, asked here because a
  // socket is the one door it did not cover. `WebSocket` is exempt from the
  // same-origin policy and sends no preflight, so any page anywhere could open one
  // against a node on the visitor's own network and drive it - and this socket is
  // not a read-only view: it carries the recorder's arm, start and stop. The
  // content-type and method halves of `requireMutation` are meaningless for an
  // upgrade, which is why `originAllowed` is exported without a `res` to write to.
  //
  // Asked before the path is routed, so a page from somewhere else gets one answer
  // rather than learning which paths exist by how they are refused.
  if (!originAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  let path;
  try {
    path = new URL(req.url, 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  const target = path === '/export' ? exportWss : path === '/' ? wss : null;
  if (!target) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

exportWss.on('connection', (ws) => {
  console.log('[export] client connected');
  ws.on('error', (err) => console.error('[export] socket error:', err.message));
  handleExportSocket(ws, { outDir: EXPORTS_DIR });
});

let helloJson = null;
const stats = { frames: 0, dropped: 0, bytes: 0, since: Date.now() };
// The measured byte rate of what is actually arriving, which is what the
// remaining-time report should divide free space by. Falls back to the nominal
// 486KB at 30fps before anything has arrived, because an operator opening the
// library on a cold server still needs a number.
let observedBytesPerSec = 0;
const recordingRate = () => (observedBytesPerSec > 0 ? observedBytesPerSec : undefined);

let sensorState = 'starting';

function broadcastText(text) {
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(text);
}

function setSensorState(state) {
  sensorState = state;
  broadcastText(JSON.stringify({ status: state }));
}

// Live camera settings the viewer can change. Colour on/off has to restart the
// grabber because it decides which streams the device is told to open at all;
// low light is a command the running grabber applies in place.
const camera = { color: !NO_COLOR, lowLight: true };
let applyCamera = null; // wired up by startLive; absent in replay

wss.on('connection', (ws) => {
  ws.binaryType = 'nodebuffer';
  console.log(`[server] client connected (${wss.clients.size} total)`);
  if (helloJson) ws.send(helloJson);
  ws.send(JSON.stringify({ status: sensorState }));
  ws.send(JSON.stringify({ camera }));
  ws.on('error', (err) => console.error('[server] socket error:', err.message));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return; // a client sending junk is not the server's problem
    }
    if (!msg || typeof msg.camera !== 'object' || !msg.camera) return;
    if (!applyCamera) return;

    const next = {
      color: typeof msg.camera.color === 'boolean' ? msg.camera.color : camera.color,
      lowLight: typeof msg.camera.lowLight === 'boolean' ? msg.camera.lowLight : camera.lowLight,
    };
    applyCamera(next);
  });
});

function broadcastFrame(payload) {
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      stats.dropped++;
      continue;
    }
    ws.send(payload);
  }
  stats.frames++;
  stats.bytes += payload.length;
}

// One take is one file, and the recorder is what holds that identity. It is
// created here rather than inside `startLive` because the HTTP routes above have
// to be able to reach it whether or not a sensor ever appears - a library on a
// machine with nothing plugged in still answers what it is recording, which is
// nothing.
const recorder = new Recorder({
  dir: CAPTURES_DIR,
  // A replay server cannot record, and refusing is the answer rather than making it
  // work. Its frames come off a file on a loop, so their stamps repeat - and one
  // take is one continuous stream with monotonic stamps, which the index, the retime
  // curve and `mixT` all rest on. What it would produce is a near-copy of a take
  // that already exists under a different name and a different hash, which is the
  // ambiguity that reconciling by content hash exists to remove. The record button
  // on the viewer disables itself off this, because it is unconditional otherwise
  // and this is one click away in the setup this repo documents.
  cannotRecord: REPLAY
    ? `this server is replaying ${basename(REPLAY)} rather than reading a sensor, and a replay loops `
      + '- its frames repeat their own timestamps, so what it wrote would not be a take'
    : null,
  // The rate the library reports, so the refusal to start a take and the
  // remaining-time readout beside it are dividing free space by the same number.
  rateOf: () => recordingRate(),
  // Every monitor sees the recording state change, which is the property the spec
  // asks record control for. The control itself arrives over HTTP; the state comes
  // back on the socket every client is already listening to.
  onChange: (state) => broadcastText(JSON.stringify({ recording: state })),
});

function handleMessage(msg) {
  if (msg.type === TYPE_HELLO) {
    helloJson = msg.payload.toString('utf8');
    console.log(`[server] sensor: ${helloJson}`);
    for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(helloJson);
    // A take begins at a hello and nowhere else. That is what makes a restart
    // split rather than corrupt: the file that was open is already closed by the
    // time this runs, and this opens the next one.
    recorder.onHello(helloJson);
  } else if (msg.type === TYPE_FRAME) {
    // Broadcast first, then record. Both happen in this same turn either way, so
    // nothing is lost by the order - what it decides is which one a failure in the
    // other can take down. A monitor that goes dark reads as a dead sensor and sends
    // somebody to check the hardware mid-shoot, where a recorder problem already has
    // its own state, its own log line and its own place on the surface.
    broadcastFrame(msg.payload);
    // The whole message rather than the payload, so the take file carries the
    // framing the format is defined by and the recorded bytes stay identical to
    // what the grabber wrote. Every caller supplies it; the replay loop did not, and
    // one open take then turned every frame into a throw that landed in the replay
    // tick's catch - no frame reached any client, the status flapped between lost
    // and live, and `/record/state` reported a healthy recording the whole time.
    recorder.write(msg.raw);
  }
}

setInterval(() => {
  const dt = (Date.now() - stats.since) / 1000;
  if (stats.frames === 0) return;
  const fps = (stats.frames / dt).toFixed(1);
  const mbs = (stats.bytes / dt / 1e6).toFixed(1);
  observedBytesPerSec = stats.bytes / dt;
  console.log(`[server] ${fps} fps  ${mbs} MB/s  dropped=${stats.dropped}  clients=${wss.clients.size}`);
  Object.assign(stats, { frames: 0, dropped: 0, bytes: 0, since: Date.now() });
}, 5000);

// The Kinect v2 drops off the bus under sustained load on a marginal USB link,
// so a dead grabber is an expected condition, not a fatal one. Respawn it.
const RESTART_DELAYS = [1000, 2000, 4000, 8000];

function startLive() {
  const bin = GRABBER_BIN ? resolve(GRABBER_BIN) : join(ROOT, 'native/build/grabber');
  const buildArgs = () => {
    const a = [...GRABBER_ARGS, ...(PIPELINE ? ['--pipeline', PIPELINE] : [])];
    if (!camera.color) a.push('--no-color');
    if (!camera.lowLight) a.push('--no-low-light');
    return a;
  };

  let child = null;
  let attempt = 0;
  let shuttingDown = false;
  let restarting = false;

  const spawnGrabber = () => {
    const grabberArgs = buildArgs();
    console.log(`[server] starting grabber: ${bin} ${grabberArgs.join(' ')}`);
    setSensorState('starting');

    const parser = new MessageParser();
    // stdin is a pipe so settings that do not need a restart can be sent to the
    // running grabber instead of costing a multi-second device reopen.
    child = spawn(bin, grabberArgs, { stdio: ['pipe', 'pipe', 'inherit'] });
    child.stdin.on('error', () => { /* the grabber can exit mid-write */ });
    // A grabber that cannot be spawned at all - not built here, or built for
    // another architecture - arrives as an `error` event rather than an exit, and
    // an unhandled one on a ChildProcess takes the whole process down: listener,
    // library routes and every connected socket with it. The design already calls a
    // dead grabber an expected condition and backs off; a missing one is the same
    // condition arriving earlier, and it must not be the one shape that is fatal.
    // Surfaced by running this server on a machine with no sensor at all, which is
    // exactly what a library on an editing machine is.
    child.on('error', (err) => {
      console.error(`[server] grabber could not start: ${err.message}`);
    });

    child.stdout.on('data', (chunk) => {
      try {
        for (const msg of parser.push(chunk)) {
          handleMessage(msg);
          if (msg.type === TYPE_HELLO) {
            attempt = 0; // a clean handshake means the link is healthy again
            setSensorState('live');
          }
        }
      } catch (err) {
        // A desynced stream is unrecoverable; restarting rebuilds the framing.
        console.error('[server]', err.message);
        child.kill('SIGTERM');
      }
    });

    child.on('exit', (code, signal) => {
      console.error(`[server] grabber exited (code=${code} signal=${signal})`);
      // The take ends here. One take is one continuous stream with one hello and
      // monotonic timestamps, and the index, the retime curve and `mixT` all depend
      // on it - a blend fraction across a restart seam has no meaning, and the
      // intrinsics in a second hello could legally differ from the first. Nothing
      // is discarded; the recording so far is a complete take and the next hello
      // opens the next one.
      recorder.split().catch((err) => console.error(`[recorder] ${err.message}`));
      if (shuttingDown) return;
      if (restarting) {
        // Asked for, not a failure - so it does not count toward the backoff.
        restarting = false;
        setTimeout(spawnGrabber, 250);
        return;
      }
      setSensorState('lost');
      const delay = RESTART_DELAYS[Math.min(attempt, RESTART_DELAYS.length - 1)];
      attempt++;
      console.log(`[server] restarting grabber in ${delay}ms (attempt ${attempt})`);
      setTimeout(spawnGrabber, delay);
    });
  };

  applyCamera = (next) => {
    const needsRestart = next.color !== camera.color;
    const lowLightChanged = next.lowLight !== camera.lowLight;
    if (!needsRestart && !lowLightChanged) return;

    Object.assign(camera, next);
    broadcastText(JSON.stringify({ camera }));

    if (needsRestart) {
      console.log(`[server] colour camera ${camera.color ? 'on' : 'off'} - restarting grabber`);
      restarting = true;
      attempt = 0;
      child?.kill('SIGTERM');
      return;
    }
    // Colour off means there is no exposure to set, but the flag is still worth
    // remembering so it takes effect when colour comes back.
    if (camera.color) {
      console.log(`[server] low light ${camera.lowLight ? 'on' : 'off'}`);
      child?.stdin.write(`low-light ${camera.lowLight ? 'on' : 'off'}\n`);
    }
  };

  // Armed at boot rather than recording at boot: the take still opens on the hello,
  // through the same door a take opened from the library goes through, so there is
  // one path into a take file rather than two. Armed *before* the grabber is
  // spawned, because arming reads the disk and a hello arriving during that read
  // would find the recorder still disarmed and start no take at all - which on a
  // node booted to record is the whole shoot.
  if (RECORD) {
    recorder.start(null).then(spawnGrabber, (err) => {
      console.error(`[recorder] ${err.message}`);
      spawnGrabber();
    });
  } else {
    spawnGrabber();
  }

  process.on('SIGINT', () => {
    shuttingDown = true;
    child?.kill('SIGTERM');
    // Closed and scanned before the process goes, because a take without a sidecar
    // index is a take the gallery has to rebuild - and the format is append-only,
    // so whatever landed is readable either way. This is a courtesy, not the
    // guarantee; the guarantee is that the bytes are already on disk.
    recorder.close('server stopped').finally(() => process.exit(0));
  });
}

async function startReplay() {
  let capture;
  try {
    capture = await openCapture(REPLAY);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`[server] no capture at ${REPLAY} — record one first: npm run record`);
    } else {
      // Anything else is a real failure of the reader and has to say so. A
      // blanket catch here used to report every error as a missing file, which
      // is how a capture the old whole-file read simply refused to open came to
      // look like a capture nobody had recorded.
      console.error(`[server] cannot open ${REPLAY}: ${err.message}`);
    }
    return;
  }

  // Retained, because this reader outlives every request and holds no lease of its
  // own - see `Capture.retain`. A replay whose descriptor is evicted by a gallery
  // skimming a directory fails every read afterwards and reports it as a lost
  // sensor, which is the one failure mode that looks like the hardware.
  capture.retain();

  // The replayed take is reachable over the frame API under its own id even when
  // it lives outside the captures directory.
  captureAliases.set(captureIdFor(REPLAY), resolve(REPLAY));

  const stamps = capture.index.frames.stampMs;
  if (stamps.length === 0) {
    console.error('[server] replay file contains no frames');
    return;
  }

  console.log(`[server] replaying ${REPLAY}`);
  const hello = await capture.readHello();
  if (hello) handleMessage({ type: TYPE_HELLO, payload: hello, raw: encodeMessage(TYPE_HELLO, hello) });

  // Replay the recorded arrival spacing rather than a uniform 30fps. A live
  // stream is deeply irregular - measured p50 64ms against p90 222ms - and
  // pacing every frame 33ms apart hands the viewer the one cadence that never
  // happens, so interpolation tuned against replay looks right here and stutters
  // on the sensor. Frame 0 anchors the loop; the gap after the last frame reuses
  // the median so the wrap does not stall.
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]).filter((g) => g > 0 && g < 2000);
  const median = gaps.length ? gaps.slice().sort((a, b) => a - b)[gaps.length >> 1] : 33;
  gaps.push(median);

  console.log(
    `[server] ${stamps.length} frames indexed, median gap ${median}ms, ${capture.index.hash}`,
  );

  // A replayed take is as live as this server gets, and saying so is what gives
  // the lost state below something to mean.
  setSensorState('live');

  let i = 0;
  let failing = false;
  const schedule = () => {
    const gap = gaps[i % gaps.length];
    i++;
    setTimeout(tick, gap);
  };
  // Each frame is read at the moment it is due, so replaying a five-minute take
  // costs the same memory as replaying a nine-second one. The read is awaited
  // before the timer is set, which adds its own duration to every gap - measured
  // at 0.07 to 0.6ms against a 64ms median, so under 1% and inside the slop the
  // old in-memory loop already had.
  const tick = () => {
    capture
      .readFrame(i % stamps.length)
      .then((payload) => {
        if (failing) {
          failing = false;
          console.log('[server] replay reads recovered');
          setSensorState('live');
        }
        // A whole message, framing included, because that is what `handleMessage`
        // is documented to take and what everything downstream of it reads. The
        // replay used to hand over a bare payload with no `raw`, which nothing
        // noticed until a take was open - so the invariant is restored here rather
        // than left to the refusal above being the only thing standing between this
        // loop and a throw per frame. One header and one copy per frame, against the
        // half-megabyte read that produced the payload.
        handleMessage({ type: TYPE_FRAME, payload, raw: encodeMessage(TYPE_FRAME, payload) });
        schedule();
      })
      .catch((err) => {
        // A read that fails must not freeze the loop in silence. A viewer holding
        // its last frame looks exactly like a paused take, so the state goes to
        // lost the way it does when the grabber dies, and the loop keeps trying
        // at the recorded cadence rather than stopping - a transient failure then
        // recovers on its own. Logged on the transition only, or a take whose
        // file went away would fill the console every 64ms.
        if (!failing) {
          failing = true;
          console.error(`[server] replay read failed: ${err.message}`);
          setSensorState('lost');
        }
        schedule();
      });
  };
  tick();
}

// The captures directory is created rather than assumed. A reflashed node has none,
// which is the state step 9 provisions from - and without this it boots disarmed
// with a raw `ENOENT: no such file or directory, statfs '/...'` coming back through
// `/record/state` and `/library/all`, so the panel in the room shows an errno and
// nothing on screen says the shoot cannot start. A directory that cannot be created
// is reported and the server still comes up: the library half of this program is
// exactly what somebody would open to find out why.
try {
  mkdirSync(CAPTURES_DIR, { recursive: true });
} catch (err) {
  console.error(`[server] no captures directory at ${CAPTURES_DIR} and it could not be made: ${err.message}`);
}

httpServer.listen(PORT, HOST, () => {
  console.log(`[server] viewer on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (HOST !== LOOPBACK) {
    console.log(`[server] reachable from the network on ${HOST} - anyone who can route here can drive the recorder`);
  }
  if (REPLAY) startReplay().catch((err) => console.error(`[server] replay failed: ${err.message}`));
  else startLive();
});
