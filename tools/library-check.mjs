// Proves the gallery and the library: one manifest over a directory of takes, one
// library spanning two machines joined by content hash, a project that survives a
// round trip through a file, and the two removals doing what their names say.
//
// **This check owns its servers rather than taking one.** Every other proof tool
// here points at a running instance, and this one cannot: its central claim is
// about *two* machines reconciling, which needs two processes with separate
// capture directories, and three of its mutations are in server code that no
// served page can reach. So it builds a fixture directory, spawns a node and an
// editing machine against a copy of `server/`, and tears both down. What it points
// at is therefore exactly what it built, which is also what makes the fixture
// arms below possible at all.
//
// Six claims, checked apart because they fail for different reasons.
//
// The **manifest** has to report the hash step 2's scan produces, and has to stop
// reporting it the moment the bytes change. A gallery that served a stale hash
// would hand the reconciliation below a lie and hand a project file a take that is
// no longer the take it was authored against.
//
// **Reconciliation is by content hash and never by name.** Both directions: the
// same bytes under two different filenames are one take, and different bytes under
// the same filename are two.
//
// A **project round-trips through a file**. Save it, load it back, render the same
// program positions: the same images. That is the claim step 3 made for the
// registry, extended to the door a file arrives through - with the same
// falsification control, since an equality between two renders of the same live
// state would pass against a loader wired to nothing.
//
// The **load path refuses**. A project file is the first thing in this build that
// comes from outside the running page, and three known gaps converge on it: an
// unversioned document whose point size cannot be interpreted, a retime curve that
// falls, and a quaternion that is not of unit length. Each is a *silent* wrong
// image rather than a crash, which is why each is checked by name.
//
// **Reclaim and delete are different actions.** The falsification control is not
// that reclaim runs - it is that reclaim *refuses* when the copy it rests on is
// not the copy it thinks: the surviving take is corrupted on disk and the reclaim
// has to notice, which an implementation trusting a manifest that said `both` a
// moment ago cannot.
//
// And **the descriptor bound holds**, because step 2 left that debt to this step
// by name. Skimming a directory of takes must not accumulate open files.
//
// The arms sweep what the interface actually offers rather than what is convenient.
// Step 6 learned this the expensive way: every arm of `export-check` was aspect
// 1.6 while every size the export menu ships is 16:9, so a whole class of scaling
// bug was invisible however many arms agreed. The constants this tool sweeps are
// therefore checked against the constants the gallery and the server offer - the
// three states, the two divisors the tiles use plus both ends of the range the
// server accepts, zero, one and several marks, a mark at the very start and a mark
// past the end of the edit, a truncated take, a take with no hello, a take with
// one frame, and an empty library. Anything the UI can produce that this does not
// stand in front of is a hole until it is measured otherwise.
//
//   node tools/library-check.mjs
//   node tools/library-check.mjs --mutate reconcile-by-filename   # ... and must FAIL

import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, readdirSync, rmSync, symlinkSync, existsSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { MessageParser, TYPE_HELLO, TYPE_FRAME, encodeMessage } from '../server/protocol.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SAMPLE = flag('--capture') ?? join(REPO, 'captures/sample.knct');
const NODE_PORT = Number(flag('--node-port', '8210'));
const MAC_PORT = Number(flag('--mac-port', '8211'));
const MUTATE = flag('--mutate');
const HEADED = argv.includes('--headed');
const WORK = flag('--work') ?? join(REPO, '.library-check');

let failures = 0;
let assertions = 0;
// Claims this run could not make a fixture for. Named in the verdict rather than
// left out of it: a check that quietly drops an assertion where the platform will
// not give it a fixture is a check reporting coverage it does not have.
const skipped = [];
const check = (ok, label, detail = '') => {
  assertions++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --------------------------------------------------------------------- mutations
//
// A mutation is a piece of source text, so it stops matching the moment the code it
// names is edited - and the exactly-once refusal below is the only warning anyone
// gets that an anchor has gone stale. A replacement that silently matched nothing
// would run the unmutated build and be recorded as this tool having missed a bug it
// was never shown.
//
// Server files and page files both appear here, in one table. The server ones are
// possible because this check spawns its own servers out of a copied tree; the page
// ones are served into the browser by route. One namespace, because the safety
// property is the refusal and splitting it would make it possible to have two rules
// about it.

const MUTATIONS = {
  // The library joins on the filename instead of the hash. Two names for one take
  // become two takes, and the payoff of hash-referencing captures is gone.
  'reconcile-by-filename': { file: 'server/library.js', edits: [
    ['    byHash.set(take.hash, { ...take, state: \'local\', local: take, remote: null });',
      '    byHash.set(take.id, { ...take, state: \'local\', local: take, remote: null });'],
    ['    const held = byHash.get(take.hash);',
      '    const held = byHash.get(take.id);'],
    ['    byHash.set(take.hash, { ...take, state: \'remote\', local: null, remote: take });',
      '    byHash.set(take.id, { ...take, state: \'remote\', local: null, remote: take });'],
  ] },
  // The index cache stops testing whether the sidecar still describes the file, so
  // a take whose bytes changed keeps reporting the hash it had before.
  'manifest-trusts-cache': { file: 'server/capture.js', edits: [[
    '  if (held && held.bytes === st.size && held.mtimeMs === st.mtimeMs) return held;',
    '  if (held) return held;',
  ]] },
  // Reclaim trusts the listing instead of re-hashing the copy that is supposed to
  // survive. A take truncated since the last listing is then treated as the
  // verified copy this reclaim rests on, and the node's copy goes anyway.
  'reclaim-trusts-manifest': { file: 'server/index.js', edits: [[
    '    const verified = await hashFile(join(CAPTURES_DIR, mine.file));',
    '    const verified = mine.hash;',
  ]] },
  // Descriptors are never evicted, which is the shape step 2 shipped and named as
  // this step's debt: a library skimming a directory of takes hits EMFILE.
  'no-fd-eviction': { file: 'server/capture.js', edits: [[
    '  if (openCaptures.size <= MAX_OPEN_CAPTURES) return;',
    '  if (true) return;',
  ]] },
  // The replay's handle goes back to being evictable. It holds no lease and its
  // `usedAt` never moves, so it is not merely a candidate - it is the *first* one,
  // and a library skimmed while a replay is running closes the replay's own
  // descriptor underneath it.
  'replay-handle-evictable': { file: 'server/index.js', edits: [[
    '  capture.retain();',
    '  /* mutation: the replay holds no lease */',
  ]] },
  // The take file gets no hello, so the recording is complete and unopenable: its
  // intrinsics are unknown, and unprojecting it on the boot defaults is an error
  // nothing on screen can show. This is the falsification control for the
  // hello-at-head row, which would otherwise be an assertion that a `1` is a `1`.
  //
  // It replaced a mutation that deferred the take's opening by a microtask, and the
  // replacement is worth recording rather than quietly swapping. That mutation
  // **provably moved nothing**, twice, with the writer arranged as adversarially as
  // a pipe allows - hello and a ten-frame burst in a single `write`. The reason is
  // structural: one frame is 486KB and a pipe's buffer is 64KB, so a `data` event
  // carrying the hello can carry at most a fragment of the frame behind it, the
  // parser yields the hello alone, and the deferred open completes before any whole
  // frame arrives. The ordering was still made synchronous, because a property that
  // holds because of a buffer size is not a property - but it is hardening rather
  // than a measured fix, and a mutation that does nothing reads as a check that
  // found nothing.
  'recorder-skips-hello': { file: 'server/recorder.js', edits: [[
    '    stream.write(encodeMessage(TYPE_HELLO, Buffer.from(helloPayload)));',
    '    /* mutation: the take begins at the first frame */',
  ]] },
  // A grabber restart no longer ends the take, so the next hello and a timestamp
  // discontinuity land in the middle of a take file - which every downstream
  // consumer assumes cannot happen.
  'restart-appends-to-take': { file: 'server/index.js', edits: [[
    "      recorder.split().catch((err) => console.error(`[recorder] ${err.message}`));",
    '      /* mutation: the take runs across the restart */',
  ]] },
  // A take starts however little room is left, so it dies partway through instead
  // of never starting.
  'recorder-ignores-space': { file: 'server/recorder.js', edits: [[
    '    if (left.secondsLeft < MIN_TAKE_SEC) {',
    '    if (false) {',
  ]] },
  // A name already taken disarms the recorder instead of stepping over it. This is
  // the shape that shipped for one round: a second writer on the same captures
  // directory silently stops a shooting node with one line in the log, which is
  // worse than refusing to start, because refusing to start is at least a decision
  // somebody can see.
  'eexist-disarms': { file: 'server/recorder.js', edits: [[
    `        console.warn(\`[recorder] \${id} is already taken, trying the next name\`);
        floor = n;`,
    `        console.warn(\`[recorder] \${id} is already taken\`);
        this.armed = false;
        this.onChange(this.state);
        return;`,
  ]] },
  // The depth divisor strides the flat byte array instead of sampling per axis, so
  // the count is right and the grid is not: every k-th sample along one row and
  // none at all along the column.
  'decimate-flat-stride': { file: 'server/capture.js', edits: [[
    `    for (let x = 0; x < w; x++) out.writeUInt16LE(payload.readUInt16LE(src + x * k * 2), dst + x * 2);`,
    `    for (let x = 0; x < w; x++) out.writeUInt16LE(payload.readUInt16LE(16 + ((y * w + x) * k) * 2), dst + x * 2);`,
  ]] },
  // The colour block is dropped from a decimated frame. Still smaller, still a
  // KNCT frame, and no longer the mechanism the 21ms-per-position number describes -
  // colour is 52KB of that 79KB.
  'decimate-drops-colour': { file: 'server/capture.js', edits: [
    ['    out.writeUInt32LE(colorBytes, 4);', '    out.writeUInt32LE(0, 4);'],
    ['    payload.copy(out, 16 + w * h * 2, 16 + depthBytes);', '    /* mutation: colour dropped */'],
  ] },
  // The document version stops being checked, so a file whose point size is in the
  // old unit loads silently and draws 1.8x wrong at every output size.
  'accept-any-version': { file: 'web/main.js', edits: [[
    '  if (project.version !== PROJECT_VERSION) {',
    '  if (false) {',
  ]] },
  // The retime guard comes off the file door. This is the door step 5 named and
  // left open, and a descending region does not merely fail - it can pass the
  // residency guard vacuously and stop playback with the play button still lit.
  'load-skips-monotonic': { file: 'web/main.js', edits: [[
    '  retime.assertMonotonic(restoredRetime);',
    '  /* mutation: the curve arrives unchecked */',
  ]] },
  // The quaternion length check comes off, which is the gap step 5 carried: four
  // finite numbers accepted as a rotation, and a camera move nobody authored.
  'accept-any-quaternion': { file: 'web/main.js', edits: [[
    '    if (Math.abs(len - 1) > 1e-3) {',
    '    if (false) {',
  ]] },
  // Track key values stop going through the registry on the way in, so the
  // quaternion check above is never reached by the door a hand-edited camera track
  // actually comes through.
  'keys-bypass-registry': { file: 'web/main.js', edits: [[
    '      key.value = params.normalise(name, key.value);',
    '      /* mutation: the key value is taken as it arrived */',
  ]] },
  // A user preset is applied through `setMode`, which applies the hardcoded
  // BLACKWALL look as part of selecting mode 4 - so the user's own twelve values
  // are overwritten on the way past and the preset appears to load.
  // A user preset is applied by writing its values and *then* selecting its mode
  // through `setMode`, which applies the hardcoded BLACKWALL look as part of
  // selecting mode 4 - so the user's own twelve values are overwritten on the way
  // past and the preset appears to load. Written as a reorder rather than as a bare
  // swap of the call, because `setMode` before the values is harmless: the values
  // land afterwards and win. The bug only exists in this order, so the mutation has
  // to be in it or it moves nothing and reads as a check that found nothing.
  'preset-through-setmode': { file: 'web/main.js', edits: [[
    `  if (Number.isInteger(doc.body.mode)) applyModeValue(doc.body.mode);
  params.apply(doc.body.values ?? {});`,
    `  params.apply(doc.body.values ?? {});
  if (Number.isInteger(doc.body.mode)) setMode(doc.body.mode);`,
  ]] },
  // Marks are drawn at their source fraction rather than through the retime curve,
  // which is identical at rate 1 with no keys and wrong everywhere else.
  'marks-ignore-retime': { file: 'web/main.js', edits: [[
    '    const program = retime.programSecAt(mark.sourceMs / 1000);',
    '    const program = mark.sourceMs / 1000;',
  ]] },
  // The gallery skims a remote take at full resolution, promising a smoothness the
  // link does not have.
  'skim-ignores-state': { file: 'web/library.js', edits: [[
    'const DIVISOR = { local: 1, both: 1, remote: 4 };',
    'const DIVISOR = { local: 1, both: 1, remote: 1 };',
  ]] },
};

function mutatedSource(name) {
  const spec = MUTATIONS[name];
  if (!spec) throw new Error(`unknown mutation ${name} - have ${Object.keys(MUTATIONS).join(', ')}`);
  let source = readFileSync(join(REPO, spec.file), 'utf8');
  for (const [from, to] of spec.edits) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) {
      throw new Error(`mutation ${name} matched ${hits} times in ${spec.file}, expected exactly 1: ${from}`);
    }
    source = source.replace(from, to);
  }
  return { file: spec.file, body: source };
}

const mutation = MUTATE ? mutatedSource(MUTATE) : null;
const pageMutation = mutation && mutation.file.startsWith('web/') ? mutation : null;
const serverMutation = mutation && mutation.file.startsWith('server/') ? mutation : null;

// ----------------------------------------------------------------- the fixtures
//
// Every take here is built rather than downloaded, so its shape is a decision this
// file makes and can name. Sized by frame count and not by duration: the sample was
// captured on a degraded link at about 9.3fps, so its seconds are not a real take's
// seconds and a fixture measured in them would be measuring the wrong thing.

function sampleMessages() {
  const parser = new MessageParser();
  const frames = [];
  let hello = null;
  for (const msg of parser.push(readFileSync(SAMPLE))) {
    if (msg.type === TYPE_HELLO) hello ??= Buffer.from(msg.payload);
    else if (msg.type === TYPE_FRAME) frames.push(Buffer.from(msg.raw));
  }
  if (!hello) throw new Error(`${SAMPLE} carries no hello`);
  return { hello, frames };
}

const SRC = sampleMessages();

/**
 * Writes a take. `frames` is a count, `withHello` decides whether the sensor record
 * is there at all, `truncate` cuts the last message in half so the scan's
 * `truncated` flag has something to report - the flag has been computed since step
 * 2 and read by nothing until this gallery.
 */
function writeTake(dir, id, { frames = 8, withHello = true, truncate = false, startedAt = null } = {}) {
  const parts = [];
  if (withHello) {
    // The wall-clock capture date, which the frame stamps cannot supply: they are
    // `steady_clock`, monotonic since boot, right for frame spacing and useless for
    // sorting a library.
    const hello = startedAt === null
      ? SRC.hello
      : Buffer.from(JSON.stringify({ ...JSON.parse(SRC.hello.toString('utf8')), startedAt }));
    parts.push(encodeMessage(TYPE_HELLO, hello));
  }
  for (let i = 0; i < frames; i++) parts.push(SRC.frames[i % SRC.frames.length]);
  let body = Buffer.concat(parts);
  if (truncate) body = body.subarray(0, body.length - 40000);
  const path = join(dir, `${id}.knct`);
  writeFileSync(path, body);
  return path;
}

const markLine = (rec) => `${JSON.stringify(rec)}\n`;

/**
 * A run of frame payloads for the deterministic drive, colour dropped so the page
 * parses them with the same field offsets the socket path uses and nothing waits on
 * an asynchronous JPEG decode. Real sensor depth and the capture's own timestamps -
 * only the colour block is absent.
 *
 * The image claim below runs on this rather than on the indexed source, and that is
 * a property rather than a convenience: the drive renders an exact program position
 * with no fetch between it and the pixels, so two runs differ because the look
 * differs and for no other reason.
 */
function pinFixture(count = 6, stride = 4) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const src = SRC.frames[(i * stride) % SRC.frames.length].subarray(12);
    const depthBytes = src.readUInt32LE(0);
    const payload = Buffer.alloc(16 + depthBytes);
    payload.writeUInt32LE(depthBytes, 0);
    payload.writeUInt32LE(0, 4);
    src.copy(payload, 8, 8, 16);
    src.copy(payload, 16, 16, 16 + depthBytes);
    out.push(payload);
  }
  return Buffer.concat(out);
}

function buildFixture() {
  rmSync(WORK, { recursive: true, force: true });
  const nodeCaps = join(WORK, 'node-captures');
  const macCaps = join(WORK, 'mac-captures');
  for (const d of [nodeCaps, macCaps, join(WORK, 'projects'), join(WORK, 'presets'), join(WORK, 'empty-captures')]) {
    mkdirSync(d, { recursive: true });
  }

  // The take both machines hold, under **different filenames**. This is the whole
  // of the reconciliation claim: nothing about these two names is comparable, and
  // the bytes are identical.
  writeTake(macCaps, 'mac-name-for-it', { frames: 12, startedAt: Date.UTC(2026, 6, 14, 9, 30) });
  writeTake(nodeCaps, 'node-name-for-it', { frames: 12, startedAt: Date.UTC(2026, 6, 14, 9, 30) });

  // The same *filename* on both machines with different bytes. The mirror claim:
  // a name shared is not a take shared.
  writeTake(macCaps, 'same-name', { frames: 6 });
  writeTake(nodeCaps, 'same-name', { frames: 9 });

  // Local only, and the take everything that needs a real clip uses.
  writeTake(macCaps, 'local-clip', { frames: 60, startedAt: Date.UTC(2026, 6, 15, 18, 5) });

  // The shapes the gallery has to survive rather than the shapes it likes.
  writeTake(macCaps, 'truncated-take', { frames: 6, truncate: true });
  writeTake(macCaps, 'no-hello-take', { frames: 6, withHello: false });
  writeTake(macCaps, 'one-frame-take', { frames: 1 });

  // Mark counts the tile renders differently: none, exactly one, and several - plus
  // a mark at source zero and a mark past the end of the footage, which are the two
  // positions a fraction can get wrong without any of the middle ones noticing.
  writeFileSync(join(macCaps, 'local-clip.marks.jsonl'),
    markLine({ id: 'k0', sourceMs: 0, label: 'first frame', at: 1000 })
    + markLine({ id: 'k1', sourceMs: 1200, label: 'the drop', at: 1000 })
    + markLine({ id: 'k2', sourceMs: 3400, label: 'turn', at: 1000 })
    + markLine({ id: 'kBeyond', sourceMs: 900000, label: 'past the end', at: 1000 }));
  writeFileSync(join(macCaps, 'same-name.marks.jsonl'),
    markLine({ id: 'only', sourceMs: 500, label: 'sole mark', at: 1000 }));
  // The node's log for the shared take, which the download has to merge: one mark
  // the mac has never seen, one the mac will supersede, and one already tombstoned.
  writeFileSync(join(nodeCaps, 'node-name-for-it.marks.jsonl'),
    markLine({ id: 'n1', sourceMs: 700, label: 'node mark', at: 1000 })
    + markLine({ id: 'n2', sourceMs: 900, label: 'to be moved', at: 1000 })
    + markLine({ id: 'n3', sourceMs: 1100, label: 'doomed', at: 1000 })
    + markLine({ id: 'n3', deleted: true, at: 2000 }));

  return { nodeCaps, macCaps };
}

// ------------------------------------------------------------------- the servers
//
// Spawned out of a copy of `server/` with `web`, `node_modules` and `vendor`
// symlinked beside it, so a server-side mutation is a file in a scratch tree rather
// than an edit to the repo. A mutation applied in place and restored afterwards
// would leave a mutated working tree behind any crash, which is precisely the state
// a proof tool must never be able to produce.

function stageServer() {
  const root = join(WORK, 'root');
  mkdirSync(root, { recursive: true });
  cpSync(join(REPO, 'server'), join(root, 'server'), { recursive: true });
  for (const name of ['web', 'node_modules', 'vendor']) {
    const from = join(REPO, name);
    if (existsSync(from) && !existsSync(join(root, name))) symlinkSync(from, join(root, name));
  }
  if (serverMutation) {
    writeFileSync(join(root, serverMutation.file), serverMutation.body);
  }
  return root;
}

const servers = [];

async function startServer(root, args, port) {
  const child = spawn(process.execPath, [join(root, 'server/index.js'), '--port', String(port), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (c) => log.push(c.toString()));
  child.stderr.on('data', (c) => log.push(c.toString()));
  servers.push({ child, log, port });
  for (let i = 0; i < 200; i++) {
    await new Promise((done) => { setTimeout(done, 100); });
    try {
      const res = await fetch(`http://localhost:${port}/library/takes`);
      if (res.ok) return `http://localhost:${port}`;
    } catch { /* not listening yet */ }
  }
  throw new Error(`server on ${port} never came up:\n${log.join('')}`);
}

function stopServers() {
  for (const { child } of servers) child.kill('SIGKILL');
}

/**
 * A real filesystem with a few megabytes on it, or null where this tool does not
 * know how to make one.
 *
 * Real rather than simulated, because the claim is about what `statfs` says and a
 * number this tool handed the server would be testing its own arithmetic. macOS
 * only for now - `hdiutil` needs no privileges and takes about 1.3 seconds, where
 * the Linux equivalents all want root.
 */
async function smallFilesystem() {
  if (process.platform !== 'darwin') return null;
  const image = join(WORK, 'nearly-full.dmg');
  const mount = join(WORK, 'nearly-full');
  try {
    execFileSync('hdiutil', ['create', '-size', '8m', '-fs', 'APFS', '-volname', 'librarycheck', '-quiet', '-ov', image]);
    execFileSync('hdiutil', ['attach', image, '-mountpoint', mount, '-nobrowse', '-quiet']);
  } catch (err) {
    console.log(`  ...  no small filesystem: ${err.message.split('\n')[0]}`);
    return null;
  }
  return {
    mount,
    release() {
      try {
        execFileSync('hdiutil', ['detach', mount, '-quiet']);
      } catch {
        // Forced only as a second attempt: a volume still held by a process that has
        // not quite exited detaches a moment later, and forcing first would hide a
        // server this tool failed to stop.
        try { execFileSync('hdiutil', ['detach', mount, '-force', '-quiet']); } catch { /* gone already */ }
      }
    },
  };
}

const getJson = async (url, init) => (await fetch(url, init)).json();
const post = (url, body) => getJson(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
});

// ------------------------------------------------------------------- playwright

async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const roots = [];
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim());
  } catch { /* no global npm root: the local resolve below may still work */ }
  const candidates = [async () => import('playwright')];
  for (const root of roots) {
    for (const name of ['playwright', '@playwright/cli/node_modules/playwright']) {
      candidates.push(async () => import(pathToFileURL(require.resolve(join(root, name))).href));
    }
  }
  for (const load of candidates) {
    try {
      const mod = await load();
      const pw = mod.chromium ? mod : mod.default;
      if (pw?.chromium) return pw;
    } catch { /* try the next one */ }
  }
  throw new Error('playwright not found - install it globally or in this project');
}

/**
 * Playwright drops the page's execution context on this rig, and it is not the
 * code: CLAUDE.md records it as a measured flake, with the server log showing the
 * work it happened during completing normally. Retried on that signature alone and
 * with the retry count printed, because a check that retried real failures would
 * report whichever attempt it liked.
 */
async function retryOnContextLoss(label, work) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await work();
    } catch (err) {
      if (!/Execution context was destroyed/.test(String(err)) || attempt === 3) throw err;
      console.log(`  ...  ${label}: execution context lost, retrying (attempt ${attempt + 1} of 3)`);
    }
  }
  throw new Error('unreachable');
}

async function openPage(browser, url, viewport = { width: 1100, height: 760 }) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  if (pageMutation) {
    const target = pageMutation.file.slice('web/'.length);
    await page.route(`**/${target}`, (route) => route.fulfill({
      status: 200, contentType: 'text/javascript; charset=utf-8', body: pageMutation.body,
    }));
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { page, errors };
}

// ============================================================================ run

console.log(`[library] ${MUTATE ? `MUTATED: ${MUTATE} (${mutation.file})` : 'unmutated tree'}`);

const { nodeCaps, macCaps } = buildFixture();
const root = stageServer();
const nodeUrl = await startServer(root, ['--captures', nodeCaps, '--name', 'pi-01',
  '--presets', join(WORK, 'node-presets'), '--projects', join(WORK, 'node-projects')], NODE_PORT);
const macUrl = await startServer(root, ['--captures', macCaps, '--name', 'mac',
  '--node', nodeUrl, '--node-name', 'pi-01',
  '--presets', join(WORK, 'presets'), '--projects', join(WORK, 'projects')], MAC_PORT);

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: !HEADED, args: ['--use-gl=angle', '--use-angle=default'] });

try {
  await runChecks();
} finally {
  await browser.close();
  stopServers();
}

const note = skipped.length ? `, ${skipped.length} claim${skipped.length === 1 ? '' : 's'} unproven here (${skipped.join(', ')})` : '';
if (failures) console.log(`\n[library] ${assertions} assertions, ${failures} failed${note}`);
else console.log(`\n[library] ${assertions} assertions, none failed${note}`);
console.log(`[library] ${failures ? `FAIL (${failures})` : 'PASS'}`);
process.exit(failures ? 1 : 0);

async function runChecks() {
  // ------------------------------------------------------------- 1. the manifest
  console.log('\n[library] the manifest carries step 2\'s hash, and stops carrying a stale one');
  {
    const { buildIndex } = await import(pathToFileURL(join(REPO, 'server/capture.js')).href);
    const takes = (await getJson(`${macUrl}/library/takes`)).takes;
    const byId = Object.fromEntries(takes.map((t) => [t.id, t]));

    // The scan, run here, against the manifest the server produced. Not the
    // server's own answer read back - that would agree with itself whatever it did.
    let agreed = 0;
    for (const take of takes) {
      const scanned = await buildIndex(join(macCaps, take.file));
      if (scanned.hash === take.hash && scanned.frames.offset.length === take.frames) agreed++;
    }
    check(agreed === takes.length,
      `every take's manifest hash and frame count is what a fresh scan produces (${agreed}/${takes.length})`);

    // A take whose bytes changed. The sidecar on disk still says the old hash, so
    // this is exactly the case a cache that trusted itself would get wrong.
    const before = byId['same-name'].hash;
    // A whole extra frame rather than arbitrary bytes. The format is append-only,
    // so a take *growing* is the shape this actually happens in - a recorder still
    // writing while the gallery lists - and it leaves a file the scan can still
    // read, which is what makes the comparison below about the hash rather than
    // about a parse failure.
    appendFileSync(join(macCaps, 'same-name.knct'), SRC.frames[0]);
    const after = (await getJson(`${macUrl}/library/takes`)).takes.find((t) => t.id === 'same-name');
    const rescanned = await buildIndex(join(macCaps, 'same-name.knct'));
    check(after.hash !== before, 'a take whose bytes changed is not served from a stale manifest',
      `${before.slice(7, 19)} then ${after.hash.slice(7, 19)}`);
    check(after.hash === rescanned.hash, 'and the hash it reports is the one the changed bytes actually have');

    // The shapes a gallery has to render rather than the ones it likes. Each of
    // these is a state the tile draws differently, and each was found by asking
    // what the interface can produce rather than what is convenient to build.
    check(byId['truncated-take'].truncated === true,
      'a take cut mid-frame is reported truncated - step 2 computed this flag and nothing read it until now');
    check(byId['local-clip'].truncated === false, 'and a whole take is not');
    check(byId['no-hello-take'].hasHello === false && byId['no-hello-take'].openable === false,
      'a take with no hello lists, and says it cannot be opened');
    check(byId['one-frame-take'].frames === 1 && byId['one-frame-take'].openable === false,
      'a one-frame take lists, and says it cannot be bracketed');
    check(byId['local-clip'].openable === true, 'and an ordinary take is openable');
    check(byId['local-clip'].dateSource === 'hello'
      && Math.abs(byId['local-clip'].capturedAt - Date.UTC(2026, 6, 15, 18, 5)) < 1,
      'the wall-clock capture date comes off the hello where the take carries one');
    check(byId['truncated-take'].dateSource === 'mtime',
      'and falls back to the file date where it does not, saying which it used');
    check(Math.abs(byId['local-clip'].marks.length) === 4, 'marks come with the take',
      `${byId['local-clip'].marks.length} on local-clip`);
    check(byId['same-name'].marks.length === 1 && byId['truncated-take'].marks.length === 0,
      'and the one-mark and no-mark cases are both real');
  }

  // ------------------------------------------------------- 2. reconciliation
  console.log('\n[library] one library, joined by content hash and never by name');
  {
    const lib = await getJson(`${macUrl}/library/all`);
    const byId = Object.fromEntries(lib.takes.map((t) => [t.id, t]));
    check(lib.node?.reachable === true, `the node is linked (${lib.node?.name})`);

    // The same bytes under two unrelated filenames.
    const shared = lib.takes.filter((t) => t.state === 'both');
    check(shared.length === 1 && shared[0].id === 'mac-name-for-it',
      'the same bytes under two different filenames are one take, in state both',
      shared.map((t) => t.id).join(' '));

    // The same filename holding different bytes.
    const sameName = lib.takes.filter((t) => t.id === 'same-name');
    check(sameName.length === 2 && new Set(sameName.map((t) => t.hash)).size === 2,
      'the same filename holding different bytes is two takes, not one',
      `${sameName.length} entries, ${new Set(sameName.map((t) => t.state)).size} states`);
    check(sameName.some((t) => t.state === 'local') && sameName.some((t) => t.state === 'remote'),
      'and they resolve to different states rather than collapsing');

    check(byId['local-clip'].state === 'local' && byId['node-name-for-it'] === undefined,
      'a take only here is local, and the node\'s name for a shared take is not a second entry');
    check(lib.takes.some((t) => t.state === 'remote'), 'a take only over there is remote');

    // Remaining time, reported as time. "94 GB free" is arithmetic under pressure.
    check(/^(\d+h \d+m|\d+m \d+s|\d+s|unbounded)$/.test(lib.storage.label),
      `remaining space is reported as time, not bytes (${lib.storage.label})`);
    check(lib.storage.secondsLeft > 0 && Number.isFinite(lib.storage.bytesPerSec),
      'and it is a duration derived from a rate rather than a byte count');
  }

  // ----------------------------------------------------------- 3. decimation
  console.log('\n[library] the decimation parameter: one mechanism, three callers');
  {
    const sizes = {};
    const bodies = {};
    // Both divisors the tiles use, and both ends of the range the server accepts -
    // the pair the UI ships plus the pair only the API can reach, because an arm
    // set that only covers what the page asks for cannot see a bound that is wrong.
    for (const k of [1, 2, 4, 16]) {
      const res = await fetch(`${macUrl}/capture/local-clip/frame/4?decimate=${k}`);
      const buf = Buffer.from(await res.arrayBuffer());
      bodies[k] = buf;
      sizes[k] = {
        header: res.headers.get('x-depth-divisor'),
        depthBytes: buf.readUInt32LE(0),
        colorBytes: buf.readUInt32LE(4),
        stamp: Number(buf.readBigUInt64LE(8)),
        total: buf.length,
      };
    }
    const grid = (k) => Math.ceil(512 / k) * Math.ceil(424 / k) * 2;
    check([1, 2, 4, 16].every((k) => sizes[k].depthBytes === grid(k)),
      'a divisor samples both axes, so the depth grid is ceil(512/k) by ceil(424/k)',
      [1, 2, 4, 16].map((k) => `k=${k}:${sizes[k].depthBytes}/${grid(k)}`).join(' '));
    check([1, 2, 4, 16].every((k) => sizes[k].colorBytes === sizes[1].colorBytes && sizes[k].colorBytes > 0),
      'the colour block is carried through untouched at every divisor',
      `${sizes[1].colorBytes} bytes each`);
    // The spec's own arithmetic: divisor 4 is 27KB of depth plus 52KB of colour,
    // which is the ~80KB that puts a scrub position at 21ms over a 3.8 MB/s link
    // against the 128ms a full frame costs. Dropping colour would give ~7ms, which
    // is a different mechanism wearing this one's measured number.
    check(Math.abs(sizes[4].total - 79 * 1024) < 6 * 1024,
      'divisor 4 lands at the ~80KB the 21ms-per-position figure is derived from',
      `${(sizes[4].total / 1024).toFixed(1)}KB = ${(sizes[4].depthBytes / 1024).toFixed(0)}KB depth + ${(sizes[4].colorBytes / 1024).toFixed(0)}KB colour`);
    check([1, 2, 4, 16].every((k) => sizes[k].stamp === sizes[1].stamp),
      'and the capture timestamp is the frame\'s own at every divisor');
    check(sizes[1].total === sizes[1].depthBytes + sizes[1].colorBytes + 16,
      'divisor 1 is the payload unchanged, so the editor\'s path is what it was');

    // **Which samples come back, not how many.** A byte count cannot tell a grid
    // sampled on both axes from one strided through the flat array: the count is
    // identical and the picture is not. So the expected grid is computed here, off
    // the full frame this tool already has, and compared sample for sample.
    for (const k of [2, 4, 16]) {
      const w = Math.ceil(512 / k);
      const h = Math.ceil(424 / k);
      const want = Buffer.allocUnsafe(w * h * 2);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          want.writeUInt16LE(bodies[1].readUInt16LE(16 + (y * k * 512 + x * k) * 2), (y * w + x) * 2);
        }
      }
      const got = bodies[k].subarray(16, 16 + w * h * 2);
      const wrong = [];
      for (let i = 0; i < want.length && wrong.length < 4; i += 2) {
        if (want.readUInt16LE(i) !== got.readUInt16LE(i)) wrong.push(i / 2);
      }
      check(wrong.length === 0,
        `at divisor ${k} every sample is the nearest-neighbour one, not a stride through the flat array`,
        wrong.length ? `first wrong samples at ${wrong.join(', ')}` : `${w}x${h} samples agree`);
    }
    // The colour bytes are the frame's own, not merely the right length.
    check(Buffer.compare(bodies[4].subarray(16 + sizes[4].depthBytes),
      bodies[1].subarray(16 + sizes[1].depthBytes)) === 0,
      'and the colour block is byte for byte the frame\'s own');

    for (const bad of ['0', '17', '1.5', 'lots']) {
      const res = await fetch(`${macUrl}/capture/local-clip/frame/4?decimate=${bad}`);
      check(res.status === 400, `a divisor of ${bad} is refused rather than clamped`, `status ${res.status}`);
    }
  }

  // -------------------------------------------------- 4. descriptors stay bounded
  //
  // **This section runs against a replay server, and that is the whole of what it
  // learned.** The first version of it spawned a server with no `--replay` at all,
  // so every arm agreed about a quantity none of them measured - which is the
  // failure `CLAUDE.md` names in the paragraph immediately above this step's work,
  // reproduced in a section written after reading it. Two hours is apparently not
  // long enough for a rule to stick, so the example lives here beside the code
  // rather than only in the document: the replay is the one reader that holds a
  // descriptor for the life of the process without any request bracketing it, so it
  // is exactly what an eviction policy gets wrong, and a bound measured without one
  // is a bound measured where nothing was at stake.
  console.log('\n[library] skimming a directory does not evict the replay out from under itself');
  {
    // Enough takes that an unbounded map is unmistakably over the cap, and small
    // enough that building them is not the measurement. Sized by frame count.
    const many = join(WORK, 'many-captures');
    mkdirSync(many, { recursive: true });
    for (let i = 0; i < 80; i++) writeTake(many, `bulk-${String(i).padStart(3, '0')}`, { frames: 3 });
    // The replayed take lives outside the directory being skimmed, so nothing the
    // skim touches is the file the replay is reading.
    const replaySource = join(WORK, 'replay-source');
    mkdirSync(replaySource, { recursive: true });
    const replaying = writeTake(replaySource, 'replayed-take', { frames: 40 });
    const manyUrl = await startServer(root,
      ['--captures', many, '--name', 'bulk', '--replay', replaying], MAC_PORT + 2);

    // A live client, because the failure this exists for is not visible from the
    // library at all: the replay's reads start throwing, the server reports a lost
    // sensor, and the descriptor count looks perfectly healthy the whole time.
    const seen = { frames: 0, statuses: [] };
    const ws = new WebSocket(manyUrl.replace('http', 'ws'));
    ws.on('message', (data, isBinary) => {
      if (isBinary) seen.frames++;
      else {
        try {
          const msg = JSON.parse(data.toString('utf8'));
          if (msg.status) seen.statuses.push(msg.status);
        } catch { /* not a status message */ }
      }
    });
    await new Promise((done, fail) => { ws.on('open', done); ws.on('error', fail); });
    await new Promise((done) => { setTimeout(done, 1200); });
    const framesBefore = seen.frames;
    check(framesBefore > 0, 'the replay is streaming before the skim starts',
      `${framesBefore} frames in 1.2s`);

    const before = (await getJson(`${manyUrl}/library/descriptors`)).open;
    // A skim is a frame read per take, which is the gesture that opens them.
    for (let i = 0; i < 80; i++) {
      await fetch(`${manyUrl}/capture/bulk-${String(i).padStart(3, '0')}/frame/1`);
    }
    const after = (await getJson(`${manyUrl}/library/descriptors`)).open;
    // The status list is deliberately *not* cleared here. It was, and that threw
    // away the evidence: an eviction during the eighty fetches reports its lost
    // sensor while the skim is still running, so clearing afterwards discarded the
    // very message the assertion was looking for and the row passed on some runs and
    // failed on others. Nothing should report a lost sensor at any point in this
    // window, so the whole window is what gets asserted.
    const framesAtSkim = seen.frames;
    await new Promise((done) => { setTimeout(done, 1500); });
    const framesAfter = seen.frames - framesAtSkim;
    ws.close();

    // The bound is on descriptors left lying about, so a couple in flight and the
    // retained replay are honest. The point of the assertion is that it does not
    // track the number of takes touched.
    check(after <= 27, 'eighty takes skimmed leave the open-capture map bounded',
      `${before} before, ${after} after, cap 24 plus the retained replay`);
    check(after < 80, 'and the bound does not track the number of takes touched');
    check(framesAfter > 0, 'and the replay is still streaming afterwards - its descriptor survived',
      `${framesAfter} frames in the 1.5s after the skim`);
    check(!seen.statuses.includes('lost'),
      'with no lost-sensor report at any point, which is how a closed handle presents itself',
      seen.statuses.length ? `saw ${seen.statuses.join(' ')}` : 'no status changes');
  }

  // ------------------------------------------------ 4b. a take is a file
  //
  // Driven by `tools/fake-grabber.mjs`: real KNCT framing and real sensor depth on
  // stdout, with no Kinect in the room. Everything here is a behaviour of the
  // *writer*, so nothing short of something actually streaming exercises any of it -
  // which is why six implemented rules sat unproven until this instrument existed.
  console.log('\n[library] a take is a file, and a restart splits it');
  {
    const recDir = join(WORK, 'recorded');
    mkdirSync(recDir, { recursive: true });
    // A decoy at the name the recorder would otherwise reach for first. A take must
    // never append to or overwrite a file that is already there - two takes in one
    // file share a hash and a gallery entry, which the project model cannot express.
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const decoyPath = join(recDir, `${day}-take1.knct`);
    writeFileSync(decoyPath, Buffer.from('not a take, and must still not be one afterwards'));
    const decoyBefore = readFileSync(decoyPath);

    const EMITTED = 24;
    const recUrl = await startServer(root, [
      '--captures', recDir, '--name', 'shooting', '--record', '--no-color',
      '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --die-after ${EMITTED} --burst 10 --fps 40`,
    ], MAC_PORT + 4);
    // Waited until the recorder has *closed* three takes, not until the library
    // lists three. Those are different conditions and the difference made this
    // assertion flaky: a listing counts the take still being written, so the loop
    // could exit with two closed and one open and the count assertion below would
    // fail on runs that had nothing to do with what was being tested. It fired on
    // four unrelated mutations before it was pinned, which is exactly the
    // one-in-five failure that teaches people to re-run a gating check until green.
    const closedSoFar = () => [...servers.find((s) => s.port === MAC_PORT + 4).log.join('')
      .matchAll(/\[recorder\] take (\S+) closed/g)].length;
    for (let i = 0; i < 90; i++) {
      if (closedSoFar() >= 3) break;
      await new Promise((done) => { setTimeout(done, 500); });
    }
    check(closedSoFar() >= 3, 'the writer ran, died and was respawned enough times to split three takes',
      `${closedSoFar()} closed`);
    // Closed takes only, and the recorder's own log is what says so. The obvious
    // test - "does a sidecar exist" - is wrong here and wrong in an instructive way:
    // listing the library scans every take in the directory, *including the one
    // still being written*, and the scan writes a sidecar. So the act of watching
    // for takes manufactures the evidence that they are finished, and the take that
    // was mid-recording gets counted against a frame total it was never going to
    // reach. Measured: it came in at 10 and at 11 on two runs, which is the burst
    // plus however long the last poll took.
    const recLog = servers.find((s) => s.port === MAC_PORT + 4).log.join('');
    const closed = new Set([...recLog.matchAll(/\[recorder\] take (\S+) closed/g)].map((m) => `${m[1]}.knct`));
    const recorded = readdirSync(recDir)
      .filter((f) => f.endsWith('.knct') && f !== `${day}-take1.knct` && closed.has(f))
      .sort();

    check(Buffer.compare(readFileSync(decoyPath), decoyBefore) === 0,
      'a take never appends to or overwrites a file that is already there',
      `${decoyPath.split('/').pop()} is byte-identical, ${decoyBefore.length} bytes`);
    check(recorded.length >= 3, 'a grabber that dies and respawns produces one take per run',
      recorded.join(' '));
    check(recorded[0] === `${day}-take2.knct`,
      'and the first of them steps over the name that was taken', recorded[0]);

    const scanned = recorded.map((file) => {
      const parser = new MessageParser();
      let helloes = 0;
      let frameCount = 0;
      let hello = null;
      const stamps = [];
      for (const msg of parser.push(readFileSync(join(recDir, file)))) {
        if (msg.type === TYPE_HELLO) { helloes++; hello ??= JSON.parse(msg.payload.toString('utf8')); }
        else if (msg.type === TYPE_FRAME) { frameCount++; stamps.push(Number(msg.payload.readBigUInt64LE(8))); }
      }
      return { file, helloes, frameCount, hello, stamps };
    });

    check(scanned.every((t) => t.helloes === 1),
      'one take is one continuous stream with exactly one hello at its head',
      scanned.map((t) => `${t.file}:${t.helloes}`).join(' '));
    // **Exact, not approximate.** The writer emits a known number of frames and then
    // exits, so a take that holds fewer lost some - and the ten of them behind the
    // hello are written back to back, which is where a recorder that opened its file
    // one turn late drops them.
    check(scanned.every((t) => t.frameCount === EMITTED),
      `and every frame the writer emitted is in it (${EMITTED} each)`,
      scanned.map((t) => `${t.file}:${t.frameCount}`).join(' '));
    check(scanned.every((t) => t.stamps.every((v, i) => i === 0 || v > t.stamps[i - 1])),
      'with strictly ascending timestamps, which a run across a restart seam would break');
    check(scanned.every((t) => Number.isFinite(t.hello?.startedAt)),
      'the hello carries a wall clock, which the frame stamps cannot supply');
    check(scanned.every((t, i) => i === 0 || t.hello.startedAt > scanned[i - 1].hello.startedAt),
      'and it advances take to take, so a library can sort by when it was shot',
      scanned.map((t) => t.hello.startedAt).join(' '));

    const listed = (await getJson(`${recUrl}/library/takes`)).takes;
    const byFile = Object.fromEntries(listed.map((t) => [t.file, t]));
    check(scanned.every((t) => byFile[t.file]?.frames === EMITTED && byFile[t.file]?.dateSource === 'hello'),
      'and each closed take is a gallery entry, scanned, hashed and dated off its own hello');
    check(new Set(scanned.map((t) => byFile[t.file]?.hash)).size === scanned.length,
      'every take has its own hash, so nothing shares a gallery entry',
      scanned.map((t) => String(byFile[t.file]?.hash).slice(7, 15)).join(' '));
    for (const p of servers.filter((s) => s.port === MAC_PORT + 4)) p.child.kill('SIGKILL');
  }

  // ------------------------------------------- 4c. the mark button, while shooting
  console.log('\n[library] mark flags the moment while it is still happening');
  {
    const markDir = join(WORK, 'marking');
    mkdirSync(markDir, { recursive: true });
    const markUrl = await startServer(root, [
      '--captures', markDir, '--name', 'shooting', '--no-color',
      '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --fps 40`,
    ], MAC_PORT + 5);
    // Waited for rather than slept against: a start before the sensor has said hello
    // arms without opening a take, which is correct and is not what this measures.
    for (let i = 0; i < 40; i++) {
      await new Promise((done) => { setTimeout(done, 250); });
      if ((await getJson(`${markUrl}/record/state`)).armed === false) break;
    }
    const started = await post(`${markUrl}/record/start`);
    check(started.recording === true && typeof started.takeId === 'string',
      'record opens a take on a running sensor', String(started.takeId));
    await new Promise((done) => { setTimeout(done, 900); });
    const mark = await post(`${markUrl}/record/mark`, { label: 'the moment' });
    await new Promise((done) => { setTimeout(done, 600); });
    const stopped = (await post(`${markUrl}/record/stop`)).stopped;

    check(mark.sourceMs > 0 && mark.label === 'the moment',
      'mark stamps the moment in source milliseconds from the take\'s start',
      `${mark.sourceMs}ms`);
    check(stopped?.frames > 0 && stopped.hash?.startsWith('sha256:'),
      'stop closes the take, scans it and gives it the hash a project would name it by',
      `${stopped?.frames} frames`);
    const listed = (await getJson(`${markUrl}/library/takes`)).takes.find((t) => t.id === stopped.id);
    check(listed?.marks.length === 1 && listed.marks[0].label === 'the moment',
      'and the mark is on the take in the library, not inside the capture',
      JSON.stringify(listed?.marks));
    // Marks are stamped raw and never pre-rolled - people press a few hundred
    // milliseconds after the thing happens, and a constant baked in at capture time
    // would be a guess. What is checked is that it lands inside the take.
    check(listed.marks[0].sourceMs > 0 && listed.marks[0].sourceMs < listed.durationSec * 1000 + 500,
      'stamped inside the footage it flags rather than at an arbitrary offset',
      `${listed.marks[0].sourceMs}ms into ${(listed.durationSec * 1000).toFixed(0)}ms`);
    check(existsSync(join(markDir, `${stopped.id}.marks.jsonl`)),
      'in an append-only sidecar beside the take, which is byte-identical to what the writer produced');
    for (const p of servers.filter((s) => s.port === MAC_PORT + 5)) p.child.kill('SIGKILL');
  }

  // ------------------------------------ 4d. a name already taken is not a stop
  //
  // `wx` is what stops two takes sharing one file, and proving it needs a take whose
  // chosen name is *already there* - which a scan that picks the highest number plus
  // one never produces on its own. The reachable case is two writers on one captures
  // directory, and the deterministic version of it is a directory this process can
  // write but not list: `readdirSync` fails, the scan falls back to take one, and
  // the names it reaches for are taken. Both halves are real - a shared directory is
  // how it happens, an unlistable one is how it is made to happen every time.
  console.log('\n[library] a take name already taken is stepped over, not a stop');
  {
    const clash = join(WORK, 'clashing');
    mkdirSync(clash, { recursive: true });
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const taken = [join(clash, `${day}-take1.knct`), join(clash, `${day}-take2.knct`)];
    for (const path of taken) writeTake(clash, basename(path, '.knct'), { frames: 4 });
    const before = taken.map((path) => readFileSync(path));
    chmodSync(clash, 0o300);

    let state = null;
    try {
      const clashUrl = await startServer(root, [
        '--captures', clash, '--name', 'shooting', '--record', '--no-color',
        '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --fps 40 --burst 4`,
      ], MAC_PORT + 6);
      for (let i = 0; i < 40; i++) {
        await new Promise((done) => { setTimeout(done, 250); });
        state = await getJson(`${clashUrl}/record/state`);
        if (state.recording) break;
      }
    } finally {
      for (const p of servers.filter((sv) => sv.port === MAC_PORT + 6)) p.child.kill('SIGKILL');
      // Restored before anything reads the directory again, including this run's own
      // teardown - a scratch tree that cannot be listed is a scratch tree that
      // cannot be deleted.
      chmodSync(clash, 0o700);
    }

    check(state?.recording === true && state?.armed === true,
      'a take whose name is taken keeps recording rather than disarming the node',
      JSON.stringify({ armed: state?.armed, recording: state?.recording, takeId: state?.takeId }));
    check(state?.takeId === `${day}-take3`,
      'and it steps to the next free name rather than the one it first reached for',
      String(state?.takeId));
    check(taken.every((path, i) => Buffer.compare(readFileSync(path), before[i]) === 0),
      'while both files that were already there are byte-identical - wx neither appended nor truncated',
      taken.map((p) => basename(p)).join(' '));
    const clashLog = servers.find((sv) => sv.port === MAC_PORT + 6).log.join('');
    // The arm has to have fired. Two names refused is what makes the three
    // assertions above about the retry rather than about a recorder that simply
    // picked a free name the ordinary way.
    check((clashLog.match(/is already taken/g) ?? []).length === 2,
      'and the refusal fired twice, so this measured the retry rather than an ordinary open',
      `${(clashLog.match(/is already taken/g) ?? []).length} refusals in the log`);
  }

  // ------------------------------- 4e. a take that cannot fit is refused up front
  console.log('\n[library] a take that cannot fit never starts');
  {
    // A real filesystem with almost nothing on it, because the gate is arithmetic on
    // free space and free space is the half of it an operator actually hits. The
    // alternative - driving the rate instead - would be testing a number this tool
    // supplied rather than the one the disk did.
    const room = await smallFilesystem();
    if (!room) {
      // Printed rather than silently passed. This claim is unproven on this
      // platform and the line says so, because a check that quietly drops an
      // assertion where it cannot make a fixture is a check that reports coverage it
      // does not have.
      console.log(`  SKIP  a take that cannot fit is refused - no way to make a small filesystem on ${process.platform}`);
      skipped.push('the low-space refusal');
    } else {
      try {
        const fullUrl = await startServer(root, [
          '--captures', room.mount, '--name', 'nearly-full', '--no-color',
          '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --fps 40`,
        ], MAC_PORT + 7);
        const space = await getJson(`${fullUrl}/library/remaining`);
        check(space.secondsLeft < 120,
          'the volume under test genuinely has less than the minimum on it, which is what makes this a fixture',
          `${space.label} at ${(space.bytesPerSec / 1e6).toFixed(1)} MB/s`);
        const refused = await post(`${fullUrl}/record/start`);
        check(/refusing to start a take/.test(refused.error ?? ''),
          'a take that cannot fit a sensible minimum is refused rather than failing partway through',
          (refused.error ?? 'ACCEPTED').slice(0, 92));
        const after = await getJson(`${fullUrl}/record/state`);
        check(after.armed === false && after.recording === false,
          'and the recorder is left disarmed rather than half-armed');
        check(readdirSync(room.mount).filter((f) => f.endsWith('.knct')).length === 0,
          'and nothing is written - a take that never started is a decision, one that dies at eighty percent is a loss',
          readdirSync(room.mount).join(' ') || 'empty');
      } finally {
        for (const p of servers.filter((sv) => sv.port === MAC_PORT + 7)) p.child.kill('SIGKILL');
        await new Promise((done) => { setTimeout(done, 400); });
        room.release();
      }
    }
  }

  // ---------------------------------------------------------- 6. the gallery page
  console.log('\n[library] the tiles: states, marks, buttons and the skim');
  {
    const { page, errors } = await openPage(browser, `${macUrl}/library.html`);
    await page.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
    const tiles = await page.evaluate('globalThis.__library.tiles()');
    // Keyed by hash, because the fixture deliberately contains two different takes
    // under one filename and a map keyed by name would silently keep one of them -
    // which would then have this tool asserting about a tile it never looked at.
    const byId = Object.fromEntries(tiles.map((t) => [t.hash, t]));
    const idOf = (id) => tiles.filter((t) => t.id === id);
    const one = (id) => { const hits = idOf(id); return byId[hits.find((t) => t.state !== 'remote')?.hash ?? hits[0].hash]; };

    // Skimming is a pointer affordance and the library also runs on a touch panel,
    // so nothing may be gated behind it. Every tile, every state.
    const labels = (t) => t.acts.map((a) => a.label);
    check(tiles.every((t) => t.acts.length >= 2),
      `every tile carries its actions without hover (${tiles.length} tiles)`);
    check(tiles.filter((t) => t.state === 'remote').every((t) => labels(t).includes('Download')),
      'a remote tile offers Download');
    check(tiles.filter((t) => t.state === 'local').every((t) => labels(t).includes('Open')),
      'a local tile offers Open');
    check(tiles.every((t) => labels(t).includes('Delete')), 'every tile offers Delete');
    check(tiles.filter((t) => t.state !== 'both').every((t) => !labels(t).includes('Reclaim')),
      'and Reclaim appears only where a second copy exists');

    // A take that cannot be opened says so on a disabled button rather than
    // throwing when pressed.
    check(one('no-hello-take').acts.find((a) => a.label === 'Open')?.disabled === true,
      'the Open on a take with no hello is disabled rather than a throw waiting to happen');
    check(one('local-clip').acts.find((a) => a.label === 'Open')?.disabled === false,
      'and an ordinary take opens');

    // Marks on the tile's scrub bar, at their source fraction. The two that a
    // fraction gets wrong on its own are checked by name: source zero has to land
    // at the left edge rather than being falsy-dropped, and one past the end has to
    // clamp rather than run off the tile.
    const marks = one('local-clip').marks;
    check(marks.length === 4, 'a take\'s marks are on the tile\'s scrub bar', `${marks.length} ticks`);
    check(marks[0] === 0, 'a mark at source zero sits at the left edge rather than vanishing');
    check(marks[marks.length - 1] === 100, 'and a mark past the end clamps to the right edge');
    check(tiles.some((t) => t.marks.length === 1), 'the single-mark case renders',
      `${tiles.filter((t) => t.marks.length === 1).length} tiles with one mark`);
    check(tiles.some((t) => t.marks.length === 0), 'and so does the no-mark case');

    // Remote tiles decimate visibly and say so - a gallery that skimmed both
    // identically would promise a responsiveness the architecture does not have.
    check(tiles.filter((t) => t.state === 'remote').every((t) => /decimated/.test(t.coarse ?? '')),
      'a remote tile says it is decimated');
    check(tiles.filter((t) => t.state !== 'remote').every((t) => t.coarse === null),
      'and a local one does not');

    // The skim draws a frame from the take rather than a placeholder, and a
    // different position draws a different frame. Read off the canvas, because a
    // position readout that moved while the picture did not is exactly what a
    // state-only assertion would pass.
    const clipHash = one('local-clip').hash;
    await page.evaluate(`globalThis.__library.drawn(${JSON.stringify(clipHash)})`);
    const at0 = await page.evaluate(`globalThis.__library.poster(${JSON.stringify(clipHash)})`);
    await page.evaluate(`globalThis.__library.skimTo(${JSON.stringify(clipHash)}, 0.9)`);
    const at90 = await page.evaluate(`globalThis.__library.poster(${JSON.stringify(clipHash)})`);
    check(at0.mean > 1, 'the poster is a frame of the take rather than an empty canvas', `mean ${at0.mean.toFixed(1)}`);
    // The signature rather than the mean, and the reason is that the mean cannot
    // see this: two positions of one take are the same room a second apart, so
    // their average brightness agrees to within its own noise while every pixel
    // that a body moved across has changed. A threshold on the mean would be a
    // threshold on sampling residual.
    check(at90.signature !== at0.signature, 'and skimming to another position draws another frame',
      `${at0.signature} then ${at90.signature}, means ${at0.mean.toFixed(2)} and ${at90.mean.toFixed(2)}`);
    const remoteHash = tiles.find((t) => t.state === 'remote')?.hash;
    check(remoteHash !== undefined, 'a remote take is present to skim');
    await page.evaluate(`globalThis.__library.drawn(${JSON.stringify(remoteHash)})`);
    const remote = await page.evaluate(`globalThis.__library.poster(${JSON.stringify(remoteHash)})`);
    // Sixteen times fewer samples reach the canvas, so a decimated skim is
    // measurably sparser rather than merely labelled as such. This is the arm the
    // label alone cannot carry: a tile that said "decimated" and fetched a full
    // frame would pass every assertion above it.
    check(remote.mean > 0 && remote.mean < at0.mean * 0.5,
      'a decimated skim is measurably sparser than a local one, not just labelled',
      `local ${at0.mean.toFixed(1)} against remote ${remote.mean.toFixed(1)}`);

    // Every tab shows a count, and a count that disagreed with the tiles it filters
    // to would be the readout lying about the library rather than about a take.
    const counts = await page.evaluate(`(() => {
      const out = {};
      for (const tab of document.querySelectorAll('.tab')) {
        globalThis.__library.filter(tab.dataset.filter);
        out[tab.dataset.filter] = { label: tab.textContent, shown: document.querySelectorAll('.tile').length };
      }
      globalThis.__library.filter('all');
      return out;
    })()`);
    const agrees = Object.entries(counts).every(([, v]) => Number(v.label.match(/(\d+)$/)?.[1]) === v.shown);
    check(agrees, 'each tab\'s count is the number of tiles it filters to',
      Object.entries(counts).map(([k, v]) => `${k}:${v.label.trim()}=${v.shown}`).join(' '));
    check(Object.keys(counts).join(',') === 'all,local,remote,both',
      'and the tabs are exactly the states a take can be in', Object.keys(counts).join(','));

    check(errors.length === 0, 'the gallery raises no page errors', errors.slice(0, 2).join(' | '));
    await page.close();
  }

  // A library with no takes at all.
  {
    const emptyUrl = await startServer(root, ['--captures', join(WORK, 'empty-captures'), '--name', 'fresh'], MAC_PORT + 3);
    const { page, errors } = await openPage(browser, `${emptyUrl}/library.html`);
    await page.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
    const line = await page.evaluate('globalThis.__library.emptyLine()');
    check(/No takes here yet/.test(line ?? ''), 'an empty library says so rather than rendering nothing',
      String(line));
    // A library with nothing in it says so whichever tab is selected, because that
    // is the fact - "no takes are local" on a machine with no takes at all would be
    // technically true and would send someone looking for a filter to clear.
    await page.evaluate('globalThis.__library.filter("local")');
    const filtered = await page.evaluate('globalThis.__library.emptyLine()');
    check(/No takes here yet/.test(filtered ?? ''),
      'and it keeps saying so under a filter rather than blaming the filter',
      String(filtered));
    check(errors.length === 0, 'and an empty library raises no page errors', errors.slice(0, 2).join(' | '));
    await page.close();
  }

  // ------------------------------------------------ 7. the project round-trips
  console.log('\n[library] a project survives a round trip through a file');
  {
    // Two pages, and the split is not tidiness. The image comparison runs the
    // deterministic drive, which detaches the animation loop and binds its own
    // frames - and a page with a take open still has a transport answering
    // parameter writes with a seek, which would walk the *pinned* source backwards
    // from inside a repaint nobody asked for. So the document claims run on a page
    // with no take, where the drive owns the loop outright, and the two claims that
    // are genuinely about a take run on a page that has one.
    {
      const { page: takePage, errors: takeErrors } = await openPage(browser, `${macUrl}/?take=local-clip`, { width: 640, height: 400 });
      await takePage.waitForFunction('globalThis.__kinect?.timeline?.transport() !== null', null, { timeout: 40000 });
      await takePage.evaluate('globalThis.__kinect.timeline.settled()');
      check(await takePage.evaluate('globalThis.__kinect.library.takeHash()')
        === (await getJson(`${macUrl}/library/takes`)).takes.find((t) => t.id === 'local-clip').hash,
        'the editor names its take by the hash the manifest reports');

      // A project built on other footage. The hash is what catches a take that was
      // truncated, re-recorded or swapped underneath an edit, which a path cannot.
      const otherHash = (await getJson(`${macUrl}/library/takes`)).takes.find((t) => t.id === 'truncated-take').hash;
      await takePage.evaluate(`(async () => {
        const body = { ...globalThis.__kinect.library.serialiseProject(), take: { id: 'truncated-take', hash: ${JSON.stringify(otherHash)} } };
        await fetch('/projects/other-footage', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      })()`);
      const crossed = await takePage.evaluate(`(async () => {
        try { await globalThis.__kinect.library.loadProject('other-footage'); return 'ACCEPTED'; }
        catch (e) { return e.message; }
      })()`);
      check(/different footage/.test(crossed), 'a project built on other footage is refused against this take',
        crossed.slice(0, 80));

      // And the whole path end to end, seek included, onto the take it was built on.
      const own = await takePage.evaluate(`(async () => {
        const k = globalThis.__kinect;
        const body = { ...k.library.serialiseProject(), take: { id: k.library.takeId(), hash: k.library.takeHash() } };
        await fetch('/projects/own-footage', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        try { await k.library.loadProject('own-footage'); return 'ACCEPTED'; } catch (e) { return e.message; }
      })()`);
      check(own === 'ACCEPTED', 'and a project built on this take loads, seek and all', String(own).slice(0, 80));
      check(takeErrors.length === 0, 'the take page raises no page errors', takeErrors.slice(0, 2).join(' | '));
      await takePage.close();
    }

    const { page, errors } = await openPage(browser, `${macUrl}/`, { width: 640, height: 400 });
    await page.waitForFunction('globalThis.__kinect !== undefined', null, { timeout: 40000 });

    // A look nothing defaults to, so a restore that did nothing cannot pass.
    const SCRAMBLE = {
      pointSize: 21.6, opacity: 0.62, exposure: 2.35, bloom: 1.35, trails: 0.62,
      rgbSplit: 2.4, scanlines: 0.44, grain: 0.31, scan: 0.62, rim: 0.28, fade: 340, wake: 720,
    };
    // The deterministic drive rather than the timeline: an image comparison needs a
    // program position rendered with nothing between the walk and the pixels, and
    // the indexed source would put a fetch there.
    const times = await page.evaluate(`(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(pinFixture().toString('base64'))}), (c) => c.charCodeAt(0));
      return globalThis.__kinect.drive.pin(bytes.buffer);
    })()`);
    // Positions between the pinned frames rather than on them, so the run crosses
    // brackets and interpolates rather than landing on the same six images however
    // many are asked for.
    const positions = [];
    for (let i = 0; i < times.length - 1; i++) {
      for (let r = 0; r < 3; r++) positions.push(times[i] + (times[i + 1] - times[i]) * (r / 3));
    }
    // The camera is pinned inside the run and not once outside it: the drive walks
    // the accumulators and the look is rewritten between runs, and a camera left to
    // whatever the page last did would make two runs differ for a reason that has
    // nothing to do with the file under test.
    const RENDER = `async (opts) => {
      const k = globalThis.__kinect;
      k.drive.reset();
      k.freeCamera.position.set(0, 0.1, 1.6);
      k.freeCamera.lookAt(0, 0, -2.2);
      k.freeCamera.updateMatrixWorld(true);
      const out = [];
      for (const t of opts.positions) {
        k.drive.stepTo(t);
        const pixels = k.drive.readPixels();
        const digest = await crypto.subtle.digest('SHA-256', pixels);
        out.push(Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''));
      }
      return out;
    }`;
    const render = () => page.evaluate(`(${RENDER})(${JSON.stringify({ positions })})`);

    await page.evaluate(`globalThis.__kinect.params.apply(${JSON.stringify(SCRAMBLE)})`);
    const authored = await render();

    // Through an actual file: the page saves it, the server writes it, the page
    // reads it back. An in-memory `serialise`/`restore` pair would prove the
    // registry and not the door.
    await page.evaluate(`(async () => {
      const k = globalThis.__kinect;
      const body = k.library.serialiseProject();
      const res = await fetch('/projects/round-trip', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return res.json();
    })()`);
    await page.evaluate('globalThis.__kinect.params.reset()');
    const defaults = await render();
    // Fetched and restored, which is the document half of the load path. The take
    // gate and the re-seek `loadProject` adds around it are transport rather than
    // document, and they are asserted separately below - putting a seek inside this
    // comparison would have the indexed source fetching underneath a pinned drive.
    await page.evaluate(`(async () => {
      const doc = await (await fetch('/projects/round-trip')).json();
      globalThis.__kinect.library.restoreProject(doc.body);
    })()`);
    const reloaded = await render();

    check(eq(authored, reloaded), 'the reloaded file reproduces the run image for image',
      eq(authored, reloaded) ? '' : `first divergence at image ${authored.findIndex((h, i) => h !== reloaded[i])}`);
    // The blunt control. Without it the equality above would be arithmetic rather
    // than evidence: two renders of an unchanged page agree whatever the loader did.
    check(!eq(authored, defaults),
      'and the defaults do not - the file is what the image depends on');
    check(new Set(authored).size > authored.length / 2, 'the run itself moves across its positions',
      `${new Set(authored).size} distinct of ${authored.length}`);

    // The saved file is a file on disk with a version on it, not a blob the page
    // interprets for itself.
    const saved = JSON.parse(readFileSync(join(WORK, 'projects/round-trip.json'), 'utf8'));
    check(saved.version === 1, 'the file carries the format version', `version ${saved.version}`);
    check(JSON.parse(readFileSync(join(WORK, 'projects/own-footage.json'), 'utf8')).take?.hash?.startsWith('sha256:'),
      'and a project saved from the editor names its footage by content hash rather than by path');

    // ---- the three refusals, built as source rather than through JSON, because
    // JSON.stringify turns NaN and undefined into null and a case labelled NaN
    // would silently be testing null a second time.
    const refuse = async (label, source) => page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const p = k.library.serialiseProject();
      ${source}
      try { k.library.restoreProject(p); return 'ACCEPTED'; } catch (e) { return e.message; }
    })()`).then((message) => ({ label, message }));

    const cases = [
      ['a project with no version', 'delete p.version;'],
      ['a project from an older version', 'p.version = 0;'],
      ['a project from a newer version', 'p.version = 2;'],
      ['a version that is not a number', 'p.version = "1";'],
      ['a retime curve that falls', 'p.retime.keys = [{t:0,value:0},{t:1,value:2},{t:2,value:0.5}];'],
      ['a retime handle outside the unit box',
        'p.retime.keys = [{t:0,value:0,easeOut:[0.4,1.9],easeIn:[0.6,0]},{t:2,value:1,easeOut:[0.4,0],easeIn:[0.6,0]}];'],
      ['a camera key whose quaternion is not unit length',
        'p.tracks.camera = [{t:0,value:{position:[0,0,3],quaternion:[0,0,0,1.4],fov:55}},{t:1,value:{position:[1,0,3],quaternion:[0,0,0,1],fov:55}}];'],
      ['a camera key whose quaternion is all zeros',
        'p.tracks.camera = [{t:0,value:{position:[0,0,3],quaternion:[0,0,0,0],fov:55}}];'],
      ['a camera key with a short position',
        'p.tracks.camera = [{t:0,value:{position:[0,0],quaternion:[0,0,0,1],fov:55}}];'],
      ['a camera key whose fov is NaN',
        'p.tracks.camera = [{t:0,value:{position:[0,0,3],quaternion:[0,0,0,1],fov:NaN}}];'],
      ['a scalar key that is a string', 'p.tracks.bloom = [{t:0,value:"0.5"}];'],
      ['a scalar key that is null', 'p.tracks.bloom = [{t:0,value:null}];'],
      ['a key at an undefined time', 'p.tracks.bloom = [{t:undefined,value:0.5}];'],
      ['a track the registry does not know', 'p.tracks.nosuchthing = [{t:0,value:1}];'],
      ['a mode outside the modes that exist', 'p.mode = 9;'],
      ['an output rate of zero', 'p.outputFps = 0;'],
      ['a preset stamp that is not a name and a rev', 'p.appliedPreset = { name: 42 };'],
    ];
    const results = [];
    for (const [label, source] of cases) results.push(await refuse(label, source));
    for (const { label, message } of results) {
      check(message !== 'ACCEPTED', `refused: ${label}`, message === 'ACCEPTED' ? 'ACCEPTED' : message.slice(0, 64));
    }
    // The control the refusals need. A loader that threw at everything would pass
    // every row above and open nothing.
    const good = await refuse('an unmodified project', '');
    check(good.message === 'ACCEPTED', 'and an unmodified project still loads',
      good.message === 'ACCEPTED' ? '' : good.message.slice(0, 80));

    check(errors.length === 0, 'the document path raises no page errors', errors.slice(0, 2).join(' | '));
    await page.close();
  }

  // ------------------------------------------------------- 8. the preset library
  console.log('\n[library] presets carry look and a provenance stamp');
  {
    const { page, errors } = await openPage(browser, `${macUrl}/?take=local-clip`, { width: 640, height: 400 });
    await page.waitForFunction('globalThis.__kinect?.timeline?.transport() !== null', null, { timeout: 40000 });
    await page.evaluate('globalThis.__kinect.timeline.settled()');

    // A preset saved off a Blackwall clip whose values have then been moved away
    // from Blackwall's. This is the shape that catches an apply routed through
    // `setMode`: the mode says 4, so `setMode` would write the hardcoded look and
    // the hand-tuned values would never survive.
    const TUNED = { bloom: 2.4, trails: 0.11, rgbSplit: 4.2, grain: 0.77, pointSize: 30.5 };
    await page.evaluate(`(async () => {
      const k = globalThis.__kinect;
      k.setMode(4);
      k.params.apply(${JSON.stringify(TUNED)});
      const res = await fetch('/presets/hand-tuned', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(k.library.presetFromCurrentLook()),
      });
      return res.json();
    })()`);

    const onDisk = readFileSync(join(WORK, 'presets/hand-tuned.json'), 'utf8');
    const doc = JSON.parse(onDisk);
    check(doc.version === 1, 'a preset carries the format version too');
    // Step 3's carried note: the registry excludes the mode as clip state, so a
    // preset saved as `values(names('look'))` alone would neither capture nor
    // restore it - and the spec lists mode first among presettable look.
    check(doc.mode === 4, 'a preset carries the clip\'s mode alongside the registry subset',
      `mode ${doc.mode}`);
    check(doc.values.bloom === TUNED.bloom && doc.values.pointSize === TUNED.pointSize,
      'and the look values it was saved with');
    check(!('camera' in doc.values) && !('renderScale' in doc.values),
      'composition and view state stay out of it - applying a look must not move your camera');

    // Applied onto a clip that has been moved away from it. Wrapped, because this
    // is the evaluate the documented context-loss flake lands on here - twice in
    // one sweep, in two different mutation runs, always at this call.
    const applied = await retryOnContextLoss('applying the preset', () => page.evaluate(`(async () => {
      const k = globalThis.__kinect;
      k.setMode(0);
      k.params.apply({ bloom: 0, trails: 0, rgbSplit: 0, grain: 0, pointSize: 9 });
      const before = { pose: k.params.get('camera'), values: k.params.values(k.params.names('look')) };
      const docRes = await fetch('/presets/hand-tuned');
      k.library.applyStoredPreset(await docRes.json());
      return {
        before,
        after: k.params.values(k.params.names('look')),
        mode: k.mode(),
        pose: k.params.get('camera'),
        stamp: k.library.appliedPreset(),
      };
    })()`));
    check(applied.after.bloom === TUNED.bloom && applied.after.rgbSplit === TUNED.rgbSplit
      && applied.after.grain === TUNED.grain && applied.after.pointSize === TUNED.pointSize,
      'applying a preset restores the values it was saved with, not the built-in look for its mode',
      `bloom ${applied.after.bloom} rgbSplit ${applied.after.rgbSplit} pointSize ${applied.after.pointSize}`);
    check(applied.mode === 4, 'and it restores the mode, which the registry does not carry');
    check(eq(applied.pose, applied.before.pose), 'and it does not move the camera');

    // The stamp, hashed over the bytes on disk. A re-serialisation would hash
    // differently for the same meaning, and the provenance would drift for no
    // reason anyone could later find.
    const diskRev = `sha256:${createHash('sha256').update(onDisk).digest('hex')}`;
    check(applied.stamp?.name === 'hand-tuned' && applied.stamp?.rev === diskRev,
      'the provenance stamp is the hash of the preset\'s bytes on disk',
      `${applied.stamp?.rev?.slice(7, 19)} against ${diskRev.slice(7, 19)}`);

    const inProject = await page.evaluate('globalThis.__kinect.library.serialiseProject().appliedPreset');
    check(eq(inProject, applied.stamp), 'and it travels in the project, so drift across a set of clips is visible');

    // The copy is what keeps a project self-contained: the values are in the file,
    // so a worker needs the file and nothing else. Changing the preset must not
    // change what an already-saved project renders.
    await page.evaluate(`(async () => {
      await fetch('/presets/hand-tuned', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 0, values: { bloom: 0, pointSize: 9 } }),
      });
    })()`);
    const stillTuned = await page.evaluate("globalThis.__kinect.params.get('bloom')");
    check(stillTuned === TUNED.bloom,
      'editing the preset afterwards does not reach back into the clip - the values were copied in',
      `bloom ${stillTuned}`);

    // A preset from a version this build does not read.
    const refusedPreset = await page.evaluate(`(() => {
      try {
        globalThis.__kinect.library.applyStoredPreset({ name: 'old', rev: 'sha256:0', body: { version: 0, values: { bloom: 1 } } });
        return 'ACCEPTED';
      } catch (e) { return e.message; }
    })()`);
    check(refusedPreset !== 'ACCEPTED', 'a preset from another format version is refused',
      refusedPreset.slice(0, 70));

    check(errors.length === 0, 'the preset path raises no page errors', errors.slice(0, 2).join(' | '));
    await page.close();
  }

  // --------------------------------------------------- 9. marks on the scrubber
  console.log('\n[library] marks on the editor\'s scrubber, through the retime curve');
  {
    const { page, errors } = await openPage(browser, `${macUrl}/?take=local-clip`, { width: 1100, height: 700 });
    await page.waitForFunction('globalThis.__kinect?.timeline?.transport() !== null', null, { timeout: 40000 });
    await page.evaluate('globalThis.__kinect.timeline.settled()');

    const marks = await page.evaluate('globalThis.__kinect.library.marks()');
    check(marks.length === 4, 'the take\'s marks are loaded with it', `${marks.length} marks`);
    check(marks.every((m, i) => i === 0 || m.sourceMs >= marks[i - 1].sourceMs),
      'and they arrive in source order');

    const flat = await page.evaluate('globalThis.__kinect.library.markTicks()');
    check(flat.length === marks.length, 'every mark draws a tick on the ruler', `${flat.length} ticks`);
    check(flat[0].left === 0, 'a mark at source zero ticks at the left edge');
    check(flat[flat.length - 1].beyond === true,
      'and a mark the edit never reaches is drawn at the edge as unreachable rather than dropped');

    // **The probe has to stand where a wrong implementation would disagree.** At
    // rate 1 with no keys, program time *is* source time, so a tick drawn from the
    // source fraction and a tick drawn through the curve land on the same pixel -
    // every assertion above would pass against an implementation that never looked
    // at the retime at all. So the curve gets a ramp, and the ticks have to move.
    const KEYS = [{ t: 0, value: 0 }, { t: 4, value: 0.6 }, { t: 6, value: 2.4 }];
    await page.evaluate(`globalThis.__kinect.keyframes.setRetime({ rate: 1, keys: ${JSON.stringify(KEYS)} })`);
    await page.evaluate('globalThis.__kinect.timeline.settled()');
    const retimed = await page.evaluate('globalThis.__kinect.library.markTicks()');
    const shown = await page.evaluate('globalThis.__kinect.timeline.read()');
    check(retimed.length === flat.length, 'a retime does not lose a tick');

    // **Asserted against positions computed here, not against "they moved".** A
    // retime changes the program duration as well as the mapping, so the ruler's
    // denominator moves too - and a build that drew ticks at the raw source
    // fraction would have every tick move for that reason alone and pass a
    // did-it-change test. The curve's inverse is therefore worked out in this file,
    // from the keys this file wrote, with the handles left linear so a straight
    // segment is a straight segment.
    const programOf = (sourceSec) => {
      if (sourceSec <= KEYS[0].value) return KEYS[0].t;
      for (let i = 0; i < KEYS.length - 1; i++) {
        if (KEYS[i + 1].value < sourceSec) continue;
        const span = (KEYS[i + 1].value - KEYS[i].value) / (KEYS[i + 1].t - KEYS[i].t);
        return KEYS[i].t + (sourceSec - KEYS[i].value) / span;
      }
      const last = KEYS.length - 1;
      const span = (KEYS[last].value - KEYS[last - 1].value) / (KEYS[last].t - KEYS[last - 1].t);
      return KEYS[last].t + (sourceSec - KEYS[last].value) / span;
    };
    const pct = (x) => Math.max(0, Math.min(1, x)) * 100;
    const expected = marks.map((m) => pct(programOf(m.sourceMs / 1000) / shown.duration));
    // Where the wrong implementation would draw each tick: the raw source fraction,
    // over the same denominator. Computed rather than assumed, because that is what
    // decides which of these marks is a probe and which is a coincidence - and the
    // comparison against the *pre-retime* layout cannot decide it, since a retime
    // moves the denominator too and every tick shifts for that reason alone.
    const naive = marks.map((m) => pct(m.sourceMs / 1000 / shown.duration));
    const off = retimed.map((t, i) => Math.abs(t.left - expected[i]));
    const discriminating = marks.map((_, i) => i).filter((i) => Math.abs(expected[i] - naive[i]) > 5);
    check(discriminating.length >= 2,
      'at least two marks land somewhere the source fraction cannot, which is what makes them probes',
      marks.map((m, i) => `${(m.sourceMs / 1000).toFixed(1)}s: curve ${expected[i].toFixed(1)}% against fraction ${naive[i].toFixed(1)}%`).join('; '));
    check(discriminating.every((i) => off[i] < 1.5),
      'and each tick sits where the curve puts it rather than where the fraction would',
      marks.map((m, i) => `${(m.sourceMs / 1000).toFixed(1)}s -> ${retimed[i].left.toFixed(1)}% (want ${expected[i].toFixed(1)}%)`).join('; '));

    // A mark written from the editor lands in the take's sidecar, in source
    // milliseconds, so it outlives this project.
    await page.evaluate('globalThis.__kinect.timeline.transport().seek(1.0)');
    await page.evaluate('globalThis.__kinect.timeline.settled()');
    await page.evaluate('globalThis.__kinect.library.markHere()');
    const written = (await getJson(`${macUrl}/capture/local-clip/marks`)).marks;
    check(written.length === 5, 'pressing mark writes to the take\'s sidecar', `${written.length} marks now`);
    const sourceAt1 = await page.evaluate('globalThis.__kinect.timeline.retime.sourceSecAt(1.0)');
    const fresh = written.find((m) => !['k0', 'k1', 'k2', 'kBeyond'].includes(m.id));
    check(Math.abs(fresh.sourceMs - sourceAt1 * 1000) < 40,
      'and it is stamped in source milliseconds rather than program time',
      `${fresh.sourceMs}ms against source ${(sourceAt1 * 1000).toFixed(0)}ms at program 1.0s`);

    check(errors.length === 0, 'the marks path raises no page errors', errors.slice(0, 2).join(' | '));
    await page.close();
  }

  // ------------------------------------------------------------ 10. the recorder
  console.log('\n[library] a take is a file, and the remaining-time report is a duration');
  {
    const state = await getJson(`${macUrl}/record/state`);
    check(state.recording === false && state.armed === false, 'a server with no sensor is not recording');
    check(/^(\d+h \d+m|\d+m \d+s|\d+s|unbounded)$/.test(state.storage.label),
      `the monitor's space readout is a duration (${state.storage.label})`);
    check(state.storage.secondsLeft > 0, 'and it is derived from a rate rather than being a byte count');
    const marked = await post(`${macUrl}/record/mark`, {});
    check(/nothing is recording/.test(marked.error ?? ''),
      'pressing mark with no take open says so rather than writing a mark nowhere',
      (marked.error ?? 'ACCEPTED').slice(0, 60));
  }

  // ------------------------------------------- 5. download, reclaim and delete
  console.log('\n[library] download verifies, reclaim keeps a verified copy, delete is the last one');
  {
    // The remote take deliberately shares a *filename* with a different local take,
    // because that is the case a name-based implementation destroys footage in: the
    // library already lists them as two entries, and writing one at the other's name
    // would delete a take to satisfy a convention this design does not use.
    const remote = (await getJson(`${macUrl}/library/all`)).takes.find((t) => t.state === 'remote');
    const localSameName = readFileSync(join(macCaps, 'same-name.knct'));
    const pulled = await post(`${macUrl}/library/download/${remote.id}`);
    check(pulled.hash === remote.hash, `a download lands under the hash the node advertised (${remote.id})`,
      JSON.stringify(pulled).slice(0, 90));
    check(Buffer.compare(readFileSync(join(macCaps, 'same-name.knct')), localSameName) === 0,
      'and it does not overwrite a different local take that happens to share its filename',
      `landed as ${pulled.downloaded}`);
    check(pulled.downloaded !== 'same-name.knct' && /same-name-[0-9a-f]{8}\.knct/.test(pulled.downloaded),
      'the collision takes the hash into the name, which is what the join was already saying');

    // The marks came with it, merged rather than replaced, with the tombstone
    // holding: n1 and n2 survive, n3 does not.
    const shared = 'mac-name-for-it';
    await post(`${macUrl}/library/sync-marks/${shared}`, {});
    const merged = (await getJson(`${macUrl}/capture/${shared}/marks`)).marks;
    check(merged.length === 2 && merged.every((m) => m.id !== 'n3'),
      'a sync merges the node\'s log as a union and a tombstone stays dead',
      merged.map((m) => m.id).join(' '));
    // Last-write-wins per id, in the direction that matters: a later local edit of
    // a mark the node also holds.
    await post(`${macUrl}/capture/${shared}/marks`, { marks: [{ id: 'n2', sourceMs: 4242, label: 'moved here', at: 9e12 }] });
    await post(`${macUrl}/library/sync-marks/${shared}`, {});
    const afterSync = (await getJson(`${macUrl}/capture/${shared}/marks`)).marks;
    check(afterSync.find((m) => m.id === 'n2')?.sourceMs === 4242,
      'and a later edit wins over an older record with the same id even after a re-sync');

    // Delete refuses what reclaim is for, and reclaim refuses what delete is for.
    const bothTake = (await getJson(`${macUrl}/library/all`)).takes.find((t) => t.state === 'both');
    const wrongDelete = await post(`${macUrl}/library/delete/${bothTake.id}`, { hash: bothTake.hash, confirm: true });
    check(/exists on/.test(wrongDelete.error ?? ''), 'delete refuses a take that exists in two places',
      (wrongDelete.error ?? 'ACCEPTED').slice(0, 70));
    const noConfirm = await post(`${macUrl}/library/delete/local-clip`, { hash: 'sha256:x' });
    check(/confirm/.test(noConfirm.error ?? ''), 'delete refuses without an explicit confirm');
    const wrongHash = await post(`${macUrl}/library/delete/local-clip`, { hash: 'sha256:nope', confirm: true });
    check(/moved underneath|not the/.test(wrongHash.error ?? ''),
      'delete refuses a hash that is not the take\'s, so a stale listing cannot remove the wrong file');
    const badReclaim = await post(`${macUrl}/library/reclaim/local-clip`, {});
    check(/nothing to reclaim/.test(badReclaim.error ?? ''), 'reclaim refuses a take that exists in one place');

    // **The falsification control, and it has to be a substitution the manifest
    // cannot see.** Reclaim rests on a hash-verified copy surviving here, so the
    // copy is damaged and the reclaim has to notice - but damaging it in a way that
    // changes the file's size or its modification time only proves the index cache
    // invalidates, which is a different claim and is checked above. The case this
    // exists for is the one step 2's sidecar comment names: **same size, same
    // mtime, different bytes**, which is what a bad sync or a restored backup
    // produces. The sidecar then still says the old hash, the take still reconciles
    // against the node's, and the only thing standing between the operator and a
    // reclaim that destroys the last good copy is the re-hash on the removal path.
    //
    // Constructed through the sidecar rather than by holding the modification time
    // still, and that is a method note worth keeping: APFS records mtime to the
    // nanosecond while `utimesSync` takes a JavaScript Date, so restoring a time
    // that way lands a few hundred nanoseconds off and the scan notices - the same
    // precision mismatch that made `index-check`'s mtime assertion fail on its
    // first run. Writing the sidecar to describe the *new* file with the *old* hash
    // reaches the identical state deterministically: the size matches, the time
    // matches, and the hash on record is a lie.
    const localPath = join(macCaps, `${bothTake.id}.knct`);
    const sidecarPath = localPath.replace(/\.knct$/, '.idx');
    const good = readFileSync(localPath);
    const swapped = Buffer.from(good);
    swapped.fill(0, swapped.length - 5000);
    writeFileSync(localPath, swapped);
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    writeFileSync(sidecarPath, JSON.stringify({
      ...sidecar, bytes: statSync(localPath).size, mtimeMs: statSync(localPath).mtimeMs,
    }));
    const stale = (await getJson(`${macUrl}/library/all`)).takes.find((t) => t.id === bothTake.id);
    check(stale?.hash === bothTake.hash,
      'the substitution is invisible to the manifest, which is what makes this a control',
      `listing still reports ${String(stale?.hash).slice(7, 19)}`);
    const refused = await post(`${macUrl}/library/reclaim/${bothTake.id}`, {});
    const nodeStillHasIt = (await getJson(`${nodeUrl}/library/takes`)).takes.some((t) => t.hash === bothTake.hash);
    check(/refusing to reclaim/.test(refused.error ?? ''),
      'reclaim re-hashes the surviving copy and refuses when the bytes are not what the library listed',
      (refused.error ?? 'ACCEPTED').slice(0, 90));
    check(nodeStillHasIt, 'and the node still holds its copy - nothing was removed on a stale belief');

    // Restored, and the lying sidecar removed with it so the next listing is a scan
    // of what is actually there.
    writeFileSync(localPath, good);
    rmSync(sidecarPath, { force: true });
    const fresh = (await getJson(`${macUrl}/library/all`)).takes.find((t) => t.id === bothTake.id);
    const done = await post(`${macUrl}/library/reclaim/${fresh.id}`, {});
    const nodeGone = !(await getJson(`${nodeUrl}/library/takes`)).takes.some((t) => t.hash === fresh.hash);
    check(done.reclaimed && done.keptHere === fresh.hash,
      'a reclaim against a verified copy removes the node\'s and names the survivor\'s hash');
    check(nodeGone && existsSync(localPath),
      'the node\'s copy is gone and the hash-verified one here is not');

    // Delete: the last copy, and it is genuinely the last one afterwards.
    const last = (await getJson(`${macUrl}/library/all`)).takes.find((t) => t.id === 'one-frame-take');
    const deleted = await post(`${macUrl}/library/delete/one-frame-take`, { hash: last.hash, confirm: true });
    check(deleted.removed === 'one-frame-take.knct' && !existsSync(join(macCaps, 'one-frame-take.knct')),
      'delete removes the last copy, and it is the file that goes');
    check(!(await getJson(`${macUrl}/library/all`)).takes.some((t) => t.id === 'one-frame-take'),
      'and the library no longer lists it');
  }

  for (const { log } of servers) {
    const text = log.join('');
    const bad = text.split('\n').filter((l) => /Error|throw|unhandled/i.test(l) && !/refus|cannot open/i.test(l));
    if (bad.length) {
      console.log(`\n[library] server log:\n  ${bad.slice(0, 4).join('\n  ')}`);
      failures++;
    }
  }
}
