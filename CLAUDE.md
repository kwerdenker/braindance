# Working in this repo

`docs/recording-and-nle.md` is the canonical design and it is long (~1590 lines) with the
build order at the end. Read it before implementing anything, and re-read it after a
compaction. Its decisions are settled — if reality contradicts it, **report the
contradiction rather than silently redesigning**. That has happened, and reporting was the
right move each time.

## Measurement culture

This repo measures rather than reasons. Several inherited estimates in these docs turned out
~40% wrong when finally profiled, and the docs record the corrections.

- **"This should be faster" is not evidence.** Measure it.
- **Interleaved A/B, never sequential before/after.** A sequential comparison on this rig
  once produced a 23% figure that was really 12.9%.
- **State the method with every number**: window length, sample count, warmup discarded, and
  whether the page cache was warm.
- **Proxy evidence does not close a user-visible change.** Drive the real UI with
  `playwright-cli` and show it working. A passing unit test is not a rendered frame.
- **Read a health number the measurement itself reports, and throw the run away when
  it is wrong.** Delivered fps is that number for anything using the grabber: the
  loop idles 55% of every interval, so a run that does not sustain ~30.0 was
  competing for the machine and its per-segment timings are noise. A threading A/B
  came back 22.75fps with registration p50 swinging 11.50/13.65/8.30ms across three
  rounds of one arm, which reads as a wildly variable optimisation and was actually
  Spotlight - `mds_stores` at 45% indexing the 280MB corpus and the build trees the
  session had just created. `captures/` and `vendor/` now carry
  `.metadata_never_index`. Re-run on a settled machine and the same comparison was
  flat: all six arms 30.03-30.04fps, all three paired deltas the same sign.

### A tight loop cannot measure an allocation

Two arms that both hit the allocator back to back are not an A/B of allocation
cost. `Registration::apply` new/deletes 9.2MB per call, and measured offline by
applying one frame five times in a row, hoisting those buffers came out *slower*
in all three paired rounds - because the allocator hands the same block straight
back and the baseline arm was already effectively persistent, leaving buffer
alignment as the only real variable. On the real loop, where 33ms and a JPEG
encode sit between calls, the same change is worth 0.30ms of 5.71ms. **An offline
harness is for correctness; `grabber --profile` on the sensor is for cost** - and a
screening measurement that removes the effect will confidently report its absence.

### An instrument must enforce its claims, not assert them

This is the failure mode this repo keeps producing, so check for it by name. Twice now a
proof tool has stated a condition in its header while doing nothing to bring it about:

- `determinism-check --clock` claimed "no frame ever arriving" but left the socket to
  whatever the server was doing, and returned FAIL/PASS/PASS on an unchanged tree.
- `index-check` claimed the scan never holds the file, while an implementation that appended
  every chunk to an array would have passed every assertion it made.

Both are fixed and both now enforce the condition — the first intercepts the socket and
*verifies the interception held*, the second asserts resident memory against a ceiling and a
growth bound. When you write a proof tool, ask what a broken implementation would have to do
to still pass it, and close that. **Every proof tool needs a falsification control**:
something that must FAIL if the thing under test were not actually doing the work.

### Mutation-test the instrument, don't just reason about it

Deliberately break the thing under test, run the check, and confirm it fails on the
assertions it should. This is the method that turns the rule above from an intention into a
result, and it has now caught two flaws that reading the code did not:

- A serialisation check whose `||` clause let it pass on key count alone.
- A malformed-value table that passed its cases into the page through `JSON.stringify` —
  which turns `NaN` and `undefined` into `null`, so three cases labelled as NaN were silently
  testing null a second and third time. **If you send test values into a browser, send them
  as source, not as JSON**, or your labels will claim coverage you do not have.

Report which mutations you ran and what each one caught. A check nobody has broken on purpose
is a check nobody knows the sensitivity of.

**A mutation that does nothing reads as a check that found nothing.** Step 5 produced one:
a mutation meant to draw editor furniture into the rendered frame reached for `gl.scissor`
and `gl.clear` directly, which three's own state cache overrode, so the pixels never changed
and the check reported a clean pass. Rewritten through `renderer.setScissor` it fails at
`max 189/255`. **Before believing a mutation was missed, confirm the mutation did something** -
have it move a number the check already prints, or the verdict is about the mutation rather
than about the check.

**And the converse, which is worse, because it reads as coverage: before believing a mutation
was *caught*, confirm it was caught for the reason claimed.** Step 7 built a plant for the
route sweep - a read route that writes a document and puts it back inside the same request,
which a before-and-after comparison of the contents cannot see by construction, since both
readings are taken outside the request. It failed two rows, and one of them was the contents
comparison it was written to walk past. The reason had nothing to do with the property under
test: APFS keeps modification times to the nanosecond, `utimesSync` takes a `Date` carrying
milliseconds, and the 0.13ms the restore could not put back is what failed the row -
`1785523816453.8726` against `1785523816454`. On a filesystem with coarser stamps the identical
plant walks straight through, so the control was asserting the platform rather than the design,
while looking exactly like a control that works. **This was found by measuring, not by reading**
- the mutation was run and the two snapshots diffed field by field, which is the only thing that
distinguishes a row that went red for its own reason from one that went red for a neighbouring
one. The fix was to rebuild the plant so nothing about it depends on the filesystem:
write-then-remove touches nothing that survives, leaves the listing identical, and moves only
the monotonic write count. It now fails that one row and leaves the contents row passing, which
is what makes the count load-bearing rather than a second way of saying the same thing.

**A mutation run that exits non-zero with zero failed assertions did not run.** Both tools
refuse a mutation whose anchor text they cannot find, and Playwright occasionally dies with
`Execution context was destroyed` partway through a run - and all three outcomes exit 1,
which reads as a caught mutation to anything checking only the exit code. Seen twice on step
5, on two different mutations in two different suite runs. **Count failed assertions, not
exit codes**, and treat `fails=0` as a crash to investigate rather than a success to record.

**A cumulative table hides which term is wrong.** Step 6 measured the look at two
output sizes down one pipeline - points, then trails, then "grade" - and reverting
any single grade term moved that row by less than the row's own sampling residual,
so three mutations passed. One row per term fixed it: `rgbsplit-absolute` now fails
the rgbsplit row and leaves the grain and scanline rows alone, which is a check
saying *what* broke rather than *that* something did.

**Three of step 6's probes were also standing in dead zones**, each for its own
reason, and each was found by mutation rather than by reading. The additive
normalisation is clamped to 1 beyond 0.83m, so at the default framing a mutation of
it changed nothing at all - the probe needed a camera inside the cloud. Grain at the
preset's 0.22 is about one part in 255, so reverting its reference grid moved every
number by 4% - the probe needed the slider at full. And an export at the editor's
own buffer size cannot tell an output size that reached the renderer from one that
did not - that probe needed a size the editor is not.

**Close the class, not the instance — and have the check enumerate it.** A review of step 7
found six HTTP routes that changed something while dispatching on the path alone, one at a
time, which makes six a floor rather than a total. Fixing them individually would have left
the next route anybody adds outside the list. The routes are now one table that *is* the
dispatch, served at `/library/routes`, and `library-check` walks it: every route with a write
handler is asked for its method, its content type and its origin, so a route added later is
asked by existing. Enumerating turned up four mutating routes the individual poking missed -
`/library/delete/:id`, `/library/sync-marks/:id`, `/record/mark` and `/presets/:name`, ten
against six. **The falsification control has to be a mutation that adds a mutating route
without registering it** — and for one round this paragraph said so while the suite had
no such mutation. What it had was `stop-route-reads`, which *moves* `/record/stop`'s
handler into the `read` slot, caught by a hardcoded floor on the route counts
(`mutating.length >= 10 && writeOnly.length >= 7`). Moving a route drops both counts and
trips the floor; **adding** one moves neither in the failing direction, so the floor was
blind by construction to the shape this paragraph names. A planted read route writing a
project passed the whole suite at 241 of 241, exit 0, with its file on disk afterwards.
`read-route-writes` is the control now, and what catches it is a snapshot of every store
rather than a count of registered routes — because a count cannot answer "did a read
handler mutate something".

**Two agreements made that sweep blind, and both are the same question as step 6's
aspect ratio.** The shooting server was spawned with **no `--projects` and no
`--presets`**, so three of the library's five stores sat outside the one directory being
snapshotted — which is the mechanical reason the plant was invisible. And the
**recording** take's id was substituted into every `:id`, where `beingRecorded` answers
409 before the handler runs: five capture routes were driven and never executed, counted
as swept and not swept. The sweep now drives an open take and a closed one, GET and HEAD,
document names that exist and names that do not, and asserts by name that every route got
past the 409 — with any route it cannot build a concrete URL for named rather than
silently driven at a URL still carrying a literal `:foo`.

**Assert against the resource, not against the bookkeeping that claims to track it.**
`/library/descriptors` reported `openCaptures.size`, and the bug underneath it dropped the map
entry while leaving the `FileHandle` open - so the number *fell* while the real count rose, and
an arm reading it watched a descriptor leak and recorded a descriptor being released, 0 against
a real 2. It reports `readdirSync('/dev/fd').length` beside it now and the arm asserts on that.
The same question is worth asking of any count a proof tool reads back from the thing under
test.

**`p.x.__proto__ = v` in a probe is not what a file on disk does.** Assignment invokes the
`__proto__` setter and creates no own property at all, so `Object.entries` never sees it and
the document handed to the loader is unchanged - two rows labelled `__proto__` passed against
a build that accepted `__proto__`, because the probe never contained one. `JSON.parse` and
`Object.defineProperty` both create the own, enumerable property that a real file produces.
This is the mirror of the `JSON.stringify` trap already recorded above: values sent as source
survive, except this one key, where source is the shape that does not.

**A mean absolute difference cannot see noise that moved.** Grain that has shifted
is as different from grain that has not as grain that has thinned, so both grade
mutations survived every difference-based threshold the sampling residual left room
for. What catches them is a correlation: high-pass both images and correlate, and a
structure quantised onto a shared reference grid correlates 0.94 where a continuously
sampled one correlates 0.77.

**Playwright drops the page's execution context here, and it is not the code.** A
second live WebGL page while an export is reading pixels back will sometimes take
the renderer process down, and it arrives as `Execution context was destroyed` -
with the server log showing the export it happened during completing normally, all
frames present. `export-check` runs one browser at a time and retries that specific
error up to three times, printing the retry count; anything else propagates on the
first attempt, because a check that retried real failures would report whichever
attempt it liked.

**`page.evaluate(fnSourceString, arg)` does not call the function.** Playwright
evaluates the string as an expression, so the arrow function is created, never
invoked, and `undefined` comes back - which surfaced three helpers later as a
missing shot rather than as a call that did not happen. The house pattern is
`page.evaluate(\`(${FN})(${JSON.stringify(opts)})\`)`, and it is what the other
tools already do.

**Place a probe where its answer would be different, not where it is convenient.** A third
flaw came out of this on step 5: a mutation replacing the pre-roll's window query with the
tangent it replaced was caught by only one of five probe positions, because four of them sat
inside a single straight segment of the retime curve where the tangent *is* the curve. The
probes were moved onto the knees and onto an eased ramp and the same mutation now fails four.
Ask what the wrong implementation would agree with, and probe somewhere it cannot.

**A probe that changes the state it samples proves whatever it did to it.** This is a
distinct failure from the two above - not a probe in a dead zone and not a vacuous
assertion, but an observer effect inside the instrument, and it is easy to write because
the sampling call looks passive. Step 7's recorder check waited for takes by polling the
library, then asserted each closed take held all the frames its writer emitted. Listing
the library scans every capture in the directory *including the one still being written*,
and the scan writes a sidecar - so "does a sidecar exist" stopped meaning "the take is
finished" the moment something asked the question, and the take that was mid-recording
was counted against a total it was never going to reach. It came in at 10 frames and at
11 on two runs, which is the burst plus however long the last poll took, and it fired on
four unrelated mutations before it was pinned - a check red for reasons that have nothing
to do with what is under test, which is how a gating check teaches people to re-run until
green. The fix was to take "closed" from the writer's own log rather than from an artifact
the reader creates. **Before polling for a condition, ask what the polling call itself
writes, opens or caches** - anything that lists, scans or indexes a directory something
else is writing is a candidate.

**When one probe turns out to be blind to something, ask what all of them are blind to
together.** Step 6 got the first half of this right and stopped one question short, which is
why it is a rule rather than a note. Its commit reasons that `pointsize-absolute` passes the
1728x1080 arm because the scale factor is exactly 1 there, and keeps a second arm at
1920x1200 for that reason - correct, and it never asked what every arm agreed about at once.
The answer was the aspect ratio. Every arm in `export-check` was 1.6 - 960x600, 1920x1200,
1728x1080, the 640x400 stage - and at 1.6 `bufferWidth / 1728` and `bufferHeight / 1080` are
not close but *identical*, so a build referencing the width was bit-identical on every arm
and would have passed all 30 assertions while drawing 11.1% too large on every size the
export menu offers. A set of probes that agree about a quantity cannot measure it however
many of them there are, and the agreement is invisible precisely because each arm confirms
the others. **The tell was there to be read: the values the instrument tested were not the
values the product ships** - four sizes in the menu, all 16:9, and not one of them in the
check. Compare the constants a tool sweeps against the constants the UI offers, and treat a
disjoint pair as a hole until measured otherwise. The fix was one cross-build arm at
1920x1080 and a `scale-by-width` mutation, which now fails that row and leaves every other
assertion in the file passing.

**That rule has a second form, and it hides better: not every arm agreeing about one
quantity, but every observation of a single *object* switched off at once, each for its own
locally defensible reason.** Step 7's route sweep watched five stores, a write counter and the
recorder's own state, and a read route appending 64KB to the take being recorded passed all
251 assertions at exit 0 — leaving nine 4096-byte runs of 0x07 in the file and
`stream desync at 6349028: expected magic KNCT, got 0x7070707` when it finally closed. Three
decisions assembled into that hole and every one of them is right on its own: the open take's
size and modification time are excluded from the snapshot **by name**, because they move on
their own and comparing them would flake; no write counter covers the captures directory,
because the counters were built for the document stores; and the recorder's state field tracks
the recorder rather than the file, which is what it is for. Reading any one of them finds
nothing wrong. **The file they all skipped was the take being shot** — the most valuable thing
in the system, excluded on purpose, for a good reason.

So ask the question in both directions. Not only "what do my arms agree about", but **"is there
an object here that every observation happens to skip"** — and be most suspicious where the
skipping was deliberate, because a deliberate exclusion comes with a justification that stops
anybody looking twice. The fix was to assert the identity `bytes === on-disk size` after the
take closes, where nothing is in flight and it is exact, with `plant-open-take` as the control.

## Proof tools

Each takes a running server and exits non-zero on failure.

```
node tools/determinism-check.mjs                    # step 1: same program time, same image
node tools/determinism-check.mjs --clock --before HEAD~1
node tools/index-check.mjs --url http://localhost:8123   # step 2: index, hash, frame API
node tools/registry-check.mjs --url http://localhost:8080 # step 3: one registry, sliders as views
node tools/timeline-check.mjs --url http://localhost:8080 # step 4: seek equals playback
node tools/timeline-check.mjs --mutate preroll-constant   # ... and must FAIL mutated
node tools/keyframe-check.mjs --url http://localhost:8080 # step 5: tracks, retime curve, undo
node tools/keyframe-check.mjs --mutate pose-linear        # ... and must FAIL mutated
node tools/export-check.mjs --url http://localhost:8080   # step 6: resolution, export, the file
node tools/export-check.mjs --mutate pointsize-absolute   # ... and must FAIL mutated
node tools/library-check.mjs --url http://localhost:8080  # step 7: library, recorder, routes
node tools/library-check.mjs --mutate plant-open-take     # ... and must FAIL mutated
node tools/guard-check.mjs                                # the socket's origin rule, and the bind
node tools/guard-check.mjs --mutate upgrade-skips-origin  # ... and must FAIL mutated
```

`guard-check` spawns its own servers and needs none running. It exits **2** when the
machine has no non-internal IPv4, because "not listening on the network" is only a
claim if there is a second address a client could have arrived on - the same reading
as `library-check`'s low-space row. Every refusal it asserts has a positive twin, so
a server that refused every upgrade, or bound to nothing, fails it rather than
passing quietly.

`library-check` had no invocation line at all until this merge, while being referenced
twice below it — so the list taught a six-tool sweep where there are seven. `plant-open-take`
is the right mutation to name here rather than a milder one: it is the control for the hole
that let a read route destroy the take being shot.

The two below need no server, and `registration-check` needs no sensor either -
it runs on a corpus of `Registration::apply` inputs dumped by
`grabber --dump-corpus`.

```
node tools/vendor-check.mjs                          # third_party is upstream v0.2.1 + declared edits
node tools/vendor-check.mjs --mutate oracle-drift    # ... and must FAIL mutated
node tools/registration-check.mjs                    # our registration == upstream's, bit for bit
node tools/registration-check.mjs --mutate one-lsb   # ... and must FAIL mutated
```

**`vendor-check` reads the built artifact as well as the source, and that closes most
of the gap it landed with.** Sections 1-4 prove `third_party/` is upstream plus the
declared edits; section 5 asserts the library actually installed at `vendor/prefix`
carries `LIBFREENECT2_REG_THREADS`, the env override the threading edit introduces.
Without it the check passed identically whether the grabber loaded that source or a
stale prefix built from something else - and it silently would have, because the
grabber's call passes two optional out-parameters any libfreenect2 0.2 accepts, so an
old prefix links and streams single-threaded with nothing looking wrong. The control
is `--mutate stale-prefix`, which points the assertion at `vendor/prefix-oracle` -
a real library registration-check builds from upstream's own registration.cpp, rather
than a doctored copy of ours - and it must FAIL. **What is still source-only is the
sub-9 fix**, whose `& 0x1ff` compiles to an immediate and leaves nothing in the binary
to look for; the tool says so rather than implying it covers both. Exit **2** where no
prefix exists, on the same reading as `library-check`'s: untested is not passed.

`registration-check` builds both sides every run - a pristine upstream prefix and
ours - because a stale oracle `.dylib` turns the whole thing into a build compared
against itself and nothing about a stale library looks wrong. It exits **2** for a
build or runtime failure and **1** only when assertions fired, so a mutation that
failed to compile can never be recorded as a mutation that was caught.

`tools/prof-summary.mjs <profile> [warmup]` reads `grabber --profile` output and
flags any run under 29.5fps as contended, because the segment timings from a run
that dropped frames are noise. `tools/pi-registration-ab.sh` is the unrun runbook
for measuring the threading on a capture node; it builds both arms, checks with
`ldd` that they load different libraries, and refuses to report milliseconds from
an arm that lost frames.

The registration corpus is gitignored like every other capture. Regenerate it with
the sensor attached, and vary the scene while it runs - a hand near the lens, a
person against a far wall, something occluding something further - because the
occlusion filter only does work at depth discontinuities:

```
./native/build/grabber --dump-corpus captures/reg-corpus --dump-count 40 --dump-every 45
```

Coverage is measurable rather than assumed: `registration-check --mutate
filter-never-rejects` reports what fraction of pixels the filter actually
rejects. The committed corpus's 72 frames sit at 6.93%; a first capture of one
static-ish scene managed 6.55%.

`export-check` needs ffmpeg and ffprobe (`--ffmpeg`, `--ffprobe`; 8.1.1 at
`/opt/homebrew/bin`) and writes into `exports/`, which is gitignored.

`--clock` refuses a rev whose `main.js` already contains the transport, so it needs
`--before` pointing at a commit before step 1.

`library-check` exits **2**, not 0, when a claim went unproven - the low-space refusal needs a
real small filesystem and only macOS gets one here. The verdict line says so too. Anything
gating on `!== 0` therefore treats a Linux run as not-a-pass, which is the intended reading:
"some claims were not tested here" and "a claim failed" are different answers and 1 already
means the second. `registration-check` reserves 2 for the same reason on the other side of
the merge — a build or runtime failure there is "the harness did not run", not "the harness
found something" — so the convention was reached twice independently and the two paragraphs
are describing one rule rather than two.

`--mutate <name>` serves a deliberately broken `main.js` into the running server, or for the
two vendoring tools rebuilds a deliberately broken source tree. All six refuse a mutation
whose text they cannot find exactly once, because a replacement that silently matched nothing
would run the unmutated page and be recorded as the check having missed a bug it was never
shown. **A mutation is a piece of source text, so a mutation stops matching the moment the
code it names is edited** — three of `timeline-check`'s nine had to be re-anchored when step 5
rewrote the retime seam, and the refusal is what surfaced that rather than a silent pass.

**The two sides disagree about what a caught mutation exits, and the disagreement runs the
dangerous way, so read the assertion count and never the code.** The four server tools exit
non-zero when they catch one. `vendor-check` and `registration-check` invert it — caught is
exit **0** with `caught, as required (N assertions fired)`, and exit **1** is `NOT CAUGHT`,
the case that actually matters. So anything gating on "non-zero means caught" reads a genuine
miss by the newer tools as a catch, which is the one direction that cannot be allowed to fail
quietly. This is why the rule is worded the way it is: count failed assertions, never exit
codes.

`keyframe-check` runs its cheapest claim first, on a 60-second budget, and stops the run if
it fails. That is not ordering by cost: an evaluator that announces its writes schedules a
seek per frame, each of which renders a pre-roll which evaluates, so the page never answers
and never errors - it runs out of memory some minutes later, somewhere else. A bounded probe
turns that into a sentence.

## Fixtures

`captures/` is gitignored; the generator is committed and the artifacts are not.

```
node tools/make-fixture.js captures/sample.knct captures/fixture-large.knct --loops 32
```

**The sample was captured on a degraded link — median gap 64ms, mean 107ms, about 9.3fps
rather than 30.** So size fixtures by *frame count*, not duration: five minutes of its source
time is 1.38 GB where a real full-rate five-minute take is 4.42 GB. A fixture is the sample
looped with rewritten monotonic stamps — real depth and real JPEGs, only the u64 at payload
offset 8 moves. Say so whenever a number rests on one.

## The Mac's USB topology reads worse than it measures

`ioreg -p IOUSB -w0` shows the sensor as controller -> `USB3.0 Hub` -> `NuiSensor
Adaptor` -> `Xbox NUI Sensor`, with a gigabit ethernet adapter on that same hub.
Against the README's "1 hub, own controller" that looks like the degraded
topology which measures 12.82fps, and it is not - **this rig sustains 30.02fps
with 2 subsequence warnings in 1921 frames.** The `USB3.0 Hub` is a good
high-speed one and the count is not the thing that matters.

Note also that `system_profiler SPUSBDataType` returns *nothing at all* on this
machine, so a check built on it reads as "no Kinect attached" whether one is
attached or not. Use `ioreg`. And settle the question by running the grabber and
reading delivered fps rather than by counting boxes in a tree.

## Two things that are easy to get backwards

**`nearClip`/`farClip` versus `--min-depth`/`--max-depth`.** The first pair are viewer
uniforms that hide points which already arrived. The second pair are grabber flags that clip
on the GPU before the frame is built, so they decide what exists at all. The recorder's
preview range drives the first and **must never reach the second** — getting it backwards
silently destroys footage in the one situation where nobody is watching for it.

**`fs.readFileSync` throws above 2 GiB** (`ERR_FS_FILE_TOO_LARGE`; 2,147,483,647 reads,
2,147,483,648 throws). Anything that reads a capture streams. `server/capture.js` is the only
thing that should be touching capture bytes.

## Conventions

- **No emojis in debug or console messages.**
- **One implementation only.** No legacy path left beside a new one, no compatibility flag to
  switch between them — a second path that drifts is the failure this design keeps rejecting.
- Comments explain *why*, usually by naming the failure mode being avoided, in flowing prose.
  Match the density and voice already in the file.
- Commits: imperative subject, then a body explaining the why and carrying the measurements
  with their methods.
- **`pointSize` is pixels at 1080p.** Step 6 made every screen-space term relative to a
  1080p reference, and that rebased both presets and the registry default by 1080/600 -
  the 600 being the buffer the look was graded against. `registry-check` asserts the
  factor rather than skipping the value, so a preset re-tuned by hand to something near
  it fails. A project saved before that change needs its point size scaled by the buffer
  height it was authored at.
- **1080p is the unit; 600 is the graded chain, and both numbers are correct.** Every
  screen-space term is *expressed* against a 1080p reference - that is what `pointSize`,
  the grade's frequencies and the split's offset are all in. Bloom is the one term with
  no parameter to express, because its width lives in a tap count baked into three's
  shaders, so instead its mip chain is *frozen* at what the old code produced at the
  600-tall buffer the look was authored on (`resize` calls `setSize(aspect * 300, 300)`).
  Freezing it at 1080 makes it constant across output sizes and 1.8x too tight, which is
  a look nobody graded. Same reference, two ways of holding it.

  **Two references are in play and they are not the same thing, so do not reconcile them.**
  1080p is the *unit* every screen-space term is expressed in — a value means the pixels it
  would draw at 1080p, so `k = drawingBufferHeight / 1080` scales it wherever the frame
  actually lands. 600 is the *graded chain*: bloom's mip chain is frozen at what the old
  build produced at a 600-tall buffer, because `UnrealBloomPass` bakes a fixed tap count in
  at construction, so its halo's width is a tap count over a texel count and freezing the
  chain anywhere else changes the glow rather than preserving it. Both were measured — a
  1080-frozen chain lands 7.16/255 on the worst of forty tile means against the graded look,
  where the 600-frozen one lands 1.10. So `main.js` correctly reads `bufferHeight / 1080.0`
  in the shaders and `(buf.x / buf.y) * 600` at `bloom.setSize`, and neither is a typo for
  the other.

## Process hygiene

Kill only your own listener, and **by PID resolved as a listener**:

```
for p in $(lsof -ti tcp:8080 -sTCP:LISTEN); do kill "$p"; done
```

A bare `lsof -ti tcp:8080` also matches processes *connected to* the port, and `pkill -f`
matches the shell running your own command.
