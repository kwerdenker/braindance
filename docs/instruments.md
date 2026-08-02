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

### A mutation whose only effect is that the page refuses to boot is not a usable mutation

Step 2 replaced a boot invariant that had become a tautology — it looked a panel control up by
id and threw when there was none, which stops being able to fail once the same pass creates the
control it then looks for — with a count assertion: rows emitted against parameters declared.
That refusal is right for whoever is looking at a blank panel and useless as evidence, because
a page that throws during module evaluation publishes nothing, every tool reports DID NOT RUN,
and an exit code with no assertions behind it is the thing this repo twice records being
written down as a bug found.

So `panel-row-skips-parameter` skips a parameter **and moves the build's own tripwire out of
the way in the same breath**, which is the sharper question anyway: if the generator filtered
wrongly and the build's own count agreed with it, would anything notice? It has to be answered
by a count the *tool* recomputes from the registry — `editor-check` section 1 diffs
`params.names()` against the ids its sweep found, and fails naming the parameter. Reading a
count the page reports would be the mutation editing its way past the check. The one-edit form
was measured separately and by hand: it refuses to boot with `emitted 53 rows for 54
parameters` and never publishes `__kinect`.

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

### A fourth dead zone, and this one was written into a design decision as a fact

Step 3 of the effects rework added `rgbSaturation`, and the spec said a probe for the
colourless-take path would stand in a dead zone because `captures/sample.knct` carries real
JPEGs, so `hasColor == 1` in every arm of every tool. The first half is right and the second is
false of the one tool that matters here: `registry-check` builds its own fixture with the
colour block dropped, because a JPEG decode is asynchronous and a pinned run that raced it
would hash a frame whose colour had or had not landed — and `drive.pin` therefore sets
`hasColor = 0` itself. Every point in every arm draws a flat `vec3(0.7)`, and **saturation of a
uniform grey is the identity at every value**, so the drop-one sweep would have recorded a new
look parameter as one that cannot touch a pixel.

The answer was to move the probe rather than to write the name into `NO_PIXEL_EFFECT`:
`drive.plantColor` takes four saturated pixels from the check, and the arm asserts `hasColor`
came back 1, because a plant that silently failed leaves the grey behind and the sweep then
reports a dead zone as a measurement. **A tool's own synthetic fixture is not the take the
program ships with, and a claim about "every arm" has to be read off the arms.**

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

**A comment containing a backtick inside a template literal ends the literal.** The shader
source, `timeline-check`'s page ARM and `export-check`'s `EDITOR_ARM` are all backtick strings,
and prose written into them in this repo's house style reaches for backticks around identifiers
by reflex. Three times in one step the file stopped parsing at a word in a comment —
`SyntaxError: Unexpected identifier 'opacity'` — which reads as a code error at a line
containing no code. Inside a template literal, name things in plain words. It happened a fourth
time in step 3 of the effects rework, `Unexpected identifier 'rgb'`, at a comment explaining why
a mix is guarded.

**`page.evaluate(fnSourceString, arg)` does not call the function.** Playwright evaluates the
string as an expression, so the arrow function is created, never invoked, and `undefined` comes
back - which surfaced three helpers later as a missing shot rather than as a call that did not
happen. The house pattern is `page.evaluate(\`(${FN})(${JSON.stringify(opts)})\`)`, and it is
what the other tools already do.

**Adding rows to the panel broke a check that never mentioned the panel.** `#panel` is
`position: fixed` at z-index 10 over the stage with `overflow-y: auto`, so `editor-check`'s
`lit()` — a screenshot clipped to `#stage` — had always been counting panel pixels alongside the
cloud. That was invisible while the panel never moved. Five new sliders made it taller,
`#cropReset` fell below the fold, Playwright scrolled it into view before clicking, and the
"open the box" row compared a frame against the same frame with the panel shifted a few pixels:
386 differing pixels in 202 thousand, reading exactly like the cloud failing to come back.
Hiding the panel for the length of the screenshot takes that row to **0.000%**, where the
pre-change build measured 0.014% — so the repair is better than the state it restored. This is
the letterboxing rule below in its second form: **a change to the panel's height is a change to
where every fixed overlay sits, and any tool screenshotting a region that overlay covers is
measuring it.**

**Feeding today's look into a historical build is a units error, and it reads as the feature
under test having failed.** `export-check`'s cross-build arm plays a pre-rebase revision where
`pointSize` is pixels at the drawing buffer rather than at 1080p. Merging today's Blackwall
document into every arm — so that both builds "end up at the same twelve numbers" — wrote 8.1
into a build for which 8.1 means something 1.8 times larger: the old arm drew 1.82..3.8px where
it should draw 1.02..2.1px, and both rebase rows came back at luminance ratio 0.342 against an
expected 1.0. That is the whole look appearing not to rebase, caused entirely by the instrument.
**Each build applies its own graded values**; the one that still has `setMode` is left to.
Caught by A/B against a worktree at the previous commit, which is the only thing that separates
"my change broke this" from "this was already red".

**Letterboxing the editor stage moved every pointer coordinate and every buffer-size
expectation, and four proof tools found out one at a time.** `export-check` needed two separate
fixes, `registry-check` failed its render-scale row, and `keyframe-check` failed four rows in a
way that read as a missing feature — `camera.project()` answers in canvas coordinates and
`page.mouse` takes viewport ones, which were the same number only while the canvas sat at the
window's corner. **When a change moves where the canvas is, the tools that drive it by
coordinate are all suspect, not just the ones that mention size.**
