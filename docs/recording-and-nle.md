# Recording, gallery and non-linear editing

The idea: treat a `.knct` capture as raw footage. Record a scene once, then
re-photograph it afterwards in an editor — move a virtual camera, keyframe the
look, scrub a timeline — and bake the result to a 2D video through FFmpeg. The
sensor data stays untouched, so the same take can be re-cut and re-graded
indefinitely.

The capture format for this already exists. `--record` writes the grabber's
stdout verbatim, so a capture file is byte-identical to the live stream and
`--replay` feeds the viewer from it. What does not exist is everything that
turns a stream into footage: an index, take boundaries, a library, a timeline,
keyframes, and a deterministic renderer.

This document is a design, not a plan of record. Numbers marked measured come
from `performance-investigation.md` or from runs cited inline. Everything else is
called out as open.

## Terms

Used precisely throughout. The first two are the pair most likely to be confused.

- **Source time** — a position inside a capture, in milliseconds from its first
  frame.
- **Program time** — a position inside an edit, in output seconds from its start.
  The playhead and every keyframe live here.
- **Retime curve** — the track mapping program time to source time. A constant
  slope is normal speed, a shallow one is slow motion, a zero one is a hold.
- **Transport** — the single thing that answers "what time is it". There are
  three: live, timeline, export.
- **View** — which cameras render and where they land on screen. Independent of
  transport, and composed with it.
- **Layer** — a shading mode read as one of several ways of seeing the same
  recording: RGB, depth, ghost, contour, Blackwall. A view decides where an image
  lands; a layer decides what the image says.
- **Take** — one recording. One take is one file.
- **Pre-roll** — frames rendered and discarded ahead of a seek target, to bring
  the accumulators to the state they would have held.
- **Draft scrub** — a single frame with the accumulators bypassed, rendered while
  the playhead is being dragged. **Accurate seek** is the same position rendered
  with full pre-roll.
- **Capture node** — the machine that solves depth and writes takes. It is not
  necessarily the machine that edits or renders.
- **Preset** — a named, saved set of *look* parameter values, without keyframes
  and without camera or retime data. Applying one copies its values into a
  project and stamps the revision they came from.
- **Mark** — a flagged moment on a take, stamped in source time and stored in the
  take's sidecar. Set during recording or while editing; shared by every project
  built on that take. Not a keyframe — it annotates footage, it does not animate
  anything.
- **Decimation** — reduced depth resolution and frame stride, negotiated per
  client. Never applied to what is written to disk.

## The inversion is the whole project

The viewer is a live consumer. A frame arrives, it renders now, and wall-clock
time drives every stateful thing in the pipeline. An NLE needs the opposite
contract: given a timeline position `t`, produce the exact image, the same way
every time. That inversion is the load-bearing change, and almost every other
item here depends on it being done first.

The wall-clock sources that have to move onto a transport clock the timeline
owns:

- **`uniforms.time` and `grade.uniforms.time`** (`web/main.js:922-923`), fed from
  `clock.getElapsedTime()`. These drive turbulence, the scan sweep, grain, glitch
  and the RGB split, so today the same second of footage renders differently
  depending on how long the tab has been open.
- **`sinceFrame` → `uniforms.mixT`** (`web/main.js:933-935`), currently "how long
  since this frame arrived". It has to become "where the playhead sits between
  the two bracketing capture timestamps".
- **`arrivalDt`** feeding the surface-memory pass (`web/main.js:907`). It has to
  become the recorded gap between the two capture frames, which is already in
  the file.
- **OrbitControls damping** (`web/main.js:32`, updated at `:937`). This is a
  frame-rate-dependent filter sitting between any camera value and the actual
  pose. Keyframes must write `camera.position` and `camera.quaternion` directly
  and bypass the controls, or the same move renders differently at a different
  output frame rate.
- **`controls.autoRotate`**, behind the `spin` checkbox (`web/main.js:675`). It
  advances on wall-clock delta, so it is a second camera-side wall-clock source
  and needs the same treatment.

Nothing demos from this refactor, which is exactly why it is easy to defer and
expensive to defer.

## Program time is the coordinate, and one curve maps it to source

Recorded as [ADR-0001](adr/0001-program-time-as-the-edit-coordinate.md), because
every saved project carries this unit implicitly and changing it later means
migrating project files.

The inversion needs a defined coordinate or it means nothing. **The playhead and
every keyframe live in program time — output seconds from the start of the edit.**
A single retime curve, itself an ordinary track in program time, maps program
time to source time. Rendering one output frame is then a straight pipeline with
no special cases:

```
output frame k
  → programTime = k / outputFps
  → evaluate every track at programTime        (camera, look, retime)
  → sourceMs = retime(programTime)
  → binary-search the index → frameA, frameB
  → mixT = (sourceMs - tA) / (tB - tA)
```

The alternative — keyframing in source time and applying retiming on top — reads
well until export, which then has to invert the retime curve to learn which
source time each output frame wants. That requires the curve to stay monotonic,
so a hold or a reverse breaks it. Program time has no inverse to compute, which
is why a speed ramp is just another track rather than a special case.

**A hold works; a reverse does not, and the reason is the accumulators rather
than the coordinate.** That sentence names a reverse as something the *inverse*
approach cannot express, and program time indeed has no trouble describing one —
but nothing downstream can render it. Surface memory and the afterimage are
walked forward one source frame at a time and neither can be stepped backwards,
which is the same property that makes a seek cost pre-roll. Rendering a reverse
would mean clearing and re-rolling from scratch for every output frame in the
region, which is a different design rather than a missing feature.

So the retime curve is **constrained monotonic non-decreasing at the editing
doors** — a key cannot be dragged below its predecessor, and an ease handle
cannot overshoot into a descending segment. A curve that descends is refused
where it is authored rather than caught where it is rendered, because the failure
at render time is the backward-seek guard firing inside the animation loop, and
that is a dead page rather than a bad frame.

**Frame index is not a usable coordinate here.** It is tempting because lookup
becomes `floor`/`ceil` with no search, but this sensor's arrival spacing was
measured at p50 64ms against p90 222ms on a degraded link. Capture frames are not
evenly spaced in time, so constant motion through index space is visibly variable
motion through real time, and a keyframe's timing would shift with the capture
rate of the take it sits on.

The choice picks a semantic for the virtual camera, and it is worth stating
plainly: keys in program time mean the camera keeps its own pace when the footage
slows, because it is a camera in the room at viewing time rather than something
glued to the subject's action. Slow the footage to a quarter speed and the camera
move does not slow with it.

**`fade` and `wake` stay in source milliseconds.** They are the one place where a
source-time quantity lives in a program-time world, and they stay source-referred
for three reasons. The accumulator already advances per source frame, so no
conversion is needed. `fade` is the correctness half — it cross-fades a ray swap
that happens *between two source frames*, so it has to span the source gap or it
stops doing its job. And a program-referred duration has to be converted through
the local retime slope, which is zero at a hold, so every trail would snap off in
a single frame exactly where a freeze should hold the look still.

The visible consequence is that on-screen persistence varies with speed while
spatial trail length does not. At quarter speed a 550ms wake covers the same
motion through the scene and lingers 2.2 seconds on screen. That is the right way
round: slow motion exists to examine the motion, and a program-referred wake
would shrink the trail to nothing precisely when it is being looked at hardest.

## One renderer; transport, acquisition and view are separate axes

There is one app and one renderer. A **transport** is the only thing that answers
"what time is it", and live viewing is the degenerate case rather than an
exception:

```
LiveTransport      playhead pinned to the newest arrival
TimelineTransport  playhead driven by the timeline
ExportTransport    playhead stepped k / outputFps, no wall clock at all
```

That makes the inversion total instead of bolted on. The live path stops having
its own wall-clock loop, so it cannot silently drift from what the editor and the
export renderer produce — which is the same drift failure this document rejects
for renderers, one layer down. The cost is that the working live viewer is the
first thing the refactor touches.

**Frame acquisition is a third axis, below the renderer.** A transport says what
time it is, but it does not say where the bytes come from, and live and timeline
genuinely differ there: you cannot request a frame the sensor has not produced
yet, and you know exactly which frame you want when the playhead is at 4.2
seconds. So live frames arrive pushed over the WebSocket and timeline frames are
pulled through the HTTP frame API, behind one interface:

```
FramePairSource.at(t) → { texA, texB, mixT }

LivePairSource      ← WS push, newest two arrivals
IndexedPairSource   ← HTTP pull, binary search on the index
```

This seam is acceptable where the others were not, because it sits **below** the
renderer. Both sources converge on the same input — two depth textures, colour,
and a blend fraction — so the renderer never learns which one fed it, and there is
still exactly one clock and one image pipeline. The rejected alternatives each
collapsed the axis at a real cost: making the live view read the tail of a file
unifies acquisition but forces recording to run permanently and puts a write-read
round trip into monitor latency, and pushing everything over the WebSocket costs
HTTP caching, range requests and a stateless export client.

**View is a fourth axis.** Transport says what time it is, acquisition says where
the bytes come from, and a **view** says which cameras render and where they land
on screen. All of them compose freely, which is what makes the next item cheap
rather than another mode.

**Monitor view: colour reference plus a top-down orthographic.** When the capture
node is a small machine in another room, the questions are whether the subject is
framed, lit, and *inside the depth clip* — and the third one is the hard one to
judge from a front-on render. A top-down orthographic projection of the same
point cloud answers it immediately, which is exactly what the `near`/`far`
sliders control. It costs nothing new: same geometry, same shaders, a second
camera with a different projection.

The colour half is already free, because a JPEG of the registered image is in
every frame.

This is worth building for the editor and not only for monitoring. A top-down
view showing the point cloud plus the virtual camera's frustum is the most useful
navigation aid available when keyframing a camera move, because a camera path is
the one thing you cannot judge from inside the camera.

**A monitor negotiates decimation on the existing stream.** This is a **network**
concession and never a compute one — the capture node sustains full rate, so
decimation exists solely because a radio link cannot carry what the sensor
produces. It is worth stating plainly because the two get conflated: a faster
capture node does not make Wi-Fi faster, and a slower one would not have made
decimation any more necessary.

A full frame is 486KB, so monitoring at rate is 14.6 MB/s, or 117 Mbit/s — fine
over ethernet, implausible to a phone in another room while the node is also
writing 14.6 MB/s to disk. The client asks for a depth divisor and a frame
stride, and the sender samples down before transmitting:

| | bytes/frame | at 10fps |
| --- | --- | --- |
| full | 486 KB | 14.6 MB/s at 30fps |
| depth ÷4, colour as-is | ~80 KB | 0.8 MB/s |

A decimated frame is still a KNCT frame, so it is the same parser, the same
renderer and the same code path — which is why this beats a purpose-built monitor
endpoint that would need a second format kept in sync for a marginal saving.
Nearest-neighbour sampling of u16 depth is trivial work on the capture node, and
**what goes to disk is unaffected**: the recording is always full fidelity
regardless of what any monitor asked for.

Note that colour dominates a decimated frame — 52KB against 27KB of depth — and
that a monitor pulling every third frame lands almost entirely on JPEGs the
grabber re-encoded from unchanged pixels. The monitor is therefore the strongest
case for caching the colour encode rather than redoing it per frame: it pays that
redundancy on every single frame it asks for, and it is running on the machine
with the least CPU to spare.

Rendering on the sender and streaming pixels was rejected. It is the cheapest
option on the wire and it loads the one machine with no budget to spare, on top
of splitting the monitor's look away from the editor's.

**Decimation is set by the user and always visible. It never downgrades itself.**
An automatic quality drop under congestion is the wrong behaviour here, because a
monitor is an instrument and an instrument that silently changes its own scale is
worse than none — coarse depth reads as a badly placed subject, and a dropped
stride reads as a sensor losing frames. Both would be misattributed to the scene.
The current setting stays on screen, and a link that cannot sustain it says so,
the same way the grabber already reports colour rate alongside depth rate because
a lagging colour stream is otherwise misread as a stale image.

## Seeking costs pre-roll, and the cost is computable

Two feedback accumulators mean the image at `t` is not a function of the frames
at `t` alone.

**Surface memory** is the ping-pong float target that remembers where each ray
used to be and how long ago it swapped. **The afterimage pass** holds a damped
copy of the previous output. Neither can be reconstructed from a single frame,
so seeking means rendering some frames before the target and discarding them.

The two halves size differently, and the warm-up has to be computed from both
rather than fixed at a constant:

- **Fade and wake are in capture frames**, because they are specified in
  milliseconds of sensor time. Blackwall's 120ms fade plus 550ms wake is 670ms,
  or about 20 capture frames at 30fps. That is a few milliseconds of work.
- **Afterimage damp is in output frames.** Residual after `n` frames is
  `damp^n`, so reaching 1% residual takes `ln(0.01) / ln(damp)` frames — about 7
  at Blackwall's `trails` of 0.5, but over 90 at 0.95. It scales with output
  frame rate, not capture rate.

So warm-up length is a function of fade, wake, damp and output fps. Compute it
per seek. The worst realistic case is still well under a second of hidden
rendering, which makes scrubbing tractable rather than something to design
around.

**Dragging renders draft, releasing renders true.** Pre-roll is inherently
sequential — every accumulator step depends on the one before it — so it cannot
be parallelised and dropping resolution barely helps. Estimated at roughly
100–200ms per seek once frame fetch and JPEG decode are counted, that is
comfortable for a click and a slideshow for a drag.

While the playhead is being dragged, the editor renders a **single frame with the
accumulators bypassed** — `fade`, `wake` and `trails` forced to zero, no
pre-roll. On release it runs the full pre-roll and lands on the true image. The
cost is that the picture visibly changes when the drag ends, which is a
well-understood convention rather than a surprise.

Draft reads the master like everything else, and it is cheaper than this document
first estimated. Measured in headless Chrome against a real frame served over
loopback, 32 samples after warmup:

| step | p50 | p90 |
| --- | --- | --- |
| fetch depth (434KB) | 0.9 ms | 1.1 ms |
| fetch colour (52KB) | 0.6 ms | 0.8 ms |
| JPEG decode | 0.9 ms | 1.0 ms |
| upload + render | 0.2 ms | 0.3 ms |
| **total** | **2.7 ms** | **3.0 ms** |
| total, colour skipped | 1.0 ms | 1.2 ms |

The earlier 5–8ms estimate was conservative by two to three times. At 2.7ms a
drag can resolve well over 300 positions per second, so the master is not merely
adequate for draft scrubbing, it is comfortable. Treat the render component as a
floor rather than a precise figure — 0.2ms reads low against the 0.83ms point
pass measured by amortised repetition in `performance-investigation.md`, so the
honest total is nearer 3ms.

The expensive thing about an accurate seek was never resolution, it was the
sequential accumulator walk, and draft skips exactly that.

Rendering draft everywhere and only running the accumulators at export was
rejected. Blackwall's 550ms wake is a large part of what the image *is*, so
grading against a version that never shows it would mean keyframing a look
nobody can see — which discards the WYSIWYG property that the single-renderer
decision exists to protect.

## Retiming falls out, and it changes what a capture node has to be

Once `mixT` comes from timeline position rather than arrival time, the
interpolation already in the viewer stops being a smoothing hack and becomes a
retiming engine. Output frame rate decouples from capture frame rate: 60fps out
of a 30fps capture, slow motion, keyframed speed ramps.

The consequence for the capture side is larger than it first looks. The capture
node's only job becomes solving depth and writing takes with honest timestamps.
It does not have to hit any particular rate, because the renderer decides what
comes out, so a node sustaining only 12–15fps would still be usable for a lot of
material.

**That safety net turned out not to be needed.** A Pi 5 sustains 30.20fps on the
GL depth path, so full rate is the expected case and a reduced-rate capture is a
fallback rather than a plan. Retiming therefore goes back to being what it should
be — slow motion, speed ramps, 60fps output from 30fps capture — rather than a
crutch compensating for a slow node. It is still what makes the deterministic-time
refactor pay for itself twice, and it is no longer load-bearing for the capture
node.

Be straight about the cost. Interpolating 15fps to 30 is synthesized motion. The
snap-versus-lerp threshold — already validated against synthetic depth planes, a
1200mm jump landing on the new depth and a 100mm drift landing on the midpoint —
is what stops a moving hand from smearing through empty space for 66ms. It is
what keeps the result from looking broken, not what makes it correct. Slow
deliberate scenes hold up. Fast motion will show it. That is a material-dependent
tradeoff to make per shoot, not a free win.

## One parameter registry, sliders as views on it

Parameters currently live in four places: `uniforms.X.value`, `bloom.strength`,
`afterimage.uniforms.damp`, and `grade.uniforms.*` — with the DOM sliders as the
actual source of truth, written through `dispatchEvent(new Event('input'))`.

That has to become a single declarative registry: name, default, range,
`apply(value)`, and an interpolation kind. Then keyframes, project files,
presets, and shipping a look to a remote renderer are all the same operation on
one object.

Three interpolation kinds cover the surface:

- **Scalar tracks** lerp, with ease handles. Most sliders.
- **Step tracks** hold until the next key. Every checkbox. Lerping a boolean is
  meaningless.
- **Pose tracks** carry position, orientation and field of view together.
  Catmull-Rom on position reads far better than linear for a camera move.

**The mode is a property of the clip, not a track of any kind.** An earlier
version of this section made it a step track, on the reasoning that a mode index
cannot be lerped so it must hold. That is true and beside the point: the question
is whether the mode should be able to change *within* a clip at all, and for a
first version it should not. One take, re-photographed, is one reading of it.

That deletion is what resolves the problem the rest of this section was written
to manage. `applyMode` rewrites eleven other sliders when entering or leaving
Blackwall, plus the additive blending toggle and the fog colour
(`web/main.js:686-704`), which makes mode-change and param-change the same
operation — and under keyframes, a mode key silently stomping every other track
is almost certainly not what anyone wants. With one mode per clip there is no
mode key to stomp anything: selecting Blackwall sets the look's starting point
once, as a user action, and the tracks are ordinary tracks from then on.

**Presets still apply on user action only, never during timeline evaluation.**
That rule is unchanged and now stands alone, since the mode selector was the
awkward case it had to cover.

Multi-mode clips are not ruled out, only deferred. Should they ever be wanted,
the mode becomes a step track and this paragraph is the thing to revisit — but
the `applyMode` problem comes back with it and would need solving properly rather
than by writing keys and hoping.

## The editor is braindance-shaped: camera in the world, look in tracks

The reference idiom is the braindance editor — stepping through a volumetric
recording, switching between readings of it, scrubbing back over the same moment.
Three parts of it are already decisions in this document under other names:

- **Shading modes are layers.** RGB, Depth, Ghost, Contour and Blackwall are the
  same recording read different ways, which is exactly the layer-switching idiom.
  Braindance switches layers live while the recording plays; here the mode is
  chosen once per clip, so the idiom survives as *which reading am I working in*
  rather than as something that changes under the playhead.
- **Marks are hotspots.** Moments flagged in the room, surfaced on the timeline.
- **The top-down orthographic is the path editor.** Specced for monitoring depth
  placement, and it is the natural surface for editing a camera move.

**But braindance is a viewer, not an editor.** It has no keyframing at all, so
the idiom has to be extended rather than copied, and the extension splits along
an axis this document already draws:

```
┌─ 3D view ──────────┬─ top-down ─────────┐
│  cloud + frustum   │  ●──●───● path     │
│                    │  └ drag the nodes  │
├────────────────────┴────────────────────┤
│ ▸ ─────◆────────◆──────█───────  marks  │
│ bloom  ──◆────────────◆──────────       │
│ wake   ──────◆──────────────────        │
└─────────────────────────────────────────┘
```

**Composition is edited in the world.** The camera path draws as a curve in the
3D view and in the top-down, keys are nodes you drag in space, and scrubbing runs
a ghost camera along it. A camera move is the one thing you cannot judge from a
graph — editing `position.x` as a curve while the actual question is where it
flies through the room is the classic mistake, and the top-down view answers that
question directly because the camera is the one object you cannot see from inside
it.

**Look is edited in tracks.** `bloom`, `grain`, `wake` and the rest have no
spatial meaning, so they get conventional keyframe tracks under the timeline with
ease handles. Inventing an in-world metaphor for a scalar buys novelty at the
cost of being able to type 0.5.

The split is not arbitrary: it is the **same look-versus-composition axis that
decides what a preset contains**. One concept governs both, which is why a preset
never moves your camera and why the camera never appears in a track list.

### One sensor gives a shell, not a volume

Worth stating plainly, because the aesthetic invites the opposite assumption. A
single static Kinect records 2.5D — a depth shell from one viewpoint. The virtual
camera can orbit it, but there is nothing behind anything: turn far enough and
you are looking at the edge of a card with a void behind it. Braindance's whole
premise is moving freely inside a volume, and no amount of styling gets there
from one sensor.

Two routes close that gap, and they are very different in cost:

- **SLAM.** Move the sensor during capture, track its pose, fuse frames into a
  single reconstruction — KinectFusion territory. It gives a genuine volume from
  one sensor and it is a separate project, not a feature.
- **Several capture nodes, one viewpoint each.** Much cheaper, and this
  architecture nearly gives it away. Multi-Kinect is painful on one machine only
  because each sensor reserves 2.16 Gbit/s and will not share a controller —
  which stops mattering the moment each sensor has its own node. Takes are
  already independent and hash-referenced, so a multi-view project is a project
  naming several captures plus a calibration transform between them.

Neither is in scope for a first version. The second is worth keeping in view
while shaping the project file, because "a project references one capture" and "a
project references several captures with transforms" are not far apart, whereas
retrofitting the first into the second later is.

## Presets are user-authored, and they carry look rather than composition

Presets are how a set of clips stay coherent when each is exported on its own, so
they have to be creatable and savable by the user rather than the two hardcoded
mode presets that exist today.

**A preset carries a subset of the registry, and the split is look versus
composition.** Applying a look must not move your camera — that is the whole
reason a preset is not just a saved project. So the registry tags each parameter,
and a preset captures only the look side:

| | examples |
| --- | --- |
| **look** — presettable | mode, additive, bloom, trails, rgbSplit, scanlines, grain, glitch, point size, scan, rim, fade, wake |
| **composition** — never in a preset | camera pose, retime curve, output fps, clip in/out |

The depth clip (`near`/`far`) is the awkward one, because it is a look control
whose right value depends on where the subject actually stood. Saving a preset
therefore picks which parameters go in rather than taking a fixed set, with the
look tags as the default selection.

**Presets hold static values, not keyframes.** A preset with animation would need
its keyframe times remapped onto a clip of different duration, and there is no
correct answer to that — stretch, hold, or clip all produce something the author
did not mean. Static values have no such problem: a preset sets the starting
point, and any animation is authored per clip on top of it.

**Applying a preset is a user action that writes keys, never an evaluation-time
effect.** This is the same rule that governs the built-in mode presets, and it
matters more here: a preset silently re-applying itself during playback would
make the timeline lie about what it is showing.

**Applying copies the values in and stamps where they came from.**

```json
{
  "tracks": { "bloom": 0.5, "wake": 550, "…": "…" },
  "appliedPreset": { "name": "blackwall-mine", "rev": "sha256:9f2a…" }
}
```

The copy is what keeps a project self-contained, which the render queue depends
on — a worker needs the file and nothing else, and re-rendering a project from
last month produces the image it produced then, **on the same class of render
hardware** — see the pinning rule under the render queue below. Referencing a preset by name and
resolving it at render time would give centrally-updatable cohesion at the cost
of both those properties, and deleting a preset would break every project that
named it.

The provenance stamp recovers most of what the reference model offered, for
nothing. Because presets are content-hashed the same way captures are, the
gallery can see that three clips are on one revision of a look and two are on an
older one. Drift is not repaired automatically — tweaking a preset means
re-applying it to the clips that should follow — but it stops being invisible,
which is the part that actually bites when a set of clips is supposed to belong
together.

## Undo snapshots the project, and view state is not part of it

Undo keeps a stack of whole serialized projects, pushed at the **end** of each
interaction rather than on every input event. A project is tracks, keys, camera
path, retime curve and marks — small JSON, on the order of tens of kilobytes — so
a hundred levels costs a few megabytes and the memory argument that normally
favours a command stack does not apply here.

What that buys is that it cannot be got wrong. A command stack needs every
mutation path to implement both directions correctly, and an asymmetric undo is
the classic way an editor quietly corrupts someone's work. Snapshots have no such
failure mode: whatever the mutation was, the previous state is already captured.

**The line that matters is document state versus view state.**

| undoable | not undoable |
| --- | --- |
| keyframes on any track | playhead position |
| camera path nodes | orbiting to inspect the cloud |
| retime curve | panel visibility, render scale |
| marks | |
| preset application | |
| the clip's mode | |

**The mode moved columns, and the reason is that it stopped being a display
setting.** This table first listed "which layer is displayed" as view state, back
when the mode was a step track. Once the mode became a property of the clip its
selection *applies a preset*, which this same table lists as undoable — and the
two cannot be split. Selecting Blackwall writes twelve look values; an undo that
restored those twelve while leaving Blackwall selected would reconstruct a state
that never existed, which is the one failure a whole-project snapshot is supposed
to make impossible.

This distinction is sharper in this editor than in most, because the camera does
two unrelated jobs. Orbiting to look at something is navigation and must leave no
trace; setting a camera key is an edit. Snapshotting view state alongside the
document would mean a look-around floods the stack, so pressing undo walks the
camera backwards instead of reverting the last real change — which is exactly the
behaviour that teaches people not to trust undo.

Coalescing keys off commit rather than input: a slider drag pushes one snapshot
when the drag ends, not one per pointer move. The existing controls already
distinguish these, since `input` fires continuously and `change` fires on release.

## A project is independent of its take, and names it by hash

An edit lives in its own file, in its own directory, and identifies its capture
by content hash rather than by path:

```
captures/2026-07-30-take3.knct
captures/2026-07-30-take3.idx      index + content hash
projects/blackwall-v2.json
projects/wide-slow.json            same take, different edit
```

**Many edits of one take is the premise, not a feature.** The whole reason to
record raw is to re-photograph the same material more than once, so a project
file that lives beside its capture and owns it — `take3.knct` paired with
`take3.edit.json` — contradicts the thing being built. A second grade of the same
take would need a naming convention, which is this model again with worse names.

Hash-referencing buys two things beyond that. A render job becomes one
self-contained file that can be handed to a worker on another machine, which is
what the queue below depends on. And a hash mismatch catches a capture that was
truncated, re-recorded or swapped underneath an edit, which a path cannot.

The hash is computed once at import, in the same pass that builds the index, and
stored in the sidecar. Re-hashing multiple gigabytes on every project load would
be its own performance problem, and the import scan is already paying for the
read.

Browser-side storage was rejected outright: the headless export worker cannot
read IndexedDB, so every render would need an export step in front of it, and the
queue's entire premise is that a job is self-contained.

## Capture files: keep the format, add an index

The wire format stays as it is, because its best property is that live, recorded
and replayed bytes are identical. Append-only with no seek-back is also exactly
what you want when the writer is a small machine on a slow disk.

What is missing is a **sidecar index** — frame offset, capture timestamp, byte
length — written alongside the capture and rebuildable by a single scan at
import. A sidecar rather than a footer keeps the capture file append-only and
survives a writer that dies mid-take.

**The current replay path cannot be reused for editing, and it fails harder than
this document first claimed.** `startReplay()` reads the whole file with
`readFileSync` (`server/index.js:264`) and then copies every payload into a fresh
Buffer (`:275`), so peak resident memory is roughly twice the file size. That
half is measured and holds: a 1.38 GB capture of 2840 frames peaks at 2.84 GB
resident, 2.06x, across three runs varying by under 0.02%.

The other half was wrong. This document said Node 26 has no hard buffer ceiling
to fail against, so replay would simply consume the machine. The premise is
right — `buffer.kMaxLength` is 9007199254740991, so there is no *buffer* ceiling —
but `fs.readFileSync` enforces a separate 2 GiB cap of its own and throws
`ERR_FS_FILE_TOO_LARGE`. Bracketed with sparse files on Node v26.0.0, the
boundary is exact:

| file size | result |
| --- | --- |
| 2,147,483,647 (2 GiB − 1) | reads, full length returned |
| 2,147,483,648 (2 GiB) | `ERR_FS_FILE_TOO_LARGE` |

So replay does not degrade into swap on a long take. It refuses outright at
2 GiB, which at the measured 14.6 MB/s is about 147 seconds — **`--replay` cannot
open any take longer than roughly two and a half minutes.** The correction
strengthens the case for the reader rather than weakening it, because the old
scenario was weakest exactly where it would be tested: 8.8 GB resident is
survivable on a 64 GB machine, where a deterministic throw at 2 GiB is not
survivable anywhere. Editing needs a reader that `pread`s the frames the playhead
actually wants.

**The same ceiling binds the import scan, so the scan streams.** Hashing and
indexing in one pass is right, but doing it by reading the file whole would
reintroduce the identical throw one layer up, in the code written to escape it.
The scan reads incrementally and feeds the hash as it goes; the range endpoint
reads per frame or in bounded chunks for the same reason. Nothing about this
reaches the writer — a size cap or a rotation on the recorder would break the
one-take-one-continuous-stream invariant below, and the boundary is a property of
one doomed read path rather than of the format.

**That reader lives on the server, behind an HTTP frame API.** The browser asks
for a frame or a range, the server `pread`s against the capture and its index and
returns the payload unchanged:

```
GET /capture/:id/index          sidecar index: offsets, timestamps, lengths
GET /capture/:id/frame/:n       one frame payload, wire format unchanged
GET /capture/:id/frames/:a-:b   a contiguous run, for prefetch
```

The deciding argument is not throughput, it is that this is the only arrangement
where live viewing, local editing, editing a capture that lives on another
machine, and the headless export worker are all **the same code path**. The
browser reading the file directly through the File System Access API is faster
and simpler right up to the point where the export worker cannot use it — at
which point the HTTP reader gets built anyway, as a second path that drifts from
the first. That is the same failure this document rejects for renderers, and it
has the same cost.

Throughput is not the constraint. One frame is 486KB, so full-rate playback is
14.6 MB/s, which is what the WebSocket already sustains. Scrubbing costs one
frame per position rather than a stream, and over a genuinely slow link the same
decimation parameter the monitor negotiates applies here too.

A `FrameSource` abstraction with both an HTTP and a local-file implementation was
considered and rejected for now: an interface with one real implementation buys
flexibility that can be added later, at the cost of two paths to keep honest from
the first day. If editing over HTTP ever measurably hurts, a local source slots in
behind the same calls.

One smaller gap shows up immediately. **There is no wall-clock capture date.**
The frame timestamp is `steady_clock` (`native/grabber.cpp:75-77`), monotonic
since boot. It is the right choice for frame spacing and useless for sorting a
library, so the hello message needs a wall-clock start time added.

## A take is a file

`--record` is process-lifetime today, so "record a scene" means restarting the
server. Takes become first-class the simplest way available: **start opens a
file, stop closes it, and one take is one file.**

```
start → captures/2026-07-30-take3.knct
stop  → close, scan, write .idx + content hash
```

That identity — take is file is gallery entry is hash — is already assumed by the
project model, the frame API and the gallery, so anything else would have to
reconcile them. It also bounds a crash to one take rather than a session, and
because the format is append-only a half-written take is still readable: the
index is rebuildable from whatever bytes landed.

The alternatives both break something already settled. A single session file with
in-band take markers makes every take share a hash and a file, which the project
model cannot express, and one corruption costs the session. An always-on ring
buffer with retroactive keep is the genuinely tempting one — it catches the shot
you did not know you wanted, which is a real failure mode when you are setting up
in front of a sensor — but it costs sustained disk write forever, 14.6 MB/s at
full rate or roughly 7 on a 15fps node, and ring wrap plus slice-out is
substantial writer complexity. **The accepted cost is that the good thing that
happened just before you pressed record is gone.** If that turns out to bite in
practice, a bounded pre-roll ring is an additive change to the recorder rather
than a different take model.

**A grabber restart ends the take and opens the next one.** The server already
respawns the grabber with backoff, because the sensor dropping off the bus under
load is a designed-for condition rather than a fault. Without a rule, that would
append a second hello and a timestamp discontinuity partway through a take file.

```
grabber dies → close take3.knct, write its index
             → respawn
             → open take4.knct on the new hello
```

This preserves the invariant everything downstream assumes: one take is one
continuous stream, with one hello and monotonic timestamps. The index, the retime
curve and `mixT` all depend on it — a blend fraction across a restart seam has no
meaning, and the intrinsics in a second hello could legally differ from the first.

Nothing is discarded, it is only split, and a recording interrupted this way is
still fully usable as two takes. Abandoning the take outright was rejected for
throwing away good footage over an expected fault, which is the opposite of what
a raw-capture tool should do.

## Marks: flag the moment while it is still happening

The recorder has a **mark** button alongside record. Pressing it during a take
flags the moment, so that the thing you noticed in the room survives to the
editor instead of having to be found again by scrubbing.

**Marks live in an append-only sidecar, not in the capture.**

```
captures/take3.knct          untouched, still byte-identical to grabber output
captures/take3.idx
captures/take3.marks.jsonl   {"sourceMs":4210,"label":"mark 1"}
```

Two reasons, and the second is the deciding one. Injecting a marker message into
the stream would end the property that live, recorded and replayed bytes are
identical. More importantly, **a mark set while recording is the same object as a
mark added while editing** — and an in-band mark could never be added, moved or
renamed later without rewriting a multi-gigabyte capture. In-band storage would
therefore force two separate mark concepts and a sidecar anyway. Append-only also
means a crash keeps every mark written before it.

Marks are stamped in **source milliseconds**, because they describe the footage
rather than any edit of it. A mark survives retiming, outlives the project that
first displayed it, and is shared by every project built on that take.

**Marks are stamped raw, and nudged in the editor.** People press a few hundred
milliseconds after the thing happens, so every mark lands slightly late — and the
recorder does not try to correct for it. A pre-roll constant would be a guess
baked in at capture time, and marks are approximate signposts rather than cut
points: you scrub around one regardless, so a mark that is a few frames late has
already done its job by getting you to the right ten seconds.

Moving a mark is an ordinary edit, and because marks live in the take's sidecar
rather than in a project, a nudge is shared by every project built on that take —
you correct it once.

**Two machines can hold the same take and different marks, and the merge is a
union with last-write-wins per mark.** The capture is immutable and identified by
its content hash, so reconciling *it* is trivial. Marks are the opposite: mutable,
outside the hash, and now editable from either machine, since the library runs on
the node too. So a take that is `both` can genuinely diverge — someone flags a
moment on the node after the take was already downloaded.

The resolution falls out of properties this document already chose rather than
needing new machinery. The sidecar is **append-only**, so two logs concatenate
without locking or a merge algorithm. Each mark carries an **id**, so a move or a
rename is just a later record superseding an earlier one with the same id. Sync
is therefore: concatenate both logs, then for each id keep the record with the
highest timestamp.

```
node:  {"id":"m3","sourceMs":4210,"label":"mark 3","at":1..}
mac:   {"id":"m3","sourceMs":4180,"label":"the drop","at":2..}   ← wins, later
       {"id":"m7","sourceMs":9900,"label":"mark 7","at":2..}     ← union, new
```

Two things make this safe here that would not be safe elsewhere. Marks are
approximate signposts rather than cut points, so resolving to the wrong one of
two nearby edits costs a scrub, not a mistake. And a deletion is a tombstone
record like any other, so it cannot be resurrected by an older log arriving late.
The alternative rules were both worse: making the node read-only after download
removes the case marks exist for, and not syncing at all breaks the promise that
you correct a mark once.

**Record control rides the existing WebSocket channel.** The server already
accepts JSON control messages and already broadcasts state back to every client
(`server/index.js:106-121`), which is exactly the shape record needs: any
connected client can arm or stop a take, and every connected monitor sees the
recording state change. A phone monitoring a capture node can therefore start the
take it is watching, with no second control surface — and press **mark** on it,
which is the case that matters, since the person watching the monitor is the one
who sees the moment worth flagging.

### The recorder is a shooting surface, so it carries two look controls

Record, mark and remaining time are the load-bearing four-fifths of it, but a
monitor that cannot be made representative of the shot is a monitor people stop
trusting. Two controls earn their place, and both are for the person in the room
rather than for the footage:

- **A look preset selector**, drawing on the same user-authored preset library the
  editor uses. Shooting against the look you intend to grade towards is the whole
  reason presets are a library rather than two hardcoded modes.

  **The node keeps its own copy of that library on disk**, refreshed when an
  editing machine connects. It has to, because the node serves its own recorder
  page and may well be shooting with nothing connected to it — a scheme that
  pushed presets over the WebSocket per session would leave a standalone node
  with an empty selector, which is exactly the shoot where the operator cannot
  go and fix it. Presets are content-hashed like captures, so the sync is the
  same reconciliation the gallery already does: compare revisions, copy what is
  missing. They are also tens of kilobytes of JSON rather than gigabytes, so
  there is no reason to be clever about when it happens.
- **A near and far preview range**, so the operator can cut the room away and see
  the subject as the shot will frame them.

**The preview range hides; it does not prune. This distinction is the one thing
in the recorder that must not be got backwards.** The project has two clips that
look alike and are not:

| control | where | effect |
| --- | --- | --- |
| `nearClip` / `farClip` | viewer uniforms, `web/main.js:205-206` | hides points that already arrived |
| `--min-depth` / `--max-depth` | grabber flags | clips on the GPU before the frame is built, so they decide what exists at all |

The recorder's range drives the first and must never be wired to the second.
Capturing wide is free — the depth payload is a fixed-size array whether 40% or
90% of it is populated — so the grabber keeps taking everything the sensor can
resolve while the operator frames against whatever subset is useful. Getting this
backwards would silently destroy footage in exactly the situation where nobody is
watching for it, which is why the control says **preview only** on its face rather
than in a comment.

The same two numbers should drive whatever range display the monitor shows, so
that moving the control moves a region the operator can see rather than changing
an abstract number.

## Compression is worth measuring before designing around

Measured against `captures/sample.knct` — 284 frames, mean 424 KiB depth plus
51 KiB colour, 475 KiB per frame. Earlier estimates in this document and in
`performance-investigation.md` put depth compression in a 2–4x band. **The top of
that band is not reachable with zstd.**

| scheme | depth ratio | overall frame | seek |
| --- | --- | --- | --- |
| zstd -1, per frame | 1.75x | 1.62x | random |
| zstd -3, per frame | 2.02x | 1.82x | random |
| zstd -19, per frame | 2.30x | 2.00x | random |
| zstd -9, long window | 2.35x | 2.03x | sequential |
| **u16 temporal delta + zstd -1** | **2.75x** | **2.30x** | GOP-bound |
| u16 temporal delta + zstd -9 | 3.00x | 2.43x | GOP-bound |

Two results worth keeping. **A large window buys almost nothing on its own** —
2.35x at level 9 against 2.09x per-frame — because generic LZ matching does not
find the frame-to-frame correspondence. It has to be handed the delta explicitly,
and then the same codec at level 1 jumps to 2.75x. And **colour compresses at
1.00x**, exactly as expected for JPEG, so it is a hard floor: at 51 KiB it is
17% of a compressed frame and nothing will shrink it.

**Frame-independent stays the decision, and now it has a price: about 1.6x.**
Per-frame zstd -1 gets 1.75x where an explicit delta gets 2.75x. That is a real
cost, and it buys the thing the editor is built on — a draft scrub is one frame,
and a delta scheme would need a GOP, so every scrub position could decode up to
the group length to produce one image. Paying 1.6x of storage to keep a seek at
one frame is the right trade for an editor. If a capture node ever becomes
storage-bound rather than editing-bound, the delta scheme is the lever.

Throughput is not a constraint on either side. zstd -1 compresses a depth plane
at 497 MB/s on this machine, so 434KB is 0.87ms — under 3% of one core at 30fps,
and still comfortable on a capture node several times slower.

**Colour deduplication is the cheap win left.** The grabber re-encodes the
registered image every frame rather than caching it
(`native/grabber.cpp:295-300`), so when depth outruns colour — measured at 49% in
the OpenCL run — a large share of those incompressible 51 KiB blocks are byte
duplicates of the frame before. A back-reference meaning "same colour as the
previous frame" would remove them at a bounded cost, because colour lags depth by
at most an interval or two, so the walk-back is short and the frame stays
effectively independent. It also removes the wasted encode on the node that can
least afford it.

## Gallery

A manifest over a captures directory: poster frame, duration, frame count,
capture date, and the content hash that project files reference. Import builds
the index and the hash in one scan.

**Takes are tiles you can skim, not rows you have to open.** Moving across a tile
scrubs that take — the Final Cut idiom — and the take's marks sit on the scrub
bar underneath, so the moments someone flagged in the room are visible before the
take is opened at all. That is the payoff for putting marks in a sidecar on the
take rather than inside a project: the gallery can show them without loading
anything that knows about edits.

**Skimming costs different amounts depending on where the take is, so it should
look different.** A local take scrubs at the measured 2.7ms, which is smooth. A
remote one goes through the decimation parameter at roughly 21ms a position over
that 3.8 MB/s link, which is browsable but not smooth. A gallery that skims both
identically is promising a responsiveness the architecture does not have, so
remote tiles decimate visibly and say so. This is the same one mechanism, third
use — monitor, editor, and now the gallery.

**Skimming is a pointer affordance, so nothing may be gated behind it.** The
library runs on the node's touch panel as well, where there is no hover at all.
Download, open, reclaim and delete are buttons on the tile at all times; skimming
is how you *find* the take you want, never how you act on it.

**There is no proxy, and that is a deliberate deletion.** An earlier draft of
this document called for a reduced-resolution depth pyramid built at import, on
the assumption that scrubbing a multi-gigabyte capture directly would be
unpleasant. Settling what a draft scrub actually does removed the need: it is one
frame with the accumulators bypassed, and that has since been **measured at 2.7ms
against the master**, or 1.0ms with colour skipped. The expensive part of a seek
is the sequential accumulator walk, and no amount of resolution reduction touches
it.

So the gallery gains nothing from a proxy and would inherit a generation pass, a
second artifact per take and a staleness question. Editing over a genuinely slow
link is covered by the same decimation parameter the monitor negotiates, applied
to the frame API — one mechanism, two uses. A rendered video proxy was rejected
for a different reason: it bakes one look at import, so the draft image would
stop matching the edit the moment the grade changed.

The deletion was originally provisional on an estimate. That estimate has now
been measured and came in two to three times better than assumed, so the decision
stands on data rather than on a guess.

### One library, takes marked local or remote

The gallery is not "the Mac's takes" or "the node's takes" — it is a single
library spanning both, and each take carries where it currently lives:

| state | meaning |
| --- | --- |
| **remote** | on the capture node only, browsable, not yet downloaded |
| **local** | downloaded and hash-verified, full-speed editing |
| **both** | downloaded, node copy not yet reclaimed |

**Reconciliation is by content hash, not by filename.** Connecting to a node
lists its takes with their hashes, and anything whose hash is already present
locally is the same bytes by definition — so the library can say exactly what is
only over there, with no guessing from names, sizes or dates. This is the payoff
from hash-referencing captures in the first place.

**Download is explicit and per take.** Each remote take gets a download button
rather than a background sync that decides for you. The measured numbers make the
case: that Pi's Wi-Fi moves about 3.8 MB/s while capture writes 14.6 MB/s, so an
automatic mirror falls behind roughly fourfold during a shoot and copies a great
deal nobody will open. A five-minute take is 4.4GB — about twenty minutes over
that link, or twelve compressed — worth spending deliberately on takes you chose.

Remote takes stay browsable before download using the same decimation parameter
the monitor negotiates, which puts a scrub position at roughly 21ms instead of the
128ms a full frame would cost over that link. That is enough to judge what is
worth keeping. Once a take is local, browsing and editing run at the measured
2.7ms and the node can go offline entirely.

**Nothing on the node is ever deleted automatically.** A take reaching `both`
stays there until someone explicitly removes it. For a tool whose entire premise
is keeping the raw footage, silently evicting a recording is the one failure that
cannot be undone, and no eviction policy is worth that risk.

**Deletion is manual, and it is available from either machine.** The library runs
on the node as well as on the editing machine, so the operator who just filled a
card can clear space without walking to another computer. That makes the two
deletions genuinely different actions rather than one action with two buttons:

| action | when | weight |
| --- | --- | --- |
| **reclaim** | take is `both` | recoverable — a hash-verified copy exists elsewhere |
| **delete** | take is `local` or `remote` only | the last copy, and unrecoverable |

The second is the only irreversible action in this tool, and it gets a real
confirm naming the take, its length, its size, its marks and which machines hold
it. An optimistic delete with an Undo toast is the wrong pattern here: undo
windows expire, and this is a raw-capture tool whose entire premise is that the
footage survives.

**That makes the low-space warning load-bearing rather than polish.** The node
holds roughly 1.9 hours uncompressed, about 3.1 compressed, and with manual-only
deletion it will eventually reach the end of that — unattended, the failure lands
mid-shoot, which is the worst possible moment to discover a full card. Three
things follow:

- **Report remaining time, not bytes.** "1h 47m left at current settings" is
  actionable where "94 GB free" is arithmetic the operator has to do under
  pressure. It is also the honest unit, since the rate depends on capture rate
  and compression.
- **Refuse to start a take that cannot fit a sensible minimum** rather than
  failing partway through one. A take that never started is a decision; a take
  that dies at 80% is a loss.
- **Surface it on the monitor**, next to the recording state, since the monitor
  is the thing an operator is actually looking at.

Because takes are files and the format is append-only, a recording that does run
out of space is still readable up to the point it stopped, and its index is
rebuildable from whatever bytes landed. That is a floor, not a plan.

## Export: one renderer, driven headless

The classic failure here is writing a second offline renderer and discovering the
export never matches the preview. Avoid it entirely. Export is `ExportTransport`
driving the same renderer, stepping the playhead at `k / outputFps` with no wall
clock involved. Slower than real time is fine and is arguably the point — the
whole reason to record raw is to spend more time on the image than the sensor
had.

Remote encoding is then the same code driven by Playwright in headless Chrome on
a bigger machine. One renderer, one look, and local-versus-remote becomes purely
a scheduling question.

**Frames leave as raw RGBA over loopback into ffmpeg's stdin.**

```
browser  readPixels → WebSocket → server
server   ffmpeg -f rawvideo -pix_fmt rgba -s WxH -r FPS -i -
```

1080p RGBA is 8.3MB per frame, which looks alarming until you notice the browser
and ffmpeg are always on the same machine — headless Chrome runs on the render
box next to the encoder, so this is loopback and loopback sustains gigabytes per
second. Raw RGBA is also exactly ffmpeg's input format, so there is no encode
step in the browser, no decode step on the other side, and no generation loss
before the codec runs. Compressing to PNG or JPEG first would spend CPU, which is
the scarce resource in a slower-than-realtime render, to save bandwidth that was
never scarce.

`readPixels` is a GPU-to-CPU synchronisation point and will stall the pipeline
every frame. That is acceptable at export rates, and if it becomes the limit the
fix is asynchronous readback through a pixel buffer with a fence rather than a
different transport.

**Measured: headless Chrome renders this bit-identically on macOS.** The whole
architecture rests on one renderer producing one look, so this was the spike
worth running before anything else. Both halves came back clean.

Headless gets the real GPU, in every configuration tried — including the plain
default with no flags:

| launch | WebGL2 renderer |
| --- | --- |
| headed | ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max) |
| headless, no flags | ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max) |
| headless `--enable-gpu` | identical |
| headless `--enable-gpu --use-angle=metal` | identical |

`EXT_color_buffer_float` and `EXT_float_blend` are present in all of them, which
matters because the surface memory is a float ping-pong target and would fail
outright without the first.

Pixel output is bit-identical too. With every input pinned — synthetic depth
planes, `hasColor` off, fixed clock, fixed camera, both accumulators disabled —
headed and headless produced byte-identical PNGs for the plain point pass *and*
for the full Blackwall post chain with bloom, RGB split, scanlines and grain
enabled.

**So "identical" can mean bit-exact, and no compromise is needed.** The earlier
worry that bit-exactness would force a software rasteriser and a large slowdown
does not apply on the same machine and GPU.

**The feedback path is bit-identical too.** A first attempt at this proved
nothing — with a static input the afterimage converges to its own input, so it
returned the same hash as the accumulator-free render, which is arithmetic rather
than evidence. Re-run with the depth block moving across 30 sequential renders at
`damp` 0.85, the output changed as it should and headed and headless still agreed
byte for byte.

One limit remains, and it is worth keeping in view: this is **one machine, one
Chrome build, one GPU**. It says headless equals headed, not that two different
render boxes agree, so a heterogeneous render pool would need re-testing.

**Linux will not be this easy.** `--enable-gpu` is a Linux flag whose job is to
disable the software fallback — on macOS it changes nothing because there is no
fallback to disable. Chromium's own guidance notes that OpenGL driver
autodetection there wants an X display and `DISPLAY` set, and that
`--use-angle=vulkan` is what works on some configurations. A Linux render box is
therefore its own spike, not a port of this result.

**Resolution changes the image drastically, and the cause is the point pass, not
the post chain.** This document previously described the problem as screen-space
grain and scanlines drifting. Rendering the same pinned scene at a 960x600 and a
1920x1200 drawing buffer shows something much larger: at 2x the cloud goes sparse
and dark, and the RGB split degenerates into per-point magenta and green
aliasing across the whole surface. It is not the same image at higher fidelity.
It is a different image.

The dominant term is `gl_PointSize`, which is set in **framebuffer pixels**:

```glsl
gl_PointSize = clamp(pointSize * (1.0 / max(0.15, -mv.z)), 1.0, 64.0);   // main.js:373
```

It is scaled by distance but never by drawing-buffer height, so doubling the
buffer leaves each point the same pixel size while the frame has four times the
pixels. Coverage per point drops fourfold, the 217k points stop overlapping into
a surface, and the sub-pixel RGB split starts fringing individual points instead
of edges. The post chain contributes on top of this — bloom at half buffer
(`web/main.js:604`), grain and scanlines from `grade.uniforms.resolution`
(`:605`) — but it is the smaller effect.

**Every screen-space term becomes resolution-relative, against a 1080p
reference.** The look is then defined at one resolution and holds at any output
size, which makes output resolution an ordinary export setting rather than a
constraint:

```glsl
float k = drawingBufferHeight / 1080.0;
gl_PointSize = clamp(pointSize * k / max(0.15, -mv.z), 1.0, 64.0);
```

Grain and scanline frequency in the grade pass take the same factor.

**Bloom was claimed here to need nothing, and that was wrong.** It does run at
half the drawing buffer, but half the buffer makes bloom's *cost* proportional,
not its *appearance*, and the two were conflated. `UnrealBloomPass` bakes a fixed
tap count into its shaders at construction — `[6, 10, 14, 18, 22]` across the
five mips — while `setSize` scales the mip chain with the buffer. So a bigger
buffer gives each mip more texels while the blur still spans the same number of
them, and the halo's width *as a fraction of the frame* is inversely proportional
to buffer height: it halves every time the buffer doubles.

Measured on a pinned Blackwall scene at 1920x1200 against 3840x2400, the larger
arm box-downsampled to match, both then reduced 4:1 so per-pixel rasterisation
aliasing is not what is being compared. Mean channel difference out of 255, and
the ratio of mean luminance large-to-small:

| pipeline | mean diff | luminance ratio |
| --- | --- | --- |
| point pass only | 0.137 | 1.0000 |
| + trails | 0.427 | 0.9999 |
| + grade | 0.581 | 0.986 |
| + bloom | 13.077 | 0.851 |

The bloom row is the whole of the remaining residual, and the halo covers 100% of
the frame at the smaller size against 80.3% at the larger. **So the bloom chain is
sized against a fixed reference rather than against the drawing buffer**, which
makes the halo's frame-fraction constant and, incidentally, makes bloom's cost
constant instead of growing with output size.

**That reference is 600, not 1080, and the difference is not cosmetic.** Freezing
the chain anywhere makes the halo constant; freezing it at the height the look was
graded at is what makes it constant *at the glow the look was tuned for*. The halo's
width is a tap count over a texel count, so a chain with 1.8x the texels has a halo
1.8x tighter — and 1.8 is exactly 1080/600, the same factor `pointSize` was rebased
by. Both were tried and measured: the graded look at 960x600 against the whole of
Blackwall at 1920x1200, compared on forty tile means, lands at **7.16/255** on the
worst tile with the chain frozen at 1080 and **1.10/255** frozen at 600. So this is
the one place the 1080p *unit* and the graded *chain* are deliberately different
numbers, and `main.js` reads `bufferHeight / 1080.0` in the shaders beside
`(buf.x / buf.y) * 600` at `bloom.setSize` for that reason.

The price runs in both directions and the expensive direction lands on the machine
with the least to spare. A 4K export now pays 600-referred bloom, which is cheaper
than the buffer-proportional chain it replaces and the right way round for a render
that is CPU-bound anyway. A capture node previewing at 800x480 pays it too: a mip-0
of 250x150 against the 200x120 it used to have, 37,500 texels against 24,000, about
**1.6x on one pass**. Sized against the 1080p reference instead it would have been
121,500 texels, or 5.06x, which is the number that would have put the Pi's preview
claim in doubt. It does not, but the claim is still measured on the old chain and
step 9 re-measures it on hardware rather than scaling it on paper.

Two more screen-space terms belong to the same rule and were missed by the
enumeration above: `rgbSplit`'s offset is a constant pixel width, so its
frame-fraction halves at twice the buffer, and the additive normalisation
`36.0 / (vSize * vSize)` needs its size in reference pixels or the same look sums
four times too bright at twice the resolution. Both sit on Blackwall's path. The
rule is every screen-space term, and an enumeration is not the rule.

Fixing only `gl_PointSize` was rejected even though it is the dominant term and a
one-line change. It removes the obvious failure, where the cloud goes dark and
sparse, and leaves a subtler one behind: grain grows finer and scanlines denser
as resolution rises. A look that is *nearly* resolution-independent is worse than
one that is openly not, because it is the kind you trust and then have to debug.

Locking export to the preview's drawing buffer was the safe alternative and costs
too much: output resolution would stop being a choice, delivering 4K would mean
grading in a 4K window, and an 800x480 preview on a capture node could never
drive a real export.

**One migration cost to note.** Existing slider values change meaning once, since
`pointSize` becomes "pixels at 1080p" rather than "pixels". The two built-in
presets need re-tuning, and any project saved before the change would need its
point size scaled by the buffer height it was authored at.

## Deferred and remote encoding

The buffer idea generalises past any particular hardware. A render job is a
project file plus a capture reference plus output settings, and the project file
should reference the capture by content hash so a job is self-contained and
reproducible. A worker pulls jobs, runs headless Chrome plus FFmpeg, and writes
the output back.

**A job records its renderer class, and the queue only re-dispatches to a match.**

```
job: { project, capture: "sha256:…", renderer: "ANGLE Metal / Apple M2 Max" }
```

Bit-exactness was measured between headed and headless Chrome on one GPU. It does
not survive a different one — the Pi renders through `ANGLE (Broadcom, V3D
7.1.10.2, OpenGL ES 3.1)` and the Mac through ANGLE Metal, and those are
different rasterisers, not two speeds of the same one. Since the hash-referenced
project model exists precisely so that a re-render reproduces the original,
letting the queue silently hand a re-render to a different class of machine would
break the property the model is built on.

So a mismatch becomes an explicit scheduling failure that the queue surfaces,
rather than a subtly different image nobody notices until an A/B. The cost is
real and accepted: a Pi cannot finish a job a Mac started, and a spare machine of
the wrong class cannot help drain a backlog.

Recording the renderer from the first job matters more than the pinning does.
There is one render machine today, so the constraint binds on nothing — but a job
record without the field cannot be retrofitted once old jobs exist, and provenance
is exactly what you want on the day two workers disagree.

Build it for "record on the laptop, encode overnight" and the remote-capture case
is a deployment detail rather than a second architecture.

**A capture-capable node is not a render-capable node**, and the gap has now been
measured. The viewer runs unmodified on the Pi — same page, same shaders, over
`ANGLE (Broadcom, V3D 7.1.10.2, OpenGL ES 3.1)`, with float render targets
present so the surface memory works. Amplified timings, rendering N times per
frame so fixed overhead amortises out, against the Mac's figures from
`performance-investigation.md`:

| | Pi 5 (V3D) | M2 Max | ratio |
| --- | --- | --- | --- |
| point pass, 0.38 Mpx | 8.42 ms | 0.83 ms | ~10x |
| point pass, 1.54 Mpx | 7.74 ms | 0.83 ms | ~9x |
| + full post, 0.38 Mpx | 15.08 ms | ~0.87 ms | ~17x |
| + full post, 1.54 Mpx | 26.22 ms | ~1.1 ms | ~24x |

**The structural finding replicates exactly.** The point pass is
resolution-independent on the Pi too — 8.42ms at 0.38 Mpx against 7.74ms at
1.54 Mpx, flat within noise across four times the pixels — while the post chain
scales with area, 15.08 to 26.22ms. Same shape as the Mac, an order of magnitude
slower.

So the Pi is a genuinely good **preview** machine: the live loop holds 43fps with
the full Blackwall chain at its 800x480 display, and 60fps without post. A
capture node can therefore also be its own monitor, rendering the real look
rather than a stripped-down view — which is a better outcome than the decimated
monitor stream was designed for, whenever the screen is attached to the node.

**Export is where the ratio bites.** Extrapolating the post chain to 1080p puts a
frame north of 33ms of render alone, before `readPixels` and before encoding — and
encoding has no hardware to fall back on.

Note also that 30.20fps for the depth solve means the GL path keeps up with a
sensor that only delivers 30fps. It is not a measurement of how long the solve
takes, so that headroom remains unknown.

Encoding is the concrete obstacle, and it is verified rather than assumed. The
Pi 5 exposes **no hardware video encoder**: the only hardware codec device is
`rpi-hevc-dec`, a decoder, the fifteen `pispbe` devices are the camera ISP, and
`vcgencmd codec_enabled` reports H264 and HEVC both disabled. ffmpeg's
`h264_v4l2m2m` and `hevc_v4l2m2m` entries are wrappers with no hardware to bind
to. Every export there would be software `libx264` on four cores, competing with
the render for those same cores.

The deeper reason to keep the queue is that offload was never mainly about
capability. Slower than real time is the point of this design, so a node that
*could* render still should not be occupied for hours doing it when it could be
capturing the next take. And because a job is a self-contained project file
naming its capture by hash, "who renders" stays a scheduling decision — if the Pi
turns out to have headroom it joins the pool as another worker rather than
removing the pool.

## The capture-node question

Running the capture on a small machine and encoding elsewhere is the motivating
case for the queue above. Four independent gates decided it, each a hard blocker
on its own. **All four now pass, measured on a Raspberry Pi 5 Model B Rev 1.1**
(kernel 6.12.62, Mesa 25.0.7, V3D 7.1.10.2). The first three were measured with
libfreenect2's own Protonect, the fourth with our grabber cross-built for it.

**Gate 1: the link streams. PASS.** The depth endpoint reserves 2.16 Gbit/s of
isochronous bandwidth whether it uses it or not, and the sensor will not tolerate
a hub chain — 12.82fps three hubs deep against 30.00fps on a single hub on its
own controller. On the Pi 5 the sensor enumerates at **5000 Mbps SuperSpeed** and
is the only device on its controller:

```
Bus 002: root_hub 5000M
  └─ NuiSensor Adaptor 5000M          (the Kinect's own adapter, unavoidable)
     └─ Xbox NUI Sensor 5000M         045e:02c4
```

That is one hub, alone on the bus — the same topology that gives 30.00fps with
zero drops on the Mac. Access needs libfreenect2's udev rule
(`platform/linux/udev/90-kinect2.rules`), without which it fails
`LIBUSB_ERROR_ACCESS` in a way that reads like a hardware fault.

**Gate 2: the GL depth path sustains full rate. PASS.**

| pipeline | fps |
| --- | --- |
| **GL, depth only** | **30.20** |
| GL, with Protonect's synced colour listener | 14.97 |
| CPU (scalar) | 5.92 |

Measured differentially — `t(500 frames) − t(200 frames)` — so device open and
stream start cancel out rather than dragging the average down.

Two things make this work. VideoCore has **no OpenCL at all**, so the GL path is
the only accelerated option, and it happens to fit exactly: libfreenect2's depth
shaders are `#version 140` and the processor requests a 3.1 context with
`GLFW_OPENGL_ANY_PROFILE` on non-Apple platforms
(`opengl_depth_packet_processor.cpp:158,870-877`), while V3D reports OpenGL 3.1
core with GLSL 1.40. It is a precise match, not headroom — a library wanting 3.3
would not have run.

**The 14.97 figure is the trap this repo already solved.** It is almost exactly
half of 30 because Protonect uses a synced listener, and the Kinect's colour
camera halves to 15fps in dim light, so every other depth frame is discarded
waiting for colour. Our grabber decouples them precisely so this cannot happen,
which means it should see the 30.20 number rather than the 14.97 one. Retiming
turned out not to be needed to rescue this gate — but it is what made the gate
worth attempting before the answer was known.

The CPU path is out, as expected, and now gives the ratio this document
previously declined to estimate: 14.4fps on an M2 Max performance core against
5.92fps here is **2.43x**, comfortably better than the 3–4x guess that was
withheld for being unverifiable.

**Gate 3: storage holds easily. PASS.** The SD card sustains **76–80 MB/s**
(`dd`, 512MB, `oflag=direct conv=fsync`) against 14.6 MB/s needed at 30fps
uncompressed — about 5x headroom, before the measured 1.6x of per-frame zstd.
Note the first attempt at this wrote to `/tmp`, which is tmpfs, and reported
3.5 GB/s; on this image `/tmp` is RAM and measures nothing.

**Gate 4: the serial half of our own frame loop fits, with half the budget to
spare. PASS.** This one needed the grabber cross-built rather than Protonect, so
`--pipeline gl` and a cross-platform `native/CMakeLists.txt` came first — the
macOS libfreenect2 has OpenCL and no OpenGL, the Pi's V3D has OpenGL and no
OpenCL, so the pipeline choice is now guarded by the library's own capability
macros and asking for one that was not compiled in is an error rather than a
silent fall-through to OpenCL.

**The port also turned up a latent heap bug that macOS was hiding.** The grabber
zeroed `jpegSize` before every `tjCompress2` call while leaving `jpegBuf` pointing
at the buffer TurboJPEG allocated last time. That parameter is an input as well as
an output — it is the reused buffer's capacity — so the call was being told the
buffer held zero bytes. Homebrew's libjpeg-turbo 3.1.4 absorbs it; Debian's 2.1.5
on aarch64 does not, and the grabber died inside `tjCompress2` with SIGBUS or
SIGSEGV within seconds. Isolated by building the two variants side by side: with
the zeroing, three runs out of three crashed before the first hundred frames;
carrying the size across calls, every run streamed clean.

The fix is one line, plus a check on the return value, since a size that survives
the call would otherwise let a failed encode ship the previous frame's length as
if it were fresh. Whether libjpeg-turbo 3 is genuinely ignoring the size the way
its documentation says or merely absorbing a stray write was not chased down —
either way the grabber was leaning on version-specific behaviour it never needed.
Because the fix changes where `colorBytes` comes from, the framing was checked
rather than assumed: over a capture with 250 colour frames, every JPEG block
starts `ffd8` and ends `ffd9` at exactly the offset its declared length puts it,
none malformed, and an extracted block decodes as a 512x424 image.

Measured with `--profile`, which times each segment of the loop in microseconds
and dumps the per-frame records at exit so the profiling I/O cannot land inside
the loop it is measuring. 117s window, first 60 frames discarded, colour on with
the default low-light behaviour, stdout written to the SD card:

| serial segment | p50 | p90 |
| --- | --- | --- |
| `Registration::apply` | 13.13 ms | 14.00 ms |
| float → u16 depth conversion | 0.14 ms | 0.28 ms |
| `tjCompress2` | 1.39 ms | 1.46 ms |
| payload assembly | 0.13 ms | 0.23 ms |
| write to stdout | 0.24 ms | 0.38 ms |
| **total serial** | **15.05 ms** | **16.09 ms** |
| blocked waiting for the next depth frame | 18.42 ms | 18.99 ms |

That window predates the `tjCompress2` fix but ran the same `jpegSize` handling
the fix adopts, and the finished binary reproduces it: 15.23ms p50 and 16.53ms
p90 over a fresh 45s window.

**The same binary was then run on the Mac with the sensor attached, which is what
closes the gap the port left open.** The fix touches the primary platform's encode
path, and until now macOS had only been compiled and linked. Three runs, 477 to
660 frames each after discarding 60 of warmup: **720 frames captured with 704
carrying colour, zero malformed** — every JPEG starts `ffd8` and ends `ffd9` at
exactly its declared offset, every payload length agrees with its header, and an
extracted block decodes as 512x424. Sustained 30.00fps with arrival spacing at
p50 32ms and p90 34ms. The fix is now verified on both platforms rather than on
the one that needed it.

| serial segment | Mac p50 | Pi p50 | ratio |
| --- | --- | --- | --- |
| `Registration::apply` | 6.33 ms | 13.13 ms | 2.07x |
| `tjCompress2` | 0.61 ms | 1.39 ms | 2.28x |
| everything else | 0.17 ms | 0.51 ms | — |
| **total serial** | **7.12 ms** | **15.05 ms** | **2.11x** |

**That comparison corrected a figure this repo had been carrying unmeasured.**
Registration was quoted at 4.5ms on the Mac, which made the Pi look 2.92x slower;
profiled properly on the same M2 Max it is 6.3ms across three runs, so the real
gap is **2.07x** — close to the 2.43x single-core depth-solve ratio rather than
notably worse than it. The correction does not change any decision here, since
15.05ms of a 33ms budget passes either way, but the old number was inherited
rather than measured and is now fixed in `README.md` and
`docs/performance-investigation.md` too.

**The decoupling prediction holds exactly.** Our grabber sees **30.00fps depth
alongside 15.00fps colour**, not the 14.97 Protonect's synced listener produced —
half the depth frames reuse the previous colour, and none are discarded waiting
for it. Delivered rate over a two-minute recording to the card was 29.86fps for
1.73 GB, with the median frame arriving 33.4ms after the last one, which is the
sensor's own cadence.

**The ~17ms estimate was 13% high, and the reason is not what it first looked
like.** Read against the 4.5ms the repo then carried for the Mac, registration
appeared to scale at 2.92x — worse than the 2.43x single-core depth ratio — and
the encode appeared to scale far better than it, the two errors cancelling. With
the Mac profiled properly the picture is duller and more consistent: registration
scales **2.07x** and the encode **2.28x**, both a little better than the depth
solve's 2.43x, and the encode's advantage is the NEON path TurboJPEG has on
aarch64. Everything else in the loop adds 0.5ms and runs whether colour is
present or not. The estimate was simply high, rather than wrong in two directions
at once.

**Both levers work, and neither is needed.** Measured as interleaved A/B against
the baseline immediately preceding each variant, three rounds, all three paired
deltas positive in both cases:

| lever | serial p50 | p90 | saving | cost |
| --- | --- | --- | --- | --- |
| baseline | 14.90 ms | 15.78 ms | — | — |
| `enable_filter=false` | 3.97 ms | 4.24 ms | **10.92 ms** | colour bleed at silhouettes |
| colour-encode cache | 14.18 ms | 14.85 ms | **0.92 ms** | colour registered against the previous depth frame |

Each row is the mean of three 45s runs, which is why the baseline sits a little
under the 117s window above rather than exactly on it. The occlusion filter is
83% of registration on the Pi — 13.13ms falls to 2.14ms without it. The
equivalent split has not been measured on the Mac: an earlier 3.8-of-4.5ms figure
was quoted here, but the 4.5ms it rests on has since been shown to be 6.3ms, so
the proportion is unverified rather than confirmed.

The cache halves the encodes exactly as predicted — 100% of frames encoded down
to 50%, mean encode 1.48ms to 0.72ms — but it is not the free win it looks like.
`Registration::apply` resamples colour into the *depth* camera's frame, so
`registered` changes when depth changes even with byte-identical colour, and a
reused JPEG is therefore registered against the previous depth frame. Neither
lever ships: at 15.05ms of a 33ms budget the headroom does not need buying, and
both pay for it in image correctness.

### A third lever, and this one pays nothing

Both levers above buy time with image correctness, which is why neither ships.
There is a third that buys the same time and costs nothing, because it changes
how the work is done rather than what work is done — and it was found by looking
at what `Registration::apply` actually is rather than at what it costs.

**It is a scatter, not a per-pixel gather.** With the occlusion filter on — which
is what the grabber uses, and what every figure above was measured on — `apply`
is three passes: an 8.3MB init of a 1920x1080 filter map to `+inf`, then a
scatter writing a min-z into a 5x3 window of that map for each of 217,088 depth
pixels, and only then the per-pixel gather that builds `registered`. Different
depth pixels legitimately write the same colour pixel; that collision *is* the
occlusion test. So the 10.92ms that `enable_filter=false` saves above is the
init plus the scatter, and the obvious parallelisation — splitting the depth
loop across cores — is a data race rather than a speedup.

Two changes follow from that, both **bit-identical to upstream** rather than
merely close, which is the property the other two levers lack:

| change | Mac reg p50 | saving |
| --- | --- | --- |
| baseline | 5.76 ms | — |
| persistent scratch buffers | 5.41 ms | 0.30 ms |
| + threaded scatter, 4 threads | 3.69 ms | **2.07 ms, 36%** |

`apply` new/deletes 9.2MB of scratch on every call unless handed somewhere to
put them, and it has out-parameters for exactly that. The scatter then bands
across threads **by linear index rather than by row** — the loop never
bounds-checks `cx` on its own, so at `cx < 2` a window's left edge is a negative
offset landing in the previous row's tail, and threads owning adjacent row
stripes would collide precisely there. Banded linearly there is no seam and no
atomics are needed. Both measured as interleaved A/B/A/B/A/B against a build of
upstream's own scatter, three rounds, ~1000 frames per arm after 60 of warmup,
all six arms sustaining 30.03–30.04fps.

**The 6.33ms above and the 5.76ms here are the same measurement, not a
correction.** Registration's cost depends on how many depth pixels carry a valid
reading, so it moves with the scene; the gap is within what scene content and
session drift produce on this rig. That is the reason the comparison is paired
and interleaved rather than read against a number recorded on another day.

**The Pi picks the thread count, and it picked 2 — the Mac's answer was 4 and
would have been the worst setting on the node.** Measured with
`tools/pi-registration-ab.sh`, four cores, three interleaved rounds of a
40-second window per arm, upstream running as a control inside every round:

| arm | reg p50 | delivered fps | rounds losing frames |
| --- | --- | --- | --- |
| upstream | 13.49 ms | 29.66–29.84 | 0 of 3 |
| **2 threads** | **11.87 ms** | **29.56–29.75** | **0 of 3** |
| 3 threads | 10.03 ms | 27.31–28.69 | 3 of 3 |
| 4 threads | 13.10 ms | 26.40–29.13 | 3 of 3 |

Read the fps column first. Three threads has the fastest registration in the
table and drops frames in every round, which makes it a trap rather than a
result — a capture node that solves depth faster and records less of it is worse,
and `reg` p50 alone would have called it the winner. Two holds rate and is worth
12%. Four being *slower* than three is the tell that this is contention: adding a
thread subtracted throughput, because on four cores these threads take CPU from
the depth solve's own `AsyncPacketProcessor` and the GL depth processor, which on
twelve Mac cores never had to compete at all.

So the Mac's 36% was a measurement of a machine with nothing else to do. It stays
in the record as what twelve idle cores can do with this work, not as a figure
the project banks — the capture node's 12% is the one that means anything, since
the Mac idles 27ms of every 33ms interval and has no headroom to want.

**This is the fourth time a number on this project changed when it was finally
measured on the machine that mattered**, after the ~17ms serial estimate, the
4.5ms Mac registration figure and the 23% patch result. The pattern is not that
the estimates were careless; it is that the rig they were reasoned from was never
the rig under load.

The driver this all lives in is now ours: `third_party/libfreenect2` is upstream
v0.2.1 committed in-tree, because the old recipe cloned a *branch* and so pinned
nothing — it built the right thing only because upstream has not committed since
2020-03-01. `tools/vendor-check.mjs` proves the tree is upstream plus exactly the
declared edits, offline, and `tools/registration-check.mjs` proves our
registration matches upstream's bit for bit on a 72-frame corpus of real sensor
input. See `third_party/UPSTREAM.md`.

**What actually costs frames is the card, not the CPU.** With colour off the
whole serial half is 0.74ms, so `Registration::apply` is very nearly the entire
cost, and with colour on the loop still sits idle 55% of every interval. The
0.14fps that separates 29.86
from 30.00 over two minutes is three buffered-write stalls of 290ms, 203ms and
38ms — 531ms of stall against a 16-frame deficit, which is the same number. The
write is 0.24ms at p50 and 0.46ms at p99, and 290ms at its worst. Gate 3's `dd`
figure measured sequential throughput and says nothing about that tail. It is
0.5% of frames over two minutes and not a blocker, but a long take will meet it,
and the honest reading of Gate 3 is that the card has the bandwidth rather than
that it has no latency spikes.

One measurement artefact worth recording, because it looked like a sensor fault:
an early run showed a 1245ms gap that turned out to be the grabber's own
every-150-frames stderr line blocking on the same card the capture was streaming
to. Instrumentation went to tmpfs after that.

**Power is the one thing to watch.** Under-voltage was detected twice during boot
and normalised both times, leaving historical flags (`get_throttled=0x50000`) but
nothing current, and no throttling occurred during any run. Temperature stayed
between 49.9°C and 55.4°C across the first three gates, and between 48.3°C and
57.6°C across the thirty-odd grabber runs of gate 4, including two of two minutes —
`get_throttled` never moved off its historical `0x50000`. A sustained capture on a
marginal supply is where this would resurface.

### Gate 5: the whole path runs, and watching it live costs you frames

The four gates above measured the grabber alone. Running the actual node — our
`server/index.js` spawning our grabber, with a browser on the Mac connected over
Wi-Fi — turned up the one finding here that changes a recommendation.

**The path works.** The server starts the grabber with no `--pipeline` argument,
the grabber selects `gl` because that is what its libfreenect2 contains, the
device opens at SuperSpeed and streams, and the Mac's browser renders a live
point cloud with the full viewer UI. This is also the first end-to-end proof of
the pipeline-default fix: the node's previous copy of the server passed
`--pipeline cl`, which no Pi build has, and would now fail outright rather than
falling back.

**Live view over Wi-Fi is link-limited to about 7fps**, not 30. The wireless link
carries 3.4 MB/s against the 14.6 MB/s a full-rate stream needs, which is the
3.8 MB/s measured earlier arriving at the same answer from the other direction.
Nothing is wrong; the link is simply the ceiling, and this is why browsing a
remote take goes through the decimation parameter rather than pretending.

**The part worth acting on: a connected viewer degrades the capture itself.**
Backpressure from the socket reaches back through the server's stdin pipe into
the grabber, which then cannot service USB in time and drops depth packets.

| | skipped depth packets / 12s | recorded rate |
| --- | --- | --- |
| no client connected | 2 | 29.98 fps |
| one browser connected | 52 | 26.64 fps |

Those are frames that never reach the file, so no amount of downloading recovers
them — watching the monitor while recording quietly costs about 11% of the take.
That turns "record locally, download deliberately" from a bandwidth convenience
into a correctness rule, and it means the monitor needs to negotiate decimation
*while recording* rather than only when browsing. A monitor showing every frame
is the thing making frames disappear.

**Both comparisons were sequential rather than interleaved**, which this document
has been burned by before, and the re-measurement more than doubled the number.
Interleaved on the node, one grabber and one continuous recording, three rounds of
three arms at 40s each with 4s of settling outside every window, the first 25s
discarded, counters sampled once a second by the node itself and pulled afterwards
so the driver never reads across the link under test:

| arm | recorded fps (median) | cost against no client |
| --- | --- | --- |
| no client | 28.77 | — |
| monitor ÷1 ×1 | 21.76 | **24.0%** |
| monitor ÷4 ×3 | 27.46 | **3.4%** |

Run twice on separate occasions, six paired rounds in all, every delta the same
sign: 24.5%/24.0% for the full-rate monitor and 3.9%/3.4% for the decimated one. So
a full-rate monitor costs about a quarter of the take rather than 11%, decimating
to the cap recovers about six sevenths of that, and `tools/monitor-cost-ab.mjs` is
what measures it.

**The mechanism above is not the one that reproduced, and that is worth saying
plainly.** libfreenect2's `not all subsequences received` fired **once in an
eight-minute run and its count did not move in any arm** — not in the no-client arm,
and not in the arm losing a quarter of its frames. So the frames are not being lost
to dropped isochronous packets here. What the numbers are consistent with is the
grabber blocking on its write to stdout while the server's pipe is full, and the
frames piling up behind it being discarded by libfreenect2's own listener — a
frame-level drop rather than a packet-level one. That is not proved and is not
claimed; what is measured is that the loss is large, reproducible, and unaccompanied
by any USB packet loss.

The harness had to be thrown away twice, and both are recorded because neither would
have been found by reading it. It first sampled the node over SSH at each window
boundary, so its control channel shared the very link the full-rate arm exists to
saturate — the sample closing that window was delayed by exactly the congestion being
measured, and twenty minutes produced no window at all. And its baseline gate was
`prof-summary`'s 29.5fps, borrowed from a profiling run that writes nothing; a
continuously recording run legitimately sits under it, as this document already says
at 29.86 over two minutes. The gate is the spread of the no-client arms now, since
variance rather than level is what contention looked like in the thread-count sweep.

## Scope for a first version

**One clip with keyframe tracks, and export is clip by clip.** No cuts, no
transitions, no sequence. The thing being built is re-photography of a single
take: virtual camera, look parameters, retiming. Multi-clip sequencing is a layer
above this one and should not shape the project-file model until it is actually
wanted.

**Cohesion across clips comes from a preset library, not from a sequence.** The
obvious failure of exporting clip by clip is that each clip drifts in look until
a set of them no longer belongs together. A sequence timeline would solve that by
making them one object, which is a large amount of machinery for the problem.
Saved presets solve it directly: build a look once, name it, apply it as the
starting point of every clip that has to match. See below.

**Audio: available on Linux, not through libfreenect2.** An earlier version of
this section said the microphone array was simply inaccessible. That is true of
libfreenect2, which exposes no audio at all, but it is not true of the sensor on
a Linux capture node — the kernel's `snd-usb-audio` driver binds interfaces 2 and
3 of the Kinect and presents it as an ordinary ALSA capture device:

```
card 2: Sensor [Xbox NUI Sensor], device 0: USB Audio [USB Audio]
```

So a Linux node can record the array's audio alongside depth with no extra
hardware, as a separate stream captured in parallel rather than through the
grabber. macOS has no such driver, so audio there still has to come from
elsewhere.

**Recorded, not just enumerated.** The device name alone would only prove the
kernel bound something, so five seconds were captured on the node and inspected:

```
Format: S32_LE   Channels: 4   Rates: 16000   Channel map: FL FR FC LFE
```

All four channels carry signal — RMS between −60 and −56 dBFS with peaks of 327
to 467 on a quiet room, and levels that differ per channel, which is what a
spaced array should give and what digital silence would not. Native format is
**S32_LE at 16 kHz**, so capture should take it natively and let anything that
wants 16-bit convert later; `plughw` will silently resample and narrow it if
asked.

The four channels are worth keeping rather than downmixing at capture. A mic
array pointed across a room is the one part of this rig that could later support
beamforming towards whatever the depth camera says is the subject, and that is
impossible from a mixed track.

**Audio is a sibling file, referenced with an offset, and mutes under a retime.**

```
captures/take3.knct
captures/take3.wav
project: { audio: { ref: "take3.wav", offsetMs: … } }
```

Where the retime curve's local slope is 1.0 the audio plays; anywhere it is not,
it drops out. That gets sync sound for straight playback, which is most takes,
without resampling and without pitch artefacts. Time-stretching audio to follow a
ramp was rejected as a lot of machinery for a result usually discarded: doing it
without artefacts needs a real time-stretch, the artefacts are worst at exactly
the extreme ramps, and a 4x stretch of a mic array pointed across a room is a
sound effect rather than sync sound.

**The 1.0 test is a band with hysteresis, not an equality.** Slope is sampled per
output frame from a curve that may have been drawn by hand, so an exact
comparison would chatter the audio on and off through any nominally-flat segment:

```
playing → mute  when |slope - 1| > 0.05
muted   → play  when |slope - 1| < 0.02
```

The band absorbs curve noise and the asymmetry stops a slope hovering near the
boundary from stuttering. Two constants to tune, and a 2% drift is inaudible
rather than exact — an acceptable trade against a gate that audibly rattles on
the first hand-drawn ramp.

Fading audio out as slope departs 1.0 was rejected. It removes the threshold
question, but audio played at slightly wrong speed drifts progressively out of
sync, so a long near-1.0 section would fade gently while quietly desyncing —
sounds fine, is wrong. A clean mute is the honest behaviour.

## Build order

1. **Deterministic time and the transport seam.** Every wall-clock source moved
   onto a transport, `LiveTransport` replacing the current loop, OrbitControls
   bypassed for keyframed camera. Load-bearing for the editor, the export path
   and the capture-node story alike, and it touches the working live viewer
   first.
2. **Index, hash and the HTTP frame API.** Replaces `readFileSync`, unlocks takes
   longer than a minute, and is what every later consumer reads through.
3. **Parameter registry.** Sliders become views. Parameters tagged look versus
   composition. Presets write keys.
4. **Timeline transport.** Scrub with draft-on-drag, accurate seek with computed
   pre-roll, playback at an arbitrary rate.
5. **Keyframes.** Interpolation kinds, ease handles, the retime curve. Two
   surfaces: look tracks under the timeline, camera path edited spatially in the
   3D and top-down views with marks shown on the scrubber.
6. **Export.** `ExportTransport` to raw RGBA to FFmpeg, local first. Screen-space
   terms made resolution-relative first, or the first export at an unfamiliar
   size will not match the grade.
7. **Gallery and library.** Posters, manifest, content hashes. No proxies. Preset
   library with the applied-revision stamp per clip. Local/remote reconciliation
   by hash, per-take download, and the remaining-time warning.
8. **Job queue and headless worker.** Deferred and remote encoding, with the
   renderer class recorded on every job from the first one.
9. **Capture node.** All five gates pass on a Pi 5, including the whole path with
   a browser attached, so this is a deployment question rather than an open one.
   The grabber cross-builds and sustains 30.00fps depth with 15.00fps colour on
   15.05ms of a 33ms serial budget, and audio comes off the array natively at
   4 × 16 kHz. What remained was not plumbing but a behaviour: the monitor
   negotiates decimation *while recording*, because a full-rate viewer costs the
   take **24%** of its frames — the 11% above was sequential, and interleaved it is
   more than twice that. The client asks for a depth divisor and a frame stride over
   the socket already carrying the frames, nothing ever downgrades itself, and
   `/record/start` refuses instead, naming the monitors and their cost. `÷4 ×3`
   brings the cost to 3.4%.

Takes as files, the wall-clock capture date, the restart-splits-the-take rule and
the mark button are all small and can land anywhere before step 7 — though marks
want the sidecar from step 2 to exist first. The monitor view — colour plus
top-down orthographic — depends only on step 1 and can come as early as it is
wanted, since the top-down camera is also the best navigation aid for step 5.
Audio capture is independent of everything else and only needs the project file
to carry a reference by step 6.
