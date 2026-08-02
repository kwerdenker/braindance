# Writing a proof tool that means something

Read this before writing or modifying any proof tool. It is the case file behind the
short rules in `CLAUDE.md`, and every entry is something that was found by running the
thing rather than by reading it.

Two neighbouring documents, and the seam between them is worth stating so a new lesson
lands in the right one. **This file is about a check that must fail when the thing under
test is broken.** `docs/measurement.md` is about a number you would report. And
`docs/proof-tools.md` is the suite reference — what each tool needs and what its exit
codes mean.

## An instrument must enforce its claims, not assert them

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

## Mutation-test the instrument, don't just reason about it

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

### A mutation that does nothing reads as a check that found nothing

Step 5 produced one: a mutation meant to draw editor furniture into the rendered frame
reached for `gl.scissor` and `gl.clear` directly, which three's own state cache overrode, so
the pixels never changed and the check reported a clean pass. Rewritten through
`renderer.setScissor` it fails at `max 189/255`. **Before believing a mutation was missed,
confirm the mutation did something** - have it move a number the check already prints, or the
verdict is about the mutation rather than about the check.

### Before believing a mutation was *caught*, confirm it was caught for the reason claimed

This is the converse of the rule above and it is worse, because it reads as coverage. Step 7
built a plant for the route sweep - a read route that writes a document and puts it back
inside the same request, which a before-and-after comparison of the contents cannot see by
construction, since both readings are taken outside the request. It failed two rows, and one
of them was the contents comparison it was written to walk past. The reason had nothing to do
with the property under test: APFS keeps modification times to the nanosecond, `utimesSync`
takes a `Date` carrying milliseconds, and the 0.13ms the restore could not put back is what
failed the row - `1785523816453.8726` against `1785523816454`. On a filesystem with coarser
stamps the identical plant walks straight through, so the control was asserting the platform
rather than the design, while looking exactly like a control that works.

**This was found by measuring, not by reading** - the mutation was run and the two snapshots
diffed field by field, which is the only thing that distinguishes a row that went red for its
own reason from one that went red for a neighbouring one. The fix was to rebuild the plant so
nothing about it depends on the filesystem: write-then-remove touches nothing that survives,
leaves the listing identical, and moves only the monotonic write count. It now fails that one
row and leaves the contents row passing, which is what makes the count load-bearing rather
than a second way of saying the same thing.

### A mutation run that exits non-zero with zero failed assertions did not run

Every tool that carries mutations refuses one whose anchor text it cannot find, and
Playwright occasionally dies with `Execution context was destroyed` partway through a run -
and all three outcomes exit 1, which reads as a caught mutation to anything checking only the
exit code. Seen twice on step 5, on two different mutations in two different suite runs.
**Count failed assertions, not exit codes**, and treat `fails=0` as a crash to investigate
rather than a success to record.

### And `fails=1` can be the same crash wearing the count

Counting assertions is not enough on its own if the harness's own failure is one of the
things it counts. `monitor-check` caught its `catch` in `failed++`, so
`expand-shifts-by-a-block` on a machine busy with an unrelated export timed out waiting for
the take, fired exactly one assertion — that timeout — and printed `caught, as required
(1 assertion fired)`. Nothing about sample placement had been tested. Run again on a settled
machine it fires eight, all of them the intended row. So a throw is now `crashed` rather than
`failed`, and the verdict is `DID NOT RUN` with exit **2**, checked before the mutation
verdict and before `untested`. **Read which assertions fired, not how many** — and a proof
tool must never count its own crash as a finding in either direction.

### A mutation can erase its own evidence

`plant-open-take` originally appended its foreign bytes through a second file descriptor.
After the recorder moved onto `createWriteStream`, that descriptor and the recorder's
descriptor had independent offsets: the append extended the file, then the next real frame
wrote from the recorder's older offset and overwrote all 64KB before the take closed. The
mutated build passed 256 assertions because it no longer contained the damage the control
claimed to plant. The control now writes through the recorder's own stream, between two real
frames, so the foreign bytes survive to the scan. When a mutation is unexpectedly green,
inspect the mutated artifact before weakening the assertion; the code change may have undone
itself rather than escaped the observation.

**And a run that stopped two thirds of the way through is the same lie told quietly.** One
sweep of nine mutations against the gallery had five runs end at 95, 117, 140 and twice 198 of
317 assertions, every one of them non-zero, every one with the mutation's own rows already
correctly red — so read line by line each looked like a catch, and read as a whole a third of
the suite's claims had not been measured against that build at all. Three causes, and none of
them was the code under test. `retryOnContextLoss` named `Execution context was destroyed` when
Playwright says `Resulting promise was garbage collected` for the same renderer going away
under an outstanding async `evaluate`; a mutation that deletes a control left `page.click` on
that control timing out for thirty seconds and then throwing; and a probe that renames a take
was pointed at the take five later rows assert about, so one red row became five and then an
undefined. **A mutation must redden the rows carrying its claim and leave the run able to
finish** — give a probe that might succeed its own fixture, guard any drive of a control the
mutation can remove, and print the assertion total beside the failure count so a run that
ended early is visible rather than implied.

**A race probe driven through the HTTP route measured the route's own latency and reported
the rule holding.** `renameTake` checked its target with `stat` and then acted on it, and
`rename(2)` replaces an existing file without a word — so two requests aiming at one name
both pass the reading and the second destroys a take. Four simultaneous POSTs against a build
with that hole came back one winner and three refusals, every loser intact, twice: each
request scans the whole captures directory before it reaches the rename, dozens of awaits of
differing durations, and that is enough that the requests are never inside the window
together. The identical four calls made straight at the function — where the only thing
between the reading and the act is three `stat`s — clobber immediately: **four fulfilled, no
rejections, one file left where four takes were.** So the row is a direct call into the
staged module, not a fetch. **When a probe is about an interval of a few microtasks, every
await between the caller and it is a widening of the thing being measured**, and a green row
means the harness could not get close rather than that the interval is closed. The fix under
it is `link(2)` then `unlink`, which fails EEXIST atomically, with the `stat` kept only for
the sentence it produces.

**Two gates that agree cannot be tested apart, and one of them will be doing all the work.**
The rename route refused the take being recorded and so did `renameTake` underneath it, in
identical words. `library-check` ran all 317 assertions against a build with the route's guard
deleted and reported the refusal working — 317 assertions, none failed, NOT CAUGHT — because
the second guard refused instead. This is not defence in depth; it is a rule with nothing
measuring it, since no mutation can reach one gate without the other covering. The duplicate
is gone and the check is aimed at the one that decides. **Before writing a second check of the
same condition, ask which mutation would tell the two apart** — if the answer is none, there
is one gate and a comment saying where it lives.

**A mutation that zeroes a quantity has not moved it.** `poster-height-in-js` was meant to
restore the shipped bug where a poster's height was assigned once from a measured width and
went stale on resize. Written without a `width > 0` guard it froze at the first fit, before
the grid had laid the tile out, so every poster came back zero-height: the aspect rows failed
with `Infinity`, the decimation row failed because a canvas of no pixels has no picture to be
sparser than, and the viewer never drew, which ended the run. Rows saying "something broke"
where the claim is about *which* quantity moved. This is the converse of the mutation that
does nothing already recorded above, and it fails the same test — confirm the mutation moved
the number the check prints, in the direction the bug moved it.

**Check the ports before a measurement run, not the results afterwards.** An earlier attempt
at the same sweep had eight of nine runs die in section 1 with an `ENOENT` on a
download-collision filename. A server leaked from a crashed run still held 8210 and 8211, so
`startServer` connected to *that* rather than to the one it had just spawned, and every run
was measuring a stale process against a fixture directory it was rebuilding underneath it.
Eight runs, one failed assertion each, all of them the harness crashing — which is `fails=1`
wearing a crash again, at sweep scale. The sweep resolves listeners by port and kills them
before each run now, and prints when it did.

## Where a probe stands

### A cumulative table hides which term is wrong

Step 6 measured the look at two output sizes down one pipeline - points, then trails, then
"grade" - and reverting any single grade term moved that row by less than the row's own
sampling residual, so three mutations passed. One row per term fixed it: `rgbsplit-absolute`
now fails the rgbsplit row and leaves the grain and scanline rows alone, which is a check
saying *what* broke rather than *that* something did.

### Three of step 6's probes were standing in dead zones

Each for its own reason, and each was found by mutation rather than by reading. The additive
normalisation is clamped to 1 beyond 0.83m, so at the default framing a mutation of it
changed nothing at all - the probe needed a camera inside the cloud. Grain at the preset's
0.22 is about one part in 255, so reverting its reference grid moved every number by 4% - the
probe needed the slider at full. And an export at the editor's own buffer size cannot tell an
output size that reached the renderer from one that did not - that probe needed a size the
editor is not.

### Place a probe where its answer would be different, not where it is convenient

A third flaw came out of this on step 5: a mutation replacing the pre-roll's window query
with the tangent it replaced was caught by only one of five probe positions, because four of
them sat inside a single straight segment of the retime curve where the tangent *is* the
curve. The probes were moved onto the knees and onto an eased ramp and the same mutation now
fails four. Ask what the wrong implementation would agree with, and probe somewhere it
cannot.

### `nav-at-the-foot` stood in a dead zone and then moved the page it measured

Both flaws at once, in one probe, and both were found by running the mutation and reading
which rows fired rather than by reading the probe. It is the control for section 1's second
claim in `editor-check`, that the way out of the editor is *reachable* rather than merely
present — it was under thirteen groups of sliders at the end of a column that scrolls, which
is being in the document and nowhere on the screen.

**The dead zone**: the first version scrolled the column to its end and asked whether the nav
was inside the panel, and the end of the travel is precisely where a nav at the foot *is*
visible — the mutation came back 683px down and comfortably in view, reddening only the
structural half of the row. The end a foot-nav fails is the top, where the panel sits when you
arrive, so both ends are read now and the mutated build answers 1958px.

**The observer effect**: the probe is the one thing in section 1 that moves the page it
measures, and leaving the column scrolled put section 8's crop sliders under different pointer
coordinates — the crop rows went from 0.005% apart to 0.446% and read as a rendering regression
the change had caused. It restores the scroll position now.

### A probe that changes the state it samples proves whatever it did to it

This is a distinct failure from the two above - not a probe in a dead zone and not a vacuous
assertion, but an observer effect inside the instrument, and it is easy to write because the
sampling call looks passive. Step 7's recorder check waited for takes by polling the library,
then asserted each closed take held all the frames its writer emitted. Listing the library
scans every capture in the directory *including the one still being written*, and the scan
writes a sidecar - so "does a sidecar exist" stopped meaning "the take is finished" the moment
something asked the question, and the take that was mid-recording was counted against a total
it was never going to reach. It came in at 10 frames and at 11 on two runs, which is the burst
plus however long the last poll took, and it fired on four unrelated mutations before it was
pinned - a check red for reasons that have nothing to do with what is under test, which is how
a gating check teaches people to re-run until green. The fix was to take "closed" from the
writer's own log rather than from an artifact the reader creates. **Before polling for a
condition, ask what the polling call itself writes, opens or caches** - anything that lists,
scans or indexes a directory something else is writing is a candidate.

**A fixture that has never held the shape under test cannot measure it, and the gallery's
tile heights are the plainest case of that yet.** Every take in `library-check`'s fixture
carried at most one warning — truncated, or no hello, or under two frames — so a
uniform-height assertion measured across all of them would have agreed on a build where each
warning still added a row: one row against one row is the same height. The shape that
differed was the take that fires several, and it did not exist until it was written.
Measured on a fixture that has one: 41.19px of spread at every viewport width before, 0.00px
after. That same take, cut before its first whole frame, then surfaced a defect nothing else
had: a take whose scan indexes no frames still asked the server for frame 0 and got a 404,
swallowed by the skim's own catch and visible only as a failed request in the console.
**Before asserting that a set of things agree, check the fixture contains the one that would
not.**

**A quantity assigned once in JavaScript from a measured box is right at first paint and
wrong afterwards, and a check that never resizes cannot see it.** The gallery's poster height
came from `canvas.parentElement.clientWidth` at the first draw, so a window dragged from 1512
to 700 left a 332px-wide tile with a 133px poster — 2.496:1 against the 16:9 it draws.
Measured, not read off the CSS: the rule that produced it also looked like it should hold.
The box is one `aspect-ratio` declaration now with the canvas taken out of flow, its backing
store follows through a `ResizeObserver`, and the geometry rows measure at two widths with a
resize between them because the two ways a tile changed size showed up under different
conditions — the warnings at every width, the poster only after something resized.

**Arithmetic about where a thing should go is not a measurement of where it went, and a
proof tool can hold the second where it cannot hold the first.** The gallery's ⋯ menu picks
its side from the room above and below the button inside the scrolling grid, and the tile in
the top row had its first item clipped away — the tallest menu, on the take whose three
warnings most needed reading. Fixing the branch was not enough: a tile in a row below the
fold has a button the grid is not showing at all, so "the room above it" is a number about a
position nothing can see and the menu lands wholly outside, which came back as six pixels of
a 98px menu on the one fixture tile whose menu carries no warnings under it — the shortest
menu there is, and therefore the one whose overflow a height cap cannot explain. The box is
measured after placement and shifted by whatever is left over now, and the row asserts
`inside` rather than asserting the reasoning. **Every assertion about what a menu offers
passes on a menu nobody can see**, because the items are in the document either way.

**A thing that draws one pixel per sample is dense at one size and threadbare at another.**
The gallery's viewer is the same projection as its tile at four times the area, and the
scale follows the height — so the gap between neighbouring depth samples on screen follows
it too, and a take that reads solid on its 228px tile came up a faint dot screen. The
spacing is exactly `scale / fx` pixels and not a proxy for it, because the depth cancels out
of the unprojection, so the sample size is derived rather than tuned. Taken from the
sensor's own focal length and never the decimated one: dividing by the divisor as well would
give a coarse remote frame four-times-larger samples and make it look identical to a local
one, erasing a signal the gallery carries on purpose. Measured: local 76.4 against remote
22.8, so a decimated skim is still visibly what it is, and the **tile's own poster is
bit-identical** to what it always drew — same mean, same signature — because the size floors
at one where the tile already covers.

**And the row that proves it was NOT CAUGHT for a round, because its threshold came from the
wrong conditions.** The ratio gate was set at 0.25 from a measurement taken at
devicePixelRatio 2, where the broken build gives 0.07 — and `library-check` runs at 1, where
the same build gives 0.28. One hundredth of a margin, and the mutation ran the full suite
reporting nothing wrong while doing exactly what it claimed. This is the fps-floor paragraph
above arriving in a different instrument: **calibrate a gate at the viewport, the pixel ratio
and the fixture the check actually runs with**, and record the broken build's value beside
the threshold so the margin is visible rather than implied.

**`el.id ?? fallback` never reaches the fallback.** The DOM answers an absent id, dataset key
or attribute with `''` rather than with undefined, so `??` keeps the empty string and `||` is
the operator that means what was intended. In the gallery's control enumeration this gave
every tab the key `''`: the sweep reported four controls it could not name and four drivers
naming nothing, both rows red, neither of them about the page. It looks exactly like a real
enumeration failure.

## What do my arms agree about

**When one probe turns out to be blind to something, ask what all of them are blind to
together.** Step 6 got the first half of this right and stopped one question short, which is
why it is a rule rather than a note. Its commit reasons that `pointsize-absolute` passes the
1728x1080 arm because the scale factor is exactly 1 there, and keeps a second arm at 1920x1200
for that reason - correct, and it never asked what every arm agreed about at once. The answer
was the aspect ratio. Every arm in `export-check` was 1.6 - 960x600, 1920x1200, 1728x1080, the
640x400 stage - and at 1.6 `bufferWidth / 1728` and `bufferHeight / 1080` are not close but
*identical*, so a build referencing the width was bit-identical on every arm and would have
passed all 30 assertions while drawing 11.1% too large on every size the export menu offers. A
set of probes that agree about a quantity cannot measure it however many of them there are,
and the agreement is invisible precisely because each arm confirms the others.

**The tell was there to be read: the values the instrument tested were not the values the
product ships** - four sizes in the menu, all 16:9, and not one of them in the check. Compare
the constants a tool sweeps against the constants the UI offers, and treat a disjoint pair as
a hole until measured otherwise. The fix was one cross-build arm at 1920x1080 and a
`scale-by-width` mutation, which now fails that row and leaves every other assertion in the
file passing.

### The second form: an object every observation happens to skip

The rule above has a second form, and it hides better: not every arm agreeing about one
quantity, but every observation of a single *object* switched off at once, each for its own
locally defensible reason. It has now produced three failures in a row.

**Step 7, and the skipped object was the take being shot.** The route sweep watched five
stores, a write counter and the recorder's own state, and a read route appending 64KB to the
take being recorded passed all 251 assertions at exit 0 — leaving nine 4096-byte runs of 0x07
in the file and `stream desync at 6349028: expected magic KNCT, got 0x7070707` when it finally
closed. Three decisions assembled into that hole and every one of them is right on its own:
the open take's size and modification time are excluded from the snapshot **by name**, because
they move on their own and comparing them would flake; no write counter covers the captures
directory, because the counters were built for the document stores; and the recorder's state
field tracks the recorder rather than the file, which is what it is for. Reading any one of
them finds nothing wrong. The file they all skipped was the most valuable thing in the system,
excluded on purpose, for a good reason.

So ask the question in both directions. Not only "what do my arms agree about", but
**"is there an object here that every observation happens to skip"**
— and be most suspicious where
the skipping was deliberate, because a deliberate exclusion comes with a justification that
stops anybody looking twice. The fix was to assert the identity `bytes === on-disk size` after
the take closes, where nothing is in flight and it is exact, with `plant-open-take` as the
control.

**The sensor view button produced it a second time, where the skipped object was the picture
and the excuse was that the camera is easier to read.** `sensor-view-check` had six sections
asserting `freeCamera.position`, `fov`, the fit and the stores, and not one pixel: the pose is
set several lines before `sensorView` asks for an image, so deleting `requestRepaint()` from
it leaves **all 125 assertions green** while the editor's picture does not move until the next
pointer gesture happens to render it. Section 7 and `--mutate no-repaint` are that gap closed,
and what makes them worth reading is that the comparison was vacuous twice before it worked,
both times reporting a picture that moved when nothing had rendered at all:

- **The chrome overlay is a second canvas sitting exactly over the picture**, and `drawChrome`
  repaints the path and the frustum from the new pose on the next animation frame whether or
  not the renderer drew anything. A stage compared with it visible says CHANGED against the
  mutated build.
- **The panel is translucent over the picture's left edge**, so a comparison clipped to the
  canvas rectangle contains the button being pressed - and the pixel row passed under
  `no-repaint` on the *hover highlight of the button itself*. The rect is now hit-tested with
  `elementFromPoint` on a grid and shrunk until every probe lands on the canvas, which is a
  region defined by what is on top of it rather than by anybody's bounds.

There is a third thing that had to be arranged and it is not furniture: **OrbitControls runs
with damping, and `advanceNavigation` calls `controls.update()` inside every render**, so
while the controls hold momentum two renders of one position genuinely differ - measured, as
the section's own control row. Any before/after of the picture is therefore about the coasting
camera unless the residual is spent first. **Anything comparing two frames of this editor
needs all three: the overlay off, the region hit-tested, and the damping drained.**

**Step 9 produced the same shape a third time, and the skipped object was again the picture.**
`monitor-check` had four sections and every arm in all four watched the server — what it
grants, what it puts on the wire, what it writes to disk — so a viewer that rendered a ÷4 frame
as a *different scene* passed all 49 assertions. It did: `bindDepth` wrote the smaller grid
into the head of the 512x424 texture, because `TypedArray.set` only objects to a source that is
too **long**, and 93.8% of the grid then held the last full-rate frame while the live cloud
collapsed into a band a metre above the optical axis. Nothing was excluded on purpose here —
the monitor's own output simply never occurred to anyone as a thing to measure, which is the
harder version, since there is no justification to argue with. **A tool named after a
user-facing surface should have at least one arm pointed at that surface.** Section 5 drives a
browser; `bind-ignores-grid` and `expand-shifts-by-a-block` are one control each, and the
second exists because the first reddens every row and a control that fails everything cannot
say which row carries the claim.

## Close the class, not the instance — and have the check enumerate it

A review of step 7 found six HTTP routes that changed something while dispatching on the path
alone, one at a time, which makes six a floor rather than a total. Fixing them individually
would have left the next route anybody adds outside the list. The routes are now one table
that *is* the dispatch, served at `/library/routes`, and `library-check` walks it: every route
with a write handler is asked for its method, its content type and its origin, so a route
added later is asked by existing. Enumerating turned up four mutating routes the individual
poking missed - `/library/delete/:id`, `/library/sync-marks/:id`, `/record/mark` and
`/presets/:name`, ten against six.

**The falsification control has to be a mutation that adds a mutating route without
registering it.** For one round the document said so while the suite had no such mutation.
What it had was `stop-route-reads`, which *moves* `/record/stop`'s handler into the `read`
slot, caught by a hardcoded floor on the route counts (`mutating.length >= 10 &&
writeOnly.length >= 7`). Moving a route drops both counts and trips the floor; **adding** one
moves neither in the failing direction, so the floor was blind by construction to the shape
the rule names. A planted read route writing a project passed the whole suite at 241 of 241,
exit 0, with its file on disk afterwards. `read-route-writes` is the control now, and what
catches it is a snapshot of every store rather than a count of registered routes — because a
count cannot answer "did a read handler mutate something".

**Two agreements made that sweep blind, and both are the same question as step 6's aspect
ratio.** The shooting server was spawned with **no `--projects` and no `--presets`**, so three
of the library's five stores sat outside the one directory being snapshotted — which is the
mechanical reason the plant was invisible. And the **recording** take's id was substituted into
every `:id`, where `beingRecorded` answers 409 before the handler runs: five capture routes
were driven and never executed, counted as swept and not swept. The sweep now drives an open
take and a closed one, GET and HEAD, document names that exist and names that do not, and
asserts by name that every route got past the 409 — with any route it cannot build a concrete
URL for named rather than silently driven at a URL still carrying a literal `:foo`.

## Assert against the resource, not against the bookkeeping that claims to track it

`/library/descriptors` reported `openCaptures.size`, and the bug underneath it dropped the map
entry while leaving the `FileHandle` open - so the number *fell* while the real count rose, and
an arm reading it watched a descriptor leak and recorded a descriptor being released, 0 against
a real 2. It reports `readdirSync('/dev/fd').length` beside it now and the arm asserts on that.
The same question is worth asking of any count a proof tool reads back from the thing under
test.

## Things that bite in a browser

**`p.x.__proto__ = v` in a probe is not what a file on disk does.** Assignment invokes the
`__proto__` setter and creates no own property at all, so `Object.entries` never sees it and
the document handed to the loader is unchanged - two rows labelled `__proto__` passed against a
build that accepted `__proto__`, because the probe never contained one. `JSON.parse` and
`Object.defineProperty` both create the own, enumerable property that a real file produces.
This is the mirror of the `JSON.stringify` trap recorded above: values sent as source survive,
except this one key, where source is the shape that does not.

**A mean absolute difference cannot see noise that moved.** Grain that has shifted is as
different from grain that has not as grain that has thinned, so both grade mutations survived
every difference-based threshold the sampling residual left room for. What catches them is a
correlation: high-pass both images and correlate, and a structure quantised onto a shared
reference grid correlates 0.94 where a continuously sampled one correlates 0.77.

**A contended machine fails a check in a way that reads as a finding.** Two worktrees running
proof tools at once produced four failed runs, and the quiet one is the dangerous one: under
contention the preset-apply evaluate dies with `Resulting promise was garbage collected`, a
sibling of the `Execution context was destroyed` the call is already wrapped against, and
`library-check` stops at 139 of 256 assertions. That reproduced **five times** against a
change while a baseline taken on an idle machine passed twice - a regression with a clean
control, and the change was innocent. What settled it was running the *unmodified* tree back
to back in the same conditions, where it crashed identically. **Re-run the baseline in the
conditions the failure happened in**, and check `pgrep -f "tools/.*-check.mjs"` first. The
loud half of the same collision is in `docs/proof-tools.md`: `library-check` binds fixed
ports, so two runs get each other's server rather than an address-in-use error.

**Playwright drops the page's execution context here, and it is not the code.** A second live
WebGL page while an export is reading pixels back will sometimes take the renderer process
down, and it arrives as `Execution context was destroyed` - with the server log showing the
export it happened during completing normally, all frames present. `export-check` runs one
browser at a time and retries that specific error up to three times, printing the retry count;
anything else propagates on the first attempt, because a check that retried real failures would
report whichever attempt it liked.

**`page.evaluate(fnSourceString, arg)` does not call the function.** Playwright evaluates the
string as an expression, so the arrow function is created, never invoked, and `undefined` comes
back - which surfaced three helpers later as a missing shot rather than as a call that did not
happen. The house pattern is `page.evaluate(\`(${FN})(${JSON.stringify(opts)})\`)`, and it is
what the other tools already do.

**Letterboxing the editor stage moved every pointer coordinate and every buffer-size
expectation, and four proof tools found out one at a time.** `export-check` needed two separate
fixes, `registry-check` failed its render-scale row, and `keyframe-check` failed four rows in a
way that read as a missing feature — `camera.project()` answers in canvas coordinates and
`page.mouse` takes viewport ones, which were the same number only while the canvas sat at the
window's corner. **When a change moves where the canvas is, the tools that drive it by
coordinate are all suspect, not just the ones that mention size.**
