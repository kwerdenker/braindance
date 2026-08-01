#!/usr/bin/env node
// Step 8's proof: the queue only hands a job to a machine that can reproduce it,
// and a job carries enough to be reproduced at all.
//
// **Every refusal here has a positive twin.** A queue that refused every claim
// would satisfy "a mismatched worker is turned away" perfectly, and a check built
// only out of refusals would call that a pass - so each row that asserts a no is
// next to the row asserting the matching yes. That is the same shape `guard-check`
// uses and the same reason.
//
// The renderer rows are the ones worth being careful about, because the failure
// they guard against does not look like a failure. Two rasterisers that nearly
// agree produce a video that plays; nobody notices until an A/B. So "the queue
// refused" is asserted by *what it said*, naming the blocked job and the class it
// wants, rather than by an absence that an empty queue would also produce.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, dflt = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const has = (name) => argv.includes(name);
const PORT = Number(flag('--port', '8231'));
const MUTATE = flag('--mutate');
const WORK = join(REPO, '.jobs-check');
const SAMPLE = flag('--source', join(REPO, 'captures', 'sample.knct'));
// The end-to-end render is real work - a browser, a GPU and ffmpeg - so it is
// skippable for a fast semantic run. It is NOT skipped by default: a queue whose
// jobs never turn into a file is a queue that proves nothing about rendering.
const SKIP_RENDER = has('--no-render');

const METAL = 'ANGLE Metal / Apple M2 Max';
const V3D = 'ANGLE (Broadcom, V3D 7.1.10.2, OpenGL ES 3.1)';

// --- mutations -------------------------------------------------------------
// Each names source text and must match exactly once. Aimed one property at a
// time, because a mutation that fails every row cannot say which row is load
// bearing - the lesson step 6 recorded when a cumulative table hid a wrong term.
const MUTATIONS = {
  'reserve-queued-only': { file: 'server/jobs.js', edits: [["      const holder = live.find((j) => j.output === String(output) && (j.state === 'queued' || j.state === 'running'));", "      const holder = live.find((j) => j.output === String(output) && j.state === 'queued');"]] },
  // The one the whole step exists to prevent: the queue stops caring what it is
  // dispatching to, and a re-render lands on a different rasteriser.
  'claim-ignores-renderer': { file: 'server/jobs.js', edits: [[
    'export const rendererMatches = (want, have) => want === null || want === undefined || want === have;',
    'export const rendererMatches = () => true;',
  ]] },
  // The subtler half. The queue still refuses, but reports the refusal as an empty
  // queue - so an operator sees an idle worker and a backlog that never drains,
  // with nothing anywhere saying why. This is the failure wearing an absence.
  'claim-hides-blocked': { file: 'server/jobs.js', edits: [[
    '        const blocked = all.map((j) => ({ id: j.id, wants: j.renderer }));\n        return { job: null, blocked, queued: all.length };',
    '        return { job: null, blocked: [], queued: 0 };',
  ]] },
  // A capture named by anything other than content. A job naming a take by id
  // renders whatever is at that id on the worker, which is the property the hash
  // exists to hold - and step 7's library already reconciles two machines holding
  // different footage under one name, so this is not hypothetical.
  'enqueue-accepts-any-capture': { file: 'server/jobs.js', edits: [[
    "    if (typeof capture !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(capture)) {",
    '    if (false) {',
  ]] },
  // A job whose outcome anyone can write, in either of the two ways that matters:
  // a queued job marked done by anybody who knows its id, with nothing having
  // rendered it, and a second report replacing the first one's.
  //
  // **It has to remove both guards, and the first version removed only the
  // terminal one - which the running check subsumes, so the mutation changed
  // nothing observable and the suite passed it.** Two guards that answer the same
  // status for different reasons cannot be told apart one at a time; what
  // distinguishes them is their message, and behaviour is what a mutation moves.
  //
  // It removes the lease-presence guard as well, and that is not over-reach: the
  // three refusals are layered, so with only the state pair gone a queued job
  // still fell at "running with no lease" and the mutation moved nothing. A
  // control has to remove whatever masks it or it is testing the mask.
  'finish-accepts-any-state': { file: 'server/jobs.js', edits: [[
    "      if (isTerminal(job.state)) {\n        throw new Error(`job ${id} is already ${job.state}, so this report is from a worker that lost a race`);\n      }\n      if (job.state !== 'running') {",
    '      if (false) {',
  ], [
    "      if (typeof job.lease !== 'string' || job.lease === '') {",
    '      if (false) {',
  ]] },
  // The control for the atomicity rows, and they had none when they were written -
  // which would have made them decoration. It lets every transition run
  // concurrently again, which is the implementation an external review found:
  // list-then-write in `claim`, read-check-write in `finish`, both correct as long
  // as nothing arrives at the same time.
  'transitions-not-serialised': { file: 'server/jobs.js', edits: [[
    '    this.serialise = (fn) => {\n      const run = this.gate.then(fn, fn);\n      this.gate = run.then(() => {}, () => {});\n      return run;\n    };',
    '    this.serialise = (fn) => Promise.resolve().then(fn);',
  ]] },
  // The control for the lease being a secret. It puts the lease back into what the
  // read routes serve, which is how it first shipped.
  'jobs-serve-lease': { file: 'server/index.js', edits: [[
    'const withoutLease = ({ lease, ...job }) => job;',
    'const withoutLease = (job) => job;',
  ]] },
  // And the control for a running record with no lease being finishable, which is
  // what `if (job.lease && ...)` allowed.
  'lease-optional-when-absent': { file: 'server/jobs.js', edits: [[
    "      if (typeof job.lease !== 'string' || job.lease === '') {",
    '      if (false) {',
  ]] },
  // And the lease on its own, so "the report came from the claim that is running
  // it" has a control that is not the state check wearing a different name.
  'finish-ignores-lease': { file: 'server/jobs.js', edits: [[
    '      if (lease !== job.lease) {',
    '      if (false) {',
  ]] },
  // The control for the way out of the deadlock: refuse a running job whatever it
  // has or has not said, which is how the requeue fix first shipped and which left
  // a killed worker's job unreachable forever.
  'requeue-refuses-all-running': { file: 'server/jobs.js', edits: [[
    '        const quietFor = this.now() - (job.heartbeat ?? job.claimed ?? 0);\n        if (quietFor < this.staleMs) {',
    '        const quietFor = 0;\n        if (true) {',
  ]] },
  // And the control for the heartbeat being held to the lease - without it anyone
  // could keep a dead worker's job looking alive, which is the same deadlock
  // reached from the other side.
  'heartbeat-ignores-lease': { file: 'server/jobs.js', edits: [[
    "      if (typeof job.lease !== 'string' || lease !== job.lease) {\n        throw new Error(`job ${id} is held by another claim, so this is not the one rendering it`);\n      }",
    '      if (false) { throw new Error(\'unreachable\'); }',
  ]] },
  // A retry that forgets what it was rendered on. The record still says a class
  // was involved once, but the next claim is unpinned, so the retry can land
  // anywhere - which is precisely a re-render on a different rasteriser, reached
  // by a different door than claim-ignores-renderer.
  'requeue-clears-renderer': { file: 'server/jobs.js', edits: [[
    "      job.state = 'queued';\n      job.claimed = null;",
    "      job.state = 'queued';\n      job.renderer = null;\n      job.claimed = null;",
  ]] },
};
if (MUTATE && !MUTATIONS[MUTATE]) {
  console.error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

// --- harness ---------------------------------------------------------------
let assertions = 0;
let failures = 0;
let crashed = null;
const check = (ok, label, detail = '') => {
  assertions++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
};
const section = (title) => console.log(`\n[jobs] ${title}`);

// Staged the way library-check stages: a copy, never an edit-and-restore, so a
// falsification run cannot leave a mutated tree behind a crash.
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const root = join(WORK, 'root');
mkdirSync(root, { recursive: true });
cpSync(join(REPO, 'server'), join(root, 'server'), { recursive: true });
cpSync(join(REPO, 'web'), join(root, 'web'), { recursive: true });
for (const name of ['node_modules', 'vendor']) {
  const from = join(REPO, name);
  if (existsSync(from)) symlinkSync(from, join(root, name));
}
if (MUTATE) {
  const spec = MUTATIONS[MUTATE];
  const path = join(root, spec.file);
  let source = readFileSync(path, 'utf8');
  for (const [from, to] of spec.edits) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) {
      console.error(`mutation ${MUTATE} matched ${hits} times in ${spec.file}, expected exactly 1 - refusing to run an unmutated server`);
      process.exit(2);
    }
    source = source.replace(from, to);
  }
  writeFileSync(path, source);
}

const caps = join(WORK, 'captures');
const jobsDir = join(WORK, 'jobs');
const exportsDir = join(root, 'exports');
mkdirSync(caps, { recursive: true });
if (!existsSync(SAMPLE)) {
  console.error(`no capture at ${SAMPLE} - this check needs one take to render`);
  process.exit(2);
}
symlinkSync(SAMPLE, join(caps, 'sample.knct'));

const servers = [];
const startServer = async () => {
  const child = spawn(process.execPath, [join(root, 'server/index.js'),
    '--port', String(PORT), '--captures', caps, '--jobs', jobsDir,
    // **No `--replay`, and that is the fix to a flake rather than a tidy-up.**
    // A replaying server pushes a frame at the page continuously, and each one
    // repaints - so a repaint could land inside the export's first seek and
    // `ExportTransport` counted it, throwing `the render at 0.000000s reached the
    // export 2 times`. It failed about one run in four, which is what a race
    // against an arriving frame looks like from outside, and awaiting the page's
    // own `settled()` narrowed it without closing it because the next frame
    // arrives regardless of what the page has finished.
    //
    // A render worker's server has no live source by construction: it renders
    // takes off disk. The `--replay` here was copied from the checks that need a
    // stream and was making the fixture contend with the thing under test.
    '--projects', join(WORK, 'projects'), '--presets', join(WORK, 'presets')],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(child);
  const log = [];
  child.stdout.on('data', (c) => log.push(c.toString()));
  child.stderr.on('data', (c) => log.push(c.toString()));
  for (let i = 0; i < 200; i++) {
    await new Promise((done) => { setTimeout(done, 100); });
    try {
      const r = await fetch(`${URL_}/library/takes`);
      if (r.ok) return () => log.join('');
    } catch { /* not up yet */ }
  }
  throw new Error(`server never came up:\n${log.join('')}`);
};
const URL_ = `http://localhost:${PORT}`;
const stopServers = () => { for (const c of servers) c.kill('SIGKILL'); servers.length = 0; };

const post = async (path, body, headers = {}) => {
  const res = await fetch(URL_ + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const get = async (path) => (await fetch(URL_ + path)).json();

const HASH_A = `sha256:${'a'.repeat(64)}`;
// A document `restoreProject` accepts, field for field, rather than a plausible
// looking one. It is written out here instead of serialised from a page because
// the queue rows below must not need a browser to run - but it has to actually
// load, or the render row would fail for a reason that has nothing to do with the
// queue. `mode` is a whole number 0-4 and `appliedPreset` is null or a name and a
// rev; the first draft used `mode: 'rgb'` and failed the render row while every
// queue row passed, which is a check reporting the wrong thing broken.
const PROJECT = {
  version: 1,
  mode: 0,
  outputFps: 30,
  params: {},
  tracks: {},
  retime: { rate: 1, keys: [] },
  appliedPreset: null,
};
// **The default output is unique per call, and that is load bearing.**
// It used to be the constant `check`, so once the queue learned to refuse an
// output another live job had reserved, every later enqueue got a 400 - and the
// row asserting that a take-id capture is refused passed on the *collision*
// message while the capture check was mutated away. A refusal that arrives for a
// neighbouring reason reads exactly like the one being tested.
let outputSeq = 0;
const enqueue = (over = {}) => post('/jobs', {
  project: PROJECT, capture: HASH_A, output: `check${++outputSeq}`, width: 640, height: 400, fps: 30, ...over,
});
// And a refusal is asserted by what it says, not only by its status, for the same
// reason: 400 is the answer to several different questions.
const refusedBecause = (res, needle) => res.status === 400 && String(res.body.error ?? '').includes(needle);

try {
  const serverLog = await startServer();

  section('a job is self-contained, or it is not a job');
  const good = await enqueue();
  check(good.status === 200 && good.body.state === 'queued', 'a job with a project body and a content-hashed capture is accepted',
    `${good.status} ${good.body.id ?? good.body.error}`);
  check(good.body.renderer === null, 'and it starts unpinned, because the first job has no class to reproduce yet');
  const byId = await enqueue({ capture: 'sample' });
  check(refusedBecause(byId, 'content hash'),
    'a capture named by take id is refused - an id is a filename and two machines can hold different footage under one',
    `${byId.status} ${(byId.body.error ?? '').slice(0, 60)}`);
  const envelope = await enqueue({ project: { name: 'p', rev: 'sha256:x', body: PROJECT } });
  check(refusedBecause(envelope, 'envelope'),
    'and so is the store envelope in place of the document body, rather than being unwrapped on a guess',
    `${envelope.status} ${(envelope.body.error ?? '').slice(0, 50)}`);
  // The output field used to be accepted unvalidated and refused three layers
  // later by the export socket, so the queue held work it already knew could not
  // run. Refused here now, against the exporter's own rule rather than a copy.
  const badNames = ['../../server/index', '/tmp/absolute', '', 'a b', '.hidden'];
  const refusedNames = [];
  for (const output of badNames) {
    const r = await enqueue({ output });
    if (refusedBecause(r, 'bad output name')) refusedNames.push(output);
  }
  check(refusedNames.length === badNames.length,
    'an output that is not a plain file name is refused at enqueue, not three layers later by the thing that writes the file',
    `${refusedNames.length} of ${badNames.length} refused`);

  section('the queue hands a job only to a machine that can reproduce it');
  // **A precondition row, because the section below reasons about what is left in
  // the queue.** Without it a mutation that lets a refused enqueue through fails
  // these renderer rows too, and it would read as the renderer pinning being
  // broken when what actually broke is two sections up - a mutation caught for a
  // neighbouring reason, which this repo has already recorded once as looking
  // exactly like a mutation caught for its own.
  const beforePin = (await get('/jobs')).jobs;
  check(beforePin.length === 1 && beforePin[0].id === good.body.id,
    'exactly one job survived the refusals above, so what follows is about the renderer class and not about a stray job',
    `${beforePin.length}: ${beforePin.map((j) => j.output).join(', ')}`);
  const pinned = await enqueue({ output: 'pinned', renderer: V3D });
  check(pinned.status === 200 && pinned.body.renderer === V3D, 'a job can be pinned to a renderer class at enqueue');
  const c1 = await post('/jobs/claim', { worker: 'mac', renderer: METAL });
  check(c1.status === 200 && c1.body.job?.id === good.body.id,
    'a Metal worker is given the unpinned job, which is the positive half of every refusal below',
    c1.body.job?.id ?? JSON.stringify(c1.body).slice(0, 70));
  check(c1.body.job?.renderer === METAL && c1.body.job?.state === 'running',
    'and the claim stamps the class it will render on, which is the provenance the field exists for');
  check(c1.body.job?.attempts === 1, 'attempts moves on the claim, so a job retried forever is visible as a number rather than a mood');

  const c2 = await post('/jobs/claim', { worker: 'mac', renderer: METAL });
  check(c2.status === 409 && c2.body.job === null,
    'with only a V3D job left, a Metal worker is refused rather than handed it',
    `${c2.status}`);
  check((c2.body.blocked ?? []).some((b) => b.id === pinned.body.id && b.wants === V3D),
    'and the refusal NAMES the job and the class it wants - an empty queue and a queue full of somebody else\'s work are different answers',
    JSON.stringify(c2.body.blocked ?? []).slice(0, 80));
  const c3 = await post('/jobs/claim', { worker: 'pi', renderer: V3D });
  check(c3.status === 200 && c3.body.job?.id === pinned.body.id,
    'a V3D worker gets it, so the refusal above was about the class and not about the job being unclaimable');

  section('two jobs cannot be aimed at one file');
  // Both would rename over exports/<name>.mp4 and the second would win, leaving
  // two finished records describing one video. Placed here rather than beside the
  // other enqueue refusals because it leaves a job in the queue, and the section
  // above reasons about what is queued - the precondition row would have caught
  // that, which is what it is for.
  const first = await enqueue({ output: 'contested' });
  const second = await enqueue({ output: 'contested' });
  check(first.status === 200 && refusedBecause(second, 'already reserved'),
    'a second live job cannot reserve an output the first one is still going to write',
    `${first.status} then ${second.status} ${(second.body.error ?? '').slice(0, 40)}`);
  const firstClaim = (await post('/jobs/claim', { worker: 'tidy', renderer: METAL })).body.job;
  await post(`/jobs/${firstClaim.id}/finish`, { state: 'failed', error: 'tidying', lease: firstClaim.lease });
  const reuse = await enqueue({ output: 'contested' });
  check(reuse.status === 200,
    'and the name frees up once nothing live holds it, because re-exporting over a file you already have is the ordinary case',
    `${reuse.status}`);
  const reuseClaim = (await post('/jobs/claim', { worker: 'tidy', renderer: METAL })).body.job;
  await post(`/jobs/${reuseClaim.id}/finish`, { state: 'failed', error: 'tidying', lease: reuseClaim.lease });

  section('the transitions are atomic, which a sequential drive cannot see');
  // **Every row above this drives one request at a time, and the implementation
  // they were written against passed them all while being racy.** An external
  // review pointed at the list-then-write in `claim` and the read-check-write in
  // `finish`, and it was right: a check that never issues two requests at once
  // cannot tell an atomic transition from one that merely works when nobody is
  // looking. These rows fire the requests together and count outcomes.
  const raceJobs = [];
  for (let i = 0; i < 4; i++) raceJobs.push((await enqueue({ output: `race${i}` })).body);
  const claims = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    post('/jobs/claim', { worker: `racer${i}`, renderer: METAL })));
  const handed = claims.filter((c) => c.body.job).map((c) => c.body.job.id);
  check(handed.length === new Set(handed).size,
    'eight workers claiming at once never receive the same job twice - a list-then-write hands one job to two machines',
    `${handed.length} handed, ${new Set(handed).size} distinct`);
  check(handed.length === raceJobs.length,
    'and all four queued jobs were handed out rather than lost to the same race', `${handed.length} of ${raceJobs.length}`);

  const victim = claims.find((c) => c.body.job).body.job;
  const reports = await Promise.all([
    post(`/jobs/${victim.id}/finish`, { state: 'done', output: 'winner', lease: victim.lease }),
    post(`/jobs/${victim.id}/finish`, { state: 'failed', error: 'loser', lease: victim.lease }),
  ]);
  const accepted = reports.filter((r) => r.status === 200);
  check(accepted.length === 1,
    'two outcome reports fired together, and exactly one is taken - read-check-write lets the second overwrite the first',
    `${accepted.length} accepted of 2`);

  section('an outcome comes from the claim that is running it');
  const unclaimed = (await enqueue({ output: 'never-rendered' })).body;
  const forged = await post(`/jobs/${unclaimed.id}/finish`, { state: 'done', output: 'never-rendered' });
  check(forged.status === 409,
    'a queued job cannot be marked done by anyone who knows its id - nothing has rendered it, so there is no outcome to report',
    `${forged.status}`);
  check((await get(`/jobs/${unclaimed.id}`)).state === 'queued', 'and it is still queued afterwards');
  const held = (await post('/jobs/claim', { worker: 'holder', renderer: METAL })).body.job;
  const noLease = await post(`/jobs/${held.id}/finish`, { state: 'done' });
  check(noLease.status === 409, 'and a report with no lease is refused while a claim holds it', `${noLease.status}`);
  // **A capability that is published is not a capability.** The lease was added so
  // a report has to come from the claim running the job, and the first version
  // left it in the record the read routes return - so anyone could GET the job,
  // copy the lease and forge the outcome, and the real worker's report then lost
  // to the terminal guard. Asserted on the read surface rather than on the
  // behaviour, because the behaviour is indistinguishable until somebody looks.
  const readBack = await get(`/jobs/${held.id}`);
  const listed = (await get('/jobs')).jobs.find((j) => j.id === held.id);
  check(!('lease' in readBack) && !('lease' in (listed ?? {})),
    'and the lease is not in what the read routes serve, or copying it out of a GET is all forging one takes',
    `GET ${'lease' in readBack ? 'leaks' : 'clean'}, list ${'lease' in (listed ?? {}) ? 'leaks' : 'clean'}`);
  check(readBack.state === 'running' && readBack.id === held.id,
    'while the rest of the record is still served, so that row is about the lease and not about the route being empty');

  // **A record the queue could not have written, written by hand.** A `running`
  // job always has a lease when a claim made it, so nothing this check drives can
  // produce one without - which meant the guard against a leaseless running record
  // was unreachable and its mutation changed nothing observable. The state exists
  // on disk though: an older build wrote records with no lease field at all, and a
  // record is a file. Planting it is the only way to stand in front of that door.
  const plantedId = `job-${'ab'.repeat(8)}`;
  writeFileSync(join(jobsDir, `${plantedId}.json`), `${JSON.stringify({
    id: plantedId, version: 1, project: PROJECT, capture: HASH_A, renderer: METAL,
    output: 'planted', width: 64, height: 64, fps: 30, codec: 'h264',
    state: 'running', created: 1, claimed: 2, finished: null, worker: 'ghost',
    error: null, attempts: 1, lease: null,
  }, null, 2)}\n`);
  const ghost = await post(`/jobs/${plantedId}/finish`, { state: 'done', output: 'planted' });
  check(ghost.status === 409,
    'a running record carrying no lease cannot be finished by anybody - that is a record no claim could have written, so it is unusable rather than open',
    `${ghost.status} ${(ghost.body.error ?? '').slice(0, 60)}`);
  const rightLease = await post(`/jobs/${held.id}/finish`, { state: 'done', lease: held.lease });
  check(rightLease.status === 200, 'while the claim that holds the lease is taken, which is the positive half of that');

  section('a finished job is finished');
  const fin = await post(`/jobs/${good.body.id}/finish`, { state: 'done', output: 'check', lease: c1.body.job.lease });
  check(fin.status === 200 && fin.body.state === 'done', 'a worker reports an outcome and the record takes it');
  const again = await post(`/jobs/${good.body.id}/finish`, { state: 'failed', error: 'the loser of a race', lease: c1.body.job.lease });
  check(again.status === 409, 'a second report on the same job is refused, so two workers racing cannot leave the last one to speak as the record',
    `${again.status}`);
  check((await get(`/jobs/${good.body.id}`)).state === 'done', 'and the record still says what the first one said');

  section('a retry is a retry, not a different render');
  const running = (await post('/jobs/claim', { worker: 'still-going', renderer: METAL })).body.job;
  if (running) {
    const rqLive = await post(`/jobs/${running.id}/requeue`, {});
    check(rqLive.status === 404 || rqLive.status === 409,
      'a job that is still rendering cannot be requeued, or a second worker joins the first on the same edit',
      `${rqLive.status}`);
    await post(`/jobs/${running.id}/finish`, { state: 'failed', error: 'tidying the fixture', lease: running.lease });
  }
  // **The deadlock the running-refusal created, and the way out of it.** Refusing
  // every running job left a job whose worker was killed unreachable forever:
  // `requeue` refused it, `finish` wanted the lease that died with the worker,
  // `claim` skipped it because it was not queued, and its output name stayed
  // reserved so not even a replacement could be enqueued. What expires is the
  // silence rather than the job - a render may run for hours by design, so no
  // timeout on duration could ever be right.
  //
  // Planted with an ancient heartbeat rather than waited for, so the row tests the
  // real default window instead of a shortened one, and takes no time at all.
  const deadId = `job-${'cd'.repeat(8)}`;
  writeFileSync(join(jobsDir, `${deadId}.json`), `${JSON.stringify({
    id: deadId, version: 1, project: PROJECT, capture: HASH_A, renderer: METAL,
    output: 'orphan', width: 64, height: 64, fps: 30, codec: 'h264',
    state: 'running', created: 1, claimed: 1, heartbeat: 1, finished: null,
    worker: 'killed-mid-render', error: null, attempts: 1, lease: 'lease-that-died-with-it',
  }, null, 2)}\n`);
  const rescued = await post(`/jobs/${deadId}/requeue`, {});
  check(rescued.status === 200 && rescued.body.state === 'queued',
    'a job whose worker died and stopped saying anything can be put back on the queue, or nothing could ever reach it again',
    `${rescued.status} ${rescued.body.state ?? (rescued.body.error ?? '').slice(0, 60)}`);
  check(rescued.body.lease === null && rescued.body.heartbeat === null,
    'and the dead claim\'s lease goes with it, so the worker that vanished cannot report on it if it comes back');
  const liveClaim = (await post('/jobs/claim', { worker: 'alive', renderer: METAL })).body.job;
  const beat = await post(`/jobs/${liveClaim.id}/heartbeat`, { lease: liveClaim.lease });
  check(beat.status === 200, 'a live worker can say it is still there', `${beat.status}`);
  check(!('lease' in beat.body), 'and the heartbeat does not hand the lease back out either');
  const forgedBeat = await post(`/jobs/${liveClaim.id}/heartbeat`, { lease: 'not-the-lease' });
  check(forgedBeat.status === 409, 'while anybody else keeping a dead job looking alive is refused - that would be the deadlock from the other side',
    `${forgedBeat.status}`);
  const stillRunning = await post(`/jobs/${liveClaim.id}/requeue`, {});
  check(stillRunning.status === 404 || stillRunning.status === 409,
    'and a job that just spoke is still refused, so the exception is about silence and not about running',
    `${stillRunning.status}`);
  await post(`/jobs/${liveClaim.id}/finish`, { state: 'failed', error: 'tidying', lease: liveClaim.lease });

  const rq = await post(`/jobs/${good.body.id}/requeue`, {});
  check(rq.status === 200 && rq.body.state === 'queued', 'a done job can go back on the queue');
  check(rq.body.renderer === METAL,
    'and it stays pinned to the class it was rendered on - a retry that could land anywhere is a second render of the same edit, not a retry',
    String(rq.body.renderer).slice(0, 40));
  const c4 = await post('/jobs/claim', { worker: 'pi', renderer: V3D });
  check(c4.status === 409, 'so the V3D worker cannot pick up the Metal retry', `${c4.status}`);

  section('the queue is behind the same guard every mutating route is');
  const noType = await fetch(`${URL_}/jobs`, { method: 'POST', body: '{}' });
  check(noType.status === 415, 'an enqueue without a JSON content type is refused', `${noType.status}`);
  const crossOrigin = await fetch(`${URL_}/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}',
  });
  check(crossOrigin.status === 403, 'and one from another page is refused before it is read', `${crossOrigin.status}`);
  const getClaim = await fetch(`${URL_}/jobs/claim`);
  check(getClaim.status === 405,
    'a GET of /jobs/claim is 405 and not 404 - the route exists, and reading it as a job id would say it does not',
    `${getClaim.status}`);

  section('the namespace the table owns is not answerable by the file tree');
  mkdirSync(join(root, 'web', 'jobs', 'probe'), { recursive: true });
  writeFileSync(join(root, 'web', 'jobs', 'probe', 'leak.js'), '// planted\n');
  const shadow = await fetch(`${URL_}/jobs/probe/leak.js`);
  check(shadow.status === 404,
    'a file planted at web/jobs/ is the API\'s 404, because the owned namespaces come from the route table rather than a list',
    `${shadow.status}`);
  rmSync(join(root, 'web', 'jobs'), { recursive: true, force: true });

  if (!SKIP_RENDER) {
    section('and a job becomes a file, through the page\'s own export door');
    const { takes } = await get('/library/takes');
    const take = takes[0];
    if (!take) throw new Error('no take in the staged library to render');
    const real = await enqueue({ capture: take.hash, output: 'jobs-check-render', width: 320, height: 200 });
    check(real.status === 200, 'a job against real footage is queued', real.body.id ?? real.body.error);
    const worker = spawn(process.execPath, [join(REPO, 'tools/render-worker.mjs'),
      '--url', URL_, '--name', 'jobs-check', '--drain', '--max', '1'], { stdio: 'ignore' });
    const code = await new Promise((done) => worker.on('close', done));
    const record = await get(`/jobs/${real.body.id}`);
    check(code === 0 && record.state === 'done',
      'the worker claims it, renders it headless and reports done', `exit ${code}, state ${record.state}${record.error ? `, ${record.error.slice(0, 70)}` : ''}`);
    check(/ANGLE/.test(String(record.renderer)),
      'and the class on the record is the one the browser actually reported, not one the worker was told',
      String(record.renderer).slice(0, 46));
    let probed = '';
    try {
      probed = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,nb_frames',
        '-of', 'default=nw=1', record.artifactPath], { encoding: 'utf8' });
    } catch (err) { probed = `ffprobe failed: ${err.message}`; }
    check(/width=320/.test(probed) && /height=200/.test(probed),
      'the file it wrote is a video at the size the job asked for, which is the only thing a metadata check cannot fake',
      probed.trim().replace(/\n/g, ' '));
    // **"It has frames in it" was the first version of this row, and a worker that
    // emitted one valid frame at the right size would have passed it.** What it
    // compares against is the count the worker reported, which is the number the
    // export declared to the encoder - and `server/export.js` refuses a stream
    // that sends a different number, so the two ends agreeing is the claim.
    //
    // It is deliberately NOT the take's frame count. The sample was shot on a
    // degraded link at about 9.3fps, so a 284-frame take exports to 911 frames at
    // 30 - and the first version of this row asserted against `take.frames` and
    // failed on a render that was entirely correct. Sizing anything by a take's
    // frame count is the trap this repo already has a rule about.
    const probedFrames = Number(probed.match(/nb_frames=(\d+)/)?.[1] ?? 0);
    check(probedFrames > 1 && probedFrames === record.frames,
      'and it holds every frame the export declared, not one frame at the right size',
      `${probedFrames} in the file, ${record.frames} declared, from a ${take.frames}-frame take`);
  } else {
    console.log('  ...   render row skipped by --no-render, so nothing here proves a job becomes a file');
  }

  check(!/\[jobs\] .*undefined/.test(serverLog()), 'the server logged no undefined while all of that ran');
} catch (err) {
  crashed = err;
  console.log(`\n  FAIL  the run did not finish: ${err.message}`);
} finally {
  stopServers();
  rmSync(WORK, { recursive: true, force: true });
  rmSync(exportsDir, { recursive: true, force: true });
}

console.log(`\n[jobs] ${assertions} assertions, ${failures} failed`);
if (crashed) {
  console.log(`[jobs] DID NOT RUN - ${crashed.message}. Nothing here is a finding: re-run it.`);
  process.exit(2);
}
if (MUTATE) {
  if (failures === 0) { console.log('[jobs] NOT CAUGHT - the check passed a queue it should have rejected'); process.exit(1); }
  console.log(`[jobs] caught, as required (${failures} assertion${failures === 1 ? '' : 's'} fired)`);
  process.exit(1);
}
console.log(failures === 0 ? '[jobs] PASS' : `[jobs] FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
