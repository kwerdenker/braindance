# Taking a number in this repo

Read this before reporting a measurement. It is the case file behind the short rules in
`CLAUDE.md`: how a number gets taken here, which runs get thrown away, and the two pieces
of hardware whose behaviour reads differently from how it measures.

The seam against its two neighbours: **this file is about a number you would report.**
`docs/instruments.md` is about a check that must fail when the thing under test is broken,
and `docs/performance.md` is the numbers already taken, which this file says how to take.

## Read a health number the measurement itself reports, and throw the run away when it is wrong

Delivered fps is that number for anything using the grabber: the loop idles 55% of every
interval, so a run that does not sustain ~30.0 was competing for the machine and its
per-segment timings are noise.

A threading A/B came back 22.75fps with registration p50 swinging 11.50/13.65/8.30ms across
three rounds of one arm, which reads as a wildly variable optimisation and was actually
Spotlight - `mds_stores` at 45% indexing the 280MB corpus and the build trees the session had
just created. `captures/` and `vendor/` now carry `.metadata_never_index`. Re-run on a settled
machine and the same comparison was flat: all six arms 30.03-30.04fps, all three paired deltas
the same sign.

## A driver paced off the page measures the driver

The browser half of this rig has its own version of the health-number rule, and it bites in
the opposite direction: the instrument is not thrown off by the machine, it is *carried along*
by the thing it is measuring.

Chasing the paused orbit drag, the first probe drove 60 pointer moves through Playwright with
`await page.evaluate('new Promise(requestAnimationFrame)')` between them, and divided the moves
by the elapsed 15.1 seconds to report 4 frames a second. That number is the driver's pacing,
not the page's rate: `page.mouse.move` does not return until the page has processed the event,
so a saturated main thread slows the driver by exactly as much as it slows itself, and the
quotient says more about the round trip than about the browser. Counting the page's own
animation frames over the same drag gave 12.4/s, with a 10.0-18.1 spread across five rounds.

**So install the counter in the page** — `globalThis.__orbitFrames` incremented from a
`requestAnimationFrame` chain — and read a delta around the gesture. That is what the editor's
section 9 does and why it does it: `tools/editor-check.mjs` installs the chain before the drag
and reads the count back beside `navigationRedraws`, so grep that identifier for a working copy
rather than writing a second chain that competes for the very frames it is there to count. The
rule generalises past rAF: any figure derived from how long the driver's own loop took is a
measurement of the driver.

And prefer a counter the page already keeps to a rate you compute. Across three runs of the
same A/B the frame rate moved with whatever else the machine was doing, while the draft count
for a 40-move drag came back 1818, 1818 and 1869 — the amplification is deterministic and the
rate is not, so the count is what carries an argument and the rate is what makes it legible.

## A tight loop cannot measure an allocation

Two arms that both hit the allocator back to back are not an A/B of allocation cost.
`Registration::apply` new/deletes 9.2MB per call, and measured offline by applying one frame
five times in a row, hoisting those buffers came out *slower* in all three paired rounds -
because the allocator hands the same block straight back and the baseline arm was already
effectively persistent, leaving buffer alignment as the only real variable. On the real loop,
where 33ms and a JPEG encode sit between calls, the same change is worth 0.30ms of 5.71ms.
**An offline harness is for correctness; `grabber --profile` on the sensor is for cost** - and
a screening measurement that removes the effect will confidently report its absence.

## Synthetic pictures cannot price a live image path

The HD colour encoder first measured 3.12ms p50 over 200 structured synthetic images,
after discarding 20 warmups. The real sensor then measured 5.50ms mean over 90 native
1920x1080 frames during a six-second subscription at the same q80, TJSAMP_420 and
FASTDCT settings. The grabber delivered 180 depth frames in that interval - 30.0fps -
and reported zero encoder-busy drops. No encoder warmup was discarded.

Those runs use different summary statistics, so their difference is not a percentage
claim about content. The live run is the cost of the path that ships. Use generated
images to test an encoder and real producer content to price it.

## Replacing a shader literal with a uniform is not one question but two

And the second one is about the expression rather than the value. Step 3 of the effects rework
turned seven per-reading literals into parameters, each defaulting to exactly the literal it
replaced, with `registry-check --against` hashing every reading against the build from before
the readings existed. Five substitutions were exact on the first run. The two that were not are
worth keeping:

- **`pow(x, 1.0)` is not `x`.** Raising to the power of one is the mathematical identity and not
  the arithmetic one - this GPU evaluates it as exp2 of the log2 and it comes back a few
  last-bit values away. Ghost's exponent needed no guard, which is the other half of the
  measurement: substituting a uniform *for a literal exponent* is exact, and it is asking for
  the power of one that is not.
- **A value that is bit-identical is not an expression that is bit-identical.** Guarding the
  gamma with a ternary and handing the ramp the resulting variable produced a *third* image,
  different from both `x` and `pow(x, 1.0)`: frame 0 came back `2cf348152757` unguarded,
  `73d0479d20f9` through the ternary, and `885c07e968a6` - the old build's own hash - only when
  the branch went around the whole statement so the default path *is* the old line. `depthRamp`
  inlines to a mix by its argument over 0.33, so with the subtraction inside the call the
  compiler contracts the two into one multiply-add and with a variable in its place it does not.
  **To stay bit-exact, reach the old expression, do not recompute what it computed.**

Two related roundings came out of the same step. The contour band edges are `0.5 ∓ width`, and
doing that subtraction in the shader is float32: `f32(0.5) - f32(0.08)` is 0.42000001668930054
where the literal `0.42` it replaces is 0.41999998688697815, so the width is halved either side
of the middle **in double on the CPU** and uploaded as two uniforms, which lands on exactly the
floats the literals did. And a `mix(x, y, 1.0)` is guarded rather than trusted for the same
reason, since `x + (y - x)` is not always `y` - measured or not, the guard costs a coherent
uniform branch and removes the question.

## A gate calibrated on earlier runs and then passed marginally by the run that matters is not a gate

The monitor-cost harness inherited `prof-summary`'s 29.5fps floor, which belongs to a profiling
run that writes nothing; a continuously recording run legitimately sits under it, at 29.86 over
two minutes. Three windows at 28.90/29.19/28.83 were thrown away as contended when a spread of
0.36 is what a settled rig looks like — the tell for contention in the thread-count sweep was
*variance and non-monotonicity*, not the absolute level. The gate is baseline spread now.

Note the trap in the fix as well: the threshold was set from two earlier runs' spreads and the
run carrying the only correct packet data cleared it by 0.04, so that column is recorded as
measured once rather than replicated.

## A counter that reports zero may be counting a string nothing emits

Step 9's monitor-cost harness grepped `not all subsequences received` — the phrase
`grabber --help` itself names when describing the dropped-isochronous counter. The node emits
`skipping depth packet` in quantity and the other one almost never, so the delta was **zero in
every arm across two full runs**, and that got written up as the loss happening with no USB
packet loss at all — a result that appeared to refute the mechanism the rest of the work
claimed. Counted properly it is 24 packets per 40s with no client against 347 with a full-rate
monitor.

A zero delta from a wrong pattern is indistinguishable from a real absence, and an absence is
the one result nobody re-checks because it looks like the instrument working. **Before
believing a counter that reports no change, grep the raw log for what the system actually says
and confirm the phrase appears at all** — a phrase in the tool's own help text is not evidence
the running build emits it. This one was caught by reading journald after installing a systemd
unit, entirely by accident, which is not a method.

## A speed read off two adjacent frames has a noise floor that moves with the frame rate

The sensor's depth jitter is a **displacement** and not a rate, so dividing it by the gap
between two frames turns a fixed quantity into one that grows as the link gets faster.
Measured on `captures/sample.knct` at two spacings, taking the median of every paired sample
inside the snap threshold: about 4mm either way, which reads as **31 mm/s across the 128ms
pairs `registry-check` pins and about 140 mm/s across the capture's own 32ms ones.** Real
movement is a fixed speed and reads the same at both, so the signal-to-noise of anything
estimated this way is *worse* on a healthy link than on a degraded one, which is the opposite
of the direction every other number in this repo moves.

Two things follow, and the second is the one that costs somebody an afternoon. A threshold
meant to reject jitter cannot be stated in mm/s, because it would need re-tuning per link -
and it cannot be stated in millimetres either, because then a slow surface registers over a
slow link and vanishes over a fast one. `duotoneMotion` carries no such threshold for exactly
that reason, and the comment beside it in `web/main.js` has the numbers. And **the median
displacement being the same at both spacings is itself the discriminator between jitter and
motion**: measure at two intervals, and whatever holds its millimetres rather than its
millimetres per second is the sensor talking to itself.

## The Mac's USB topology reads worse than it measures

`ioreg -p IOUSB -w0` shows the sensor as controller -> `USB3.0 Hub` -> `NuiSensor Adaptor` ->
`Xbox NUI Sensor`, with a gigabit ethernet adapter on that same hub. Against
`docs/performance.md`'s "1 hub, own controller" that looks like the degraded topology which
measures 12.82fps, and it is not - **this rig sustains 30.02fps with 2 subsequence warnings
in 1921 frames.** The
`USB3.0 Hub` is a good high-speed one and the count is not the thing that matters.

Note also that `system_profiler SPUSBDataType` returns *nothing at all* on this machine, so a
check built on it reads as "no Kinect attached" whether one is attached or not. Use `ioreg`.
And settle the question by running the grabber and reading delivered fps rather than by
counting boxes in a tree.

## Driving a capture node over ssh

**`await ssh(...)` cannot launch a long-lived remote process.** ssh does not return until the
channel has no holders, and a backgrounded remote process holds it whatever `nohup` and
`< /dev/null` are given — the symptom is a driver frozen with the server running perfectly well
on the other side, and it cost two runs before the cause was read off the fact that the next log
line never printed. Detach and poll for readiness.

Likewise **a multi-line script through `bash -c "..."` loses twice**: the outer shell expands
every `$(...)` before bash sees it, and JSON quoting carries newlines as two literal
characters. Ship it base64. And on this node `pkill -f` matches the remote shell running your
own command — resolve listeners by port through `ss`.

## A route's cost is per item, so measure it against a library the size of a shoot

The gallery's poll had to pick between the cheap question and the true one:
`/record/state`, which is memory the process already holds, and `/library/all`, which is
what the grid is actually drawn from. "The listing is more expensive" is the kind of
reasoning this repo does not accept on its own, so it was measured.

Interleaved A/B on this rig, 20 pairs alternating the two routes against a 200-take
library, both servers' indexes warm and the sidecars written, page cache settling
discarded as the first eight pairs: **1.2ms for `/record/state` against 145ms for
`/library/all`**, with the linked pair on one machine so the listing includes its node
round trip. The steady-state figures are the last twelve pairs; the first two reads were
5.3s and 1.6s and are the cache, not the route.

The number that decides is not the ratio but where it comes from. `describeTake` reads a
marks sidecar per take on both machines, so the listing's cost is per take and a
five-second cadence would spend four hundred sidecar reads every tick to answer a question
that is almost always no — against a recorder whose own comment says exactly this
contention is what turns a slow card into dropped frames. **A route measured against a
fixture-sized library reports a constant where the thing you need is a slope.** The
200-take fixture is hardlinks of one capture, so the bytes are one file and the per-take
work is real.

Cold is a different quantity and worth stating so nobody re-derives it as a regression:
the first listing over 200 unindexed takes took **7m30s**, because `cachedIndex` scans each
file once and writes a `.idx` beside it. The second server over the same directory warmed
in 2.4s off those sidecars.
