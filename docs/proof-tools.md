# The proof-tool suite in detail

`CLAUDE.md` carries the invocation list — what exists and how to run it. This file is what
each tool needs, what its exit codes mean, and the per-tool facts that are only worth having
when you are about to run or edit that tool.

For the method behind the suite, see `docs/instruments.md`.

## Exit codes, and why reading them is a trap

**The tools disagree about what a caught mutation exits,
the disagreement runs the dangerous way, so read the assertion count and never the code.**
Counted rather than recalled:

- **Seven exit non-zero on a catch and say `NOT CAUGHT` when they miss**: `guard-check`,
  `jobs-check`, `editor-check`, `monitor-check`, `sensor-view-check`, `level-check`,
  `vcam-check`.
- **Four invert it**: `vendor-check`, `registration-check`, `registry-check` and
  `release-gate-check`, where caught is exit **0** with `caught, as required (N assertions
  fired)` and exit **1** is `NOT CAUGHT`.
  Anything gating on "non-zero means caught" reads a genuine miss by these four as a catch.
  `registry-check` joined this group rather than the first deliberately, because all three of
  its outcomes have their own code: it exits **2** with `DID NOT RUN` on a crash, on the same
  reading `registration-check` reserves 2 for. `level-check` and `vcam-check` separate the same
  three and land in the first group instead, so the three-way split and the sign of a catch are
  independent choices rather than one decision — which is the whole reason this section exists.
  That is not hypothetical — two of its four mutations reddened their intended row and *then* died on
  Playwright's `Target page, context or browser has been closed`, and without the crash handler
  each would have exited non-zero having asserted the right thing for the wrong reason.
  `release-gate-check` is here because its header says it follows `vendor-check` and its code
  does: it prints the assertion count and exits 0 on a catch, and 1 with `NOT CAUGHT` on a miss.
  It is the one tool in this census that carries mutations without appearing in the fourteen
  below, for the reason given there — so an agent who goes looking for it under Mutations and
  gives up reads it by the majority convention, which is backwards for exactly this tool.
- **Four have no `NOT CAUGHT` branch at all** and simply exit on their failure count:
  `timeline-check`, `export-check`, `keyframe-check`, `library-check`. **A mutation these four
  fail to catch exits 0**, which reads as a clean pass rather than as the check being blind.
  That is the same direction as the inverting group above and it is silent rather than merely
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

**Fourteen tools carry mutations by one of those two mechanisms** — editor, export, guard, jobs,
keyframe, level, library, monitor, registration, registry, sensor-view, timeline, vcam and
vendor — and all of them refuse a mutation whose text they cannot find exactly once, because a
replacement that silently matched nothing would run the unmutated page and be recorded as the
check having missed a bug it was never shown.

**That qualifier is load-bearing, because the exit-code census above has fifteen entries and
this list has fourteen names.** `release-gate-check` is the difference, and it carries three
mutations — `wrong-unit`, `no-gate` and `absent` — by a third mechanism: each is a whole
`.npmrc`, written into a scratch directory npm is then asked to resolve a package from, so there
is no source text to match and nothing for the refusal above to be about. Both numbers are
right because they count different things, so do not reconcile them — a fifteenth name in this
list would claim a delivery that tool does not use, and dropping it from the census leaves the
tool whose convention is easiest to read backwards as the one nothing documents.

**A mutation is a piece of source text, so a mutation stops matching the moment the code it
names is edited** — three of `timeline-check`'s nine had to be re-anchored when step 5 rewrote
the retime seam, and the refusal is what surfaced that rather than a silent pass. If you change
something a mutation anchors to, re-anchor it in the same commit and say in the message which
ones moved.

**`library-check` delivers every mutation by one mechanism — the staged tree — and then asks
the server whether it arrived.** Both halves are worth reading before editing that tool,
because it had two mechanisms for a release and the seam between them was a hazard rather
than a redundancy.

Server mutations were always staged. Page mutations were fulfilled by a Playwright route
interception matched on a URL, and that shape has a specific failure: **a page is reached at
the URL `PAGES` names it by, not at its filename**. `web/library.html` has no URL of its own —
`server/index.js` 404s any `.html` under `web/` on purpose, so a page has exactly one address —
and it is served at `/gallery`, so an interception written as `**/library.html` matches
nothing, the unmutated page loads, and the run is recorded as the check having missed a bug it
was never shown. That is the match-exactly-once failure arriving through the *delivery* rather
than through the anchor, where nothing refused it.

Staging everything closed a different hole — `server/library.js` imports `web/format.js` by
path, so a mutation of it that reached only the page left the server deciding `openable` on the
unmutated band — and made the interception redundant in the same breath, since `WEB_DIR` is
`join(ROOT, 'web')` and `web/` is copied into the staged root. Two mechanisms delivering the
same bytes is not defence in depth; it is the two-gates-that-agree shape `docs/instruments.md`
records, where no mutation can reach one without the other covering, so neither can be tested
and one of them is doing all the work.

So there is one delivery path, and `requireMutationDelivered` is the opposite shape from the
thing it replaced: it fetches the page's own URL before a browser opens anything and requires
the bytes back to be the ones this run staged. `PAGE_URLS` is unavoidably a second spelling of
`PAGES` and is *checked rather than trusted* by exactly that fetch, so a page that moved or
stopped being served fails by name. **It exits 2 rather than failing an assertion**, and the
direction is the point: a suite that fails one row on a mutation run reads as a catch, so a
mutation that never arrived has to be the harness declining to run.

Measured when the mechanisms were collapsed: 19 of the 20 page mutations delivered, each
named with the URL and the byte count, `gallery-has-no-way-back` among them at `/gallery`,
which is the case the interception existed for. The twentieth is `marks-ignore-retime`, which
cannot be constructed at all — its anchor matches twice in `web/main.js` and the
match-exactly-once refusal stops it, a stale anchor that predates this and is tracked in #28.
The control for the delivery refusal is to stop staging `web/` files and run a page mutation:
it names the file, the URL and both byte counts, and exits 2 without printing an assertion.

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

**`jobs-check`** spawns its own server and renders two real jobs through
`tools/render-worker.mjs`, so it needs a GPU browser and ffprobe. `--no-render` drops both rows
and says so - the queue rows are seconds, each render is about a minute.

**Its mutation runs are no longer all `--no-render`, and reading them as though they were is
how a control gets recorded as green without running.** Every one but `heartbeat-stops-on-first-error`
is queue semantics and wants `--no-render`; that one names a line in the worker's beat, is
reached only by a render, and needs the browser and about two minutes. Take the names from the
tool's own refusal rather than from a count written here - this sentence used to carry one and
it was wrong, which is what a count in prose beside a list that grows does to itself, and
enumerating from the refusal is what `sweep-all` already does for the same reason. That the
split is by *which* mutation rather than by a number is the same argument arriving one level
down: a reader who takes "its mutation runs use `--no-render`" as a rule runs the one that
needs a render without one, and it passes.

**The worker under test is the staged copy, not the repo's.** `jobs-check` copies `server/`,
`web/` and `tools/render-worker.mjs` into `.jobs-check/root` and spawns from there, because a
mutation naming a file nothing runs reports a miss that is really a control that never applied.

**The heartbeat row runs the whole render through a forwarding proxy**, which destroys the
socket on the first `POST /jobs/<id>/heartbeat` without answering - `ECONNRESET` at the
worker's `fetch`, the one class of failure that is neither a 409 nor a status code. A worker
has one `--url`, so the proxy also carries the page load and the export WebSocket, handling
`upgrade` by piping the raw sockets both ways with the headers verbatim - `Host` included,
since the page's `Origin` names the proxy and `originAllowed` compares the two. If that row
fails with anything about the export, the page or a closed target, the proxy is the suspect and
the finding is not the heartbeat. What discriminates is the record's `heartbeat` against its
`claimed`: `claim` stamps them equal, so a worker that gave up on the first failure finishes
`done` exactly like a healthy one and only the timestamp says it went quiet.

**The worker reads its renderer class out of the browser it will render in and cannot be told
one.** `channel: 'chromium'` rather than the bundled headless shell, which has no GPU and falls
back to SwiftShader - a class nothing else can reproduce, which the worker refuses outright
rather than pinning jobs to.

**`vcam-check`** spawns its own server on 8361 and needs none running, but it needs a capture at
`captures/sample.knct` to loop, ffmpeg and ffprobe, and a GPU browser for section 5
(`--no-browser` drops it and says so). It writes takes into its own staged tree, so it never
touches `captures/`.

**It also needs this machine to have a non-internal IPv4, and exits 2 when it has none.**
Section 6 is the only arm in the repo that creates a webcam subscriber which is not on
loopback, and it makes one the way `guard-check` does: a server widened with `--host 0.0.0.0`
and a subscriber arriving on this machine's own LAN address. Without a second address there is
nothing the loopback exemption can be asked about, so the run prints `UNPROVEN` naming the
missing address rather than passing quietly — `guard-check`'s answer to the same condition,
not `monitor-check`'s, which turns it into a failed assertion. Both exit-2 reasons carry their
own remedy now, because the verdict line used to append playwright's advice to whatever it was
given and would have told an operator missing a LAN address to install a browser.

**Its own server-readiness wait is on the sensor rather than on a constant**, and that was a
bug rather than a nicety. `viewer on` is printed inside `httpServer.listen`'s callback, which
is before the grabber has been spawned at all, and this grabber reads a 138MB capture and runs
a 1080p ffmpeg encode first — measured at 3.8 to 4.7 seconds on a loaded Mac and never under a
second on an idle one, against the 400ms the tool used to allow. Sections 2, 3 and 4 were all
questioning a server with no sensor behind it, so the endpoint 503'd, no take gathered a frame,
and every row read as a finding about the webcam. `start()` now polls `/record/state` until
`webcam.available`, which is the right flag because `server/webcam.js` only ever clears it on a
hello with colour on, and reads without subscribing — which section 1 needs, since its first
row is about what happens while nothing is subscribed. That row was the second casualty: it
passed on an empty emit log, which is as true of a grabber that never started as of one running
with colour off.

**Its discriminator is geometry rather than resolution, and that is the whole design of the
tool.** The webcam's claim is that it serves the colour camera and not the registered 512x424
image the point cloud is textured with — and an implementation that upscaled the registered
image to 1080p would pass every dimension check there is. What it cannot pass is a margin: the
colour camera sees 84.1° where the registered frustum sees 70.6°, so a real colour frame carries
content down the sides that no upscale can invent. `fake-grabber --hd` builds the fixture as
*the registered frame upscaled* plus a magenta left margin and a cyan right one, so a cheating
implementation matches most of the picture and still fails on the 12% at each edge. Run
`--mutate hd-upscales-registered` and read which rows fire: the two margin rows, the
passthrough row and the re-encode row. `--mutate hd-reaches-recorder` fires the two rows about
the take, and only those. A control that failed on a neighbouring row would not be a control
for the thing it names.

**`hd-upscales-registered` reddens neighbouring rows on a contended machine, and that is a
defect in the control rather than a finding about the code.** It runs a synchronous 1920x1080
ffmpeg scale on the server's event loop *per colour message*, so the stream starves — over four
`--no-browser` runs on one Mac spanning one-minute load averages of about 25 to about 95, its
four named rows fired in all four, `and the subscriber is actually being served parts` fired in
two, `the take carries a hello and frames` fired in two, and exactly one run showed neither.
Read the four named rows and treat a fifth in section 1 or 3 as the harness competing for the
machine. Memoising it the way
`hd-reencodes-in-flight` is memoised would fix the starvation, but not for free: the registered
image varies across the fixture's 284-frame loop, so a memoised upscale serves one constant
frame and `and nothing re-encoded it on the way through` would go green — which is a decision
about what that control is for, not a tidy-up, and it has not been taken here.

**The margins say the picture is right and only the emit log says the bytes are.**
`--mutate hd-reencodes-in-flight` decodes the colour payload and re-encodes it at the same size
and a comparable quality, so every geometric row still passes and exactly one fires: `every
served part is the same JPEG the writer emitted`. It fires because the writer's emit log now
carries a fourth column, the sha256 of the part body a reader receives, which is what makes
comparing the two ends possible at all — a colour payload is a u64 stamp then the JPEG, the
stamp moves per frame, and the row that used to be here hashed a served part against the set of
served parts and was therefore true whenever a part arrived. Both readers of that log
destructure positionally and ignore the fourth column, so adding it changed no behaviour; if a
fifth is ever wanted, that is the moment to give the log a header line instead.

The mutation memoises its re-encode, and that is load-bearing rather than an optimisation: a
synchronous 1920x1080 re-encode per message starves the stream until `a frame was served at all`
reddens instead, and a control that fires for a neighbouring reason is not a control. The memo
costs nothing in fidelity because the fixture's colour payload carries one constant HD frame.
Its own falsification is the pair: the same mutation printed NOT CAUGHT with 0 failed against
the row as it stood before, and prints `caught, as required` with 1 failed after — which is
also what discriminates a real catch from ffmpeg having silently failed, since the mutation
falls back to the original bytes when it cannot run.

**`--mutate refusal-ignores-webcam`** deletes the webcam clause from
`consumersCostingTheTake`, leaving the monitors one, and must fire exactly the two section 6
rows that assert the refusal — never the third, which is the operator accepting the cost, since
a take that was already permitted stays permitted. Section 1's `a loopback subscriber does not
refuse the take` is a row that mutation makes *more* true, which is why it could never have
stood in for the arm that creates a remote one.

**That row is the control for the other direction**, and it was tested rather than reasoned
about. `Webcam.subscribersCostingTheTake` is written as a filter over `describe()`, so a
`describe()` that stopped publishing `loopback` would silently make it return every subscriber
and charge every proof tool in this repo for its own localhost connection. Forcing the rule to
`return this.describe()` reddens three rows — the section 1 one by name, and the two in section
3 that need a take to start with a loopback webcam attached.

**`guard-check`** spawns its own servers and needs none running. It exits 2 when the machine has
no non-internal IPv4, because "not listening on the network" is only a claim if there is a
second address a client could have arrived on. Every refusal it asserts has a positive twin, so
a server that refused every upgrade, or bound to nothing, fails it rather than passing quietly.

**`library-check`** takes no `--url`; it spawns what it needs. `plant-open-take` is the mutation
worth naming beside it rather than a milder one: it is the control for the hole that let a read
route destroy the take being shot.

**It binds a span of fixed ports** — `--node-port`, and `--mac-port` through `--mac-port + 16`,
defaulting to 8210 and 8211..8227. Two worktrees running it at once did not get an
address-in-use error, they got each other's server: one run stat-ed `three-warning-take.knct`,
a fixture belonging to the other tree, and reported itself as not finishing. The quieter half
of that same collision is in `docs/instruments.md`, because it fails in a way that reads as a
finding — most recently six recorder rows reporting `undefined counted, -1 on disk` when
`MAC_PORT + 9` belonged to somebody else.

It now **refuses the run rather than discovering this halfway through**: `reservePorts` asks
the kernel about every port in the span before anything spawns and exits 2 naming what is
held, `startServer` throws if its own child exits instead of listening, and it refuses a port
outside the declared span so a section added at `+17` is a failure rather than a hole. Pass
`--node-port`/`--mac-port` a range nothing else holds.

**Three rows in it are flaky under machine contention, and they are written down here so the
next person does not spend the afternoon on an innocent change.** Two are in the
marks-on-the-scrubber section and are the same race: `and it is stamped in source milliseconds
rather than program time` seeks the editor to program 1.0s, awaits `settled()`, presses mark,
and asserts the written `sourceMs` is within 40ms of `sourceSecAt(1.0)`, while `stamped inside
the footage it flags rather than at an arbitrary offset` asks that the mark land within the
take. Observed failing as `0ms against source 150ms` — the playhead still at program zero when
the mark was taken — and as `934ms into 425ms`. Neither is fixed: `settled()` resolving before
the transport's program position has moved is a page-timing race in the editor, not a property
of anything the section is about.

The third is `and when the reader lets go the descriptor is closed rather than left for the
collector to throw over`, which reports `real 19 against a baseline of 18` and whose own comment
in the file already calls it measured-flaky. Its settle is a fixed 250ms against a collector
measured to take 300ms to 1s, so it is sound on an idle machine and arithmetic on a loaded one.

What says all three are the rows rather than the change under test is that they fail on
unmutated trees as well as mutated ones, and disagree with themselves across runs of one tree —
the descriptor row was green at load 70, red at 250 and green again at 276 on an identical
checkout. A run that reddens only these on a busy machine is a re-run, not a finding, and per
the rule at the top of this file that judgement comes from reading *which* assertion fired,
never from the exit code.

**Under a mutation they are worse than noise, because they land on top of a count.**
`open-ignores-format` carries its claim *as* a number — six, and the doc above says which six —
so a marks row arriving alongside them prints `7 failed` or `8 failed` and reads as a control
that over-fired onto rows it was supposed to leave green, which is the one failure shape that
would mean the band had stopped being a single predicate. Measured twice on the merge that
brought the two together: `7 failed` at load average 71, the intended six by name and one marks
row seventh; and `8 failed` at load average 270, the same six and both marks rows. Compare the
names against the six rather than the total against six, and re-run before recording a spread —
the same tree's baselines passed those rows at other moments, which is what a race looks like
from the outside and what a real interaction would not do.

**`--mutate exit-keeps-the-child-reference` reddens exactly two, and its section is the one to
suspect first on a loaded machine**, because the whole of it is a message that has to land
inside a 1000ms respawn backoff. The two are `the next failure is still reported lost` and `and
it still counts toward the backoff`; the three rows above them are provenance and must stay
green, since they are what separates a control that missed from a fixture that never reached the
window. Read the printed `colour camera on - ...` line beside them either way — `restarting
grabber` says the mutation reached the branch, `takes effect on the next spawn` says it did not,
and the assertion count cannot tell you which. Both claim rows assert an order and a ratio
rather than the presence of a word, and `docs/instruments.md` carries why: the earlier versions
passed the mutated build, which reddened nothing and exited 0.

**Two takes carry the capture format's band, and the second is the one that keeps the archive
readable.** `future-format-take` declares a generation this build has never read and is
otherwise an entirely ordinary take — whole frames, a readable hello, intrinsics in range —
because "nothing here knows what these numbers mean" is a condition with no other symptom.
`generation-zero-take` declares no `format` key at all, which is what `captures/sample.knct`
itself is and what every take shot before the field existed is; it is planted under its own name
rather than left to the takes that are generation zero incidentally, since a band written as
"refuse anything unfamiliar" passes every row about the first take and shuts the whole existing
archive out of the editor.

`--mutate open-ignores-format` is the control and it edits one line of `web/format.js`, which is
the point of it rather than an implementation detail. Four doors decide whether a take may be
opened — `openable` in `describeTake`, the badge and the dead Open button in the gallery, and
`openTake` in the editor — and three of them are cheap to satisfy by inlining a comparison, which
would pass every row here and drift the first time the band gains a member. So the assertion the
mutation really carries is the *count*: it reddens **6 of 365**, one row per door plus the
gallery's menu sentence and the editor's editing state, and the takes that must stay green stay
green — both `no-hello-take` rows, `local-clip`'s `dateSource === 'hello'`, and all four
generation-zero rows. A mutation that reddened fewer would mean the band had quietly become
several predicates that agree.

Reaching all four needed the harness to stage `web/` mutations rather than leaving them to the
browser route interception, because `server/library.js` imports `format.js` by path: served to
the page and not staged, the server would have gone on deciding `openable` on the unmutated band
and the control would have reddened the page's rows only, reading as a partial break in the
product rather than a half-broken build. That is what put the tool briefly on two delivery
mechanisms and is why it is now on one — see the Mutations section above for the collapse and for
what `requireMutationDelivered` asserts.

**`syntax-check` also holds the hello to the README and the format constant to the grabber**, in
both directions and without importing either. The prose block documented nine keys against the
thirteen emitted for long enough that the four it omitted became the argument for the check:
`startedAt` is the only durable capture date a take has, so a second producer written against the
documented nine writes takes the library dates by file modification time, which changes the first
time a take is copied off the node and degrades quietly, because that fallback is legitimate and
reports `dateSource: 'mtime'` rather than failing. The README side is cut to the `type 1 hello`
stanza and stops at `type 2`, the grabber side to the one `snprintf` that builds the hello, and an
empty extraction from either fails — zero keys means the anchor moved and the comparison ran on
nothing. `CAPTURE_FORMAT` is read textually out of `web/format.js` and `native/grabber.cpp` and
required equal, because this tool takes `--root` and an import would bind the assertion to this
checkout while claiming to have checked another tree.

Its three controls are run by hand, in the idiom the `tools/` and `docs/` blocks already use.
This tool does carry a `--mutate` harness, but its table holds one entry and that entry belongs
to the specification row below, so nothing here has a named mutation — which is worth stating
rather than leaving to be inferred, since a reader who saw the flag would otherwise read a green
`--mutate spec-drifts` as a control over these assertions too. Add a key to the grabber literal and not to the
README; add one to the README the grabber does not emit; bump the constant in one language. Each
must fail naming what it found — measured, in that order: `the grabber's hello emits exposure and
README.md's type 1 hello does not document it`, `README.md's type 1 hello documents exposure and
the grabber does not emit it`, and `CAPTURE_FORMAT is 2 in web/format.js and 1 in
native/grabber.cpp`. The first of those three is worth doing carefully: the obvious `perl -pi`
one-liner silently matches nothing against a C++ string literal full of escaped quotes, and a
mutation that did not apply reads exactly like a check that missed one.

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

**`level-check` needs no sensor and no capture, and that is a claim about what it can grade
rather than a convenience.** It writes analytic planes — `z = c / (u . n)` along each pixel's
own ray — straight into the depth texture, so it knows the normal of every surface it plants
and can mark the plane fit against the answer. A fixture take would have given it a surface
nobody knows the normal of, and the fit would then only ever have been asserted against itself.
Section 5 also plants different planes on the left and right of one frame, selects each side,
and checks the two resulting rotations. A full frame of one plane cannot distinguish a selected
point from a hard-coded centre. The same section drives the reset button and reads both axes and
both sliders back at neutral.

**Its staged tree deliberately has no `native/`, and that is the reason it works.** A live
socket wipes a planted frame in well under a second — an arriving frame swaps the two depth
textures and the plant is left in the one nothing reads, measured at gone-within-500ms on a
page with the sensor attached. The staged tree carrying no grabber binary is what keeps the
server it spawns quiet. That held by accident for as long as this machine had no Kinect, and
the day one was plugged in nothing in the file would have noticed: symlink `native` alongside
`node_modules` and the run goes on being green while it grades live footage against a normal
it thinks it planted. Section 1 now checksums the planted grid after a full settle and asserts
the texture was not swapped under it; with `native` staged that row fires at 1726596637 against
an expected 95354338 and nine rows fail behind it, the fits reading tilt -3.5 roll -32 off a
surface planted at 73.5 and 0. **Ask of any tool that plants state what else writes to the same
place**, and prefer a row that names the cause to nine that describe the symptom.

Two of its rows are worth knowing about before editing it. **The bit-identity in section 2 is
the whole crop claim**: rotating the world and the camera by the same quaternion is a no-op, so
the two pictures must hash the same, which is only true while the crop and the region are
tested on the undisplaced sensor-space position. It carries its own anti-vacuity row — leaving
the camera behind *must* change the picture — because otherwise a build that ignored the
parameters entirely satisfies the identity by drawing the same thing twice. **And surface A is
deliberately blind to `level-order-swapped`**: it leans along one axis, its roll comes out zero,
and `Rx * Rz` and `Rz * Rx` are then the same rotation. B and C catch it. The blind arm stays,
because a sweep where every arm reddens cannot say which property is load-bearing.

Its `LEVEL_TOLERANCE` is a bound and not a fitted number: snapping two angles to the sliders'
half-degree step leaves about 0.0062 radians in the worst case, the gate is 0.012, the clean
run's worst arm sits at 0.0035 and `level-order-swapped` misses by 0.19. An earlier 0.02 let
surface C through by 0.0005 — green or red depending on the machine — which is the shape
`docs/instruments.md` warns about under gates that pass for a neighbouring reason.

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

**Its third row is the `.knct` decoder specification**, the page at the top of
`server/protocol.js` that issue #45 decided is a take's exit from this program instead of a
point-cloud export. That makes it load-bearing in a way prose here usually is not: it is what
somebody writes a reader from once nothing in this tree runs, so a constant that moved while it
did not would send them to a reader that is plausibly shaped and quietly wrong. The row reads the
specification's number table against the module's exports and fails on any disagreement. Two
choices in it are the whole of why it means anything. The exports are **enumerated rather than
listed**, so every numeric export has to appear in the specification and a constant added next
year is asked by existing rather than added to a second table that drifts. And the values are
read by **importing** the module rather than by a regex over its source, because
`MAX_PAYLOAD_BYTES` is `8 * 1024 * 1024` and reads correctly one way and not the other.

The control is `--mutate spec-drifts`, which substitutes `TYPE_COLOR = 3` for `4` and leaves the
prose where it is. Both arms import through a scratch copy of the file rather than the clean arm
importing the live path — they have to differ only in the substitution, or the run is comparing
two mechanisms and calling the difference a catch. An anchor it cannot find and a mutation name it
does not know both exit 2 rather than running, for the reason the exit-code section above gives.
Mutation-tested three ways beyond its own control: a numeric export added to `protocol.js` and
left out of the table reddens it, the specification block deleted reddens it, and a number edited
in the table while the code stays put reddens it.

**`prof-summary.mjs <profile> [warmup]`** reads `grabber --profile` output and flags any run
under 29.5fps as contended, because the segment timings from a run that dropped frames are
noise. That floor belongs to a profiling run that writes nothing — see the gate paragraph in
`docs/measurement.md` before reusing it for a recording run.

**`pi-registration-ab.sh`** is the unrun runbook for measuring the threading on a capture node;
it builds both arms, checks with `ldd` that they load different libraries, and refuses to
report milliseconds from an arm that lost frames.

**`sweep-all` says "every mutation of every tool" and drives four of the fourteen that carry
mutations.** Its `TOOLS` is `['library', 'timeline', 'keyframe', 'export']`, so editor, guard,
jobs, level, monitor, registration, registry, sensor-view, vcam and vendor are outside the sweep
a merge waits on - and the file's own header is an argument against exactly this shape, since it
takes each tool's mutation *names* from that tool's refusal specifically so no list has to agree
with anything. The names are enumerated and the tools are not. The ten that are missing each
need something
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

**`fake-grabber` honours `--no-color` and `--no-low-light`, and reports any argument it does
not know.** It ignored both for its whole life, which mattered because they are not the
operator's flags — the server appends them to the grabber's argv out of `camera`, so eight of
`library-check`'s servers were running colour-off and being answered with a `"color":true`
hello over frames still carrying full JPEGs. That is a stream the real sensor cannot produce
under the arguments it was given, and the mirror image of it — a hello claiming colour over a
take with no JPEG — is a state the server treats as corruption. Under `--no-color` the hello
now says `"color":false`, and `"lowLight":false` with it: `native/grabber.cpp` reports
`lowLight` as the **conjunction**, so colour off makes it false whatever the second flag said,
and a fixture watching only for `--no-low-light` reproduces the same defect one field over
while looking fixed. Every payload is rewritten once at load — the `colorBytes` u32 at offset
4 zeroed and the payload truncated to `16 + depthBytes` — because `server/capture.js` refuses
a frame whose two declared lengths do not describe it, so both edits are needed or nothing
parses.

**The depth it emits is real recorded sensor depth under both flags**, which is the whole
value of this fixture. What it still deliberately does not do is simulate a sensor: the
cadence is a flag, colour is dropped rather than re-shot, and `--pipeline`, `--log`,
`--quality`, `--min-depth` and `--max-depth` are accepted and ignored because there is no
device here to apply them to. Anything else in argv gets one line on stderr naming it and the
stream runs on — **reported, never refused**, because `buildArgs` appends `--pipeline` on a
server that was given one and a fixture that rejected a legitimate spawn would break that
path. That line proves the fixture noticed a flag, never that it acted on one; the behavioural
claims belong to `monitor-check`'s colour-off section, which watches the wire and the page
separately.

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
verdict — a run against a stand-in fails the rows named above by construction, and reporting it
as a pass or as unexplained failures without naming the fixture is wrong in both directions.

**The total is not written down here any more, and that is deliberate.** This sentence used to
carry one — "317 of 319" — and it was stale by twenty-eight the day it was next read, because
the total moves whenever a section is added and nothing was walking it. The number to compare a
run against is the one a baseline on the same tree prints: **365 assertions on darwin against
the real 138MB sample**, measured on the merge that brought section 4f alongside the capture
format's band, which is the figure to re-measure rather than to trust. It went from 352 to 365
in that merge alone — five rows from one branch and thirteen from the other, neither of which
knew about the other — and that is the rate a total in prose goes stale at when two sections
land in the same week.
