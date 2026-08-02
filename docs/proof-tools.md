# The proof-tool suite in detail

`CLAUDE.md` carries the invocation list — what exists and how to run it. This file is what
each tool needs, what its exit codes mean, and the per-tool facts that are only worth having
when you are about to run or edit that tool.

For the method behind the suite, see `docs/instruments.md`.

## Exit codes, and why reading them is a trap

**The tools disagree about what a caught mutation exits,
the disagreement runs the dangerous way, so read the assertion count and never the code.**
Counted rather than recalled:

- **Five exit non-zero on a catch and say `NOT CAUGHT` when they miss**: `guard-check`,
  `jobs-check`, `editor-check`, `monitor-check`, `sensor-view-check`.
- **Two invert it**: `vendor-check` and `registration-check`, where caught is exit **0** with
  `caught, as required (N assertions fired)` and exit **1** is `NOT CAUGHT`. Anything gating on
  "non-zero means caught" reads a genuine miss by these two as a catch.
- **Four have no `NOT CAUGHT` branch at all** and simply exit on their failure count:
  `timeline-check`, `export-check`, `keyframe-check`, `library-check`. **A mutation these four
  fail to catch exits 0**, which reads as a clean pass rather than as the check being blind.
  That is the same direction as the inverted pair and it is silent rather than merely
  confusing, so it is the worse of the two shapes.

Which is why the rule is worded the way it is: count failed assertions, never exit codes — and
read *which* assertions fired, because a tool that counts its own crash as a failure reports a
catch it never made.

**Exit 2 means the harness did not run, or a claim went unproven.** `library-check` exits 2
when the low-space refusal could not be tested — it needs a real small filesystem and only
macOS gets one here — and the verdict line says so. Anything gating on `!== 0` therefore treats
a Linux run as not-a-pass, which is the intended reading: "some claims were not tested here"
and "a claim failed" are different answers and 1 already means the second. `registration-check`
reserves 2 on the other side of the merge, where a build or runtime failure is "the harness did
not run" rather than "the harness found something", so a mutation that failed to compile can
never be recorded as a mutation that was caught. `guard-check` and `vendor-check` use it the
same way. The convention was reached independently several times and it is one rule.

## Mutations

`--mutate <name>` serves a deliberately broken `main.js` into the running server, or for the
two vendoring tools rebuilds a deliberately broken source tree.

**Eleven tools carry mutations** — editor, export, guard, jobs, keyframe, library, monitor,
registration, sensor-view, timeline and vendor — and all of them refuse a mutation whose text
they cannot find exactly once, because a replacement that silently matched nothing would run
the unmutated page and be recorded as the check having missed a bug it was never shown.

**A mutation is a piece of source text, so a mutation stops matching the moment the code it
names is edited** — three of `timeline-check`'s nine had to be re-anchored when step 5 rewrote
the retime seam, and the refusal is what surfaced that rather than a silent pass. If you change
something a mutation anchors to, re-anchor it in the same commit and say in the message which
ones moved.

**`library-check` serves a mutated page at the URL the page is reached by, not at its
filename.** `web/library.html` has no URL of its own — `server/index.js` 404s any `.html`
under `web/` on purpose, so a page has exactly one address — and it is served at `/gallery`.
A route interception written as `**/library.html` therefore matches nothing, the unmutated
page loads, and the run is recorded as the check having missed a bug it was never shown.
That is the match-exactly-once failure arriving through the *delivery* rather than through
the anchor, where nothing refuses it, so the interception refuses a page file it has no URL
for instead.

## What each tool needs

**`determinism-check --clock`** refuses a rev whose `main.js` already contains the transport,
so it needs `--before` pointing at a commit before step 1.

**`export-check`** needs ffmpeg and ffprobe (`--ffmpeg`, `--ffprobe`; 8.1.1 at
`/opt/homebrew/bin`) and writes into `exports/`, which is gitignored.

**`keyframe-check`** runs its cheapest claim first, on a 60-second budget, and stops the run if
it fails. That is not ordering by cost: an evaluator that announces its writes schedules a seek
per frame, each of which renders a pre-roll which evaluates, so the page never answers and
never errors - it runs out of memory some minutes later, somewhere else. A bounded probe turns
that into a sentence.

**`jobs-check`** spawns its own server and renders one real job through
`tools/render-worker.mjs`, so it needs a GPU browser and ffprobe. `--no-render` drops that row
and says so - the queue rows are seconds, the render row is a minute. Its mutation runs use
`--no-render` because all five are queue semantics.

**The worker reads its renderer class out of the browser it will render in and cannot be told
one.** `channel: 'chromium'` rather than the bundled headless shell, which has no GPU and falls
back to SwiftShader - a class nothing else can reproduce, which the worker refuses outright
rather than pinning jobs to.

**`guard-check`** spawns its own servers and needs none running. It exits 2 when the machine has
no non-internal IPv4, because "not listening on the network" is only a claim if there is a
second address a client could have arrived on. Every refusal it asserts has a positive twin, so
a server that refused every upgrade, or bound to nothing, fails it rather than passing quietly.

**`library-check`** takes no `--url`; it spawns what it needs. `plant-open-take` is the mutation
worth naming beside it rather than a milder one: it is the control for the hole that let a read
route destroy the take being shot.

**It binds fixed ports** — 8210 and 8211, plus `MAC_PORT + 2/4/5` — so two worktrees running it
at once do not get an address-in-use error, they get each other's server: one run stat-ed
`three-warning-take.knct`, a fixture belonging to the other tree, and reported itself as not
finishing. Pass `--node-port`/`--mac-port` a range nothing else holds. The quieter half of that
same collision is in `docs/instruments.md`, because it fails in a way that reads as a finding.

**`editor-check` enumerates rather than lists, and it exists because the suite tested the model
and never the control.** The clip in/out markers were detached from the document during boot
for the whole life of the feature — `rebuildLanes` cleared `#tBeds` of every child that was
neither `.ruler` nor the playhead, and `#tIn`/`#tOut` were neither. Nothing caught it because
nothing looked: no proof tool referenced `#tIn`, `#tOut` or `.tcut` at all, and `export-check`
drives in/out through `activeDeliverable`, which is the model. The model was perfect throughout;
`paintTimeline` simply wrote `style.left` onto two nodes no document contained. So section 1
walks every interactive control the page renders and fails on any it has no driver for, with
`plant-unswept-control` as the control for that claim — without it, "every control was tested"
is a sentence the tool writes about itself. **Aiming its layout mutation took three attempts,
and the two misses are recorded in the file** because each was NOT CAUGHT against a build with
a fix removed: the rule they named had been made redundant by the two-row bar, which is worth
knowing about the fix as well as about the check.

Its `nav-at-the-foot` mutation is the control for section 1's second claim, that the way out of
the editor is *reachable* rather than merely present. Its own two flaws — a probe in a dead zone
and a probe that moved the page it measured — are in `docs/instruments.md`, because both are
instances of rules that were already written down.

**`vendor-check` reads the built artifact as well as the source.** Sections 1-4 prove
`third_party/` is upstream plus the declared edits; section 5 asserts the library actually
installed at `vendor/prefix` carries `LIBFREENECT2_REG_THREADS`, the env override the threading
edit introduces. Without it the check passed identically whether the grabber loaded that source
or a stale prefix built from something else - and it silently would have, because the grabber's
call passes two optional out-parameters any libfreenect2 0.2 accepts, so an old prefix links and
streams single-threaded with nothing looking wrong. The control is `--mutate stale-prefix`,
which points the assertion at `vendor/prefix-oracle` - a real library `registration-check`
builds from upstream's own registration.cpp, rather than a doctored copy of ours - and it must
FAIL. **What is still source-only is the sub-9 fix**, whose `& 0x1ff` compiles to an immediate
and leaves nothing in the binary to look for; the tool says so rather than implying it covers
both. Exit 2 where no prefix exists.

**`registration-check` builds both sides every run** - a pristine upstream prefix and ours -
because a stale oracle `.dylib` turns the whole thing into a build compared against itself and
nothing about a stale library looks wrong. It needs no sensor: it runs on a corpus of
`Registration::apply` inputs dumped by `grabber --dump-corpus`.

**`syntax-check`** needs nothing at all, and it refuses to pass on finding no files: the roots
must exist, each must yield files, and the count is printed beside the verdict so a number that
has quietly halved is visible rather than implied. It also asserts that every tool in `tools/`
is named in `CLAUDE.md`, which is why the invocation list lives there rather than here — a tool
added later is asked by existing, and the falsification control is adding a tool without
documenting it.

**`prof-summary.mjs <profile> [warmup]`** reads `grabber --profile` output and flags any run
under 29.5fps as contended, because the segment timings from a run that dropped frames are
noise. That floor belongs to a profiling run that writes nothing — see the gate paragraph in
`docs/measurement.md` before reusing it for a recording run.

**`pi-registration-ab.sh`** is the unrun runbook for measuring the threading on a capture node;
it builds both arms, checks with `ldd` that they load different libraries, and refuses to
report milliseconds from an arm that lost frames.

**`sweep-all` says "every mutation of every tool" and drives four of the eleven that carry
mutations.** Its `TOOLS` is `['library', 'timeline', 'keyframe', 'export']`, so editor, guard,
jobs, monitor, registration, sensor-view and vendor are outside the sweep a merge waits on -
and the file's own header is an argument against exactly this shape, since it takes each tool's
mutation *names* from that tool's refusal specifically so no list has to agree with anything.
The names are enumerated and the tools are not. The seven that are missing each need something
the sweep does not currently arrange - a private server, a GPU browser, a built prefix - so
wiring them is real work rather than a longer array.

## The supply-chain gate

**npm 12 is the version this repo uses.** CI installs `npm@12.0.2` explicitly in the gate job
rather than taking whatever `setup-node` bundles, because `release-gate-check` is the one thing
here whose answer depends on the npm running it.

**The gate is read out of npm's refusal, not out of its config.** npm derives its cutoff from
the age internally; npm 11.12.1 exposed the derived date through `before`, and 11.16.0 and
12.0.2 answer `null` there while enforcing the gate identically. A check reading `npm config
get before` therefore went red against a repository whose gate had never been open - bookkeeping
that had stopped tracking the resource. The check asks npm to resolve a package and reads the
cutoff out of the refusal, which is measured identical on all three versions.

**npm does not fail open on a value it cannot parse.** Measured on 11.12.1, 11.16.0 and 12.0.2:
`min-release-age=2d` warns `invalid config` and then stops with `npm error Invalid time value`,
exit 1, nothing installed. A wrong *unit* is loud. What is silent is an npm older than 11, which
does not know the key and installs ungated without a word, and a value npm accepts that nobody
meant - `0` puts the cutoff at this instant and `-1` puts it tomorrow, neither warning about
anything, which is what the tool's two bounds rows are for.

It masks the user and global config layers while it runs, and that is load-bearing rather than
tidiness: this machine carries the same gate in `~/.npmrc`, so an unmasked run inherits it and
proves nothing about the repo. Rewriting the check reproduced that exact mistake in a throwaway
probe - with the layers unmasked, the *no gate* arm came back carrying a cutoff.

## Fixtures and the registration corpus

`captures/` is gitignored; the generator is committed and the artifacts are not.

```
node tools/make-fixture.js captures/sample.knct captures/fixture-large.knct --loops 32
```

**The sample was captured on a degraded link — median gap 64ms, mean 107ms, about 9.3fps rather
than 30.** So size fixtures by *frame count*, not duration: five minutes of its source time is
1.38 GB where a real full-rate five-minute take is 4.42 GB. A fixture is the sample looped with
rewritten monotonic stamps — real depth and real JPEGs, only the u64 at payload offset 8 moves.
Say so whenever a number rests on one.

The registration corpus is gitignored like every other capture. Regenerate it with the sensor
attached, and vary the scene while it runs - a hand near the lens, a person against a far wall,
something occluding something further - because the occlusion filter only does work at depth
discontinuities:

```
./native/build/grabber --dump-corpus captures/reg-corpus --dump-count 40 --dump-every 45
```

Coverage is measurable rather than assumed: `registration-check --mutate filter-never-rejects`
reports what fraction of pixels the filter actually rejects. The committed corpus's 72 frames
sit at 6.93%; a first capture of one static-ish scene managed 6.55%.

**`captures/sample.knct` is not in the repository and a synthesised stand-in is not the
same fixture.** It is gitignored like every other capture, so a fresh clone has none, and
`library-check` needs one — every take it builds is cut out of it. A synthetic one is enough
to run the whole suite and it is worth knowing exactly which rows it cannot answer: **a
sample with no colour block fails the two decimation rows by construction** (`the colour
block is carried through untouched` and `divisor 4 lands at the ~80KB`), because those
measure a JPEG the stand-in does not contain, and a sample whose hello carries `startedAt`
fails the file-date fallback row, because the fixture depends on some takes having no wall
clock. Neither is a defect in the build. Say which sample a run used when reporting its
verdict — a run against a stand-in is 317 of 319 by construction, and reporting it as a pass
or as two failures without naming the fixture is wrong in both directions.
