#!/usr/bin/env node
// The headless worker: claim a job, render it in a real browser, report back.
//
// **It renders through the page's own export door and encodes through the
// server's own socket.** Neither is reimplemented here, and that is the point -
// `web/main.js`'s `exportClip` sizes the buffer, points the viewport at the
// program camera, takes the furniture off and streams RGBA to `server/export.js`,
// which is the only thing in this program that spawns ffmpeg. A worker with its
// own render path or its own encoder would be a second implementation of the two
// things the whole design is about, drifting from the one the editor uses.
//
// So what is actually here is small: the claim loop, opening a page, handing it a
// project, and turning what comes back into `done` or `failed`.
//
// The renderer class is read from the browser this worker will actually render in,
// never configured. A worker that could be *told* its class could be told the
// wrong one, and the pinning it feeds exists precisely because two rasterisers
// that nearly agree are the failure being guarded against.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const has = (name) => argv.includes(name);

const URL_ = flag('--url', 'http://localhost:8080');
const NAME = flag('--name', 'worker');
// How many jobs to take before exiting. `--once` is the shape a check wants and
// the shape a cron entry wants; the default drains and stops rather than looping
// forever, because a worker that never exits is a worker nobody can tell has hung.
const MAX = Number(flag('--max', has('--once') ? '1' : '16'));
const IDLE_EXIT = has('--drain');
const POLL_MS = Number(flag('--poll', '2000'));

if (has('--help')) {
  console.log(`usage: render-worker.mjs [--url URL] [--name NAME] [--once | --max N]
                        [--drain] [--poll MS]

  Claims render jobs and runs them in headless Chrome, reporting each outcome
  back to the queue. The renderer class it claims with is read out of the
  browser it will render in, so it cannot be told a class it does not have.

  --drain exits as soon as the queue has nothing for this worker, rather than
  polling. A queue holding work pinned to another renderer class is NOT nothing:
  it is reported and exits non-zero, because an idle worker beside a queue that
  never drains is the failure the class pinning exists to make visible.`);
  process.exit(0);
}

// Resolved the way every other tool here resolves it - globally installed, or
// beside a global @playwright/cli.
async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [async () => import('playwright')];
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    for (const name of ['playwright', '@playwright/cli/node_modules/playwright']) {
      candidates.push(async () => import(pathToFileURL(require.resolve(join(root, name))).href));
    }
  } catch { /* the local resolve above may still work */ }
  for (const load of candidates) {
    try {
      const mod = await load();
      const pw = mod.chromium ? mod : mod.default;
      if (pw?.chromium) return pw;
    } catch { /* try the next one */ }
  }
  throw new Error('playwright not found - install it globally or in this project');
}

const post = async (path, body) => {
  const res = await fetch(URL_ + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const { chromium } = await loadPlaywright();
// `channel: 'chromium'` and not the bundled headless shell, which has no GPU and
// falls back to SwiftShader - the software rasteriser the class guard below
// refuses. Same launch `export-check` uses, and for the same reason: a render on
// a rasteriser nothing else has is not a render of this job.
const browser = await chromium.launch({ channel: 'chromium', headless: !has('--headed') });

let claimed = 0;
let failed = 0;
let blockedExit = false;

try {
  // One page for the whole run. Opening a second live WebGL page while an export
  // is reading pixels back is what takes the renderer process down on this
  // machine, which `export-check` already carries a retry for - a worker that
  // opened a page per job would be arranging for that on purpose.
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.__kinect?.export?.rendererClass, null, { timeout: 30000 });

  const renderer = await page.evaluate(() => globalThis.__kinect.export.rendererClass());

  /**
   * A job names its capture by content hash, and the page opens a take by id, so
   * this is where one becomes the other.
   *
   * **The resolution is by hash and never by id, which is the whole reason the
   * field is a hash.** An id is a filename: two machines can hold different
   * footage under the same one, and step 7's library already reconciles exactly
   * that case. Looking up by id would render whatever happened to be called that
   * on this worker, and it would look like it worked.
   */
  const takeForHash = async (hash) => {
    const { takes = [] } = await (await fetch(`${URL_}/library/takes`)).json();
    const match = takes.find((t) => t.hash === hash);
    if (!match) {
      throw new Error(
        `no take on this worker hashes ${hash.slice(0, 22)}…, so the footage this job was authored `
        + `against is not here - ${takes.length} take(s) present and none of them is it`,
      );
    }
    return match.id;
  };
  // A software rasteriser renders something, and what it renders is not what any
  // job was authored against. Claiming with that class would pin every job it
  // touched to a rasteriser no other machine has.
  if (/swiftshader|software|llvmpipe/i.test(renderer)) {
    throw new Error(`this browser is on a software rasteriser (${renderer}), so anything it rendered would be pinned to a class nothing else can reproduce`);
  }
  console.log(`[worker] ${NAME} on ${renderer}`);

  while (claimed < MAX) {
    const claim = await post('/jobs/claim', { worker: NAME, renderer });
    if (claim.status === 409) {
      // Work exists and none of it is ours. Reported rather than slept on: this is
      // the scheduling failure the class pinning exists to surface, and a worker
      // that quietly polled forever would turn it back into the silence it was
      // designed to replace.
      console.error(`[worker] ${claim.body.error}`);
      for (const b of claim.body.blocked ?? []) console.error(`[worker]   ${b.id} wants ${b.wants}`);
      blockedExit = true;
      break;
    }
    if (!claim.body.job) {
      if (IDLE_EXIT) { console.log('[worker] queue empty, draining out'); break; }
      await new Promise((r) => { setTimeout(r, POLL_MS); });
      continue;
    }

    const job = claim.body.job;
    claimed++;
    console.log(`[worker] ${job.id} ${job.width}x${job.height} @${job.fps} -> ${job.output}`);
    errors.length = 0;
    try {
      // Reopened per job rather than once, because two jobs in a queue are two
      // edits and nothing says they are against the same footage. The page reloads
      // with the take in the query, which is the same door the editor uses.
      const takeId = await takeForHash(job.capture);
      await page.goto(`${URL_}/?take=${encodeURIComponent(takeId)}`, { waitUntil: 'load' });
      await page.waitForFunction(() => Boolean(globalThis.__kinect?.timeline?.transport()), null, { timeout: 60000 });
      errors.length = 0;
      // The project travels *in the job* rather than by name. That is what makes a
      // job self-contained: a name would resolve to whatever is in the store when
      // the worker gets round to it, which is the opposite of reproducing an edit.
      const result = await page.evaluate(async (j) => {
        // `restoreProject` rather than `loadProject`: the second fetches by name
        // from the store, and a job carries its document precisely so it does not
        // depend on what the store holds by the time a worker reaches it. The job
        // carries the body, which the queue checks at enqueue - so this hands over
        // exactly one shape rather than guessing between two.
        globalThis.__kinect.library.restoreProject(j.project);
        // **Settled before exporting, or the restore's own repaint lands inside
        // the export's first seek.** `ExportTransport` counts how many times each
        // program position reaches the sink and throws on anything but one,
        // because an export of the same image repeated is the failure that looks
        // most like a success - and a repaint this worker caused, arriving late,
        // is counted as one of those reaches. It showed up as
        // `the render at 0.000000s reached the export 2 times`, on some runs and
        // not others, which is exactly what a race between a scheduled repaint and
        // the first seek looks like from outside. The page has this for the
        // purpose; the editor never hit it because a person does not restore a
        // project and press export in the same task.
        // **Then a seek, because `restoreProject` on its own leaves the transport
        // where it was rather than where the restored document says.** The
        // editor's own load path does exactly this - `loadProjectNamed` restores
        // and then seeks to `timeline.programSec` - and a worker that restored
        // without it went straight into the export with the playhead and the
        // document disagreeing. `ExportTransport`'s first frame is the only one
        // that seeks, and it counted two reaches at 0.000000s on roughly one run
        // in three. Awaiting `settled()` alone narrowed nothing, which is the tell
        // that the extra render was the seek reconciling state rather than a
        // stray repaint.
        const transport = globalThis.__kinect.timeline.transport();
        await transport.seek(transport.programSec);
        await globalThis.__kinect.timeline.settled();
        return globalThis.__kinect.export.run({
          name: j.output, width: j.width, height: j.height, fps: j.fps, codec: j.codec,
        });
      }, job);
      if (errors.length) throw new Error(`the page errored during the render: ${errors[0]}`);
      // The frame count travels with the outcome so the record says how much was
      // rendered rather than only that something was. `server/export.js` refuses a
      // stream whose count differs from the one the export declared, so this is the
      // encoder's own number and a check can hold the file against it.
      const fin = await post(`/jobs/${job.id}/finish`, {
        state: 'done', output: result?.output ?? job.output, frames: result?.frames ?? null, lease: job.lease,
      });
      if (fin.status !== 200) throw new Error(`the queue refused the report: ${fin.body.error}`);
      console.log(`[worker] ${job.id} done ${result?.output ?? ''} ${result?.frames ?? ''} frames`);
    } catch (err) {
      failed++;
      const message = String(err.message ?? err);
      console.error(`[worker] ${job.id} failed: ${message}`);
      // Reported, not swallowed. A job left `running` by a worker that walked away
      // is the state nothing can tell from a job still being rendered.
      await post(`/jobs/${job.id}/finish`, { state: 'failed', error: message, lease: job.lease }).catch(() => {});
    }
  }
} finally {
  await browser.close();
}

console.log(`[worker] ${claimed} claimed, ${failed} failed`);
// Three outcomes rather than two: nothing to do, work done, and work that exists
// for somebody else. The last one is not success.
if (blockedExit) process.exit(2);
process.exit(failed ? 1 : 0);
