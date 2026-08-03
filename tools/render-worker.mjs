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
// How often a running claim says it is still there. A flag with the shipped value as
// its default, the way `JobStore`'s constructor already takes `staleMs` defaulting to
// `STALE_MS`, so a check can drive the loop fast without the worker growing a second
// code path that only checks run down.
const BEAT_MS = Number(flag('--beat', '15000'));

if (has('--help')) {
  console.log(`usage: render-worker.mjs [--url URL] [--name NAME] [--once | --max N]
                        [--drain] [--poll MS] [--beat MS]

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

// `timeoutMs` is offered rather than applied everywhere, because the two kinds of call
// here want opposite answers. A claim or a finish report is worth waiting out - it is
// the only chance to say what happened - while a heartbeat that has not been answered
// by the time the next one is due has already failed, and the difference is not
// cosmetic: undici's default header timeout is around 300s, so a black-hole outage that
// drops packets without an RST leaves a beat hanging for minutes. The failure counter
// never moves during that, so the budget below would be counting something other than
// wall-clock seconds while its comment claimed otherwise.
const post = async (path, body, { timeoutMs = null } = {}) => {
  const res = await fetch(URL_ + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
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
  // The recorder rather than the root, which is the main menu now. This load exists
  // only to read the renderer class off a page with a WebGL context, and the menu has
  // none - a worker pointed at it would wait thirty seconds and then refuse every job
  // for a renderer it never managed to name.
  await page.goto(`${URL_}/record`, { waitUntil: 'domcontentloaded' });
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
    if (claim.status === 409 || claim.status >= 500) {
      // Work exists and none of it is ours, or the queue itself failed. Reported
      // rather than slept on: a worker that quietly polled forever would turn the
      // scheduling failure back into the silence it was designed to replace.
      console.error(`[worker] ${claim.status} from claim: ${claim.body?.error ?? '(no body)'}`);
      for (const b of claim.body?.blocked ?? []) console.error(`[worker]   ${b.id} wants ${b.wants}`);
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
    let beat = null;
    let leaseLost = false;
    // Out here with `beat` rather than inside the try, so the two teardown paths below
    // and the loop itself all stop it the same way. Three spellings of the same two
    // lines is how one of them ends up being the one that forgets to null it.
    const stopBeating = () => { if (beat) { clearInterval(beat); beat = null; } };
    try {
      // Reopened per job rather than once, because two jobs in a queue are two
      // edits and nothing says they are against the same footage. The page reloads
      // at `/edit` with the take in the query, which is the same door the editor uses.
      const takeId = await takeForHash(job.capture);
      await page.goto(`${URL_}/edit?take=${encodeURIComponent(takeId)}`, { waitUntil: 'load' });
      await page.waitForFunction(() => Boolean(globalThis.__kinect?.timeline?.transport()), null, { timeout: 60000 });
      errors.length = 0;

      // **Attest the footage and renderer before rendering.** A job names its
      // capture by content hash, so the page opened by id has to agree after load.
      // The renderer class is pinned on the claim, so the browser that renders it
      // must be the same one that claimed.
      const [actualHash, actualRenderer] = await page.evaluate(() => [
        globalThis.__kinect.library.takeHash(),
        globalThis.__kinect.export.rendererClass(),
      ]);
      if (actualHash !== job.capture) {
        throw new Error(`the opened take hashes ${actualHash.slice(0, 22)}… but the job expects ${job.capture.slice(0, 22)}…`);
      }
      if (actualRenderer !== renderer) {
        throw new Error(`the rendering browser is ${actualRenderer} but the claim was made on ${renderer}`);
      }

      // **Says it is alive while it renders, because the queue's only alternative
      // is believing a dead worker forever.** A render runs for minutes or hours
      // by design, so nothing can time a job out on duration - what the queue
      // expires is silence, and this is the noise.
      //
      // **A dropped connection is not silence, and turning one into silence is what
      // this loop used to do.** The beat was armed with a catch that cleared the
      // interval on any rejection and never re-armed it, and the only thing that can
      // reach that catch is a transport failure - a 409 is handled below, and an HTTP
      // 500 resolves with a status rather than throwing. So one `ECONNRESET` on a
      // reused keep-alive socket, one DNS hiccup, one moment of `EHOSTUNREACH` on a
      // worker pointed at a remote `--url`, and a still-rendering job went quiet for
      // the rest of its life with `leaseLost` false and the render carrying on. That
      // is not cosmetic: `JobStore.requeue` refuses a running job only while it has
      // spoken inside `STALE_MS`, on the premise that a live render would have spoken,
      // so a worker gone silent while alive removes the premise and the documented
      // rescue hands a live render to a second worker.
      //
      // So a failure is retried, and only a budget of them gives up. Seven at the
      // default 15s beat is 105s of consecutive failure against the queue's 120s
      // `STALE_MS`, which is deliberately inside it: past that the queue would accept
      // a requeue of this job anyway, so there is nothing left for a beat to keep
      // alive. Any single success resets the count, because what matters is a run of
      // failures rather than a tally of them. The beat carries a timeout of one
      // interval for the arithmetic's sake - a hung request that never rejects is not
      // a failure this counter can see, and the 105s would be a fiction.
      //
      // **Past the budget this worker is silent while it renders, which is the
      // original failure bounded rather than removed - say so rather than calling it
      // safe.** It is bounded at 105s instead of at one beat, and what it still costs
      // is the case the queue's own rescue is for: an operator requeues the job that
      // has gone quiet, a second worker claims it, and this one renders to the end for
      // an outcome that will be refused on the lease. Removing the bound entirely
      // would mean beating until a 409 says the lease is gone and aborting on it, and
      // that is a decision about whether a worker may outlive its own stale window
      // rather than a bug to fix in passing - `STALE_MS` and this budget are one
      // arithmetic and moving either without the other is what makes a worker choose
      // to be requeued underneath itself.
      const BEAT_BUDGET = 7;
      let missed = 0;
      const heartbeat = async () => {
        if (leaseLost) return;
        const res = await post(`/jobs/${job.id}/heartbeat`, { lease: job.lease }, { timeoutMs: BEAT_MS });
        if (res.status === 409) {
          // The lease is gone: the job was requeued or finished by something else.
          leaseLost = true;
          stopBeating();
          console.error(`[worker] ${job.id} heartbeat refused: ${res.body?.error ?? 'lease lost'}`);
          // **And the render stops, which takes interrupting the page from outside.**
          // `exportClip` has no cancel - adding one is a change to `web/main.js` rather
          // than to this worker - so the blunt version is to navigate the one page away,
          // which destroys the execution context and rejects the in-flight
          // `page.evaluate` into the catch below. Blunt and honest about it: the partial
          // output is lost and the GPU stops, which is the right trade for an outcome
          // the queue is going to refuse on the lease anyway. Without it the worker
          // rendered on for however long was left and threw its own time away.
          page.goto('about:blank').catch(() => { /* the page may already be gone */ });
          return;
        }
        // A 5xx did not land either, so it counts the same way a dropped socket does -
        // the record's `heartbeat` is what `requeue` reads, and it did not move.
        if (res.status !== 200) throw new Error(`the queue answered ${res.status}`);
        missed = 0;
      };
      const missedBeat = (message) => {
        missed++;
        console.error(`[worker] ${job.id} heartbeat failed (${missed}/${BEAT_BUDGET}): ${message}`);
        if (missed < BEAT_BUDGET) return;
        stopBeating();
        console.error(`[worker] ${job.id} ${BEAT_BUDGET} heartbeats failed in a row - this claim now goes quiet while it renders, and a requeue would put a second worker on it`);
      };
      // One handler for the interval and for the first beat both, so the retry policy
      // has exactly one place to be wrong and one place for a control to name.
      const beatOnce = () => { heartbeat().catch((err) => missedBeat(err.message)); };
      beat = setInterval(beatOnce, BEAT_MS);
      beat.unref?.();
      // Beaten once here rather than one interval from now. A claim used to say nothing
      // at all for its first fifteen seconds, and a job whose very first beat rejected
      // never beat at all - so the record carried a `claimed` and no `heartbeat`, which
      // is exactly the shape of a worker that died on the claim.
      beatOnce();

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
        // A job may now also carry a deliverable. If it does, the worker adopts it
        // as the active deliverable and lets `exportClip` resolve the export
        // settings from there. Older jobs carry explicit width/height/fps/codec and
        // still need to work, so those override when no deliverable is present.
        if (j.deliverable) globalThis.__kinect.library.setActiveDeliverable(j.deliverable);
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
          name: j.output,
          width: j.width,
          height: j.height,
          fps: j.fps,
          codec: j.codec,
          in: j.deliverable?.in,
          out: j.deliverable?.out,
        });
      }, job);
      if (errors.length) throw new Error(`the page errored during the render: ${errors[0]}`);
      if (!result?.output) throw new Error('the export did not return an output path');
      if (leaseLost) throw new Error('the lease was lost during the render, so the outcome is not accepted');

      // The frame count travels with the outcome so the record says how much was
      // rendered rather than only that something was. `server/export.js` refuses a
      // stream whose count differs from the one the export declared, so this is the
      // encoder's own number and a check can hold the file against it.
      // **Stopped before the report rather than after it, because the report is what
      // makes the job terminal.** A beat still in the air when `finish` lands reads the
      // job as `done` and is answered 409, which this loop now treats as a revoked lease
      // - so a completely successful render printed a "heartbeat refused" line and fired
      // the abort navigation at a page it had already finished with. Only reachable with
      // a beat interval short enough to fall inside the finish round trip, which is what
      // the check drives.
      stopBeating();
      const fin = await post(`/jobs/${job.id}/finish`, {
        state: 'done', output: result.output, frames: result?.frames ?? null, lease: job.lease,
      });
      if (fin.status !== 200) throw new Error(`the queue refused the report: ${fin.body.error}`);
      console.log(`[worker] ${job.id} done ${result.output} ${result?.frames ?? ''} frames`);
    } catch (err) {
      failed++;
      const message = String(err.message ?? err);
      stopBeating();
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
