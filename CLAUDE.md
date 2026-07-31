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
```

The two below need no server, and `registration-check` needs no sensor either -
it runs on a corpus of `Registration::apply` inputs dumped by
`grabber --dump-corpus`.

```
node tools/vendor-check.mjs                          # third_party is upstream v0.2.1 + declared edits
node tools/vendor-check.mjs --mutate oracle-drift    # ... and must FAIL mutated
node tools/registration-check.mjs                    # our registration == upstream's, bit for bit
node tools/registration-check.mjs --mutate one-lsb   # ... and must FAIL mutated
```

`registration-check` builds both sides every run - a pristine upstream prefix and
ours - because a stale oracle `.dylib` turns the whole thing into a build compared
against itself and nothing about a stale library looks wrong. It exits **2** for a
build or runtime failure and **1** only when assertions fired, so a mutation that
failed to compile can never be recorded as a mutation that was caught.

`export-check` needs ffmpeg and ffprobe (`--ffmpeg`, `--ffprobe`; 8.1.1 at
`/opt/homebrew/bin`) and writes into `exports/`, which is gitignored.

`--clock` refuses a rev whose `main.js` already contains the transport, so it needs
`--before` pointing at a commit before step 1.

`--mutate <name>` serves a deliberately broken `main.js` into the running server and is
expected to exit non-zero. Both tools refuse a mutation whose text they cannot find exactly
once, because a replacement that silently matched nothing would run the unmutated page and
be recorded as the check having missed a bug it was never shown. **A mutation is a piece of
source text, so a mutation stops matching the moment the code it names is edited** — three
of `timeline-check`'s nine had to be re-anchored when step 5 rewrote the retime seam, and
the refusal is what surfaced that rather than a silent pass.

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
