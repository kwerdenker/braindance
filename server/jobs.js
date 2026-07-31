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
    // Same counter the document stores keep, for the same reason: a handler that
    // writes a job and puts the bytes back is invisible to a before-and-after
    // reading of the contents, and this is the quantity no restore can undo.
    this.writes = 0;
  }

  pathFor(id) {
    if (!VALID_JOB_ID.test(id)) throw new Error(`unusable job id ${JSON.stringify(id)}`);
    return join(this.dir, `${id}.json`);
  }

  // Content-addressed off the record itself, so two enqueues of the same edit at
  // the same millisecond cannot collide, and an id carries nothing a path parser
  // could act on.
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
    const created = this.now();
    const body = {
      version: JOB_VERSION,
      project,
      capture,
      renderer: renderer ?? null,
      output: String(output ?? ''),
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
    };
    const job = { id: this.idFor({ ...body, created }), ...body };
    return this.#put(job);
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
  async claim({ worker, renderer }) {
    if (!renderer) throw new Error('a worker claims with the renderer class it will render on');
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
    // Stamped on the claim, not on completion. A job that dies mid-render has still
    // told us which class of machine it was attempted on, and that is the provenance
    // the field exists for.
    job.renderer = renderer;
    await this.#put(job);
    return { job, blocked: [], queued: all.length };
  }

  /** Report an outcome. A job that already finished is refused rather than rewritten. */
  async finish(id, { state, error = null, output = null }) {
    if (state !== 'done' && state !== 'failed') throw new Error(`a job finishes done or failed, not ${state}`);
    const job = await this.read(id);
    if (isTerminal(job.state)) {
      throw new Error(`job ${id} is already ${job.state}, so this report is from a worker that lost a race`);
    }
    job.state = state;
    job.error = error;
    job.finished = this.now();
    if (output) job.output = output;
    return this.#put(job);
  }

  /**
   * Put a finished-or-running job back on the queue.
   *
   * The renderer stays pinned, which is the point: a retry of a job that has been
   * rendered once has to land on the same class of machine or it is not a retry,
   * it is a different render of the same edit.
   */
  async requeue(id) {
    const job = await this.read(id);
    job.state = 'queued';
    job.claimed = null;
    job.finished = null;
    job.worker = null;
    job.error = null;
    return this.#put(job);
  }

  async remove(id) {
    const path = this.pathFor(id);
    this.writes++;
    await unlink(path);
    return { removed: id };
  }
}
