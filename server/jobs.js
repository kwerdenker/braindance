// The render queue: jobs on disk, claimed by workers, one at a time.
//
// A job is a project file plus a capture named by content hash plus output
// settings, which is what makes it self-contained - the same three things
// `server/export.js` has been stamping onto every export since step 6, because
// step 6 knew this step was coming. Nothing here re-derives them.
//
// **The renderer class is the whole reason this is a queue rather than a list.**
// Bit-exactness was measured between headed and headless Chrome on one GPU and
// does not survive a different one: the Pi rasterises through ANGLE/V3D and the
// Mac through ANGLE/Metal, and those are different rasterisers rather than two
// speeds of one. Since a project names its capture by hash precisely so a
// re-render reproduces the original, a queue that silently handed a re-render to
// a different class of machine would break the property the model rests on. So a
// mismatch is refused and *recorded*, never quietly re-dispatched.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VALID_NAME } from './export.js';

export const JOB_VERSION = 1;

// A job id is generated here rather than accepted from a caller, so it can never
// name a path. The same rule the capture ids follow, reached the same way.
const VALID_JOB_ID = /^job-[0-9a-f]{16}$/;

// Where a job can be. `queued` is claimable, `running` is somebody's, and the two
// terminal states are terminal - a worker reporting on a job that already finished
// is a worker that lost a race, and it is told so rather than allowed to overwrite.
export const STATES = ['queued', 'running', 'done', 'failed'];

const isTerminal = (state) => state === 'done' || state === 'failed';

/**
 * Whether a worker of class `have` may run a job pinned to class `want`.
 *
 * An unpinned job - `want` null - is claimable by anyone, and that is the common
 * case rather than the exception: a job created before anything has rendered it
 * has no class to pin to, and the claim is what stamps one on. Pinning matters on
 * the *second* pass, when the record exists to be reproduced.
 *
 * Compared as exact strings on purpose. The renderer string is a driver's own
 * description of itself and the failure being guarded against is two rasterisers
 * that nearly agree, so anything fuzzier than equality would admit exactly the
 * pair this is for.
 */
export const rendererMatches = (want, have) => want === null || want === undefined || want === have;

export class JobStore {
  constructor(dir, { now = Date.now } = {}) {
    this.dir = dir;
    this.now = now;
    // **Every state transition goes through here, one at a time.**
    //
    // `claim` lists, picks and writes, and `finish` reads, checks and writes,
    // and both of those have an `await` between the decision and the write. In one
    // Node process that is not a theoretical race: two requests arriving together
    // interleave at exactly that await, so two workers both saw a job `queued`,
    // both wrote it `running`, and both got a 200 for the same job - and two
    // finish reports both read a `running` record, both passed the terminal-state
    // guard, and the second one silently replaced the first one's outcome.
    //
    // A promise chain rather than a lock file because this is one process by
    // construction: the queue lives beside the server that serves it. A lock file
    // would be the right answer for two servers on one directory, and that is not
    // a thing this program can currently be.
    this.gate = Promise.resolve();
    // Serialises `fn` against every other transition. The chain is advanced even
    // when `fn` rejects, or one refused claim would wedge the queue forever.
    this.serialise = (fn) => {
      const run = this.gate.then(fn, fn);
      this.gate = run.then(() => {}, () => {});
      return run;
    };
    // Same counter the document stores keep, for the same reason: a handler that
    // writes a job and puts the bytes back is invisible to a before-and-after
    // reading of the contents, and this is the quantity no restore can undo.
    this.writes = 0;
  }

  pathFor(id) {
    if (!VALID_JOB_ID.test(id)) throw new Error(`unusable job id ${JSON.stringify(id)}`);
    return join(this.dir, `${id}.json`);
  }

  // Content-addressed off the record itself, so an id carries nothing a path
  // parser could act on. It does NOT make two enqueues of the same edit distinct -
  // identical bodies inside one millisecond hash identically, and the second used
  // to overwrite the first - which is why `enqueue` salts on collision rather than
  // trusting this to be unique.
  idFor(record) {
    const h = createHash('sha256').update(JSON.stringify(record)).digest('hex');
    return `job-${h.slice(0, 16)}`;
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
      try {
        out.push(JSON.parse(await readFile(join(this.dir, file), 'utf8')));
      } catch { /* a job record this build cannot read is not a reason to hide the rest */ }
    }
    return out;
  }

  async read(id) {
    return JSON.parse(await readFile(this.pathFor(id), 'utf8'));
  }

  // Written aside and renamed, the same as every other record in this program: a
  // crash partway through must not leave a file that parses and describes a job
  // nobody enqueued.
  async #put(job) {
    const path = this.pathFor(job.id);
    this.writes++;
    await mkdir(this.dir, { recursive: true });
    const text = `${JSON.stringify(job, null, 2)}\n`;
    await writeFile(`${path}.tmp`, text);
    await rename(`${path}.tmp`, path);
    return job;
  }

  /**
   * Enqueue a render.
   *
   * `project` and `capture` are required and `renderer` is not, because the whole
   * point of recording the class from the first job is that the first job does not
   * have one yet. A capture that is not a content hash is refused here: "reproduces
   * the original" is a claim about identified footage, and a job naming a take by
   * id would reproduce whatever is at that id today.
   */
  async enqueue({ project, capture, renderer = null, output, width, height, fps, codec = 'h264' }) {
    // The project is the document *body* - what `serialiseProject()` returns and
    // what `restoreProject` takes - not the `{ name, rev, body }` envelope the
    // document store hands back. One shape, checked here, because accepting both
    // would be a fork in the one field that decides what gets rendered, and the
    // loader's seventeen refusals are written against the body.
    if (!project || typeof project !== 'object' || Array.isArray(project)) {
      throw new Error('a job needs a project document body');
    }
    if (project.version === undefined) {
      throw new Error(
        'a job\'s project has no version, so it is the store envelope rather than the document body: '
        + 'pass what serialiseProject() returns, not { name, rev, body }',
      );
    }
    if (typeof capture !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(capture)) {
      throw new Error(`a job names its capture by content hash, got ${JSON.stringify(capture)}`);
    }
    if (!(Number(width) > 0 && Number(height) > 0)) throw new Error(`bad output size ${width}x${height}`);
    if (!(Number(fps) > 0)) throw new Error(`bad output rate ${fps}`);
    // The exporter's own rule, imported rather than restated. A job carrying
    // `../../server/index` used to be accepted here and refused three layers later
    // by the export socket, so the queue held work it already knew could not run -
    // and the refusal that mattered lived nowhere near the field it was about.
    if (!VALID_NAME.test(String(output ?? ''))) {
      throw new Error(`bad output name ${JSON.stringify(output)}: it names a file in the exports directory, so it is letters, digits, dot, dash and underscore`);
    }
    return this.serialise(async () => {
      const live = await this.list();
      // **Two jobs writing one file is one job's work thrown away.** Both render to
      // `exports/<output>.mp4` and the second rename replaces the first, along with
      // its sidecar - so a queue of two finished jobs leaves one video and two
      // records claiming to describe it. Refused while the other is still going to
      // write; a finished or failed job's name is free again, because replacing an
      // export you already have is what re-exporting means.
      const holder = live.find((j) => j.output === String(output) && (j.state === 'queued' || j.state === 'running'));
      if (holder) {
        throw new Error(`output ${JSON.stringify(String(output))} is already reserved by ${holder.id} (${holder.state}), and two jobs writing one file is one render thrown away`);
      }
      const created = this.now();
      const body = {
        version: JOB_VERSION,
        project,
        capture,
        renderer: renderer ?? null,
        output: String(output),
        width: Math.trunc(width),
        height: Math.trunc(height),
        fps: Number(fps),
        codec,
        state: 'queued',
        created,
        claimed: null,
        finished: null,
        worker: null,
        error: null,
        attempts: 0,
        lease: null,
      };
      // The id is content-addressed, and two identical enqueues inside one
      // millisecond hash identically - so the second silently wrote over the first
      // and a queue of two held one job. The salt is the collision counter rather
      // than a random value, because the id has to stay a function of the record
      // for the same reason every other identity in this program does.
      let id = this.idFor({ ...body, salt: 0 });
      for (let salt = 1; live.some((j) => j.id === id); salt++) id = this.idFor({ ...body, salt });
      return this.#put({ id, ...body });
    });
  }

  /**
   * Hand the oldest claimable job to a worker of this renderer class.
   *
   * Returns the job, or a refusal naming what blocked it. **A queue with work in
   * it that this worker cannot run is a different answer from an empty queue**,
   * and both used to be "null" in the first draft of this - which is exactly the
   * silent-mismatch failure the class pinning exists to prevent, reappearing as
   * an absence rather than a wrong image.
   */
  claim({ worker, renderer }) {
    if (!renderer) return Promise.reject(new Error('a worker claims with the renderer class it will render on'));
    return this.serialise(async () => {
      const all = (await this.list()).filter((j) => j.state === 'queued').sort((a, b) => a.created - b.created);
      const mine = all.filter((j) => rendererMatches(j.renderer, renderer));
      if (mine.length === 0) {
        const blocked = all.map((j) => ({ id: j.id, wants: j.renderer }));
        return { job: null, blocked, queued: all.length };
      }
      const job = mine[0];
      job.state = 'running';
      job.claimed = this.now();
      job.worker = worker ?? null;
      job.attempts += 1;
      // A token the finisher has to present. Without it any caller could report on
      // a job it never claimed - and `POST /jobs/<id>/finish` with `{"state":"done"}`
      // straight after an enqueue marked a job done that no worker had ever
      // touched, which is a render that never happened wearing a successful record.
      job.lease = `${job.id}-${job.attempts}-${createHash('sha256').update(`${job.id}${job.attempts}${job.claimed}`).digest('hex').slice(0, 12)}`;
      // Stamped on the claim, not on completion. A job that dies mid-render has still
      // told us which class of machine it was attempted on, and that is the provenance
      // the field exists for.
      job.renderer = renderer;
      await this.#put(job);
      return { job, blocked: [], queued: all.length };
    });
  }

  /**
   * Report an outcome, against the lease the claim handed out.
   *
   * **A job finishes only from `running`, and only for the claim that owns it.**
   * Terminal-state-only was the first version of this guard and it was too weak in
   * two directions at once: a `queued` job could be marked done by anyone who knew
   * its id, without any worker ever having claimed it, and two reports that both
   * read a `running` record both passed the guard so the second overwrote the
   * first. The lease closes the first; running inside the same gate as `claim`
   * closes the second.
   */
  finish(id, { state, error = null, output = null, frames = null, lease = null }) {
    return this.serialise(async () => {
      if (state !== 'done' && state !== 'failed') throw new Error(`a job finishes done or failed, not ${state}`);
      if (output !== null && typeof output !== 'string') throw new Error('a job\'s output is a string or nothing');
      const job = await this.read(id);
      if (isTerminal(job.state)) {
        throw new Error(`job ${id} is already ${job.state}, so this report is from a worker that lost a race`);
      }
      if (job.state !== 'running') {
        throw new Error(`job ${id} is ${job.state}, so nothing is rendering it and there is no outcome to report`);
      }
      // **`job.lease &&` was the first version of this and it was permissive in
      // the one direction that matters**: a running record whose lease is null or
      // missing accepted a report from anybody, and a record is a file on disk
      // that a hand or an older build can write. A running job has a lease by
      // construction, so its absence is a broken record rather than a job to be
      // helpful about.
      if (typeof job.lease !== 'string' || job.lease === '') {
        throw new Error(`job ${id} says it is running with no lease, which is not a state a claim can produce - the record is unusable rather than finishable`);
      }
      if (lease !== job.lease) {
        throw new Error(`job ${id} is held by another claim, so this report is not the one running it`);
      }
      job.state = state;
      job.error = error;
      job.finished = this.now();
      job.lease = null;
      if (output) job.output = output;
      // What the encoder actually took, reported by the worker rather than derived
      // here. The take's own frame count is NOT this number - the sample was shot
      // on a degraded link at about 9.3fps and an export at 30 makes far more
      // frames than the take holds - so anything comparing a file against "the
      // clip" has to compare against this.
      if (Number.isFinite(frames)) job.frames = frames;
      return this.#put(job);
    });
  }

  /**
   * Put a finished-or-running job back on the queue.
   *
   * The renderer stays pinned, which is the point: a retry of a job that has been
   * rendered once has to land on the same class of machine or it is not a retry,
   * it is a different render of the same edit.
   */
  requeue(id) {
    return this.serialise(async () => {
      const job = await this.read(id);
      // **A running job is refused rather than duplicated.** Putting one back on
      // the queue while a worker is still rendering it lets a second worker claim
      // it, so two machines render the same edit and whichever finishes first
      // decides - and the first worker's own report then arrives against a lease
      // that has moved. Requeue is for jobs that stopped, and a job that has not
      // stopped is not one of them.
      if (job.state === 'running') {
        throw new Error(
          `job ${id} is running on ${job.worker ?? 'a worker'}, so requeueing it would put a second machine on the same render: `
          + 'let it finish or fail first',
        );
      }
      job.state = 'queued';
      job.claimed = null;
      job.finished = null;
      job.worker = null;
      job.error = null;
      job.lease = null;
      return this.#put(job);
    });
  }

  async remove(id) {
    const path = this.pathFor(id);
    this.writes++;
    await unlink(path);
    return { removed: id };
  }
}
