# Braindance

A volumetric capture and non-linear editing system for the Kinect v2. It records
what a depth sensor saw, and then lets you fly a camera through the recording
afterwards — the shot is chosen at edit time rather than at capture time, because
the footage is a cloud of points in space rather than a picture of them.

A native grabber pulls depth and registered colour from
[libfreenect2](https://github.com/OpenKinect/libfreenect2), a Node server fans the
frames out over WebSocket, and a Three.js viewer unprojects them on the GPU using
the sensor's own intrinsics. On top of that sits a recorder, a take library that
reconciles between two machines, a keyframe editor with a retime curve, and a
render queue that exports video through ffmpeg.

**Status: complete and working, maintained as a personal project.** It runs on macOS
(Apple Silicon) and on a Raspberry Pi capture node. There is no release cadence and
no support commitment — see [CONTRIBUTING.md](CONTRIBUTING.md) for what that means
in practice.

> *Braindance* is a term from the Cyberpunk tabletop and video games, used here
> because it names the idea exactly: a recorded experience you can step into and
> look around inside. This project is not affiliated with or endorsed by CD Projekt
> Red or R. Talsorian Games.

```
Kinect v2 ──USB3──▶ native/grabber ──framed stdout──▶ server/index.js ──WebSocket──▶ web/main.js
                    (libfreenect2 +                   (fan-out, drop-to-latest)     (GPU unprojection,
                     OpenCL depth,                                                   217k points +
                     TurboJPEG colour)                                               surface memory)
```

Depth and colour are captured on separate listeners. The Kinect's colour camera
halves to 15fps in dim light while depth stays at 30, and a single synced
listener would throw away every other depth frame waiting for it — so depth runs
at its own rate and reuses the most recent colour, at worst one interval stale.
The grabber logs both counts (`600 frames (293 colour)`) because a lagging colour
rate is the one thing that explains an image looking stale.

## Run it

You need **Node 18.15 or newer**, and for anything involving the sensor you need the
native grabber built first — see [Building the native side](#building-the-native-side),
which is a one-time step that needs no network.

```bash
npm install
npm start                 # live sensor, menu on http://localhost:8080
npm run record            # live sensor, and record every take to captures/
npm run replay            # replay a capture you already have, no sensor needed
```

`npm start` lands on a menu, not directly on the viewer — from there you pick the
live viewer, the take library, or the editor.

**`npm run replay` needs a capture, and none ships with this repository.** Captures
are large and binary, so `captures/` is gitignored. If you have a Kinect, record one
first with `npm run record`; if you do not, most of this program cannot be exercised,
and that is worth knowing before you invest an evening. `tools/make-fixture.js` loops
one short real capture into an arbitrarily long one, which is how the index and the
frame API get tested without shooting for five minutes.

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

**There is no authentication anywhere in this program**, so whoever can reach the port
can arm the recorder, start a take and stop one. The server binds `127.0.0.1` unless you
pass `--host`, and says on stdout when it did. A capture node is the case where being
reachable is the entire point — a browser on the Mac driving a Pi over Wi-Fi — and there
the network you trust is doing the work; the flag only makes that a decision somebody
took rather than the default.

Mutating routes and the WebSocket upgrade additionally require a same-origin `Origin`
and an address rather than a hostname — the socket included, because `WebSocket` is
exempt from the same-origin policy and sends no preflight, so without the rule any page
you visited could open one against a node on your own network and drive the recorder. It
stops hostile pages and it stops nothing else: curl, a script or another machine on the
Wi-Fi sends no origin and is allowed everything. The hostname half was added because
comparing `Origin` against `Host` was measured reaching every mutating route on the
*default loopback bind* through DNS rebinding, up to and including deleting a take, so a
browser arriving at any other hostname is now refused — which is the rule working rather
than a bug. `node tools/guard-check.mjs` proves both halves, and
[SECURITY.md](SECURITY.md) has the threat model and exactly what `--host 0.0.0.0` exposes.

`--replay` is the one to reach for when iterating on shaders: it loops a recorded
capture so you can work on the visuals with the sensor unplugged. It replays the
*recorded* arrival spacing rather than a uniform 30fps, because frames do not arrive
evenly — a live stream on a degraded link runs p50 64ms against p90 222ms, and pacing
them evenly would hand the viewer the one cadence that never happens, so smoothing
tuned against replay would look right there and stutter on the sensor.

## The four surfaces

`npm start` opens a menu onto four things, and most of the program lives in the
three that are not the viewer. The reasoning behind each one lives in the comments
of the file that implements it.

**The viewer** is the live cloud — orbit around what the sensor sees right now, with
the render modes below.

**The recorder** writes takes. It arms, waits for the sensor's hello so the take
carries the intrinsics it was shot with, and streams frames straight to disk in the
same framing the wire uses, so a capture file is byte-identical to what the grabber
emitted. You can drop marks while a take is running, and it refuses to start a take
it does not have disk space to finish. Its preview clip range is cosmetic and
deliberately cannot reach the grabber's `--min-depth`/`--max-depth`, which clip on
the GPU before a frame exists — getting those two backwards destroys footage in the
one situation where nobody is watching for it.

**The library** is the gallery of takes, and it reconciles across two machines. A
capture node on the network and the machine you edit on each hold takes; the library
joins them on content hash rather than on filename, because two machines can hold
genuinely different takes under one name, and writing one over the other to satisfy
a naming convention would destroy footage. Takes can be pulled down, and a copy can
be reclaimed on the node after the local one is re-hashed.

**The editor** is where a take becomes a shot. The camera is keyframed through the
recorded volume on its own track, the look is keyframed on others, and a retime
curve maps program time onto source time so the footage can be slowed, held or run
backwards independently of the camera move. Seeking to a frame and playing to that
frame produce the same image, which is a property `tools/timeline-check.mjs` exists
to prove rather than assert.

**The render queue** takes finished edits and produces video. Jobs are claimed by a
worker pinned to the renderer class it will actually draw with, frames are pushed to
ffmpeg over a socket, and the queue survives a restart because it lives as records on
disk rather than as state in a process.

### Program time is the edit coordinate

Source time is a position inside the capture; program time is a position inside the
output. Under normal speed they advance together, and under a ramp, a hold or a reverse
they are genuinely different numbers — so every keyframe has to be stamped in one of
them, and both readings compile into working software that behaves differently. Every
track here, including the retime curve itself, is in program time, and rendering is
forward-only: `programTime = k / outputFps`, evaluate the tracks,
`sourceMs = retime(programTime)`, binary-search the index.

Three consequences worth knowing before changing anything near it:

- **Export needs no inverse.** Keying in source time would force export to invert the
  retime curve to learn which source time each output frame wants, which requires the
  curve to stay monotonic — so a hold or a reverse breaks it outright.
- **The virtual camera keeps its own pace when the footage slows**, which is the
  creative point rather than a side effect: the whole idea is re-photographing a take,
  and a photographer's movement is independent of what they are filming.
- **`fade` and `wake` stay in source time anyway**, because they drive surface memory,
  which advances per source frame. Converting them would mean dividing by the local
  retime slope, which is zero at a hold, so every trail would snap off exactly where a
  freeze should hold it.

Frame index was rejected as a coordinate for a measured reason: capture frames are not
evenly spaced in time (the p50/p90 spread above), so constant motion through index space
is visibly variable motion through real time.

## Viewer controls

Drag to orbit, scroll to zoom, right-drag to pan, `H` hides the panel.

| Mode | What it does |
| --- | --- |
| RGB | registered colour mapped onto the depth points |
| Depth | cool-to-warm ramp across the clip range |
| Ghost | luminance shell that glows along depth discontinuities |
| Contour | topographic bands sweeping through depth |
| Blackwall | crimson containment volume, cyan scan sweep, torn datastream bands |

Blackwall is a pipeline preset rather than just a shader branch: selecting it switches
the points to additive blending and drives the whole post chain (scan, rim, bloom,
trails, RGB split, scanlines, grain, glitch). Leaving it restores a neutral view. Every
value stays on its own slider afterwards, so the preset is a starting point.

Two controls decide how much white ends up on the geometry, which is the first
thing to reach for if the look feels blown out:

- **`scan`** is the plane sweeping through depth. Because it keys off distance
  rather than screen position, it lands on an angled surface as a diagonal band
  that drifts across it. Wide and hot, it reads as a light leak dragging over the
  scene instead of something scanning it, so it is kept narrow and tinted cyan.
- **`rim`** brightens depth discontinuities. It gives the subject its edge
  definition, but under additive blending plus bloom it washes broad surfaces
  toward white — turn it down before turning down bloom.

`turbulence` displaces points with a time-varying noise field. The `near`/`far`
depth clip is the most useful control for isolating a person from the room.
`cull speckle` drops points whose neighbours disagree, which cleans up the
sensor's own edge noise — measured at sigma ~= 3.5 + 1.3*d mm, so 4.6mm at 0.75m
rising to 10mm at 4.25m. `render %` scales the drawing buffer, and it is the one
control that reliably buys back frame time on a large display, for the reason the
[rendering cost](#rendering-cost) table gives.

## Surface memory

A ray landing on a different surface between frames is a death and a birth, and
teleporting the point was the loudest artifact in the image — 3.14% of pixels flip
valid/zero every frame pair, 44x more than the snap threshold ever touches. A
ping-pong float target now remembers where each ray used to be and how long ago it
swapped, so:

- **`fade`** cross-fades the transition: the new point ramps in over the same
  window the old one thins out. 120ms by default. This is the correctness half.
- **`wake`** lets a hard transition linger past the fade, shedding a trail from
  moving silhouettes. 0 by default, 550ms under Blackwall.

Wake length is keyed off the local depth spread, not the raw transition, and that
is what keeps a static scene from shimmering. Measured live: of 2.56% of pixels
swapping per 50ms, 2.36% classify soft — the depth solve's confidence gate
chattering on a flat wall, which earns only the cross-fade — against 0.20% hard.

Both are in milliseconds rather than frame intervals, so a better frame rate does
not silently shorten the look. With both at zero the ghost half of the geometry
leaves the draw range and the original 217088-point draw is restored exactly.
`__kinect.stateStats()` reads the memory back if a static scene ever starts
shedding.

## Frame interpolation

The sensor delivers 30fps on a healthy USB topology, and far less on a bad one,
while the display runs at 120Hz — so the vertex shader blends between the last
two depth frames rather than holding each one until the next arrives. Two details
make this an improvement rather than a regression:

- **Blend time comes from measured arrival spacing**, kept as an EMA, not an
  assumed 30fps. On a healthy link arrivals are a clean 33ms apart and the EMA is
  nearly a constant; on a degraded one they run at the p50/p90 spread above, and
  guessing that interval wrong stutters worse than not blending at all. The blend
  clamps at 1.0 so a late frame holds on the newest data rather than
  extrapolating past it.
- **Discontinuities snap instead of lerping.** A hand crossing in front of a wall
  jumps metres between frames, and interpolating that draws a smear through empty
  space for the whole interval. Above the `snap mm` threshold the point jumps to
  the new depth.

Both branches are verified against synthetic depth planes rendered to an offscreen
target: a 1200 mm jump lands exactly on the new depth rather than the lerp midpoint,
and a 100 mm drift interpolates to the midpoint. Worth re-checking against a capture
with real motion — the sample this was written against is nearly static, with only
0.06% of pixels exceeding the snap threshold between frames.

## Rendering cost

Measured on an M2 Max by rendering N times per frame so fixed overhead amortises
out. A plain rAF counter only measures the 120Hz vsync ceiling, not the work —
every configuration reads as "120fps" until you amplify it.

The point pass does not scale with resolution; the post chain does:

| Drawing buffer | Points only | With full Blackwall chain |
| --- | --- | --- |
| 0.92 Mpx | 0.83 ms | 0.87 ms |
| 2.07 Mpx | 0.83 ms | 1.17 ms |
| 3.69 Mpx | 0.83 ms | 1.57 ms |

So the 217k points are bound by vertex work and texture fetches, not fill rate —
resolution is nearly free for them. The post chain costs roughly 0.2 ms per
megapixel on top, which is what the `render %` slider exists to control. At 120Hz
the budget is 8.33 ms per frame.

The one optimisation that mattered was returning early on `mm <= 0.0` before the
four neighbour `texelFetch` calls, which cut the point pass from 1.44 ms to
0.71 ms at 2.28 Mpx. A large share of every frame is empty, and those pixels are
culled regardless of what their neighbours say.

Removing the fragment `discard` in favour of additive alpha falloff was measured
separately and made no difference here (0.71 vs 0.74 ms), so it is kept for the
look rather than for speed. Bloom runs at half the buffer resolution because it is
the most expensive pass in the chain.

## What did not work, measured rather than assumed

Kept because a negative result nobody wrote down is a negative result somebody
re-derives. Each of these looked obviously worth doing and none of them survived
measurement, on a fixed 40–45s window with a 6s warmup discarded.

**Transfer-pool tuning does nothing.** libfreenect2 uses a different isochronous
pool on macOS (`ir_pkts_per_xfer=128, ir_num_xfers=4`) than elsewhere (`8`/`60`),
and all four knobs take env overrides. Sweeping them across 13 runs, delivered fps
spans 1.03fps — while four runs of the *identical* baseline span 0.60fps. Every knob is
barely above run-to-run noise, and the Linux default was the worst of the set, so
Apple's choice is not a bug waiting to be fixed.

**`--no-color` does not halve the drop rate.** An older README claim said it did.
Controlled, drops went slightly *up* (1046/min with colour, 1089 without). The
mechanism was always weak: SuperSpeed isochronous bandwidth is reserved, so bulk
colour transfers cannot preempt the depth endpoint's allocation. Colour is
exonerated.

**The depth solve is not the bottleneck, and a Metal port would not help.** The
vendored OpenCL kernels benchmark at 0.75–0.85 ms per frame against an 80–90 ms
frame interval, and the solve already runs on its own `AsyncPacketProcessor`
thread — so making it faster cannot raise USB intake by one frame. Porting to
Metal is a contingency against Apple dropping OpenCL, not a performance change.

**What *is* worth watching** is `Registration::apply` at 6.3 ms/frame, because it
runs serially in the grabber's frame loop and lands directly on capture-to-wire
latency. The whole serial half of that loop measures 7.1 ms against a 33 ms budget,
which `grabber --profile` prints per segment. That number is also a correction: it
was carried as 4.5 ms for a long time, and `--profile` over three runs gives
6.05 / 6.33 / 6.53 at p50 — the inherited figure was roughly 40% low. Its occlusion
filter's share has *not* been re-measured on this machine and should not be quoted
as if it had.

**Compressing the wire is possible but bounded by colour.** 434 KB of the 486 KB
frame is uncompressed depth, and an early estimate put zstd-over-temporal-deltas
at 35–45 Mbit/s. Measured, that was optimistic: per-frame zstd manages 1.75x on
depth, and an explicit u16 temporal delta plus zstd reaches 2.75x on depth and
2.30x overall — 117 Mbit/s down to 51. Colour compresses at exactly 1.00x, being
already JPEG, which floors the whole thing.

## Building the native side

Both builds are one-time, and neither needs the network. libfreenect2's source is
in this repo at `third_party/libfreenect2` — upstream v0.2.1 plus our declared
edits, see `third_party/UPSTREAM.md` — and builds into the gitignored
`vendor/prefix`. Expect a few minutes for the first build.

Install the dependencies first:

```bash
brew install libusb jpeg-turbo cmake                       # macOS
sudo apt install libusb-1.0-0-dev libturbojpeg0-dev cmake \
                 libglfw3-dev libgl1-mesa-dev              # Debian / Raspberry Pi OS
```

The two GL packages are on the Debian line and not the macOS one because the `linux`
preset builds depth on OpenGL, and libfreenect2 treats a missing GLFW as a reason to
build without it rather than a reason to stop — so this line lacking them produced a
CPU-only library and a build that reported success over it. The build now refuses that
outcome, but the refusal is a worse way to find out than installing them here.

Then build both:

```bash
npm run build:native
```

It picks a preset from the platform — `macos` builds depth on OpenCL, `linux`
covers the Pi and builds it on OpenGL — resolves Homebrew's prefix rather than
assuming one, and refuses with the `brew install` line you need when a dependency
is missing rather than letting it surface as a cmake package it could not find.
`--preset macos|linux` overrides the detection, `--clean` discards the vendored
build, and `node tools/build-native.mjs --help` has the rest.

Picking the wrong preset costs you a refusal rather than a silent slow path: the
grabber's `--pipeline` is guarded by whichever backend the library was actually
compiled with, so a build without the one you ask for says so instead of falling
through to something else.

The flags are in that script rather than here, one copy, next to the comments
explaining why each is what it is — the OpenCL/OpenGL split, the CMake policy
floor that v0.2.1 needs, and why the Homebrew prefix is looked up instead of
written down. It closes by running the grabber it just built rather than checking
that the file exists, since a stale binary and one linked against a prefix that
has moved both exist perfectly well.

`node tools/vendor-check.mjs` proves the source is upstream v0.2.1 plus exactly
the declared edits, offline, before you trust a build of it.

Depth runs through OpenCL on the GPU, and `--pipeline cpu` exists for comparison
rather than for use. Measured on a healthy link, the two differ by more than 2x:

| pipeline | fps | depth packets skipped |
| --- | --- | --- |
| OpenCL | 30.0 | 0 |
| CPU | 14.4 | 638 |

Both runs saw the same two USB subsequence failures, so delivery was identical and
the solve is the only variable. The CPU path is plain scalar C++ on a single
`AsyncPacketProcessor` thread — libfreenect2 ships no hand-written SIMD for depth on
any architecture — which puts it at roughly 70ms per frame against a 33ms budget.
The OpenCL kernels run the same solve in 0.75–0.85ms, some 80x faster.

## Wire format

One framing for the live stream, the recording and the replay, so a capture file
is byte-identical to what the grabber emits:

```
[u32 magic 'KNCT'][u32 type][u32 payloadLen][payload]

type 1  hello  UTF-8 JSON, once, before any frame:
               { serial, firmware, width, height, fx, fy, cx, cy, color }
type 2  frame  [u32 depthBytes][u32 colorBytes][u64 timestampMs]
               [u16 depth[512*424] millimetres, 0 = no reading]
               [JPEG of the registered 512x424 colour image]
```

Measured over a real capture: 434,176 bytes of depth plus a 49–59KB JPEG, 486KB per
frame all in. At 30fps that is 14.6MB/s, or 117Mbit/s per connected browser. Fine
over ethernet, right at the practical ceiling of Wi-Fi.

The grabber writes frames to stdout and every log line to stderr — a single stray
log line on stdout would desync the stream permanently.

The browser needs `fx/fy/cx/cy` from the hello message to unproject; hardcoded
intrinsics skew the cloud in a way that is hard to spot and hard to attribute.

## The edits we carry in libfreenect2

Two, both in the vendored source itself rather than in a patch file, and both
pinned by `tools/vendor-check.mjs` so they cannot quietly revert.

**Accepting depth frames that are missing only the unused 10th sub-image.**
libfreenect2 discards a frame unless all ten arrive, but the depth solve reads
only 0–8, so frames were being thrown away over ~300KB that nothing reads. Worth
+12.9% on the degraded topology — 12.82fps to 14.48fps — and inert on a healthy
one, where nothing is dropped.

**Threading registration's occlusion filter.** On an M2 Max at four threads that is
worth 2.07ms of registration's 5.76ms p50, but the shipped default is two, because
the capture node measures four as the worst threaded setting there is. The
constrained machine decides.

`third_party/UPSTREAM.md` carries both in full: what changed, why the tree is
committed rather than cloned, and the interleaved A/B behind each number.

## Resolved: USB topology was the whole bottleneck

The sensor ran at 12–15fps for a long time, with ~1000 discarded depth frames a
minute. It was the hub chain, and nothing else. Moving it from three hubs deep on
a Thunderbolt dock to a single hub on its own controller took it to a flat
30.00fps with zero drops, 1200 frames in 40 seconds, three runs, identical:

| topology | fps | drops/min |
| --- | --- | --- |
| 3 hubs deep on the dock | 12.82 | ~1000 |
| ditto, with the sub-9 patch | 14.48 | ~950 |
| 1 hub, own controller | 30.00 | 0 |

The sensor is greedy in a way that hubs handle badly: the depth endpoint declares a
33,792-byte isochronous packet per 125µs microframe, which *reserves* 2.16Gbit/s of
the link whether or not it is used, against 90MB/s of payload actually sent at 30fps
before colour. Anything sharing that controller competes for what is left, and in the
old topology the sensor was a *sibling* of the last hub, sharing its parent with the
network interface. libfreenect2 reports continuous `not all subsequences received`
there — isochronous packets dropped, so most depth frames arrive incomplete and get
discarded.

Replay from a file held a steady 29fps throughout all of it, which is what ruled out
the browser and the GPU path as the bottleneck.

Check the link is actually SuperSpeed before measuring anything — a USB 2.0 cable
enumerates fine and then fails to stream:

```bash
ioreg -p IOUSB -w0 -l | grep -A 40 "Xbox NUI Sensor@" | grep "Device Speed"
```

`"Device Speed" = 3` is SuperSpeed and works. `= 2` is High Speed, and the Kinect
v2 cannot stream on it — libfreenect2 fails at `failed to claim interface with
IrInterfaceId(=1)`, which reads like a permissions problem and is not one.

Two workarounds that sound plausible and were measured *not* to work are in
[What did not work](#what-did-not-work-measured-rather-than-assumed): `--no-color`,
and tuning the isochronous transfer pool.
