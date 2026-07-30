# Design studies: surfaces and motion

Three studies for the surfaces in `docs/recording-and-nle.md`, each a standalone page
that opens in a browser with no build step:

| file | surface | build order |
| --- | --- | --- |
| `recorder.html` | capture-node monitor, touch first | steps 1 and 9 |
| `library.html` | one skimmable library spanning both devices | step 7 |
| `editor.html` | one clip, inspector on the right | steps 4 and 5 |

`tokens.css` carries the shared system. The colours are the live viewer's own palette
(`web/index.html:8-14`) restated in OKLCH, with one deliberate change recorded there:
the three ink tiers were re-spaced so all of them clear 4.5:1 on this ground.

**The viewports are hand-built diagrams, not screenshots.** Each renders a deterministic
depth scatter from a fixed seed, so a study looks the same every time it opens and two
screenshots can be compared. The point cloud stands in for the real renderer, which does
not exist behind these surfaces yet.

**Type is monospace only, and that is a decision rather than an omission.** Nearly every
value on these screens is a timecode, a frame count, a content hash or a slider readout,
and all of them want tabular figures.

---

## What each study commits to

### The recorder is designed to the panel it will actually run on

`wlr-randr` on the node reports **800×480**, so that is the first target and a phone is
the second. Everything is sized for a finger: no control is under 44px on its short axis,
and there is no hover-only affordance anywhere.

**The range strip runs distance left to right, and it is not a literal plan.** A room is
about 4.4m across and 7m deep, so a true top-down wants aspect 0.6 while a strip on this
panel is aspect 9.5 — the field-of-view cone leaves the frame within a pixel of the sensor
and the range arcs flatten into lines. The two axes therefore carry different scales, the
cone and the arcs are dropped because they only mean anything isotropically, and the
compression is printed on the strip rather than hidden. What survives answers the question
the view is actually asked: is the subject inside the band I am previewing.

**The preview clip is the viewer's clip, and nothing else.** This is the one place in the
study where a wiring mistake would destroy footage. `nearClip`/`farClip` are shader
uniforms that hide points (`web/main.js:205-206`, `632-633`); `--min-depth`/`--max-depth`
are grabber flags that, in the grabber's own words, "clip on the GPU before the frame is
built, so they decide what exists at all". The control drives the first and must never
reach the second, which is why it is labelled **preview only · capture keeps 0.05–9.0**
as visible text on the surface rather than as a comment in the source.

The same two numbers draw the band on the range strip, so moving the control moves a
region you can see.

**Orbit is clamped to ±40°, and the reason is the sensor.** One Kinect records a shell from
one viewpoint, so past roughly that angle the subject collapses into the edge of a card
with a void behind it. That is worth seeing in the editor; on a monitor whose job is
framing a shot it is just a broken-looking picture.

### The library is one gallery, skimmable, and can delete on either device

Tiles rather than rows, and moving across a tile scrubs its frame — the Final Cut
skimming idiom. The scrub bar carries the take's marks, so the moments someone flagged in
the room are visible before the take is ever opened.

**Skimming costs different amounts depending on where the take is, so it looks different.**
A local take scrubs at the measured 2.7ms. A remote one goes through the same decimation
parameter the monitor negotiates, at roughly 21ms a position over that 3.8 MB/s link.
Remote tiles therefore genuinely render coarser and say `decimated · 21 ms/pos`, because
skimming them identically would promise a smoothness the architecture does not have.

**Skimming is a pointer affordance, so nothing is gated behind it.** Download, open,
reclaim and delete are buttons on the tile at all times, reachable by tap on the node's
touch panel.

**Delete gets a real confirm, and it is the only thing here that does.** Reclaiming a node
copy after download is recoverable and says so. Deleting the last copy of a take is the
one action in this tool that cannot be undone, on a tool whose whole premise is keeping the
raw footage — so it names the take, its length, its size, its marks and which machines hold
it, and states plainly that this is the only copy. An optimistic delete with an Undo toast
would be the wrong pattern here.

### The editor edits one clip, and the timeline only shows what moves

**Mode is a property of the clip, not a track.** Selecting Blackwall sets the look's
starting point and writes nothing to the timeline. This is a change from the spec and is
flagged below.

**Look lives in an inspector, keyframed the Final Cut way.** Each parameter is a row with
a value and a keyframe diamond: hollow means static, outlined means it has keys elsewhere,
filled means there is a key here at the playhead. Changing a value on a track that already
has keys writes a key at the playhead rather than shifting the whole curve. Groups are the
unit of expansion — a new parameter is one more entry in the registry, a new mode is one
more option, and nothing else in the surface changes.

**Only parameters that carry keys get a lane.** The previous study gave every parameter a
permanent lane, which is most of what made it feel convoluted. Five lanes now: marks,
retime, camera, and the two look parameters that are actually animated.

**The camera is moved by dragging the frame.** Pushing the picture right moves the camera
left, one to one with the hand. Because the playhead sits on a camera key, the drag
rewrites that key rather than creating a new one — the Final Cut rule again. The top-down
survives as a small inset, since it answers "where is the camera in the room" and the main
view cannot, but it no longer costs half the screen.

Three details are still drawn deliberately because they are the visible consequence of
decisions argued for in prose: the ruler is **program time** per ADR-0001 with source as a
derived readout; marks sit where the retime curve currently puts them, because they are
stamped in source milliseconds; and **pre-roll is drawn where it is paid**, as a hatched
span carrying its own cost in frames and seconds.

---

## Where the studies now disagree with the spec

These follow from the redesign and are **not** yet folded into `docs/recording-and-nle.md`.

1. **Mode is no longer a step track.** `docs/recording-and-nle.md:355-359` lists step tracks
   as covering "every checkbox, plus the mode selector", and `:363-370` argues that
   selecting Blackwall should write keys onto the affected tracks at the playhead. One mode
   per clip removes both. It also dissolves the tension that section was written to manage,
   since a mode change can no longer stomp eleven other tracks.
2. **The gallery skims.** The Gallery section (`:760-784`) argues against a proxy and settles
   what a draft scrub costs, but never describes hover-scrubbing a tile. The costs it
   records are what make the local-versus-remote difference above legible, so the section
   needs extending rather than correcting.
3. **Deletion happens on both devices.** `:816-819` says nothing on the node is ever deleted
   automatically, which still holds — but it assumes deletion is initiated from the Mac.
   The node's own panel can now delete too.
4. **The recorder carries look and range controls.** The spec's recorder is record, mark and
   remaining time. A preset selector and a preview-clip range are new, and the preview-only
   distinction above is worth stating in the spec because it is the kind of thing a later
   change could quietly get backwards.

---

## MotionPlan

**Result** — `MotionPlan`.

### Profile source and provenance

The governing source is the project's own convention, read from `web/index.html:8-14` and
`web/main.js`. It wins because it is the only motion system this project has and it is
already shipping.

Two facts define it. The token block fixes the palette and the monospace stack. And the
viewer contains **no DOM transition, no keyframe animation and no easing declaration
anywhere** — every panel, slider and mode button changes state instantly, while all motion
lives in the WebGL layer as surface cross-fades, wakes and trails driven by
`stateUniforms.dt` (`web/main.js:907`). That absence is a convention, not a gap: the chrome
holds still so the image can move. No brand profile, `design.md` or motion library exists in
the repo, and none was invented to fill the space.

### Semantic decision

| class | decision |
| --- | --- |
| direct manipulation — orbit, camera drag, skim, clip range, playhead | `NoMotion` |
| state entry — record arming, a mark landing, a preset applied, download state | `Animate`, narrowly |
| returning the view to home | `Animate`, briefly |
| the record-armed indicator | `Animate`, and load-bearing |

### Rationale

**The redesign made direct manipulation the dominant interaction, which sharpens the split
rather than changing it.** Four of the surfaces' primary gestures now write a value straight
from the pointer: orbiting the monitor, dragging the preview-clip thumbs, skimming a tile,
and dragging the frame to move the camera. All of them are the user's hand, and easing any
of them misreports latency — an eased skim makes a 2.7ms draft scrub feel like a 200ms one,
which teaches the operator something false about their own tool. There is no smoothing and
no interpolation between pointer and value anywhere in the three studies.

**State entry is the exception, because there the movement is the message.** A mark landing
while you are looking at the room, or a preset overwriting a group at once, are changes the
user did not watch happen. These are occasional, so they can afford 90–160ms.

**Returning the view to home is the one new case, and it is not direct manipulation.** It is
a state change with a spatial relationship — a known pose, returned to along the path
between here and there — so a 220ms ease-out reads as the view travelling back rather than
teleporting. Getting this wrong in the other direction is the trap: the drag that precedes
it must not pick up easing on the way past.

**The record indicator still earns its place outright.** It is the "am I recording" signal,
read across a room, often at a glance and often on a phone propped somewhere.

### Semantic roles

| role | value | where |
| --- | --- | --- |
| `continuous gesture` | no duration, no easing — value follows input | orbit, camera drag, skim, clip range, playhead |
| `fast feedback` | `--dur-fast` 90ms, `--ease-out` | button hover, focus, pressed |
| `retargetable state change` | `--dur-base` 160ms, `--ease-out` | mark landing, preset applied, download state |
| `anchored return` | 220ms, cubic ease-out | view reset |
| `continuous state cue` | `--dur-rec` 1400ms, `--ease-in-out`, alternating, opacity 1 → 0.34 | record-armed indicator |
| `reduced-motion feedback` | instant; colour, fill and text | all of the above |

Focus rings are exempt from every duration above and appear instantly.

### Native guidance

Platform is Web. `transition` on `background-color`, `border-color` and `color` only, named
per property — never `transition: all`. The record indicator is a CSS `@keyframes` pair on
`opacity` alone. The view reset is a `requestAnimationFrame` loop over the pose rather than
a CSS transition, because the value being eased is a camera orientation that feeds a canvas
render, not a style.

All pointer handling uses Pointer Events with `setPointerCapture`, so touch on the node's
panel, touch on a phone and a mouse on the Mac are one code path rather than three.

### Reduced-motion behaviour

Under `prefers-reduced-motion: reduce`, every duration collapses to 1ms, the record
indicator's keyframes stop with the dot at full opacity, and the view reset jumps rather
than travels — it checks the preference itself rather than relying on the CSS override,
since it animates in script.

**Nothing loses its meaning, because no state was ever carried by movement alone.** The
recording state reads from three redundant signals: the button fills solid red, the dot
stays lit, and the label reads `Stop` beside a running timecode.

Direct manipulation is untouched. Reducing motion must never disconnect a value from the
hand dragging it, and there is no autonomous travel in these gestures to remove.

### Verification conditions

Checked in Chrome against the three studies. What passed is recorded as measured; what was
not run is named as not run.

1. **The gestures work, not just render — passes.** Dragging the recorder's far clip thumb
   moved it 4.20 → 7.93m and the range strip's band extended over the back wall, which then
   appeared in the main view. Skimming a tile moved it to 02:51 of a 03:45 take at 76.2%.
   Dragging the editor's frame moved the camera 0.09 → −0.39 and reported the key it
   rewrote.
2. **The editor's camera maths is right — checked numerically.** The look-at point projects
   to an offset of exactly (0, 0) in frame. An earlier version had the pitch sign inverted,
   which sank the subject out of the bottom of the shot.
3. **Reduced motion while recording — passes.** `animation-name: none` at `opacity: 1`, the
   button keeps its solid fill and the label still reads `Stop`.
4. **Focus rings appear instantly — passes.** Computed `transition-property` is
   `background-color, border-color, color`; `outline` is not among them.
5. **Contrast — passes.** Measured from painted pixels rather than computed strings, since
   `getComputedStyle` returns OKLCH here and a naive parse reads the lightness as a red
   channel. Against `--color-paper`: ink 17.3, dim 7.2, faint 4.7, accent 11.2, warn 11.8,
   focus ring 15.1 to one.
6. **Responsive floor — passes at 320, 375, 414, 768, 800×480 and 1440.** No horizontal
   scroll on any study at any size, and no clickable label wrapping to two lines.
7. **Console — clean.** No errors or warnings on any of the three.
8. **Not run: the five-minute performance profile** on the record indicator, and no study has
   been opened on the node's actual panel — 800×480 was emulated in Chrome, not run on the
   Pi. Both belong on the real hardware rather than on a study.
