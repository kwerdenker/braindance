# Braindance

A volumetric capture and non-linear editing system for the Kinect v2. It records what a
depth sensor saw, then lets you fly a camera through the recording afterwards.

![A camera arcing across a recorded room, shaded by depth: the near column is warm
yellow, the far wall cool blue, and the two slide past each other as the camera
moves.](media/flythrough.gif)

That move was never shot. The sensor never left its mount: the arc is five camera keyframes
laid over the recording and rendered through the editor's export.

**Status: complete and working, maintained as a personal project.** macOS (Apple Silicon)
and Raspberry Pi capture nodes. No release cadence, no support commitment; see
[CONTRIBUTING.md](CONTRIBUTING.md).

> *Braindance* is a Cyberpunk term for a recorded experience you can step into and look
> around inside. Not affiliated with CD Projekt Red or R. Talsorian Games.

## Contents

- [What you need](#what-you-need)
- [Quickstart](#quickstart)
- [Using it](#using-it): shoot a take, find it, edit it, get a video out
- [Streaming to OBS](#streaming-to-obs)
- [Building the native side](#building-the-native-side)
- [Going deeper](#going-deeper): reference, architecture, measurements

## What you need

- **A Kinect v2**, not manufactured since 2017. Without one you can still work on the
  browser side and the server's pure logic; [CONTRIBUTING.md](CONTRIBUTING.md) says which
  parts.
- **Node 18.15 or newer.**
- **macOS on Apple Silicon, or Debian / Raspberry Pi OS** for a capture node.
- **The native grabber**, built once: [Building the native side](#building-the-native-side).
- **ffmpeg** for video out, looked for at `/opt/homebrew/bin/ffmpeg`. `FFMPEG=` overrides.
- **A capture.** None ships here, since `captures/` is gitignored. Record one as step 1.

## Quickstart

```bash
npm install
npm run build:native      # one-time, offline; skip it if you have no sensor
npm start                 # menu on http://localhost:8080
```

`npm start` lands on a menu: live viewer, take library, or editor.

![The menu: three cards reading RECORD, GALLERY and EDITOR, the last one saying
nothing has been opened on this machine yet.](media/menu.png)

Two shortcuts past it:

```bash
npm run record            # live sensor, and arm the first take at boot
npm run replay            # replay a capture you already have, no sensor needed
```

`npm run replay` looks for `captures/sample.knct`. `tools/make-fixture.js` loops a short
capture into a long one, which is how the index and the frame API get tested without
shooting for five minutes.

## Using it

### 1. Shoot a take

Pick **Record**, then press **record** to arm. The recorder waits for the sensor's hello
before opening a take, so the capture carries the intrinsics it was shot with; the bar
counts frames and shows the recording time the disk has left.

![The live viewer in Blackwall: a room drawn as a crimson containment volume, a hot
rim burning along the ceiling edge, with the record and shading controls down the left
and "30 fps in" at the top.](media/viewer.png)

**mark** drops a mark at the current frame, which shows up later on the gallery's scrub bar
and the editor's ruler. **stop** closes the take: the `.knct` and its `.idx` index land in
`captures/`, with a `.marks.jsonl` sidecar if you marked anything.

**The shading controls change what you are looking at, never what is written.**

### 2. Find it in the gallery

**Gallery** on the menu, or the link in any surface's header.

![The gallery: three take cards of identical size with depth thumbnails, the first
carrying three marks on its scrub bar, each showing its size, frame count and date
above an Open, a Delete and a three-dot menu, with a way back to the menu in the
header.](media/gallery.png)

Every take is a same-size tile carrying its poster, duration, size, frame count, mark count
and date. Skim a poster to scrub it; tap to open it large, with arrow keys stepping a frame
and up and down moving between takes.

The **⋯** menu holds what does not fit on a 228px tile: **rename**, **show in the file
manager** and **reclaim on node**. With a capture node linked, the filter row splits the
library into *local*, *node only* and *both*.

### 3. Open it in the editor

**Open** lands on `/edit?take=<id>`. The cloud draws on the left, the keyed camera path with
it and in the top-down inset, and the timeline underneath.

![The editor. The recorded cloud sits on the left; on the right the keyed camera path
draws as a line of nodes with the program camera's frustum on it. Below, three lanes
(retime, camera, exposure) carry their keys, and the program clock reads 00:03.000
against a source clock of 00:02.350.](media/editor.png)

Drag to orbit, scroll to zoom, right-drag to pan, `H` hides the panel;
[the controls reference](docs/reference.md#viewer-and-timeline-controls) has the timeline's
navigation. On a canted mount,
[level the room](docs/reference.md#levelling-a-canted-mount) first.

### 4. Key a camera move

Park the playhead, orbit to the pose you want, and press **key here** under
*Camera · composition*. Move, orbit, press again: a key takes the pose you are orbiting
from, and dragging a path node in either the view or the top-down moves it.

Two clocks read under the transport. **program** is a position in the output, **source** a
position in the capture; at 1.00× they agree, and pulling **speed** or keying the retime
lane makes them diverge, so the footage slows while the camera keeps its own pace. See
[program time](docs/architecture.md#program-time-is-the-edit-coordinate).

Nearly every slider carries a keyframe button, so a clip can dissolve from depth into
Blackwall under the playhead. `depth ÷`, `every Nth` and `render %` are the exceptions:
they change what you are looking at rather than what the frame is, so they are neither
saved with the clip nor exported.

### 5. Get a video out

Set **in** and **out**, pick a size from the **export** list, name it, and press **render**.

![The right half of the editor's timeline bar after a render: out set to 00:01.967 over
a 1.97s length, and below it the export row reading 2026-08-02-take2.mp4 · 60 frames ·
0.6 MB in 1.5s, beside the name field, a 960x540 size, render and save a
copy.](media/export.png)

The render runs in the page, frame by frame through the program camera, pushing frames to
ffmpeg over a socket. Each render gets its own directory under `exports/` with a `.job.json`
carrying the whole project document, so nothing overwrites and every render is reproducible.
**save a copy…** puts the file anywhere through the browser's file picker.

**The batch path has no button anywhere in the browser**: `POST /jobs` with a project
document, a capture hash and an output size, then

```bash
node tools/render-worker.mjs --url http://localhost:8080 --drain
```

A worker claims only jobs matching the renderer class of the browser it will draw in, so it
cannot be handed work that would come back looking different. `--drain` exits when the queue
has nothing *for this worker*, and exits non-zero if what is left is pinned elsewhere. The
queue is records on disk, so it survives a restart.

**The trim lives on the job's `deliverable`, not in its project document.** In/out, fps, size
and codec go there together, so one edit can spawn several deliverables; a job posted without
one renders the whole clip.

## Streaming to OBS

Two outputs, and they are different pictures rather than two views of one. The panel's
*Output to OBS* group prints both URLs.

| What | How | What it is |
| --- | --- | --- |
| the viewport | browser source on `/program` | this renderer, at a fixed size, no chrome |
| the webcam | browser source on `/camera.mjpg` | the colour camera's own 1920x1080 frame |

Add a *Browser Source*, paste the URL, set *Width* and *Height*. The webcam is always
1920x1080; the viewport is whatever you set in the panel. OBS's own virtual camera publishes
either one to Zoom or Meet, so nothing here installs a system camera extension.

**The webcam is not the colour on the wire.** Type 2 carries the *registered* colour,
resampled into the depth camera's 70.6° frustum from the colour camera's 84.1° and holed
wherever the depth solve failed, which is right for texturing a cloud and useless as a
picture of a room. The native 1080p frame is therefore a second stream on its own thread,
emitted only while subscribed, because the encode costs 5.50 ms (90 sensor frames, no warmup
discarded, q80, TJSAMP_420, FASTDCT) against a 7.1 ms serial loop and its ~50 Mbit/s
backpressures the grabber and costs the take.

The viewport has two modes: *program camera* frames the keyed camera at a fixed size,
*mirror* follows what the operator is orbiting. Mirror re-renders their viewpoint rather
than copying their pixels, because a browser source renders its own context.

**It renders once per sensor frame, and OBS is the clock after that.** CEF renders offscreen
and OBS pulls the latest texture at canvas rate, so the two clocks beat: negligible at a flat
30.00fps, uneven on a degraded link. The source shows its delivered rate, its missed count,
and the decimation it was granted if it is being served coarse.

Turning colour off restarts the grabber and **drops a live webcam mid-call**, with the
endpoint answering 503 and the reason. `/camera.mjpg` serves the camera to anything that can
reach the port, so read [SECURITY.md](SECURITY.md) before `--host 0.0.0.0`.

## Building the native side

Both builds are one-time and neither needs the network. libfreenect2's source is at
`third_party/libfreenect2` (upstream v0.2.1 plus our declared edits, see
`third_party/UPSTREAM.md`) and builds into the gitignored `vendor/prefix`.

```bash
brew install libusb jpeg-turbo cmake                       # macOS
sudo apt install libusb-1.0-0-dev libturbojpeg0-dev cmake \
                 libglfw3-dev libgl1-mesa-dev              # Debian / Raspberry Pi OS
npm run build:native
```

The GL packages are on the Debian line because the `linux` preset builds depth on OpenGL, and
libfreenect2 treats a missing GLFW as a reason to build without it rather than to stop: this
line lacking them produced a CPU-only library and a build that reported success. The build
refuses that now, but the refusal is a worse way to find out than installing them here.

`build:native` picks a preset from the platform (`macos` on OpenCL, `linux` on OpenGL for the
Pi), resolves Homebrew's prefix rather than assuming one, and refuses with the `brew install`
line you need. `--preset macos|linux` overrides, `--clean` discards the vendored build, and
`node tools/build-native.mjs --help` has the rest. The wrong preset costs a refusal rather
than a silent slow path, since `--pipeline` is guarded by whichever backend the library was
actually compiled with.

The flags live in that script, one copy, beside the comments explaining why each is what it
is. It closes by running the grabber it just built rather than checking that the file exists,
since a stale binary and one linked against a moved prefix both exist perfectly well.
`node tools/vendor-check.mjs` proves the source is upstream v0.2.1 plus exactly the declared
edits, offline.

## Going deeper

- **[docs/reference.md](docs/reference.md)** is the command line, the viewer and timeline
  controls, levelling a canted mount, the five readings and presets.
- **[docs/architecture.md](docs/architecture.md)** is how the pieces fit, the four surfaces,
  program time as the edit coordinate, surface memory, frame interpolation and the `.knct`
  wire format.
- **[docs/performance.md](docs/performance.md)** is what this costs: rendering cost, the USB
  topology that was the whole bottleneck, the OpenCL and CPU depth solves, and the things
  that looked obviously worth doing and were measured not to be.

Behind those sit the working notes: [docs/measurement.md](docs/measurement.md) for how this
rig is measured, [docs/instruments.md](docs/instruments.md) for every way a check here has
claimed a property it was not testing, and [docs/proof-tools.md](docs/proof-tools.md) for
what each tool needs before it will run.
