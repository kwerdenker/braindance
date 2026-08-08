# Reference

Command line, controls, the five readings and presets. [README.md](../README.md) has the
usage path; this is the detail behind it.

## Command line

Options pass through to the grabber:

```bash
node server/index.js --pipeline cpu     # CPU depth instead of OpenCL
node server/index.js --no-color         # depth only, no colour stream
node server/index.js --port 9000
node server/index.js --record           # a flag, not a path - takes are named and
                                        # placed in captures/ by the recorder
node server/index.js --replay captures/session.knct
node server/index.js --host 0.0.0.0     # reachable from other machines - see below
```

**`--record` arms the *first* take rather than offering the recorder.** The flag is read
once at boot and spent when you stop that take; arming again is the record button. So
`npm run record` writes from the moment the server is up, and `npm start` is the one that
lets you decide when.

`--replay` loops a recorded capture, for iterating on shaders with the sensor unplugged. It
replays the *recorded* arrival spacing rather than a uniform 30fps: a degraded link runs
p50 64ms against p90 222ms, so even pacing would hand the viewer the one cadence that never
happens.

## Reaching it from another machine

**There is no authentication anywhere in this program**, so whoever can reach the port can
arm the recorder and start or stop a take. The server binds `127.0.0.1` unless you pass
`--host`, and says on stdout when it did.

Mutating routes and the WebSocket upgrade require a same-origin `Origin` and an address
rather than a hostname. The socket is included because `WebSocket` is exempt from the
same-origin policy and sends no preflight; the hostname half exists because comparing
`Origin` against `Host` was measured reaching every mutating route on the default loopback
bind through DNS rebinding. It stops hostile pages and nothing else: curl and other machines
on the Wi-Fi send no origin and are allowed everything. `tools/guard-check.mjs` proves both
halves, and [SECURITY.md](../SECURITY.md) has the threat model.

## Viewer and timeline controls

Drag to orbit, scroll to zoom, right-drag to pan, `H` hides the panel.

The ruler shows a *window* of the clip, because a fifteen-minute take across one screen puts
a keyframe against gradations forty times coarser than the thing being placed. Scroll to
zoom about the pointer, `+`/`-` about the playhead, `,`/`.` to pan, `F` to fit the clip, `Z`
to frame the trim. The overview underneath is always the whole clip: drag its box to pan, an
edge to zoom, click to go there.

**Glitch** tears bands of the feed sideways, and it is seven controls rather than
one because the interesting looks live off the diagonal. `amount` is the master and the one
worth keyframing — it scales density and shove together, so corruption fades in and out on a
single track. `density` is what fraction of the bands tear at a full master and `shove m` is
how far one travels, in metres in the room: sparse-and-violent and dense-and-subtle are the
two ends those give you, and neither is reachable from a single slider. `flare` is the cyan
a torn band burns, per metre it was shoved, so a bigger tear lights harder on its own.
`band rows` is the height of a band in the sensor's own scanlines — 424 over that many bands,
so 35 at the default of 12 — and `rate hz` is how often the torn set is redrawn, where 0
freezes the pattern where it stands rather than switching it off.

`axis` is which way the bands run, from the sensor's rows at 0 to its columns at 1, and the
fractions between are the point: at 0.5 the bands cross the frame on a diagonal, which is a
look neither end reaches. It is a blend of the two image axes rather than an angle in degrees,
because the bands are cut in the sensor's frame where 512 columns meet 424 rows and a band is
a run of scanlines rather than a distance — there is no square in which an angle would mean
what an angle means. The raster's `angle` under Post is the one that gets degrees, because it
runs in screen space where the pixels are square. Turning the axis changes which bands tear
and not which way they slide: the shove stays along sensor x, so a column of bands shears
across itself rather than along itself, and there is no separate shear control because the
pair that could disagree buys nothing the references show.

The tear is applied in the sensor's frame before the camera sees it, so it is only
screen-horizontal from head-on: orbit around a torn band and it shoves in depth instead, and
a levelled room tears along the angle the mount was really at. That is the effect saying the
*volume* is corrupt rather than the picture, and it is why the group sits at the displacement
stage next to what moves points rather than in `Post` next to `scanlines`.

**`lattice`** rebuilds the volume on a grid: every axis quantised to `cell m`, so surfaces
break into steps and the cloud reads as something being reconstructed rather than something
that was measured. It is the last displacement applied, after the tear, so what gets snapped
is where the point actually ends up — a grid cut before the turbulence would be smoothly
pushed back off itself. **It snaps in the levelled frame**, so the cells line up with the room
rather than with the bracket: level a canted mount afterwards and the grid does not re-cut.
The cell is metres in the room like the other displacements, so a look gives the same grid at
any export size.

**`ripple`** is the region read a fourth way, after displacing, scrambling and masking: a wave
travelling out along the radius, in metres at a full weight, so the volume breathes where
`push` only swells it. `ripple per m` is its spacing and `ripple hz` its speed — and the wave
advances in eighths of a cycle rather than sliding, which is the character rather than a
limitation: the surface arrives at each step instead of gliding between them, so it reads as
machinery rather than as breathing. A speed of 0 freezes it where it stands rather than
switching it off, the way `rate hz` does under Glitch, and both keyframe.

`turbulence` displaces points with a noise field. `near`/`far` is the most useful control
for isolating a person from the room. `cull speckle` drops points whose neighbours disagree,
cleaning up the sensor's edge noise (sigma ~= 3.5 + 1.3*d mm, so 4.6mm at 0.75m and 10mm at
4.25m). `render %` scales the drawing buffer and is the one control that reliably buys back
frame time, for the reason [rendering cost](performance.md#rendering-cost) gives.

Two controls decide how much white lands on the geometry, and they are the first to reach
for if the look is blown out. **`scan`** keys off distance rather than screen position, so
it crosses an angled surface as a drifting diagonal band; wide and hot it reads as a light
leak, so it is kept narrow and cyan. **`rim`** brightens depth discontinuities and gives the
subject its edge, but under additive blending plus bloom it washes broad surfaces white, so
turn it down before turning down bloom.

**The five Post terms share one pass, and the pass carries the tonemap.** `rgb split`,
`scanlines`, `grain`, `streak` and `vignette` each switch it on, because a full-screen read and
write that changes nothing is worth skipping. What rides along with it is the highlight rolloff
and the black-toe crush, so a look with all five at zero is not the same image without five
effects: it also has lifted blacks and no rolloff, and additive accumulation clips to flat
white where it would otherwise keep its hue. Raising any one of the five brings the grade back.
The vignette used to be part of that bundle and is now its own control, which is why a project
saved before it existed loses its corner falloff until it names one.

**`streak`** bleeds light across the frame. Each pixel gathers back along the streak's axis and
keeps the brightest thing it finds, decayed by distance, so a highlight smears the way a sensor
smears one down a column of wells — sixteen taps at geometric spacing, reaching about 168 pixels
at the 1080p reference. `streak angle` beside it is which way, in degrees, and **0 is straight
down**, which is what this term did when it did nothing else: a look authored before the control
existed names no angle and keeps the fall it was graded with, to the bit. Positive turns the
smear clockwise on the glass, so 90 runs it across to the left, 180 sends it up and -90 across to
the right, and the same half-turn is reachable either way round. It is degrees rather than the
axis blend `axis` under Glitch gets, because this runs in the grade pass in screen space where
the pixels are square and an angle means what an angle means, where the tear is quantised in the
sensor's own frame and has no square to mean it in. It is a gather over the current frame rather
than a buffer that accumulates across frames: a buffer would smear along whatever the camera did
last, so an orbit would drag every streak sideways and a seek would arrive carrying the streak
the scrub built rather than the one playback would have.

## Levelling a canted mount

A sensor bolted to a dashboard shoots a room that arrives on its side, and nothing measures
the angle, since libfreenect2 exposes camera intrinsics and no accelerometer. `tilt` and
`roll` under Framing rotate the *room* rather than the camera, so the turntable's pole, the
top-down inset, auto-orbit's axis and the exported frame all come level together. Set them
by eye against the top-down, which is where a canted room reads as canted, and **Reset
rotation** zeroes both in one press. There is no third angle because yaw is what dragging on
the picture already does.

Crop faces and the region stay in sensor metres and are tested before the model matrix, so a
box shrunk onto a subject stays there when the room levels underneath it. `level-check`
holds that as a bit-identity.

**Show crop box** draws the six faces in the picture and in the top-down, and puts a handle
on each face you can drag with the pointer. It is a viewer control and writes nothing: the
drag itself writes, through the same registry door the sliders use, so a dragged face keys,
undoes and presets exactly as a typed one does. A face is offered a handle in a view that can
show it moving, which is why the top-down carries `left`, `right`, `near` and `far` and not
`bottom`/`top`, and why the far plane has no handle when you are looking straight down the
axis it moves along — turn the orbit and it appears. While the box is on screen the points it
cuts draw faintly rather than vanishing, so you can see what a face is about to remove and
drag it onto something deliberately. None of that reaches an exported frame or the OBS
output, which `export-check` asserts as byte-identity.

**`crop`** is whether the box bites, over all six faces at once, and it is a look value like
any other — it keys, it presets, and it exports what you see. It releases by not testing
rather than by moving the planes, so `near` and `far` still normalise the depth ramp while
the crop is off and the picture you get back is the room, not a re-grade of it. Use it to
check what a tight box removed without losing the numbers; **revert all to default** is the
other way back and throws them away. With the crop released the box draws dashed and grey.

## The five readings

Five readings of the take, split on the panel into what colours a point and what is then
made of it. Each is a weight from 0 to 1, so they mix.

| Reading | What it does |
| --- | --- |
| colour (source) | registered colour mapped onto the depth points |
| depth (source) | cool-to-warm ramp across the clip range |
| ghost (treatment) | luminance shell that glows along depth discontinuities |
| contour (treatment) | topographic bands sweeping through depth |
| blackwall (treatment) | crimson containment volume, cyan scan sweep, torn datastream bands |

![The five readings on one frame of one take: colour, depth, ghost and contour in a
grid, and Blackwall full width beneath them.](../media/shading-modes.png)

All five are the same frame from the same pose, each at its own brightness: the room was
shot unlit, so colour and contour read a signal the sensor barely produced while Blackwall
blends additively into bloom and blows out early.

**They are weights and not a mode.** The shader sums whichever are non-zero and divides by
the sum of the weights, so colour at 0.6 against depth at 0.4 is a 60/40 blend. Each is an
ordinary registry parameter, so each keyframes, and a single reading at 1.0 is arithmetically
the identity; `registry-check` hashes each reading's framebuffer against the mode it replaced.

Seven constants that were literals inside the old shader branch are registry parameters too,
so they keyframe: the colour's saturation, the depth ramp's gamma, the ghost shell's rim
exponent and fill, the contour's bands per metre and line thickness, and the Blackwall scan
speed. Each defaults to the literal it replaced.

**The duotone sits on top of all five**, beside `thermal` and `edges` and for their reason:
a term written into one reading is inert in every other. It is a tonal transform rather than
a tint, because its two poles carry luminance as well as hue — the near one runs toward black
and the far one toward hot, so one term gives both the depth-keyed palette and the near-black
figure against a burning core. A plain global toe cannot draw that second thing at all, since
it darkens near and far alike, which is why there is no separate silhouette control to look
for. `duotone depth` is how far the image lands between the poles, `duotone hue` turns both of
them together, and `duotone split` is the depth they meet at, as a fraction of the clip range
— so the crossover is a place in the room rather than a fraction of the frame. The pair itself
is baked, the way `heatRamp` and `depthRamp` are: what is parameterised is how you use them.

**`duotone motion`** keys those same two poles on speed as well, so whatever is moving through
the room comes out hot against a room graded by distance. It is the reading the depth key
cannot draw on its own: a subject and the wall behind it are graded by where they stand, so a
person walking through a scene is exactly as cold as the air they walk through until something
keys on the walking. The speed is axial and is measured from the two depth frames the renderer
already holds rather than from a flow pass, so what it sees is what the sensor sees — somebody
walking toward it rather than across it. A point reaches the hot pole at 1200 mm/s, about the
axial speed of an ordinary walk, and the amount pushes toward that pole rather than adding to
it, so the far half of a room is already hot and has nothing to gain while the effect keeps its
room where the picture is near-black, which is where a subject usually is. `snap mm` bounds it
at both ends: a jump larger than it reads as a different surface rather than as fast motion,
which is what stops every silhouette burning, and the same threshold caps the fastest speed a
pair can express at `snap mm` over the gap between the two frames — 7500 mm/s at the default
over a 30fps stream, and proportionally less over a slower link.

**The scanlines term is a raster now**, with three settings under it in a `Raster` group of
its own. `angle` turns it — at 0 it is the horizontal scanline it has always been, at 90 the
dense vertical column grille the reference frames slice a picture into — and because it keys,
a raster can rotate under the playhead. `pitch` is the line frequency, promoted from a literal
and defaulting to it — and **the settings worth having are below that default, not above it**,
because the wave is sized against 1080p and 1.3 is already about 220 cycles across the frame.
That is a television scanline; the wide bands the reference frames cut a picture into want
something under 0.6, and 0.1 is bands you can read across the room. The slider runs to 4 rather
than further because a line thinner than the pixel drawing it is aliasing rather than a raster.
`hardness` squares the wave into a grille with dark gaps between the
lines, and it is the one that makes the other two worth having: an angle over a sine only ever
buys rotated softness, where the references are hard line grilles.

They are settings of `scanlines` rather than terms beside it, so only the master gates the
grade pass — raise the angle with the master at zero and nothing happens, which is deliberate,
since switching a full-screen pass on to draw nothing is the no-op the gate exists to refuse.
The angle is one parameter behind a two-component uniform, computed in double on the way
through for the reason `contourWidth`'s two band edges are: taking the sine in the shader is
allowed to be a couple of thousandths off, and a raster meant to run along y then leaks a
whisker of x.

`crush` is the toe under the grade's Reinhard curve, promoted from a literal and defaulting to
it. It is a sub-control of the grade pass rather than a fifth term gating it — raise it on its
own and nothing happens, because the pass only runs when the split, the scanlines, the grain
or the vignette asks for it. That asymmetry is deliberate: its default is not zero, so gating
on it would hold the pass open for every look there has ever been.

The panel is generated from the registry at boot. A parameter is one entry naming its group
and label, and the row, bounds, readout and keyframe control are built from that, so an
effect cannot get a control the registry does not own. The generator refuses to boot if the
rows it emitted are not the parameters that were declared.

## Presets

Selecting Blackwall used to apply twelve post-chain values with it. They are separate now: a
preset is look values and nothing else, so applying one never moves your camera.

A preset is `{ version, values }`, and the keys it names are its scope. Nine ship read-only
from `presets-builtin/` and are marked `·` in the picker. Five of them — `rgb`, `depth`,
`ghost`, `contour` and `blackwall` — are one per reading and differ in little else, so they
are where a grade starts, with `blackwall.json` carrying the twelve values the old mode
wrote. The other four — `ember`, `grille`, `voxel` and `tearline` — are graded looks in
their own right: each reads Blackwall and spends a duotone, a raster and a toe on top of it,
so applying one takes a finished grade rather than clearing the desk. Nothing in the format
marks the difference and nothing should — they are all documents, and the split is
editorial. A preset naming two values is equally valid, and applying it leaves everything
else where the grade left it.

Saving and exporting both ask which values go in, every box ticked, so a sparse preset takes
deliberate effort. The boxes derive from the registry, so a parameter added later appears
under its own heading by existing.

**The five reading weights tick and untick together.** A file naming any reading has to name
all five, because the ones it omits stay at whatever the clip was already wearing, and two
fifths of a blend renders as a mixture nobody authored. A file naming none of them is a look
that is not about the reading, which is fine. `format.js` refuses everything in between.

**A partial preset does not stamp the clip**, because the stamp answers "what look is this
clip wearing" and three of fifty-four values did not answer it. The two surfaces that report
an apply say which of the two happened.

**Saving over a shipped name forks it**: the write lands in your library and shadows the
built-in, and deleting the fork brings the shipped look back.

`export` writes the look on screen (not the document the picker names, which diverge the
moment you move a slider) as `<name>.braindance-preset.json`, and `import` reads one back.
The bytes are the document, so a look is something you can commit, mail, or edit in a text
editor.

An imported file is validated against the registry before it is saved: a scalar carrying a
string fails at the key that is wrong instead of writing a plausible-looking look, and
`__proto__` is refused as an unknown parameter. A file is the one door nothing upstream
validates, so `editor-check` section 12 drives the round trip in a browser, with
`import-skips-normalise` as the mutation that must break it.

Documents from before the readings are version 3 and will not open. The conversion is total
and lossless, so it is a one-shot over files:

```
node tools/convert-presets.mjs presets projects jobs
```
