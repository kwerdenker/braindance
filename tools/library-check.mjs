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
import { createConnection } from 'node:net';
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
  'reconcile-by-filename': { file: 'server/library.js', edits: [[
    "  const keyOf = (take, side) => take.hash ?? `${side}:${take.id}`;",
    '  const keyOf = (take) => take.id;',
  ]] },
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
    '    stream.write(helloMessage);',
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
  // Re-anchored when step 9 lifted the sampling loop out of `Capture.readFrame` and
  // into the module-level `decimatePayload` the live socket shares - the body is
  // unchanged and two spaces to the left, which is exactly the shape the
  // match-exactly-once rule exists to surface rather than swallow.
  'decimate-drops-colour': { file: 'server/capture.js', edits: [
    ['  out.writeUInt32LE(colorBytes, 4);', '  out.writeUInt32LE(0, 4);'],
    ['  payload.copy(out, 16 + w * h * 2, 16 + depthBytes);', '  /* mutation: colour dropped */'],
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
  // ---- the mutating routes, one term per mutation, so a failing row says which
  // term broke rather than that something did.
  //
  // A route reaches its handler only by being an entry in the table, and an entry
  // reaches a handler that changes something only through `requireMutation`. The two
  // guard mutations take the origin and content-type terms out one at a time.
  //
  // **The method one cannot be narrowed and its rows are not one per term, so it is
  // said here rather than left to read as if it were.** Letting a GET reach the write
  // branch on its own moves nothing: `requireMutation` is still in the path and still
  // answers 405 to a GET, so the page under test is unchanged and a mutation that
  // does nothing reads as a check that found nothing. The second edit is therefore
  // load-bearing, and it removes the gate rather than the method term - so this one
  // trips all three guard rows. The catch is real and the extra coverage is welcome;
  // what would be wrong is a comment claiming a diagnosis this mutation does not give.
  'writes-take-any-method': { file: 'server/index.js', edits: [
    ['    if (!reading && r.write) {', '    if (r.write) {'],
    ['      if (!requireMutation(req, res, r.write.methods)) return true;',
      '      /* mutation: whatever method arrived is fine */'],
  ] },
  'origin-unchecked': { file: 'server/http-guard.js', edits: [[
    'export function originAllowed(req) {\n  const origin = req.headers.origin;',
    'export function originAllowed(req) {\n  return true; /* mutation: any page may act on this server */\n  const origin = req.headers.origin;',
  ]] },
  'content-type-unchecked': { file: 'server/http-guard.js', edits: [[
    "const JSON_TYPE = /^application\\/json\\s*(?:;|$)/i;",
    'const JSON_TYPE = /^/; /* mutation: anything a no-cors fetch can send is fine */',
  ]] },
  // **The control for the enumeration itself: a mutating handler *added* in a `read`
  // slot.** This is the shape the rule names, and it is a different shape from
  // moving one - the sweep used to rest on a hardcoded floor,
  // `mutating.length >= 10 && writeOnly.length >= 7`, which moving a route trips
  // because the counts fall and which adding one cannot trip at all. Planted against
  // that build, this route went through the whole suite at 241 of 241, exit 0, with
  // `planted-by-a-read-route.json` on disk afterwards.
  //
  // It writes a *project*, deliberately, because that is the store the old sweep did
  // not watch: the shooting server was spawned with no `--projects`, so the document
  // stores lived outside the one directory being snapshotted. What catches it now is
  // the snapshot of all five stores taken across a drive of every read route.
  'read-route-writes': { file: 'server/index.js', edits: [[
    "  { path: '/library/routes', pattern: /^\\/library\\/routes$/, read: serveRoutes },",
    "  { path: '/library/routes', pattern: /^\\/library\\/routes$/, read: serveRoutes },\n"
    + "  { path: '/library/sweep-probe', pattern: /^\\/library\\/sweep-probe$/, read: (req, res) => {\n"
    + "    PROJECTS.write('planted-by-a-read-route', { planted: true })\n"
    + '      .then(() => sendJson(res, { planted: true }), (err) => sendJson(res, { error: err.message }, 500));\n'
    + '  } },',
  ]] },
  // **The plant a contents comparison cannot see, and the reason the write count is a
  // row of its own.** A read route that writes a document and removes it again inside
  // the same request. Both readings the sweep takes are outside the request, and what
  // they compare - the names, sizes and modification times of the files that are there
  // - is byte-for-byte what it was, because the file this wrote is gone by the time the
  // second reading happens and nothing that survived was touched. Only the monotonic
  // count moves, by two.
  //
  // Written this way after the obvious version was measured and found dishonest. That
  // one overwrote the seeded document and restored its timestamp with `utimesSync`, and
  // it failed *both* rows - because APFS keeps modification times to the nanosecond,
  // `utimesSync` takes a `Date` that keeps milliseconds, and the snapshot caught the
  // 0.13ms the restore could not put back. That is the filesystem's timestamp
  // resolution catching it rather than the sweep's design, and on a filesystem with
  // coarser stamps the same plant walks through - so a control resting on it would have
  // been asserting the platform. Write-then-remove needs no timestamp restored at all.
  'read-route-restores': { file: 'server/index.js', edits: [[
    "  { path: '/library/writes', pattern: /^\\/library\\/writes$/, read: serveWriteCounts },",
    "  { path: '/library/writes', pattern: /^\\/library\\/writes$/, read: serveWriteCounts },\n"
    + "  { path: '/library/sweep-probe', pattern: /^\\/library\\/sweep-probe$/, read: async (req, res) => {\n"
    + "    await PROJECTS.write('planted-then-removed', { version: 1, body: {} });\n"
    + "    await PROJECTS.remove('planted-then-removed');\n"
    + '    sendJson(res, { restored: true });\n'
    + '  } },',
  ]] },
  // **The plant that destroys the shoot.** A read route appending to the file the
  // recorder has open - the one place where three of this sweep's observations are
  // switched off at once, since the open take's size and modification time are out of
  // the snapshot by name, no write counter covers the captures directory, and the
  // recorder's state field does not move for a foreign append. Against the build
  // before this, it passed 251 assertions at exit 0 while ruining the take.
  //
  // Written through the recorder's own stream rather than appended through a second
  // descriptor. The old plant used `appendFileSync`, and the next recorder frame
  // wrote from the first descriptor's older offset and erased the plant before close
  // — so the mutation healed itself and passed 256 assertions. Through this stream
  // the foreign bytes stay ordered between two real frames. 0x07 rather than
  // anything structured makes the damage a desync the scan names rather than a
  // plausible frame, and 64KB makes it unambiguously more than in-flight noise.
  'plant-open-take': { file: 'server/index.js', edits: [
    ["  { path: '/library/writes', pattern: /^\\/library\\/writes$/, read: serveWriteCounts },",
      "  { path: '/library/writes', pattern: /^\\/library\\/writes$/, read: serveWriteCounts },\n"
      + "  { path: '/library/sweep-probe', pattern: /^\\/library\\/sweep-probe$/, read: (req, res) => {\n"
      + '    recorder.take.stream.write(Buffer.alloc(65536, 0x07));\n'
      + '    sendJson(res, { appended: true });\n'
      + '  } },'],
  ] },
  // The other half of the captures directory, and the reason it is a mutation rather
  // than a sentence: the open take is excluded from the snapshot *by name*, so every
  // other file in there should still be covered - and "should" is what this repo
  // measures. A read route unlinking a take that is not the one being recorded.
  'plant-unlink-closed-take': { file: 'server/index.js', edits: [
    ["import { createReadStream, mkdirSync, readdirSync, statSync } from 'node:fs';",
      "import { createReadStream, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';"],
    ["  { path: '/library/writes', pattern: /^\\/library\\/writes$/, read: serveWriteCounts },",
      "  { path: '/library/writes', pattern: /^\\/library\\/writes$/, read: serveWriteCounts },\n"
      + "  { path: '/library/sweep-probe', pattern: /^\\/library\\/sweep-probe$/, read: (req, res) => {\n"
      + "    const victim = readdirSync(CAPTURES_DIR).find((f) => f.endsWith('.knct')\n"
      + '      && join(CAPTURES_DIR, f) !== recorder.openPath);\n'
      + '    if (victim) unlinkSync(join(CAPTURES_DIR, victim));\n'
      + '    sendJson(res, { removed: victim ?? null });\n'
      + '  } },'],
  ] },
  // A mutating handler *moved* behind a `read`. Kept beside the plant above rather
  // than described as the control, which it is not: what catches this one is the
  // recorder having moved, since a `GET /record/stop` ends the take.
  // The control for the namespace seam. It puts the derived set back to a written
  // list, one name short - which is exactly the state the dispatcher was in before
  // step 8, and exactly the state it would return to the next time somebody added
  // a namespace to a literal instead of to the table.
  //
  // `presets` is dropped rather than a name invented, so the mutation is testable
  // against today's tree rather than only once `jobs` exists. What must fail is the
  // shadowing row: with `presets` unowned, the file planted at web/presets/ is
  // served off disk with a 200 where the route table should have answered 404.
  'namespaces-hardcoded': { file: 'server/index.js', edits: [[
    'export const OWNED_NAMESPACES = new Set(ROUTES.map((r) => {',
    // Two parens are open at the anchor (`new Set(` and `ROUTES.map(`), so the
    // replacement leaves two open too or the file does not parse - and a mutation
    // that fails to parse is a server that never starts, which this suite would
    // report as a catch without ever having run the check.
    "export const OWNED_NAMESPACES = new Set(['capture', 'library', 'projects', 'record']);\n"
    + 'const _unusedNamespaceDerivation = new Set([].map((r) => {',
  ]] },
  'stop-route-reads': { file: 'server/index.js', edits: [[
    "  { path: '/record/stop', pattern: /^\\/record\\/stop$/, write: { methods: ['POST'], run: serveRecordStop } },",
    "  { path: '/record/stop', pattern: /^\\/record\\/stop$/, read: serveRecordStop },",
  ]] },
  // Marks for a take that is not here, which created its sidecar in the captures
  // directory out of a caller's own JSON.
  'marks-without-a-take': { file: 'server/index.js', edits: [[
    '  if (!takeIsHere(path)) {\n    sendJson(res, { error: `no take ${id} here, so there is nothing to mark` }, 404);\n    return;\n  }',
    '  /* mutation: any id may have marks */',
  ]] },
  // The document store restamps the version instead of checking it, so a project
  // from a build this one is not lands looking like one this build wrote.
  'store-restamps-version': { file: 'server/library.js', edits: [[
    '    if (body?.version !== undefined && body.version !== PROJECT_VERSION) {',
    '    if (false) {',
  ]] },
  // A replay server records. The frames come off a file on a loop, so their stamps
  // repeat, and one take is one continuous stream with monotonic stamps.
  'replay-can-record': { file: 'server/index.js', edits: [[
    '  cannotRecord: () => (REPLAY\n    ?', '  cannotRecord: () => (false\n    ?',
  ]] },
  // The demonstrated failure, whole: recording a replay is allowed *and* the replay
  // hands `handleMessage` a payload with no framing. One open take then turns every
  // frame into a throw that lands in the replay tick's catch - no frame reaches any
  // client, the status flaps between lost and live, and `/record/state` reports a
  // healthy recording throughout.
  //
  // Both edits in one mutation on purpose. Removing the framing on its own moves
  // nothing, because the refusal above means `recorder.write` is never reached - a
  // mutation that does nothing, wearing the appearance of one that does, which is
  // the shape this repo has been caught by before. What the pair proves is that the
  // framing is load-bearing rather than decorative: with the door open, it is the
  // only thing between the replay loop and a throw per frame.
  'replay-records-a-bare-payload': { file: 'server/index.js', edits: [
    ['  cannotRecord: () => (REPLAY\n    ?', '  cannotRecord: () => (false\n    ?'],
    ['        handleMessage({ type: TYPE_FRAME, payload, raw: encodeMessage(TYPE_FRAME, payload) });',
      '        handleMessage({ type: TYPE_FRAME, payload });'],
  ] },
  // `forgetCapture` drops the map entry and leaves the descriptor to the collector,
  // which on this Node is a process death rather than an untidy count.
  'forget-leaks-descriptor': { file: 'server/capture.js', edits: [
    ['  pending?.then((capture) => {\n    capture.doomed = true;\n    if (capture.leases === 0) capture.close().catch(() => {});\n  }, () => {});',
      '  pending?.then((capture) => { if (capture.leases === 0) capture.close().catch(() => {}); }, () => {});'],
    ['    if (capture.doomed && capture.leases === 0) await capture.close().catch(() => {});',
      '    /* mutation: the last lease lets go and nothing closes anything */'],
  ] },
  // A take that dies mid-write drops the marks pressed during it.
  'mid-write-drops-marks': { file: 'server/recorder.js', edits: [[
    '        flushMarks(failed);', '        /* mutation: the marks go nowhere */',
  ]] },
  // The flush moves out of the `finally`, so a close that rejects loses them - the
  // second way the same orphaning arrived.
  'close-flush-outside-finally': { file: 'server/recorder.js', edits: [[
    '    try {\n      await once(take.stream, \'close\');\n    } finally {',
    '    {\n      await once(take.stream, \'close\');\n    }\n    {',
  ]] },
  // The write stream's backpressure is discarded again, so a stalling card becomes
  // heap that grows until the process is killed.
  'recorder-ignores-backpressure': { file: 'server/recorder.js', edits: [[
    '    if (take.stream.writableLength > MAX_TAKE_BUFFER) {', '    if (false) {',
  ]] },
  // The counters go back to reporting what was accepted rather than what drained, so
  // the monitor reads healthy for exactly as long as the failure is invisible.
  'recorder-counts-accepted': { file: 'server/recorder.js', edits: [[
    '  const written = take.stream.bytesWritten;', '  const written = take.accepted;',
  ]] },
  // The in-flight queue is drained only when something asks for state, which is the
  // shape the previous round shipped: nothing removes an entry until an operator
  // opens the monitor, so the queue is bounded by the length of the take and the
  // drain that finally runs is quadratic in it. The stall is synchronous, so the
  // grabber sees backpressure and drops depth packets at the device.
  'settle-drains-on-poll-only': { file: 'server/recorder.js', edits: [[
    `    // Drained on the frame path rather than only when something asks for state, and
    // that placement is what makes the queue bounded by the ceiling below instead of
    // by the length of the take. \`settle\` carries the measurement and the mechanism.
    settle(take);`,
    '    /* mutation: the queue is drained only when something asks for state */',
  ]] },
  // The head advances and the array is never compacted, which leaves the depth
  // correct and the allocation growing with the take - and puts every operation over
  // that array back to scaling with the take's length.
  'settle-never-compacts': { file: 'server/recorder.js', edits: [[
    `  if (take.inFlightHead > 0 && take.inFlightHead * 2 >= take.inFlight.length) {
    take.inFlight.splice(0, take.inFlightHead);
    take.inFlightHead = 0;
  }`,
    '  /* mutation: the head moves and the array is never compacted */',
  ]] },
  // The transition into dropping goes back to being silent, so the only thing
  // carrying it is the panel's five-second poll - and after the queue drains on
  // every write, no monitor has to be open for the drop to happen at all.
  'drop-transition-silent': { file: 'server/recorder.js', edits: [[
    `        // stays green costs the take.
        this.onChange(this.state);`,
    '        /* mutation: the drop is left to the five-second poll */',
  ]] },
  // The push moves out from behind the transition flag and fires per dropped frame,
  // which is a socket write in the frame path on the one machine that cannot afford
  // one. Without this the "pushed once" row would only ever be exercised by the
  // mutation above, which fires it zero times.
  'drop-transition-per-frame': { file: 'server/recorder.js', edits: [[
    `      take.dropped++;
      if (!take.stalling) {`,
    `      take.dropped++;
      this.onChange(this.state);
      if (!take.stalling) {`,
  ]] },
  // The buffer ceiling shrinks to an eighth. Every row that reads the ceiling out of
  // the build still passes - which is the point - and the take now survives about
  // half a second of a stalled card rather than four and a half.
  'ceiling-too-small': { file: 'server/recorder.js', edits: [[
    'export const MAX_TAKE_BUFFER = 64 * 1024 * 1024;',
    'export const MAX_TAKE_BUFFER = 8 * 1024 * 1024;',
  ]] },
  // The manifest scans the take being written, which is a full read and a sha256 of
  // a growing multi-gigabyte file per request, against the recorder's own disk.
  'manifest-scans-open-take': { file: 'server/library.js', edits: [[
    '  if (recording) {\n    return {', '  if (false) {\n    return {',
  ]] },
  // The boot stops making the captures directory, which is the state a reflashed
  // node comes up in.
  'boot-without-captures-dir': { file: 'server/index.js', edits: [[
    '  mkdirSync(CAPTURES_DIR, { recursive: true });',
    '  /* mutation: the captures directory is assumed */',
  ]] },
  // Delete goes back to trusting the sidecar where reclaim re-hashes, so the
  // irreversible action carries the weaker check.
  'delete-trusts-sidecar': { file: 'server/library.js', edits: [[
    '  const actual = await hashFile(path);', '  const actual = (await cachedIndex(path)).hash;',
  ]] },
  // The decimation path stops checking that a frame's two declared lengths describe
  // the frame, so an overstated colour length returns the uninitialised tail of an
  // `allocUnsafe` buffer.
  // Re-anchored with `decimate-drops-colour` above, and for the same reason.
  'decimate-skips-length-check': { file: 'server/capture.js', edits: [[
    '  if (16 + depthBytes + colorBytes !== payload.length) {', '  if (false) {',
  ]] },
  // The registry's door goes back to testing truthiness on an object literal, which
  // accepts every name on `Object.prototype`.
  'registry-gate-by-truthiness': { file: 'web/main.js', edits: [[
    '  if (!Object.hasOwn(PARAMS, name)) throw new Error(`unknown parameter ${JSON.stringify(name)}`);',
    '  if (!PARAMS[name]) throw new Error(`unknown parameter ${JSON.stringify(name)}`);',
  ]] },
  // The delete confirm promises to remove a copy the server refuses to remove.
  'confirm-promises-both-delete': { file: 'web/library.js', edits: [[
    "  const alsoOnNode = take.state === 'both';", '  const alsoOnNode = false;',
  ]] },
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

/**
 * A take whose second frame declares more colour bytes than it carries.
 *
 * The reachable version is a writer that died between the header and the payload,
 * or a take truncated by a card pulled - the scan indexes what landed, and the
 * frame's own two lengths then no longer add up to the frame. The decimation path
 * builds a new buffer out of those two numbers with `allocUnsafe` and copies the
 * colour block into it, so an overstated length left the tail of the served frame
 * as whatever was in that memory: this process's own recycled heap, handed to
 * whoever asked for a frame.
 */
function writeBadLengthTake(dir, id) {
  const good = SRC.frames[0];
  const bent = Buffer.from(good);
  // The framing is untouched, so the scan walks the file cleanly and indexes the
  // frame - which is what makes this a bad *frame* rather than a bad file. Only the
  // colour length inside the payload moves, and it moves upward.
  const payloadAt = 12;
  const colorBytes = bent.readUInt32LE(payloadAt + 4);
  bent.writeUInt32LE(colorBytes + 4096, payloadAt + 4);
  const body = Buffer.concat([encodeMessage(TYPE_HELLO, SRC.hello), SRC.frames[1], bent, SRC.frames[2]]);
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
  writeBadLengthTake(macCaps, 'bad-length-take');

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
  // `web` is copied where the other two are symlinked, and the difference is not
  // cosmetic: the namespace-shadowing row plants files under it, and a symlink
  // would put those in the repo's own web/. A proof tool that writes into its
  // subject makes every later run untrustworthy, which is the same reason
  // mutations run against a staged copy rather than an edit-and-restore. It is
  // 312K, so the isolation costs nothing worth counting.
  cpSync(join(REPO, 'web'), join(root, 'web'), { recursive: true });
  for (const name of ['node_modules', 'vendor']) {
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
 * Waits until a frame has actually come off the sensor, and answers how long it took.
 *
 * **The socket, because nothing over HTTP says this.** `/record/state` reports armed
 * and recording, which are what the operator asked for rather than what the sensor is
 * doing, and a wait written against them is a wait on the wrong quantity - section 4c
 * had one keyed on `armed === false`, true from boot, which granted a fixed 255ms
 * while claiming to wait for the hello. A binary message on the live channel is a
 * frame that was captured, parsed and fanned out, which is the condition the sections
 * that call this actually need.
 */
async function liveFrame(url, timeoutMs = 20000) {
  const began = Date.now();
  const ws = new WebSocket(url.replace('http', 'ws'));
  try {
    await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no frame from ${url} within ${timeoutMs}ms`)), timeoutMs);
      const finish = (err) => { clearTimeout(timer); if (err) fail(err); else done(); };
      ws.on('message', (data, isBinary) => { if (isBinary) finish(); });
      ws.on('error', finish);
      ws.on('close', () => finish(new Error(`the live channel on ${url} closed before a frame arrived`)));
    });
  } finally {
    ws.close();
  }
  return Date.now() - began;
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

/**
 * Whether a line in a server's log means this run went wrong.
 *
 * **The generic pattern cannot see the recorder's fatal line, and the allowlist was
 * hiding it twice over.** `!/refus|cannot open/i` dropped
 * `[recorder] cannot open <path>: <errno> - recording is off`, which is the single
 * message meaning a shooting node stopped - and it would have been dropped anyway,
 * because every errno that produces it (ENOSPC, EACCES, ENOENT, ENOTDIR) spells out
 * a message containing neither "Error" nor "throw" nor "unhandled". So removing it
 * from the allowlist is not enough; the line needs a pattern of its own.
 *
 * `recording is off` is that pattern, and it is the right one rather than a
 * convenient one: it is the phrase all three recorder failures end with - the open
 * that could not happen, the write that died mid-take, and the names that ran out -
 * and every one of them means footage stopped being written on a machine that
 * believed it was shooting.
 *
 * The two benign lines are anchored to their prefixes instead of matched by
 * substring, so `[server] cannot open` stays benign while `[recorder] cannot open`
 * does not.
 */
const BENIGN_LOG = [
  /^\[server\] cannot open /, // the replay reader saying the file it was pointed at is not there
  /refusing to start a take/, // the low-space gate, which is a decision rather than a failure
];
const FATAL_LOG = [
  /Error|throw|unhandled/i,
  /recording is off/, // every recorder failure ends here, and none of them says "Error"
  /no free take name/,
];
const looksFatal = (line) => FATAL_LOG.some((re) => re.test(line)) && !BENIGN_LOG.some((re) => re.test(line));

// The predicate's own falsification control, run before anything else so a sweep
// that has been quietly blinded says so in the first three lines rather than by
// passing a mutated tree. Every case here is a real line one of these servers emits.
function checkLogPredicate() {
  console.log('\n[library] the log sweep can see the line that matters');
  const cases = [
    ['[recorder] cannot open /caps/2026-07-31-take1.knct: ENOSPC: no space left on device - recording is off', true],
    ['[recorder] cannot open /caps/x.knct: EACCES: permission denied, open \'/caps/x.knct\' - recording is off', true],
    ['[recorder] take 2026-07-31-take2 failed mid-write: EIO: i/o error - recording is off', true],
    ['[recorder] no free take name after 64 tries - recording is off', true],
    ['[server] capture request failed: Error: short read at 4096', true],
    ['[server] cannot open /nope/missing.knct: ENOENT: no such file or directory', false],
    ['[recorder] refusing to start a take: 8s left at current settings, under the 2m minimum', false],
    ['[recorder] 2026-07-31-take1 is already taken, trying the next name', false],
    ['[server] 24.8 fps  12.2 MB/s  dropped=0  clients=1', false],
    ['[recorder] take 2026-07-31-take3 open', false],
  ];
  const wrong = cases.filter(([line, want]) => looksFatal(line) !== want);
  check(wrong.length === 0,
    'the sweep flags every recorder line that means a shooting node stopped, and none of the ordinary ones',
    wrong.length ? wrong.map(([l]) => l.slice(0, 52)).join(' | ') : `${cases.length} lines, ${cases.filter((c) => c[1]).length} fatal`);
  // Named on its own, because this is the one the old predicate dropped and the
  // reason it dropped it was two independent failures agreeing.
  check(looksFatal('[recorder] cannot open /caps/take1.knct: ENOTDIR: not a directory - recording is off'),
    'including `[recorder] cannot open`, which the old allowlist excluded by name and the old pattern could not have matched anyway');
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
} catch (err) {
  // Recorded rather than thrown. An exception out of here used to end the process
  // with no verdict line and no assertion count - which reads as a caught mutation
  // to anything counting exit codes and as nothing at all to anything counting rows.
  // Several of this step's own mutations end in a server that has died, and a dead
  // server is a failure this tool has to be able to *say*.
  console.log(`\n  FAIL  the run did not finish: ${err.message}`);
  assertions++;
  failures++;
} finally {
  await browser.close();
  stopServers();
}

// The verdict, and a skipped claim reaches all three of it: the count line, the
// word, and the status this process exits with.
//
// It used to reach only the count line. On any platform that cannot make a small
// filesystem - which is every platform but this one - the run printed an
// unqualified `[library] PASS` and exited 0 with the low-space refusal never
// exercised, so "it never silently passes" was a claim about macOS being read as a
// claim about the tool. A CI job checks the exit code and nothing else, so the
// status is where it has to land.
//
// Code 2 rather than 1, because "some claims were not tested here" and "a claim
// failed" are different answers and collapsing them would make an unprovable
// platform look like a broken build. Anything checking `!== 0` now treats a run with
// an unproven claim as not-a-pass, which is the intended reading.
const note = skipped.length ? `, ${skipped.length} claim${skipped.length === 1 ? '' : 's'} unproven here (${skipped.join(', ')})` : '';
if (failures) console.log(`\n[library] ${assertions} assertions, ${failures} failed${note}`);
else console.log(`\n[library] ${assertions} assertions, none failed${note}`);
const verdict = failures ? `FAIL (${failures})`
  : skipped.length ? `PASS WITH ${skipped.length} CLAIM${skipped.length === 1 ? '' : 'S'} UNPROVEN HERE (${skipped.join('; ')})`
    : 'PASS';
console.log(`[library] ${verdict}`);
process.exit(failures ? 1 : skipped.length ? 2 : 0);

async function runChecks() {
  checkLogPredicate();

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

    // A frame whose two declared lengths do not describe the frame. Only the depth
    // length was checked, so an overstated colour length sized a fresh
    // `allocUnsafe` buffer larger than the copy that follows fills - and what came
    // back past the copy was uninitialised memory rather than picture.
    const bentUrl = `${macUrl}/capture/bad-length-take/frame/1`;
    const bent = await fetch(`${bentUrl}?decimate=4`);
    check(bent.status >= 400,
      'a frame whose declared lengths overrun the payload is refused rather than sampled past',
      `${bent.status} ${(await bent.text()).slice(0, 80)}`);
    // The control, and it is what says this arm is about the *frame* rather than
    // about the take: the same take's other frames are fine, so the scan indexed
    // the file and the refusal is per frame.
    const beside = await fetch(`${bentUrl.replace('/frame/1', '/frame/0')}?decimate=4`);
    check(beside.ok, 'while the sound frames beside it in the same take still decimate',
      `frame 0 came back ${beside.status}`);
    // And at divisor 1 nothing is rebuilt, so the file's own bytes come back exactly
    // as the format promises - which is why the check lives on the decimation path.
    const verbatim = await fetch(bentUrl);
    check(verbatim.ok, 'and the undecimated read still returns the bytes the file holds, unchanged',
      `frame 1 undecimated came back ${verbatim.status}`);

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
    // Optional access for the same reason section 4c has it: a build with no hello at
    // the head of a take leaves `t.hello` null here, and reading through it ended the
    // run in this section - so `recorder-skips-hello` was caught on the two rows
    // above and then took every section after it out of the run, which is a mutation
    // whose real reach nobody was measuring.
    check(scanned.every((t, i) => i === 0 || t.hello?.startedAt > scanned[i - 1].hello?.startedAt),
      'and it advances take to take, so a library can sort by when it was shot',
      scanned.map((t) => t.hello?.startedAt ?? 'none').join(' '));

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
    //
    // **The condition is a frame arriving, and it used to be the opposite of one.**
    // The loop here broke on `armed === false`, which is true from boot on a server
    // nobody has armed - so it left after a single 250ms tick while its comment
    // claimed it was waiting for the sensor. Measured 5 of 5: the loop returned at
    // 255ms and the first frame arrived at 257-506ms, negative margin every run, and
    // the row below then failed with `null` for reasons that had nothing to do with
    // what it tests. A gate that goes red for unrelated reasons is how people learn
    // to re-run until green.
    await liveFrame(markUrl, 20000);
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
    // Read through optional access from here down, and that is about the *tool*
    // rather than about the take. A mutation that stops `/record/stop` from working
    // leaves `stopped` undefined, and `stopped.id` then threw - which ended the run
    // in this section and left every section after it unrun, while the exit code
    // still looked like a mutation being caught. `stop-route-reads` was caught that
    // way, by a TypeError twelve hundred lines above the arm whose comment claimed
    // the credit.
    const listed = (await getJson(`${markUrl}/library/takes`)).takes.find((t) => t.id === stopped?.id);
    check(listed?.marks?.length === 1 && listed.marks[0].label === 'the moment',
      'and the mark is on the take in the library, not inside the capture',
      JSON.stringify(listed?.marks));
    // Marks are stamped raw and never pre-rolled - people press a few hundred
    // milliseconds after the thing happens, and a constant baked in at capture time
    // would be a guess. What is checked is that it lands inside the take.
    check(listed?.marks?.[0]?.sourceMs > 0 && listed.marks[0].sourceMs < listed.durationSec * 1000 + 500,
      'stamped inside the footage it flags rather than at an arbitrary offset',
      listed?.marks?.[0] ? `${listed.marks[0].sourceMs}ms into ${(listed.durationSec * 1000).toFixed(0)}ms` : 'no mark landed');
    check(Boolean(stopped?.id) && existsSync(join(markDir, `${stopped.id}.marks.jsonl`)),
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
    // Corroboration, and labelled as corroboration. This is a `console.warn` scrape,
    // and an implementation that logged twice without retrying would satisfy it -
    // so it cannot be the thing that proves the retry happened. What proves that is
    // the row above: the recorder landed on `take3` while `take1` and `take2` sat
    // there byte-identical, which no implementation reaches without having been
    // refused by both and stepped past both.
    check((clashLog.match(/is already taken/g) ?? []).length === 2,
      'and the log agrees, with two refusals - corroboration for the take3 row above, which is what carries the claim',
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

    // **What the confirm promises against what the server does.** A `both` take's
    // delete dialog offered "a copy exists on both machines; this removes the one
    // here", and `serveRemoval` answers that exact request with a 409 - delete is
    // the last copy, reclaim is a copy while another survives. It errs safe, which
    // is why it survived review, and a confirm that describes an outcome the server
    // declines is a confirm nobody can trust the next time it says something is
    // irreversible. So the page's own dialog is read here and the server is asked
    // the same question, and the two have to agree.
    const bothHash = tiles.find((t) => t.state === 'both')?.hash;
    const bothTakeId = tiles.find((t) => t.state === 'both')?.id;
    check(bothHash !== undefined, 'a take in state both is on screen to ask about', String(bothTakeId));
    const bothConfirm = await page.evaluate(`globalThis.__library.confirmFor(${JSON.stringify(bothHash)}, 'Delete')`);
    const serverSays = await post(`${macUrl}/library/delete/${bothTakeId}`,
      { hash: one(bothTakeId)?.hash ?? bothHash, confirm: true });
    check(/exists on .* as well|reclaim removes a copy/.test(serverSays.error ?? ''),
      'the server refuses to delete a take that exists in two places, which is the behaviour the dialog has to describe',
      (serverSays.error ?? 'ACCEPTED').slice(0, 70));
    check(!/removes the one here/.test(bothConfirm.warn) && /refused|two/.test(bothConfirm.warn),
      'and the confirm says so rather than promising to remove the copy here',
      bothConfirm.warn.slice(0, 90));
    check(bothConfirm.goDisabled === true,
      'with no destructive button to press, so the operator is not agreeing to something that will be declined');
    const localConfirm = await page.evaluate(`globalThis.__library.confirmFor(${JSON.stringify(one('local-clip').hash)}, 'Delete')`);
    // The control: the case delete *is* for still offers it, or the row above would
    // pass against a dialog that had simply been disabled everywhere.
    check(localConfirm.goDisabled === false && /only copy/.test(localConfirm.warn),
      'while a take that really is the last copy still warns and still offers the button',
      localConfirm.warn.slice(0, 70));

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
      // **The registry's door, probed where the answer is different.** The one name
      // this list used to try was `nosuchthing`, which is the case the code handled
      // correctly - a probe placed exactly where the wrong implementation agrees
      // with the right one. `PARAMS` is an object literal, so gating on
      // `PARAMS[name]` truthiness accepted every name `Object.prototype` answers
      // for: `__proto__` landed in `tracks`, `normalise` read min, max and step off
      // a function and made NaN out of undefined, and the page threw mid-render -
      // a failure inside the evaluator rather than a decision at the door, which is
      // the whole class the door exists for.
      ['a track the registry does not know', 'p.tracks.nosuchthing = [{t:0,value:1}];'],
      // `p.tracks.__proto__ = x` sets the *prototype* and creates no own property at
      // all, so `Object.entries` never sees it and the loader is handed an unchanged
      // document - a probe placed exactly where the wrong implementation and the
      // right one agree, which is the trap this repo already has two entries for.
      // `defineProperty` builds the own, enumerable property that `JSON.parse` puts
      // there when a file on disk literally contains `"__proto__": [...]`, which is
      // the shape this arrives in.
      ['a track named __proto__',
        "Object.defineProperty(p.tracks, '__proto__', { value: [{t:0,value:1}], enumerable: true, configurable: true, writable: true });"],
      ['a track named constructor', 'p.tracks.constructor = [{t:0,value:1}];'],
      ['a track named toString', 'p.tracks.toString = [{t:0,value:1}];'],
      ['a track named valueOf', 'p.tracks.valueOf = [{t:0,value:1}];'],
      ['a track named hasOwnProperty', 'p.tracks.hasOwnProperty = [{t:0,value:1}];'],
      ['a parameter named constructor in the values', 'p.params.constructor = 1;'],
      ['a parameter named __proto__ in the values',
        "Object.defineProperty(p.params, '__proto__', { value: 1, enumerable: true, configurable: true, writable: true });"],
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

    // Straight at the registry, because the load path is one of four doors into it
    // and the other three were gated the same wrong way. `spec`, `get`, `normalise`
    // and `set` each asked the question in their own words - three `PARAMS[name]`
    // and one `name in PARAMS`, which is one hole written two ways.
    const inherited = await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const names = ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'];
      const out = {};
      for (const name of names) {
        out[name] = {};
        for (const door of ['spec', 'get', 'normalise', 'set']) {
          try {
            k.params[door](name, 0.5);
            out[name][door] = 'ACCEPTED';
          } catch (e) {
            out[name][door] = /unknown parameter/.test(e.message) ? 'refused' : 'threw: ' + e.message.slice(0, 40);
          }
        }
      }
      return out;
    })()`);
    const leaked = Object.entries(inherited)
      .flatMap(([name, doors]) => Object.entries(doors).filter(([, v]) => v !== 'refused').map(([d, v]) => `${name}.${d}=${v}`));
    check(leaked.length === 0,
      'every door into the registry refuses a name that only exists on Object.prototype, and refuses it as an unknown parameter rather than throwing somewhere inside',
      leaked.slice(0, 4).join(' ') || `${Object.keys(inherited).length} names x 4 doors, all refused`);
    // The control: a real parameter still goes through all four, or the row above
    // would pass against a registry that refused everything.
    const real = await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      try {
        return { spec: typeof k.params.spec('bloom').max, normalised: k.params.normalise('bloom', 1.25), set: k.params.set('bloom', 1.25), got: k.params.get('bloom') };
      } catch (e) { return { error: e.message }; }
    })()`);
    check(real.spec === 'number' && Number.isFinite(real.normalised) && real.got === real.set,
      'while a parameter the registry does declare passes through all four unchanged',
      JSON.stringify(real));
    await page.evaluate('globalThis.__kinect.params.reset()');

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

    // **`timeline.settled()` settles the transport, and the marks are not on it.**
    // They arrive on the library's own fetch, so a read taken the instant the render
    // queue drained came back `0 marks` beside `4 ticks` on a loaded machine - a row
    // red for a reason that has nothing to do with what it tests, which is the same
    // shape as section 4c's inverted wait. Waited for, and swallowed rather than
    // thrown, so a build that genuinely loads none fails the row below with its own
    // number instead of ending the section with a timeout.
    await page.waitForFunction('globalThis.__kinect.library.marks().length > 0', null, { timeout: 15000 })
      .catch(() => {});
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

    // **The same substitution, now on the delete path.** Reclaim re-derived the hash
    // and delete read it off the sidecar, which meant the irreversible action was
    // carrying the weaker check - and the technique that catches it was already
    // sitting in this tool twenty lines up, built as reclaim's falsification
    // control. Same size, same modification time, different bytes: the manifest
    // cannot see it, the listing keeps reporting the hash the sidecar remembers,
    // and a delete built on that listing removes a file whose bytes nobody looked at.
    {
      const victimPath = join(macCaps, 'no-hello-take.knct');
      const victimSidecar = victimPath.replace(/\.knct$/, '.idx');
      const listedBefore = (await getJson(`${macUrl}/library/takes`)).takes.find((t) => t.id === 'no-hello-take');
      const original = readFileSync(victimPath);
      const substituted = Buffer.from(original);
      substituted.fill(0, substituted.length - 5000);
      writeFileSync(victimPath, substituted);
      const idx = JSON.parse(readFileSync(victimSidecar, 'utf8'));
      writeFileSync(victimSidecar, JSON.stringify({
        ...idx, bytes: statSync(victimPath).size, mtimeMs: statSync(victimPath).mtimeMs,
      }));
      const stillListed = (await getJson(`${macUrl}/library/takes`)).takes.find((t) => t.id === 'no-hello-take');
      check(stillListed?.hash === listedBefore.hash,
        'the substitution is invisible to the manifest here too, which is what makes this the same control',
        `listing still reports ${String(stillListed?.hash).slice(7, 19)}`);
      const refusedDelete = await post(`${macUrl}/library/delete/no-hello-take`,
        { hash: listedBefore.hash, confirm: true });
      check(/not the .*this removal named|moved underneath/.test(refusedDelete.error ?? ''),
        'delete re-hashes the file it is about to unlink and refuses when the bytes are not what the library listed',
        (refusedDelete.error ?? 'ACCEPTED').slice(0, 90));
      check(existsSync(victimPath),
        'and the file is still there - the only irreversible action does not run on a hash nobody re-derived');
      // Restored, and the lying sidecar with it, so the delete below is a delete of
      // a take whose bytes are what the library says.
      writeFileSync(victimPath, original);
      rmSync(victimSidecar, { force: true });
      const honest = (await getJson(`${macUrl}/library/takes`)).takes.find((t) => t.id === 'no-hello-take');
      const gone = await post(`${macUrl}/library/delete/no-hello-take`, { hash: honest.hash, confirm: true });
      check(gone.removed === 'no-hello-take.knct' && !existsSync(victimPath),
        'while a delete whose hash matches the bytes on disk goes through - the control that stops the row above being a delete that simply never works');
    }

    // Delete: the last copy, and it is genuinely the last one afterwards.
    const last = (await getJson(`${macUrl}/library/all`)).takes.find((t) => t.id === 'one-frame-take');
    const deleted = await post(`${macUrl}/library/delete/one-frame-take`, { hash: last.hash, confirm: true });
    check(deleted.removed === 'one-frame-take.knct' && !existsSync(join(macCaps, 'one-frame-take.knct')),
      'delete removes the last copy, and it is the file that goes');
    check(!(await getJson(`${macUrl}/library/all`)).takes.some((t) => t.id === 'one-frame-take'),
      'and the library no longer lists it');
  }

  // ------------------------------------------- 7. the routes that change something
  //
  // **Enumerated rather than named.** The review that produced this section found six
  // routes dispatching on the path alone - `GET /record/stop` ending a shoot,
  // `GET /library/reclaim/:id` destroying the node's copy - by poking them one at a
  // time, which makes six a floor rather than a total and leaves the next route
  // anybody adds outside whatever list gets written today. So the server serves its
  // own route table at `/library/routes`, derived from the array the dispatcher
  // walks rather than restated beside it, and this section iterates it: every route
  // that changes something is asked the same three questions, and a route added
  // later is asked them by existing.
  //
  // One row per term, because a cumulative row cannot say which term broke. The
  // method probe carries a JSON content type and no foreign origin, so only the
  // method is under test; the content-type probe carries the right method; the
  // origin probe carries both. Each of the three mutations below fails its own rows
  // and leaves the other two alone.
  //
  // And the fourth row is the falsification control: the same request in the shape
  // the capture-node link actually uses - correct method, JSON, and **no `Origin`
  // header at all**, because nothing in Node has an origin to declare - has to be
  // let through. Without it, a guard that refused everything would pass the first
  // three rows perfectly.
  console.log('\n[library] every route that changes something requires its method, its type and its origin');
  {
    const guardDir = join(WORK, 'guarded');
    mkdirSync(guardDir, { recursive: true });
    writeTake(guardDir, 'guard-take', { frames: 6 });
    // Given its own document directories rather than left on the defaults. The
    // control probe below is a *successful* write - that is what makes it a control -
    // so on the defaults it planted `no-such-document.json` in the staged tree's own
    // `projects/` on every run, clean runs included. A proof tool that leaves files
    // in a directory it did not make is a habit worth not starting.
    const guardDocs = join(WORK, 'guard-docs');
    const guardPresets = join(WORK, 'guard-presets');
    const guardUrl = await startServer(root, [
      '--captures', guardDir, '--name', 'guarded',
      '--projects', guardDocs, '--presets', guardPresets,
    ], MAC_PORT + 8);
    const table = (await getJson(`${guardUrl}/library/routes`)).routes;

    // **The file tree must not answer for a namespace the route table owns**, and
    // this is asked of every namespace in the table rather than of the five
    // somebody wrote down. The dispatcher used to hold that list as a literal, so
    // the day a namespace was added it was outside the list until someone noticed -
    // which is the "close the class, not the instance" rule, aimed at the seam step
    // 8 was about to add `jobs` to.
    //
    // It is deliberately NOT a traversal test. The handoff that asked for this said
    // `/jobs/../web/main.js` traverses, and it does not: `new URL()` removes dot
    // segments including `%2e%2e`, and `isInside` rejects whatever is left, so four
    // escape attempts all came back with nothing served. The real property is
    // shadowing, and it is worth one measured sentence rather than a story - a file
    // planted under an unowned namespace IS served, 200 with its contents, and the
    // same file under an owned one is the API's 404.
    const tableNamespaces = [...new Set(table.map((r) => r.path.split('/')[1]))];
    check(tableNamespaces.length >= 5, 'the route table declares its namespaces, so this row grows when a step adds one',
      tableNamespaces.join(', '));

    // **The probe is two segments deep, and the first version was not.** A file at
    // `/presets/shadow-probe.js` is claimed by `/presets/:name`, whose `([^/]+)`
    // matches it - so the table answered 404 out of `readDocument` and the
    // fallthrough this row is about was never reached. The mutation below ran the
    // whole suite and was NOT caught, at 255 assertions and none failed, which is
    // what a probe sitting in a dead zone looks like from the outside: indis-
    // tinguishable from a build with nothing wrong with it. A slash in the tail
    // puts it past every `([^/]+)` in the table.
    const PROBE = 'shadow-probe/leak.js';
    // The unowned twin. Without it the owned rows could all be 404 because nothing
    // is served from anywhere - a check that only asserts refusals passes happily
    // against a file server that is simply broken.
    const CONTROL_NS = 'not-a-declared-namespace';
    for (const ns of [...tableNamespaces, CONTROL_NS]) {
      mkdirSync(join(root, 'web', ns, 'shadow-probe'), { recursive: true });
      writeFileSync(join(root, 'web', ns, PROBE), `// planted under /${ns} by library-check\n`);
    }
    const control = await fetch(`${guardUrl}/${CONTROL_NS}/${PROBE}`);
    check(control.status === 200,
      'a file under a namespace the table does NOT declare is served off disk, which is what makes the next row mean something',
      `/${CONTROL_NS}/${PROBE} -> ${control.status}`);
    const shadowed = [];
    for (const ns of tableNamespaces) {
      const res = await fetch(`${guardUrl}/${ns}/${PROBE}`);
      if (res.status !== 404) shadowed.push(`${ns}:${res.status}`);
    }
    check(shadowed.length === 0,
      'and the identical file under every namespace the table DOES declare is the API\'s 404, not the file',
      shadowed.length ? `served: ${shadowed.join(' ')}` : `${tableNamespaces.length} namespaces, all 404`);
    // Removed again so the planted files cannot make any later row mean something
    // different from what it says.
    for (const ns of [...tableNamespaces, CONTROL_NS]) rmSync(join(root, 'web', ns), { recursive: true, force: true });

    const mutating = table.filter((r) => r.mutates);
    // A route that also answers GET is a legitimate read at that method, so the
    // method row below is about the ones where a GET can only be somebody else's
    // idea. What covers the rest is the read sweep further down: every route with a
    // read handler is driven with a plain GET and the recorder and the captures
    // directory have to be where they were.
    const writeOnly = mutating.filter((r) => !r.read);
    const readable = table.filter((r) => r.read);
    // **A count of registered routes cannot answer "did a read handler mutate
    // something", and this row used to be one.** It read
    // `mutating.length >= 10 && writeOnly.length >= 7`, today's values - which
    // *moving* a route into the read slot trips, because the counts fall, and which
    // **adding** one cannot trip at all, because adding a read route moves neither
    // number in the failing direction. So the floor was structurally blind to
    // exactly the shape the rule names, and a planted mutating read route went
    // through the whole suite at 241 of 241 with its file on disk afterwards.
    //
    // What replaces it is a coverage row further down - every entry in the table
    // driven, with any route this sweep cannot build a concrete URL for named rather
    // than skipped - and the resource rows beside it, which observe what moved.
    // Coverage in one place, behaviour in another.
    const swept = new Set();
    console.log(`  ...   ${table.length} routes, ${mutating.length} mutating, `
      + `${writeOnly.length} of those write-only, ${readable.length} answering GET`);

    // A concrete URL for a route pattern. Ids that do not exist on purpose: the
    // guard runs before the handler, so its verdict is visible either way, and a
    // refusal that comes from the handler is a refusal this section is not about.
    //
    // **A path this cannot make concrete comes back null rather than half-built.** A
    // route added later with a parameter nobody taught this about would otherwise be
    // driven at a URL still carrying a literal `:foo`, match no pattern, answer 404
    // and be recorded as swept - a route counted and not tested, which is the same
    // bookkeeping-instead-of-resource failure the sweep below exists to close.
    const concrete = (path, { id = 'no-such-take', name = 'no-such-document' } = {}) => {
      const built = path
        .replace(':id', id)
        .replace(':name', name)
        .replace(':a-:b', '0-1')
        .replace(':n', '0');
      return built.includes(':') ? null : built;
    };
    const urlFor = (path) => guardUrl + concrete(path);
    const status = async (path, init) => (await fetch(urlFor(path), init)).status;
    const GUARDED = new Set([403, 405, 415]);

    const wrongMethod = [];
    const wrongType = [];
    const wrongOrigin = [];
    const refusedOutright = [];
    for (const r of mutating) {
      swept.add(r.path);
      const method = r.methods[0];
      // Method: a GET that is otherwise perfectly formed. This is the shape a link
      // prefetch or an `<img src>` produces, which is how `GET /record/stop` was
      // reachable from any page anybody visited. Asked only of the routes that offer
      // nothing to read, since a GET of `/projects/:name` is a project being read.
      if (!r.read && await status(r.path, { headers: { 'Content-Type': 'application/json' } }) !== 405) wrongMethod.push(r.path);
      // Content type: the right method, declaring text/plain. This is the only shape
      // a cross-origin `no-cors` fetch can send, so it is the term that actually
      // stops a hostile page.
      if (await status(r.path, { method, headers: { 'Content-Type': 'text/plain' }, body: '{}' }) !== 415) wrongType.push(r.path);
      // Origin: everything right except the page it claims to come from.
      if (await status(r.path, {
        method,
        headers: { 'Content-Type': 'application/json', Origin: 'http://evil.invalid' },
        body: '{}',
      }) !== 403) wrongOrigin.push(r.path);
      // The control. No `Origin` at all, which is every call across the node link.
      if (GUARDED.has(await status(r.path, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' }))) {
        refusedOutright.push(r.path);
      }
    }
    check(wrongMethod.length === 0,
      `every route that only changes things refuses a GET (${writeOnly.length} of ${mutating.length} mutating routes)`,
      wrongMethod.join(' ') || 'all 405');
    check(wrongType.length === 0,
      'every mutating route refuses a body that does not declare JSON', wrongType.join(' ') || 'all 415');
    check(wrongOrigin.length === 0,
      'every mutating route refuses a cross-origin caller', wrongOrigin.join(' ') || 'all 403');
    check(refusedOutright.length === 0,
      'and the shape the node link uses - right method, JSON, no Origin header - is let through, which is what stops this being a guard that refuses everything',
      refusedOutright.join(' ') || `${mutating.length} routes reached their handler`);

    // **A refusal has to mean the route did not act**, which a status code does not
    // say on its own. Driven on the two the reviewer demonstrated, against a server
    // that is genuinely recording, because "the take is still open afterwards" is
    // the assertion a 405 cannot make.
    const shootDir = join(WORK, 'guard-shooting');
    const shootProjects = join(WORK, 'guard-shooting-projects');
    const shootPresets = join(WORK, 'guard-shooting-presets');
    for (const d of [shootDir, shootProjects, shootPresets]) {
      rmSync(d, { recursive: true, force: true });
      mkdirSync(d, { recursive: true });
    }
    // **All five stores, and a closed take beside the open one.** The read sweep
    // below used to spawn this server on the default document directories, which put
    // `projects/` and `presets/` outside the one directory it snapshotted - so three
    // of the library's five stores were unobserved, and a route registered as a
    // `read` whose handler wrote a project went through the entire suite at 241 of
    // 241 with its file sitting on disk afterwards. Two of five is not a sweep.
    //
    // The closed take is the other half. Substituting the *recording* take's id into
    // every `:id` looks like coverage and is not: `beingRecorded` answers 409 before
    // the handler runs, so `/capture/:id/hello`, `/index`, `/file`, `/frame/:n` and
    // `/frames/:a-:b` were driven and never executed - five routes counted as swept
    // and not swept, and a mutation inside `serveIndex` unreachable however closely
    // the directory was watched. Both ids are driven, and the row below asserts by
    // name that every route got past the 409.
    const closedTake = writeTake(shootDir, 'a-closed-take', { frames: 6 });
    // Seeded documents, so `/projects/:name` and `/presets/:name` run their found
    // path as well as their not-found one - a mutation in the branch that reads an
    // existing document is unreached by a name that does not exist.
    writeFileSync(join(shootProjects, 'seeded-project.json'), `${JSON.stringify({ version: 1, body: {} }, null, 2)}\n`);
    writeFileSync(join(shootPresets, 'seeded-preset.json'), `${JSON.stringify({ version: 1, body: {} }, null, 2)}\n`);
    const shootUrl = await startServer(root, [
      '--captures', shootDir, '--name', 'shooting', '--record', '--no-color',
      '--projects', shootProjects, '--presets', shootPresets,
      '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --fps 40`,
    ], MAC_PORT + 9);
    let shooting = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((done) => { setTimeout(done, 250); });
      shooting = await getJson(`${shootUrl}/record/state`);
      if (shooting.recording) break;
    }
    check(shooting?.recording === true, 'a take is open, which is what makes the next two rows about behaviour rather than status codes',
      String(shooting?.takeId));
    const stopStatus = (await fetch(`${shootUrl}/record/stop`, { headers: { 'Content-Type': 'application/json' } })).status;
    const afterStop = await getJson(`${shootUrl}/record/state`);
    check(stopStatus === 405 && afterStop.recording === true && afterStop.takeId === shooting.takeId,
      'a GET of /record/stop is refused and the take is still open - the refusal is a decision, not a status on a thing that already happened',
      `${stopStatus}, still ${afterStop.takeId}`);

    // Every read route driven, and every store this server owns asserted not to have
    // moved. This is what stops a route hiding a mutation behind a `read` handler,
    // which is the only way left to add one the guard above never sees - and it is
    // the resources that are read, never a count of registered routes, because a
    // count cannot answer whether a handler wrote something.
    //
    // **Both methods.** `serveRoute` treats HEAD as reading, which is correct and is
    // why HEAD works at all - but a sweep that only sends GET is blind to a handler
    // that mutates on HEAD, and the dispatcher would carry it there just the same.
    //
    // The snapshot is name, size and modification time for every file in all three
    // directories, plus the document revisions the stores report, plus the recorder's
    // own state. Modification time is in it deliberately: a plant that rewrites the
    // same bytes leaves the name and the size where they were.
    //
    // **A before-and-after snapshot cannot see a write that is put back, so it is not
    // what the next row rests on.** A handler that writes and restores inside the same
    // request is invisible to any pair of readings taken outside it: the bytes match,
    // and the modification time is one `utimes` call away from matching too. So the
    // stores carry a monotonic write count, served at `/library/writes`, and that is
    // the row - a count is the one thing a restore cannot undo. The contents comparison
    // stays as the second opinion rather than the only one.
    //
    // One shape is still outside this, and it is outside the *drive* rather than the
    // snapshot: a handler that mutates only on a query parameter. This sweep sends
    // none, so any parameter at all is unswept, and no enumeration of the route table
    // can find one that is not declared. A hole until measured otherwise.
    //
    // **Two things move for reasons that are not a read route, and both are named
    // rather than left to weaken the row.** The take being recorded grows while this
    // runs - measured 4.89MB to 6.35MB across one sweep - so its own bytes are out of
    // the comparison while its presence stays in, and a sidecar appearing beside it is
    // a separate row below. And reading a capture legitimately opens and caches a
    // descriptor, which is the module's designed behaviour, so the count gets a bound
    // rather than an equality: 22 to 28 across the same sweep, which is caching, where
    // a route holding one per request would run away.
    const snapshotDir = (dir, growing = null) => readdirSync(dir).sort().map((f) => {
      if (f === growing) return `${f}:being-written`;
      const st = statSync(join(dir, f));
      return `${f}:${st.size}:${st.mtimeMs}`;
    }).join(' ');
    const snapshot = async () => JSON.stringify({
      captures: snapshotDir(shootDir, `${shooting.takeId}.knct`),
      projects: snapshotDir(shootProjects),
      presets: snapshotDir(shootPresets),
      // Revisions rather than names, and they are the stores' own: `DocumentStore.list`
      // hashes the bytes on disk, so a plant that overwrites a document that is
      // already there moves this where a listing of filenames would not.
      projectRevs: (await getJson(`${shootUrl}/projects`)).projects?.map((d) => `${d.name}=${d.rev}`) ?? null,
      presetRevs: (await getJson(`${shootUrl}/presets`)).presets?.map((d) => `${d.name}=${d.rev}`) ?? null,
      recorder: await getJson(`${shootUrl}/record/state`).then((s) => `${s.recording}:${s.takeId}:${s.dropped}`),
    });
    const descriptorsNow = async () => (await getJson(`${shootUrl}/library/descriptors`)).real;

    // Warmed first, and only these two, because scanning a *closed* take and writing
    // its sidecar is what makes it a gallery entry - designed behaviour rather than a
    // read that mutates. Warming exactly the two calls that do it, by name, keeps the
    // snapshot below able to see a file appear: a blanket warm would have created the
    // planted document too, and then only its modification time would have moved.
    await fetch(`${shootUrl}/library/all`).catch(() => {});
    await fetch(`${shootUrl}/capture/a-closed-take/index`).catch(() => {});

    const before = await snapshot();
    const writesBefore = JSON.stringify(await getJson(`${shootUrl}/library/writes`));
    const fdBefore = await descriptorsNow();
    const reached = new Map();
    const unbuildable = [];
    for (const r of readable) {
      swept.add(r.path);
      for (const id of [shooting.takeId, 'a-closed-take']) {
        for (const name of ['seeded-project', 'nothing']) {
          const path = concrete(r.path, { id, name: r.path.startsWith('/presets') ? name.replace('project', 'preset') : name });
          if (path === null) { unbuildable.push(r.path); continue; }
          for (const method of ['GET', 'HEAD']) {
            const code = await fetch(shootUrl + path, { method }).then((x) => x.status).catch(() => 0);
            // 409 is `beingRecorded` answering before the handler runs. Anything else
            // means the handler executed - a 404 out of `readDocument` is the handler
            // having looked - so "not 409" is the reached predicate and a 200 is not.
            if (code !== 409) reached.set(r.path, `${code} on ${id === shooting.takeId ? 'the open take' : 'a closed take'}`);
          }
        }
      }
    }
    // The fallthrough, driven inside the same window: a static file, an unclaimed
    // path under every namespace the table owns, and a GET of a write-only route.
    // Nothing downstream of `ROUTES` may write, and this is that assertion observed
    // rather than assumed - the static server only reads today, and the day it does
    // not, this window is where it shows.
    const namespaces = [...new Set(table.map((r) => r.path.split('/')[1]))];
    for (const path of ['/main.js', '/', '/no-such-file.js', ...namespaces.map((ns) => `/${ns}/no-such-route-here`)]) {
      await fetch(shootUrl + path).catch(() => {});
    }
    await fetch(`${shootUrl}/record/stop`, { headers: { 'Content-Type': 'application/json' } }).catch(() => {});
    const after = await snapshot();
    const writesAfter = JSON.stringify(await getJson(`${shootUrl}/library/writes`));
    const fdAfter = await descriptorsNow();

    check(unbuildable.length === 0 && swept.size === table.length,
      `all ${table.length} routes the server declares are driven, so a route added later is swept by existing`,
      unbuildable.length ? `no concrete URL for ${unbuildable.join(' ')}`
        : `${swept.size} of ${table.length} driven, ${readable.length} of them with GET and HEAD against an open and a closed take`);
    check(reached.size === readable.length,
      'and every one of them actually runs its handler rather than stopping at a 409 the fixture caused',
      readable.filter((r) => !reached.has(r.path)).map((r) => r.path).join(' ')
        || `${reached.size} reached: ${[...reached].map(([p, c]) => `${p} ${c}`).join(', ')}`.slice(0, 150));
    // **The row a write-and-restore cannot pass.** Asserted before the contents
    // comparison because it is the stronger of the two: the counts are monotonic, so a
    // handler that writes a document and puts the bytes and the timestamp back still
    // moves them, where the snapshot below sees a store that never changed.
    check(writesAfter === writesBefore,
      'not one of them writes a store even momentarily - a count no restore can undo, which is what a handler that writes and puts it back defeats a contents comparison with',
      `${writesBefore} then ${writesAfter}`);
    check(after === before,
      'and none of it moves a byte in any of the five stores, their sidecars or the recorder',
      after === before ? `${namespaces.length} namespaces and the file tree swept alongside, nothing moved`
        : `${before}\n              then ${after}`);
    // **The descriptor count is deliberately not a row here, and that is a measurement
    // rather than an omission.** `/library/descriptors` reports `/dev/fd`, which counts
    // sockets as well as captures, and this arm opens about seventy connections - so
    // the delta came in at 6 on a clean run and at 9 under `origin-unchecked` and
    // `content-type-unchecked`, two mutations that touch no descriptor at all. A row
    // on it fired on five unrelated mutations, which is a gate going red for reasons
    // that have nothing to do with what it tests. The descriptor bound has a section
    // of its own further down, where a raw socket against a quiet server controls for
    // exactly what this arm cannot.
    console.log(`  ...   ${fdBefore} descriptors before the sweep, ${fdAfter} after `
      + '(sockets included, which is why it is not a row - see section 9)');
    // The sidecar is the tell, and it is the same one section 11 uses. `buildIndex`
    // writes a `.idx` beside the take, so a read route that scanned the file the
    // recorder has open would leave one - which is how this arm caught
    // `/capture/:id/index` reaching that scan by a shorter road than the manifest.
    check(!existsSync(join(shootDir, `${shooting.takeId}.idx`)),
      'and the take still being written has no sidecar - the closed one beside it was scanned and this one was not',
      readdirSync(shootDir).sort().join(' '));

    // ---- and the shoot itself survived the sweep
    //
    // **Three observations are switched off at once for the file being recorded, so
    // a read route appending to it passed every row above.** Its size and modification
    // time are out of the snapshot by name, because they move on their own; no write
    // counter covers the captures directory, since the counters are on the two document
    // stores and the marks log; and the recorder's own state field is
    // `recording:takeId:dropped`, which a foreign append does not move. Demonstrated:
    // a read route appending 64KB to `recorder.openPath` gave 251 assertions, none
    // failed, exit 0, with the take ruined - `stream desync at 6349028: expected magic
    // KNCT, got 0x7070707` and nine surviving 4096-byte runs of 0x07 in the file.
    //
    // **The identity is section 10's, applied after the take closes rather than during
    // it, and the timing is the whole reason.** Comparing the file's size against the
    // recorder's own `bytes` while it is still recording is very nearly exact and not
    // exact: measured 40 samples over two seconds on a 40fps take, `onDisk - bytes` was
    // 0 every time - but that zero is a syscall-width window, not a guarantee, since the
    // bytes reach the disk before the callback that moves `bytesWritten` runs. One
    // sample landing inside it reddens the row by one frame for no reason, which is a
    // gate that teaches people to re-run. After `close`, nothing is in flight and the
    // identity is exact, which is why section 10 can assert it with `===`.
    const shotPath = join(shootDir, `${shooting.takeId}.knct`);
    const stopped = await post(`${shootUrl}/record/stop`);
    const shotSize = existsSync(shotPath) ? statSync(shotPath).size : -1;
    check(!stopped.error && Number.isFinite(stopped.stopped?.frames),
      'the take the sweep ran alongside still scans as one continuous stream - foreign bytes in the middle of it are a desync rather than a frame',
      stopped.error ? `close refused: ${String(stopped.error).slice(0, 100)}` : `${stopped.stopped?.frames} frames`);
    check(stopped.stopped?.bytes === shotSize,
      'and the file is exactly the bytes the recorder put there, which is the one reading a route writing to the open take cannot leave alone',
      `${stopped.stopped?.bytes} counted, ${shotSize} on disk`);
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 9)) p.child.kill('SIGKILL');

    // Marks used to be creatable for a take that does not exist, which put an
    // attacker-chosen `nosuchtake.marks.jsonl` in the captures directory - up to
    // four megabytes a request, and tombstones waiting to delete real marks the
    // moment a take of that name existed.
    const ghost = await post(`${guardUrl}/capture/nosuchtake/marks`,
      { marks: [{ id: 'x', sourceMs: 1, at: 1, label: 'planted' }] });
    check(/nothing to mark|no take/.test(ghost.error ?? ''),
      'marks on a take that is not here are refused rather than creating its sidecar',
      (ghost.error ?? 'ACCEPTED').slice(0, 70));
    check(!existsSync(join(guardDir, 'nosuchtake.marks.jsonl')),
      'and nothing was written to the captures directory',
      readdirSync(guardDir).join(' '));

    // A document from a build this one is not. It came back stamped as version 1
    // with its version 2 fields underneath, which is exactly what the version field
    // was chosen over an authored buffer height to prevent.
    const future = await post(`${guardUrl}/projects/from-the-future`, { version: 2, tracks: {}, futureField: 'kept' });
    check(/version 2/.test(future.error ?? ''),
      'a document from a future format version is refused rather than restamped as this one',
      (future.error ?? 'ACCEPTED').slice(0, 80));
    const stored = await getJson(`${guardUrl}/projects/from-the-future`);
    check(stored.error !== undefined,
      'and nothing was written, so a project this build cannot interpret never enters the store at all');
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 8)) p.child.kill('SIGKILL');
    // The control probe above is a write that succeeds, which is the point of it, so
    // it leaves a document behind. Cleared here rather than left in a directory this
    // section made: a proof tool whose clean run adds files is one nobody can use the
    // filesystem to reason about.
    rmSync(guardDocs, { recursive: true, force: true });
    rmSync(guardPresets, { recursive: true, force: true });
  }

  // -------------------------------------------- 8. recording a replay is refused
  //
  // **This arm exists because no other arm crossed replay with record.** Every
  // recording section spawns a server with a grabber and every replay section spawns
  // one with no recorder, so both halves agreed about a combination neither of them
  // stood in front of - which is the same shape as the descriptor section's own
  // history two hundred lines up, and the reason that one carries its story beside
  // the code.
  //
  // The record button on the viewer is unconditional, so this was one click in the
  // setup this repo documents: the take opened, `recorder.write(undefined)` threw on
  // every frame into the replay tick's catch, no frame reached any client, the
  // status flapped between lost and live, and `/record/state` reported a healthy
  // recording the whole time.
  console.log('\n[library] a replay server refuses to record, and goes on streaming');
  {
    const replayCaps = join(WORK, 'replay-record-captures');
    mkdirSync(replayCaps, { recursive: true });
    const source = join(WORK, 'replay-source');
    mkdirSync(source, { recursive: true });
    const replaying = writeTake(source, 'replay-me', { frames: 40 });
    const url = await startServer(root,
      ['--captures', replayCaps, '--name', 'replaying', '--replay', replaying], MAC_PORT + 10);

    const seen = { frames: 0, statuses: [] };
    const ws = new WebSocket(url.replace('http', 'ws'));
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
    const before = seen.frames;
    check(before > 0, 'the replay is streaming before anything presses record', `${before} frames in 1.2s`);

    const state = await getJson(`${url}/record/state`);
    check(typeof state.cannotRecord === 'string' && /replay/i.test(state.cannotRecord),
      'the state says this server cannot record and why, which is what the button disables itself on',
      String(state.cannotRecord).slice(0, 80));

    const refused = await post(`${url}/record/start`);
    check(/replay/i.test(refused.error ?? ''),
      'pressing record on a replay is refused with the reason rather than opening a take',
      (refused.error ?? 'ACCEPTED').slice(0, 80));
    const during = await getJson(`${url}/record/state`);
    check(during.recording === false && during.armed === false,
      'and the recorder is left alone rather than half-armed',
      JSON.stringify({ armed: during.armed, recording: during.recording }));

    await new Promise((done) => { setTimeout(done, 1500); });
    const after = seen.frames - before;
    ws.close();
    check(after > 0, 'the live stream is untouched afterwards - the frames kept arriving',
      `${after} frames in the 1.5s after the refusal`);
    check(!seen.statuses.includes('lost'),
      'with no lost-sensor report, which is how the broken build presented itself',
      seen.statuses.length ? `saw ${seen.statuses.join(' ')}` : 'no status changes');
    check(readdirSync(replayCaps).filter((f) => f.endsWith('.knct')).length === 0,
      'and no take was written - a 163-byte file holding a hello and nothing else is not a take',
      readdirSync(replayCaps).join(' ') || 'empty');

    // The button itself, in the page. `web/index.html` carries an unconditional
    // record button, which is what made this one click away rather than one curl
    // away - so a state field saying the server cannot record is only half the fix
    // and the other half is visible or it is not there.
    {
      const { page, errors } = await openPage(browser, `${url}/`, { width: 900, height: 700 });
      await page.waitForFunction('globalThis.__kinect !== undefined', null, { timeout: 40000 });
      await page.waitForFunction("document.getElementById('recGo')?.disabled === true", null, { timeout: 20000 })
        .catch(() => { /* asserted below, so a timeout is a failing row rather than a throw */ });
      const button = await page.evaluate(`(() => {
        const go = document.getElementById('recGo');
        return { disabled: go.disabled, title: go.title, note: document.getElementById('recNote').textContent };
      })()`);
      check(button.disabled === true, 'the record button on a replay server is disabled in the page rather than only refused by the server',
        JSON.stringify(button).slice(0, 90));
      check(/replay/i.test(button.note) || /replay/i.test(button.title),
        'and it says why, so the operator is not looking at a dead control with no explanation',
        (button.note || button.title).slice(0, 80));
      check(errors.length === 0, 'and the viewer raises no page errors on a server that cannot record',
        errors.slice(0, 2).join(' | '));
      await page.close();
    }
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 10)) p.child.kill('SIGKILL');
  }

  // --------------------------- 9. a descriptor outlives the map entry that held it
  //
  // **Counted off `/dev/fd` rather than off the module's own bookkeeping, and that
  // is the whole method of this section.** `openCaptures.size` is what
  // `/library/descriptors` used to report alone, and the bug here made that number
  // *fall* - `forgetCapture` dropped the map entry while the `FileHandle` stayed
  // open, so an arm watching the bookkeeping would have seen a descriptor being
  // released at the exact moment one leaked. The general form is worth stating:
  // **an assertion about a resource has to read the resource, not the accounting
  // that claims to track it.**
  //
  // The reachable gesture is one the gallery performs constantly. Skimming leases a
  // capture per pointer move, Delete is a button on the same tile, and on Node 26 a
  // `FileHandle` collected unclosed throws `ERR_INVALID_STATE` out of the garbage
  // collector at the top level - measured on v26.0.0, process gone, listener and
  // every socket with it.
  console.log('\n[library] a take removed while a reader holds it still gives its descriptor back');
  {
    const leaseDir = join(WORK, 'leased');
    mkdirSync(leaseDir, { recursive: true });
    // Big enough that the run cannot fit in socket buffers. At forty frames it did:
    // the whole nineteen megabytes drained before the delete, the lease was already
    // released, and the mutation that leaks a descriptor came back green because
    // there was never a descriptor being held. Sized by frame count, since the
    // sample was captured on a degraded link and its seconds are not a take's.
    writeTake(leaseDir, 'leased-take', { frames: 200 });
    const url = await startServer(root, ['--captures', leaseDir, '--name', 'leasing'], MAC_PORT + 11);
    const take = (await getJson(`${url}/library/takes`)).takes.find((t) => t.id === 'leased-take');
    const baseline = await getJson(`${url}/library/descriptors`);
    check(Number.isInteger(baseline.real),
      'the server reports the descriptors the kernel says it holds, not only the ones its own map remembers',
      `open ${baseline.open}, real ${baseline.real}`);

    // A reader that is genuinely mid-read: a raw socket asking for a long frame run
    // and then reading nothing, so TCP backpressure stalls the pipeline and the
    // lease is held for as long as this test wants it held.
    const sock = createConnection(MAC_PORT + 11, 'localhost');
    await new Promise((done, fail) => { sock.on('connect', done); sock.on('error', fail); });
    // Read exactly enough to know the response started, then stop reading, so TCP
    // backpressure stalls the pipeline and the lease stays held for as long as this
    // section wants it held. Left in flowing mode for even 700ms the whole 97MB
    // drained - Node's own socket buffering is larger than any of this - and the run
    // then finished, released its lease, and left nothing for the removal below to
    // happen underneath.
    let received = 0;
    sock.on('data', (c) => { received += c.length; sock.pause(); });
    sock.write(`GET /capture/leased-take/frames/0-${take.frames - 1} HTTP/1.1\r\nHost: localhost:${MAC_PORT + 11}\r\nConnection: close\r\n\r\n`);
    await new Promise((done) => { setTimeout(done, 1200); });
    const held = await getJson(`${url}/library/descriptors`);
    // **The precondition, asserted rather than assumed.** A run that finished has no
    // lease left to hold anything, and every row below would then be measuring a
    // capture nobody was reading. Partway through is the state this needs, and the
    // byte count is what says it is partway through.
    check(received > 0 && received < take.bytes * 0.9,
      'the reader is genuinely mid-run rather than finished, which is what the rows below rest on',
      `${(received / 1e6).toFixed(1)}MB of ${(take.bytes / 1e6).toFixed(1)}MB read, then stopped reading`);
    check(held.real > baseline.real && held.open === 1,
      'and it is holding the capture open, which is what the removal below has to happen underneath',
      `open ${held.open}, real ${held.real} against ${baseline.real}`);

    const removed = await post(`${url}/library/delete/leased-take`, { hash: take.hash, confirm: true });
    const afterDelete = await getJson(`${url}/library/descriptors`);
    check(removed.removed === 'leased-take.knct', 'the take is removed while the reader is still on it',
      JSON.stringify(removed).slice(0, 60));
    // **A precondition, and it was labelled a control, which it cannot be.** The
    // reading here - map empty, descriptor still open - is what the fixed build and
    // the leaking one both produce, because at this instant the reader still holds
    // its lease and the descriptor is legitimately open in either. So nothing about
    // this row can fail on the mutation beside it, and calling it the control
    // overstated an arm that rests on the two rows after `sock.destroy()`, where the
    // builds genuinely diverge.
    //
    // What it does say is why the arm reads `/dev/fd` at all: a check reading `open`
    // alone sees it fall to zero here and would record a descriptor being released
    // while the real count sat at 2. Stated as the precondition it is.
    check(afterDelete.open === 0 && afterDelete.real === held.real && held.real > baseline.real,
      'the module\'s own count drops to zero while the descriptor is genuinely still there - a precondition for the rows below rather than a catch, and the reason this arm reads /dev/fd',
      `open ${afterDelete.open}, real ${afterDelete.real} against a baseline of ${baseline.real}`);

    sock.destroy();
    // **Polled inside a catch, because the failure mode is the server going away.**
    // A leaked `FileHandle` does not sit there being counted: the collector finds it
    // and throws `ERR_INVALID_STATE` at the top level, and the process is gone -
    // measured here at between 300ms and one second after the reader let go. An
    // unguarded poll then throws out of `runChecks` and the run ends with an exit
    // code and *zero failed assertions*, which is the shape `CLAUDE.md` records as a
    // crash wearing a catch's status. This turns it back into rows.
    //
    // **One reading at a fixed delay, and deliberately not a poll-until-it-passes.**
    // A loop that retried until the count came back turned this into a race with the
    // garbage collector: it closes the leaked handle on its way to throwing, so
    // there is a window in which the count *has* returned to baseline and the
    // process has not died yet - and a patient loop finds that window and calls it a
    // pass. Measured flaky exactly that way, green on one run and two failed rows on
    // the next against an identical mutated tree.
    //
    // 250ms is three orders of magnitude more than the fixed build needs - the close
    // is one `fs.close` in a `finally` that runs when the socket errors - and it is
    // comfortably inside the 300ms-to-1s window the collector was measured to take.
    let settled = null;
    let died = null;
    await new Promise((done) => { setTimeout(done, 250); });
    try {
      settled = await getJson(`${url}/library/descriptors`);
    } catch (err) {
      died = err.message;
    }
    check(died === null,
      'the server is still answering afterwards - an unclosed FileHandle is a process death on this Node, taking the listener and every socket with it',
      died ?? 'still up');
    check(died === null && settled.real <= baseline.real,
      'and when the reader lets go the descriptor is closed rather than left for the collector to throw over',
      died ? 'the server did not survive to be asked' : `real ${settled.real} against a baseline of ${baseline.real}`);
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 11)) p.child.kill('SIGKILL');
  }

  // ------------------------------------------- 10. the recorder's own two failures
  //
  // **Driven in process rather than through a server, because both claims are about
  // what happens inside one synchronous turn** and nothing reachable over HTTP can
  // stand in the middle of one. The backpressure arm in particular needs frames
  // handed over faster than any disk can take them, and a synchronous loop is the
  // only thing that guarantees it: no I/O can complete while it runs, so every byte
  // written is still in memory when it ends. That is a fixture rather than a race.
  console.log('\n[library] the recorder holds its marks and bounds its buffer');
  {
    // A take whose sidecar was never written has no marks, which is a *failing*
    // answer rather than a missing file. Read through this, or the two mutations
    // that drop the flush take the whole run down with an ENOENT before any row is
    // recorded - and an exit code with zero failed assertions reads as a caught
    // mutation to anything counting statuses.
    const marksOf = (id) => {
      try {
        return readFileSync(join(WORK, 'recorder-unit', `${id}.marks.jsonl`), 'utf8').trim().split('\n').filter(Boolean);
      } catch {
        return [];
      }
    };
    // **Imported out of the staged tree rather than out of the repo**, which is what
    // makes a server-file mutation reach this section at all. Pointed at `REPO` it
    // loaded the unmutated recorder while the mutation sat in the copy nothing here
    // was running, and five mutations came back green against code they never
    // touched - a check measuring a build that was not under test.
    const { Recorder, MAX_TAKE_BUFFER } = await import(pathToFileURL(join(root, 'server/recorder.js')).href);
    const recDir = join(WORK, 'recorder-unit');
    mkdirSync(recDir, { recursive: true });
    const hello = SRC.hello.toString('utf8');

    // ---- marks belong to the take, not to the recorder
    //
    // A take that dies mid-write used to null itself without flushing, and the marks
    // pressed during it were still on the recorder when the *next* take closed - so
    // take one lost the moment somebody flagged and take two gained one at a source
    // time that means nothing there.
    const one = new Recorder({ dir: recDir });
    await one.start(null);
    one.open(hello);
    const firstTake = one.state.takeId;
    one.write(SRC.frames[0]);
    one.mark(1234, 'the moment');
    // A card pulled mid-write, which is the reachable version of this: the stream
    // errors, the take ends, and there is no next name that would help.
    one.take.stream.destroy(new Error('the card was pulled'));
    await new Promise((done) => { setTimeout(done, 400); });
    check(one.state.recording === false && one.state.armed === false,
      'a take that fails mid-write ends and says so rather than looking like it is still recording',
      JSON.stringify({ armed: one.state.armed, recording: one.state.recording }));
    const firstMarks = marksOf(firstTake);
    check(firstMarks.length === 1 && JSON.parse(firstMarks[0]).sourceMs === 1234,
      'and the mark pressed during it is in that take\'s sidecar, written on the way down',
      firstMarks.join(' ').slice(0, 70));

    // The other half: the next take must not inherit it.
    const two = new Recorder({ dir: recDir });
    await two.start(null);
    two.open(hello);
    const secondTake = two.state.takeId;
    two.write(SRC.frames[1]);
    await two.stop();
    check(secondTake !== firstTake, 'the next take is a different file', `${firstTake} then ${secondTake}`);
    check(!existsSync(join(recDir, `${secondTake}.marks.jsonl`)),
      'and it carries no marks at all - the orphaned one did not travel forward into footage it does not describe');

    // ---- a close that rejects still flushes
    //
    // The same orphaning arrived a second way: `once(stream, "close")` rejects when
    // the stream errors during the flush, and the old shape had already nulled the
    // take by then, so the marks sat in a list nothing would read again.
    const three = new Recorder({ dir: recDir });
    await three.start(null);
    three.open(hello);
    const thirdTake = three.state.takeId;
    three.write(SRC.frames[2]);
    three.mark(777, 'flagged as it died');
    const stream = three.take.stream;
    const closing = three.close('testing a close that fails').catch((err) => err);
    stream.destroy(new Error('the card went away during the close'));
    const outcome = await closing;
    check(outcome instanceof Error, 'a close that fails partway through reports the failure rather than swallowing it',
      String(outcome?.message ?? outcome).slice(0, 60));
    const thirdMarks = marksOf(thirdTake);
    check(thirdMarks.length === 1 && JSON.parse(thirdMarks[0]).sourceMs === 777,
      'and the marks are still written, because the flush hangs off the take rather than off the close succeeding',
      thirdMarks.join(' ').slice(0, 70));

    // ---- backpressure, and numbers that mean durable
    //
    // **The requirement this arm holds the ceiling to is written down here rather
    // than imported.** `MAX_TAKE_BUFFER` is the number under test, so the row
    // bounding the observed peak against it passes at whatever ceiling the build
    // cares to name - demonstrated at 8MB and again at 1MB, the whole suite green,
    // the row printing "peak 1.5MB against a 1MB ceiling" while 297 of 300 frames
    // went on the floor. A build that rides out 0.6 seconds of a stalled card was
    // therefore indistinguishable from one that rides out 4.4.
    //
    // Two rows fix that, on two literals that are not the build's to move: the
    // ceiling the design settled on, and the full rate the ride-out requirement is
    // about. Both are written here as requirements the recorder must meet rather
    // than as facts read off it.
    //
    // The bytes are **observed** - accumulated from the frames actually handed over
    // and divided back out into a mean, rather than imported from `recorder.js` or
    // multiplied out of one frame's nominal size. That matters on this fixture: its
    // mean frame is about 475KB where the spec measured 486KB, so the shipped build
    // accepts 139 frames where the spec's arithmetic says 135, and a hardcoded frame
    // size would have made a correct build miss by 3%.
    //
    // **The 30 in the second row is the sensor's full rate, not the fixture's.** It
    // is legitimate here for the same reason `CLAUDE.md` forbids it elsewhere: the
    // requirement is "four seconds of a full-rate take", so 30 is what the claim is
    // *about*. Nothing here is sized by duration - the sample runs at about 9.3fps
    // and every fixture in this file is sized by frame count.
    const CEILING_REQUIRED = 64 * 1024 * 1024;
    const CEILING_TOLERANCE = 0.10;
    const FULL_RATE_FPS = 30;
    const RIDE_OUT_SEC = 4;

    // The recorder's own pushes, so the transition into dropping can be asked about
    // rather than assumed. Nothing here reads `state` - the getter drains the queue,
    // which is the very thing two arms below are measuring.
    const pushed = [];
    const four = new Recorder({ dir: recDir, onChange: (s) => pushed.push(s) });
    await four.start(null);
    four.open(hello);
    const burstTake = four.take.id;
    const burstPath = join(recDir, `${burstTake}.knct`);
    const BURST = 300;
    let peak = 0;
    let acceptedBytes = 0;
    let acceptedFrames = 0;
    const pushedBeforeBurst = pushed.length;
    // Synchronous from end to end. Nothing drains while this runs, so the buffer
    // grows monotonically and the ceiling is reached deterministically rather than
    // whenever the disk happens to be slow.
    for (let i = 0; i < BURST; i++) {
      const frame = SRC.frames[i % SRC.frames.length];
      four.write(frame);
      // Read off the take rather than through `state`, for the same reason. Drops
      // are contiguous once they start, because nothing can drain mid-turn, so this
      // is exactly the footage accepted before the first one.
      if (four.take.dropped === 0) {
        acceptedBytes += frame.length;
        acceptedFrames++;
      }
      peak = Math.max(peak, four.take.stream.writableLength);
    }
    const midBurst = four.state;
    const onDiskMid = statSync(burstPath).size;
    const meanFrameBytes = acceptedBytes / acceptedFrames;
    check(Math.abs(acceptedBytes - CEILING_REQUIRED) <= CEILING_TOLERANCE * CEILING_REQUIRED,
      `the buffer holds the 64MiB the design settled on, within ${(CEILING_TOLERANCE * 100).toFixed(0)}%`,
      `${acceptedFrames} frames x ${(meanFrameBytes / 1024).toFixed(0)}KB observed mean = `
      + `${(acceptedBytes / 1e6).toFixed(1)}MB accepted before the first drop, `
      + `${((acceptedBytes / CEILING_REQUIRED - 1) * 100).toFixed(1)}% off ${(CEILING_REQUIRED / 1e6).toFixed(1)}MB`);
    check(acceptedFrames / FULL_RATE_FPS >= RIDE_OUT_SEC,
      `which is at least the ${RIDE_OUT_SEC}s of a stalled card the recorder is required to ride out`,
      `${(acceptedFrames / FULL_RATE_FPS).toFixed(2)}s at the sensor's ${FULL_RATE_FPS}fps, `
      + `${RIDE_OUT_SEC}s required`);
    check(peak <= MAX_TAKE_BUFFER + SRC.frames[0].length,
      `${BURST} frames handed over in one turn never buffer past the stated ceiling`,
      `peak ${(peak / 1e6).toFixed(1)}MB against a ${(MAX_TAKE_BUFFER / 1e6).toFixed(0)}MB ceiling`);
    // The transition, pushed. Left to the five-second poll, a node with nobody
    // watching it drops footage for five seconds before anything says so - and after
    // the queue drains on every write, no monitor has to be open for the drop to
    // happen at all, so the poll is the only thing that would have carried it.
    const drops = pushed.slice(pushedBeforeBurst).filter((s) => s.dropped > 0);
    check(drops.length > 0,
      'the moment the recorder starts dropping is pushed rather than left to the panel\'s five-second poll',
      `${pushed.length - pushedBeforeBurst} pushes during the burst, ${drops.length} carrying a drop`);
    check(drops.length === 1,
      'and pushed once for the transition rather than once per dropped frame, which would put a socket write in the frame path',
      `${drops.length} pushes for ${midBurst.dropped} dropped frames`);
    check(midBurst.dropped > 0,
      'and the frames past it are dropped and counted rather than queued into heap that grows until the process is killed',
      `${midBurst.dropped} of ${BURST} dropped`);
    // The monitor's numbers. Mid-turn nothing has reached the file, so a recorder
    // reporting what it *accepted* reads healthy at exactly the moment it is holding
    // sixty-four megabytes it may be about to lose.
    check(midBurst.bytes === onDiskMid,
      'the bytes the monitor reports are the bytes that reached the file, not the ones this process is holding',
      `reports ${midBurst.bytes}, on disk ${onDiskMid}, buffered ${(midBurst.buffered / 1e6).toFixed(1)}MB`);
    check(midBurst.frames === 0 && midBurst.buffered > 0,
      'so a stalled card reads as stalled rather than as a healthy take',
      `${midBurst.frames} frames durable with ${(midBurst.buffered / 1e6).toFixed(1)}MB waiting`);

    const closed = await four.close('burst over');
    const finalSize = statSync(burstPath).size;
    check(closed.bytes === finalSize,
      'and once the take closes the count is the file, exactly',
      `${closed.bytes} against ${finalSize}`);
    check(closed.frames === BURST - midBurst.dropped,
      'with the frames that landed being the ones that were accepted - a dropped frame is a gap, not a miscount',
      `${closed.frames} scanned, ${BURST} offered, ${midBurst.dropped} dropped`);

    // ---- the in-flight queue is bounded by the ceiling, not by the take
    //
    // `write` pushes a frame end-offset per frame and `settle` is what removes them.
    // Drained only when something asked for state, the queue held every frame of the
    // take until an operator opened the monitor, and the drain that then ran was
    // `shift()` in a loop - 48.9ms at 27,000 frames, 3,677ms at 216,000, about 4.1x
    // per doubling. Synchronous, so stdin is not serviced while it runs, and the
    // grabber answers that backpressure by dropping depth packets at the device.
    //
    // **Depth is asserted, never a stopwatch.** Absolute timings on this rig move by
    // 2x with load - the same drain measured 3,677ms here and 7,632ms on the
    // reviewer's machine - so a threshold in milliseconds would be a flake. The
    // queue's depth is a count: bounded by what is not yet durable if the drain runs
    // per frame, and equal to the whole take if it does not.
    //
    // **And the array behind the head is asserted separately**, because a head index
    // that never compacts leaves the depth right and the allocation growing with the
    // take - which is also the only way per-frame work can go back to scaling with
    // the take's length. An array bounded by a constant bounds every operation over
    // it, for any implementation rather than for the ones a timing probe happened to
    // sample, so the bound is the cost claim rather than a proxy for it.
    //
    // Small frames on purpose, and the trade is worth naming: the queue records one
    // end-offset per message and never reads a payload byte, so this claim is about
    // message count, and 20,040 of the sample's own 486KB frames would be 9.7 GB of
    // disk to say the same thing. Real frames stay where the claim is about bytes -
    // the ceiling arm above.
    const PER_CHUNK = 500;
    const CHUNKS = 40;
    const smallFrame = (n) => {
      const payload = Buffer.alloc(1024);
      payload.writeUInt32LE(1008, 0);
      payload.writeUInt32LE(0, 4);
      payload.writeBigUInt64LE(BigInt(n * 33), 8);
      return encodeMessage(TYPE_FRAME, payload);
    };
    // Everything the stream is holding has reached the descriptor, so the next
    // `settle` has every queued frame to drain and the depth read afterwards is the
    // queue's own bookkeeping rather than a slow disk's backlog.
    const flushed = async (stream) => {
      for (let i = 0; i < 4000 && stream.writableLength > 0; i++) {
        await new Promise((done) => { setTimeout(done, 0); });
      }
      return stream.writableLength;
    };

    const five = new Recorder({ dir: recDir });
    await five.start(null);
    five.open(hello);
    const longTake = five.take.id;
    let deepest = 0;
    let longest = 0;
    let stillWaiting = 0;
    let written = 0;
    for (let c = 0; c < CHUNKS; c++) {
      for (let i = 0; i < PER_CHUNK; i++) five.write(smallFrame(written++));
      stillWaiting = Math.max(stillWaiting, await flushed(five.take.stream));
      // One more frame after the flush, because `settle` runs on the frame path: the
      // entries a chunk left behind are drained by the next `write` and not by the
      // disk finishing. Reading the depth before it would be reading a queue nothing
      // had been given the chance to drain, which would pass against a build that
      // never drains at all.
      five.write(smallFrame(written++));
      deepest = Math.max(deepest, five.take.inFlight.length - five.take.inFlightHead);
      longest = Math.max(longest, five.take.inFlight.length);
    }
    // Held past the close, which nulls the recorder's reference. The last frame's
    // entry is drained by the settle in `close`'s `finally` and not by the loop
    // above - the drain runs on the frame path, so nothing follows the final write
    // to run it - and a count read before that is one short of the file.
    const longTakeState = five.take;
    const droppedLong = five.take.dropped;
    const longClosed = await five.close('the long take is over');
    const counted = longTakeState.frames;
    check(droppedLong === 0 && stillWaiting === 0,
      `the disk kept up across all ${written} frames, which is what makes the next two rows about the queue rather than about the card`,
      `${droppedLong} dropped, ${stillWaiting} bytes still waiting at the deepest flush`);
    check(deepest <= 4,
      'the queue holds only the frames not yet durable, so it is bounded by the buffer ceiling rather than by the length of the take',
      `deepest ${deepest} live entries after ${written} frames`);
    check(longest <= 8,
      'and the array behind it is compacted rather than merely indexed past, so nothing grows with the take',
      `longest ${longest} slots for ${written} frames`);
    check(counted === written && longClosed.frames === written,
      'with every frame counted exactly once on its way through - a drain that skipped or double-counted would move this and leave the depth alone',
      `${counted} counted, ${longClosed.frames} scanned, ${written} written`);
    rmSync(join(recDir, `${longTake}.knct`), { force: true });
    rmSync(join(recDir, `${longTake}.idx`), { force: true });
  }

  // ---------------------------- 11. the manifest does not scan the take being written
  //
  // The staleness test `cachedIndex` uses is size and modification time, and both of
  // those move continuously on a take that is still being written - so every
  // `/library/*` request re-ran a full read plus sha256 over the in-progress take,
  // sequentially, with no concurrency guard. The gallery on the node's own panel is
  // the caller, and on a 4.4 GB take that is minutes of disk contention against the
  // recorder's own writes.
  //
  // **Measured by the sidecar rather than by a stopwatch.** `buildIndex` writes a
  // `.idx` beside the take, so "the manifest scanned it" leaves a file - which is
  // deterministic where a timing threshold would be a flake, and is the same
  // observer effect `CLAUDE.md` records from this step's own first draft.
  console.log('\n[library] listing a library does not scan the take still being written');
  {
    const liveDir = join(WORK, 'while-recording');
    mkdirSync(liveDir, { recursive: true });
    const url = await startServer(root, [
      '--captures', liveDir, '--name', 'shooting', '--record', '--no-color',
      '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --fps 40`,
    ], MAC_PORT + 12);
    let open = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((done) => { setTimeout(done, 250); });
      open = await getJson(`${url}/record/state`);
      if (open.recording) break;
    }
    check(open?.recording === true, 'a take is open', String(open?.takeId));

    // Polled the way the node's own gallery polls it.
    let listed = null;
    for (let i = 0; i < 8; i++) {
      listed = (await getJson(`${url}/library/takes`)).takes.find((t) => t.id === open.takeId);
      await new Promise((done) => { setTimeout(done, 120); });
    }
    check(!existsSync(join(liveDir, `${open.takeId}.idx`)),
      'eight listings while the take is open write it no sidecar - nothing scanned it',
      readdirSync(liveDir).join(' '));
    check(listed?.recording === true && listed.hash === null && listed.frames === null,
      'the take is listed and says it is being recorded, with no hash and no frame count - numbers over a growing file are not facts',
      JSON.stringify({ recording: listed?.recording, hash: listed?.hash, frames: listed?.frames }));
    check(listed?.openable === false,
      'and it says it cannot be opened, so the tile has something to draw rather than zeros');

    // Neither removal can verify anything about a file that is still arriving, and
    // unlinking one underneath a running write stream loses the shoot in progress.
    const refusedDelete = await post(`${url}/library/delete/${open.takeId}`, { hash: 'sha256:whatever', confirm: true });
    check(/being recorded/.test(refusedDelete.error ?? ''),
      'delete refuses the take the recorder has open', (refusedDelete.error ?? 'ACCEPTED').slice(0, 70));
    check(existsSync(join(liveDir, `${open.takeId}.knct`)), 'and the file is still there');

    // The tile, drawn. A take with a null hash and a null frame count is a shape the
    // gallery had never been handed, and the fields it renders - the duration, the
    // frame count, the hash prefix, the scrub bar's own divisor - all read one of
    // them. So this is the page rather than the JSON: NaN in a tile is not something
    // a manifest assertion can see.
    {
      const { page, errors } = await openPage(browser, `${url}/library.html`);
      await page.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
      const tile = await page.evaluate(`(() => {
        const el = document.querySelector('.tile[data-recording="true"]');
        if (!el) return null;
        return {
          id: el.dataset.id,
          text: el.querySelector('.meta').textContent,
          acts: [...el.querySelectorAll('.act')].map((b) => ({ label: b.textContent, disabled: b.disabled })),
        };
      })()`);
      check(tile?.id === open.takeId, 'the take being recorded has a tile of its own', String(tile?.id));
      check(!/NaN|null|undefined/.test(tile?.text ?? 'NaN'),
        'and it renders no NaN, no null and no undefined where a scan\'s numbers would have gone',
        (tile?.text ?? '').replace(/\s+/g, ' ').slice(0, 110));
      check(/recording now/.test(tile?.text ?? ''), 'it says it is recording rather than showing zeros');
      check((tile?.acts ?? []).length > 0 && tile.acts.every((a) => a.disabled),
        'and every action on it is present and disabled - the library runs on a touch panel, where a control that vanishes reads as a broken page',
        JSON.stringify(tile?.acts));
      check(errors.length === 0, 'the gallery raises no page errors while a take is being written',
        errors.slice(0, 2).join(' | '));
      await page.close();
    }

    const stopped = (await post(`${url}/record/stop`)).stopped;
    const afterStop = (await getJson(`${url}/library/takes`)).takes.find((t) => t.id === open.takeId);
    check(existsSync(join(liveDir, `${open.takeId}.idx`)) && stopped?.hash?.startsWith('sha256:'),
      'and once it closes it is scanned exactly once, which is what makes it a gallery entry',
      `${stopped?.frames} frames, ${String(stopped?.hash).slice(7, 19)}`);
    check(afterStop?.recording === false && afterStop.hash === stopped?.hash && afterStop.frames === stopped?.frames,
      'the listing then carries the hash and the frame count the scan produced');
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 12)) p.child.kill('SIGKILL');
  }

  // ------------------------------ 12. a node whose captures directory does not exist
  //
  // The state a reflashed capture node boots in, which is what step 9 provisions
  // from. Without this the node came up disarmed and answered `/record/state` and
  // `/library/all` with a raw `ENOENT ... statfs`, so the panel in the room showed an
  // errno and nothing on it said the shoot could not start.
  console.log('\n[library] a node with no captures directory makes one and says so');
  {
    const fresh = join(WORK, 'never-existed', 'captures');
    rmSync(join(WORK, 'never-existed'), { recursive: true, force: true });
    check(!existsSync(fresh), 'the directory genuinely is not there, which is what makes this a fixture');
    const url = await startServer(root, [
      '--captures', fresh, '--name', 'reflashed', '--no-color',
      '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --fps 40`,
    ], MAC_PORT + 13);
    check(existsSync(fresh), 'the server creates it at boot rather than failing every request that needs it', fresh);

    const state = await getJson(`${url}/record/state`);
    check(state.storage?.error == null && /^(\d+h \d+m|\d+m \d+s|\d+s|unbounded)$/.test(state.storage?.label ?? ''),
      'and the remaining-time report is a duration rather than an errno',
      JSON.stringify(state.storage?.error ?? state.storage?.label));
    const lib = await getJson(`${url}/library/all`);
    check(Array.isArray(lib.takes) && lib.takes.length === 0 && lib.unreadable.length === 0,
      'the library answers with an empty shelf rather than an error, which is the honest report for a node nobody has shot on yet');

    let armed = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((done) => { setTimeout(done, 250); });
      armed = await post(`${url}/record/start`);
      if (armed.recording || armed.armed) break;
    }
    check(armed?.armed === true, 'and it can be armed, which is the whole point of provisioning it',
      JSON.stringify({ armed: armed?.armed, error: armed?.error }));
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 13)) p.child.kill('SIGKILL');
  }

  for (const { log } of servers) {
    const text = log.join('');
    const bad = text.split('\n').filter(looksFatal);
    if (bad.length) {
      console.log(`\n[library] server log:\n  ${bad.slice(0, 4).join('\n  ')}`);
      failures++;
    }
  }
}
