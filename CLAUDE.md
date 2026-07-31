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

**Place a probe where its answer would be different, not where it is convenient.** A third
flaw came out of this on step 5: a mutation replacing the pre-roll's window query with the
tangent it replaced was caught by only one of five probe positions, because four of them sat
inside a single straight segment of the retime curve where the tangent *is* the curve. The
probes were moved onto the knees and onto an eased ramp and the same mutation now fails four.
Ask what the wrong implementation would agree with, and probe somewhere it cannot.

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
```

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
- Don't tune look values before step 6. `pointSize` changes meaning when screen-space terms
  go resolution-relative, so anything tuned earlier is invalidated.

## Process hygiene

Kill only your own listener, and **by PID resolved as a listener**:

```
for p in $(lsof -ti tcp:8080 -sTCP:LISTEN); do kill "$p"; done
```

A bare `lsof -ti tcp:8080` also matches processes *connected to* the port, and `pkill -f`
matches the shell running your own command.
