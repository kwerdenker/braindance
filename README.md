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

**Status: complete and working, maintained as a personal project.** All nine steps
of the build order in `docs/recording-and-nle.md` are done. It runs on macOS
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
are large and binary, so `captures/` is gitignored and there is no sample to clone.
If you have a Kinect, record one first with `npm run record`; if you do not, most of
this program cannot be exercised, and that is worth knowing before you invest an
evening. `tools/make-fixture.js` loops one short real capture into an arbitrarily
long one, which is how the index and the frame API get tested without shooting for
five minutes.

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

**The server binds loopback unless you pass `--host`, and a capture node needs it.**
There is no authentication anywhere in this program: whoever can reach the port can
arm the recorder, start a take and stop one. On a Mac you are editing on, that is
nothing anybody else should be able to reach, so the default is `127.0.0.1`. A
capture node is the case where being reachable is the entire point — a browser on
the Mac driving a Pi over Wi-Fi — so start the node with `--host 0.0.0.0` and it
says on stdout that it did. Being on a network you trust is doing the work there;
the flag just makes that a decision somebody took rather than the default.

The WebSocket is held to the same origin rule the mutating HTTP routes are, because
`WebSocket` is exempt from the same-origin policy and sends no preflight — so
without it, any page you visited could open a socket against a node on your own
network and drive the recorder. A request carrying no `Origin` at all still passes,
which is load-bearing rather than lax: every call across the capture-node link is a
server-side `fetch` and none of them has an origin to declare.
`node tools/guard-check.mjs` proves both halves.

Two things that paragraph does not cover, and both matter before you point this at a
network. **The origin rule stops hostile web pages and nothing else** — a request with
no `Origin` passes on purpose, so curl, a script, or any other machine on the Wi-Fi is
allowed to do everything. And **comparing `Origin` against `Host` cannot survive DNS
rebinding**: a name an attacker controls, re-resolved onto the address you listen on,
makes the two headers match because they are the same name. That was measured reaching
every mutating route on the *default loopback bind*, up to and including deleting a
take, so the guard additionally requires that a browser arrived at an address rather
than a name. If you reach this server through a browser at some other hostname, that
request is now refused — which is the rule working rather than a bug.

[SECURITY.md](SECURITY.md) has the threat model and exactly what `--host 0.0.0.0`
exposes.

`--replay` is the one to reach for when iterating on shaders: it loops a recorded
capture so you can work on the visuals with the sensor unplugged. It replays the
*recorded* arrival spacing, not a uniform 30fps — a live stream runs p50 64ms
against p90 222ms, and pacing every frame evenly would hand the viewer the one
cadence that never happens, so smoothing tuned against replay would look right
there and stutter on the sensor.

## The four surfaces

`npm start` opens a menu onto four things, and most of the program lives in the
three that are not the viewer. The full design and the reasoning behind it are in
[`docs/recording-and-nle.md`](docs/recording-and-nle.md), which is the canonical
document and is long.

**The viewer** is the live cloud — orbit around what the sensor sees right now, with
the render modes below. This is the part the rest of this README describes.

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
ffmpeg over a socket, and the queue survives a restart because it is records on disk
rather than state in a process.

## Viewer controls

Drag to orbit, scroll to zoom, right-drag to pan, `H` hides the panel.

| Mode | What it does |
| --- | --- |
| RGB | registered colour mapped onto the depth points |
| Depth | cool-to-warm ramp across the clip range |
| Ghost | luminance shell that glows along depth discontinuities |
| Contour | topographic bands sweeping through depth |
| Blackwall | crimson containment volume, cyan scan sweep, torn datastream bands |

## Persistence

A ray landing on a different surface between frames is a death and a birth. The
viewer used to teleport the point, which was the loudest artifact in the image —
3.14% of pixels flip valid/zero every frame pair, 44x more than the snap
threshold ever touches. A ping-pong float target now remembers where each ray
used to be and how long ago it swapped, so:

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

Blackwall is a pipeline preset rather than just a shader branch: selecting it
switches the points to additive blending and drives the whole post chain (scan,
rim, bloom, trails, RGB split, scanlines, grain, glitch). Leaving it restores a
neutral view. Every value stays on its own slider afterwards, so the preset is a
starting point.

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
rising to 10mm at 4.25m. `render %` scales the drawing buffer and is
the one control that reliably buys back frame time on a large display.

## Frame interpolation

The sensor delivers 30fps on a healthy USB topology, and far less on a bad one,
while the display runs at 120Hz — so the vertex shader blends between the last
two depth frames rather than holding each one until the next arrives. Two details make this an improvement rather than a regression:

- **Blend time comes from measured arrival spacing**, kept as an EMA, not an
  assumed 30fps. On a healthy link arrivals are a clean 33ms apart and the EMA is
  nearly a constant; on a degraded one they ran p50 64ms against p90 222ms, and
  guessing that interval wrong stutters worse than not blending at all. The blend
  clamps at 1.0 so a late frame holds on the newest data rather than
  extrapolating past it.
- **Discontinuities snap instead of lerping.** A hand crossing in front of a wall
  jumps metres between frames, and interpolating that draws a smear through empty
  space for the whole interval. Above the `snap mm` threshold the point jumps to
  the new depth.

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
megapixel on top, which is what the `render %` slider exists to control on a large
display. At 120Hz the budget is 8.33 ms per frame.

The one optimisation that mattered was returning early on `mm <= 0.0` before the
four neighbour `texelFetch` calls, which cut the point pass from 1.44 ms to
0.71 ms at 2.28 Mpx. A large share of every frame is empty, and those pixels are
culled regardless of what their neighbours say.

Removing the fragment `discard` in favour of additive alpha falloff was measured
separately and made no difference here (0.71 vs 0.74 ms), so it is kept for the
look rather than for speed. Bloom runs at half the buffer resolution because it is
the most expensive pass in the chain.

Interpolation's two branches are verified against synthetic depth planes rendered
to an offscreen target: a 1200 mm jump lands exactly on the new depth rather than
the lerp midpoint, and a 100 mm drift interpolates to the midpoint. Worth
re-checking against a capture with real motion — `captures/sample.knct` is nearly
static, with only 0.06% of pixels exceeding the snap threshold between frames.

## Building the native side

Both builds are one-time, and neither needs the network. libfreenect2's source is
in this repo at `third_party/libfreenect2` — upstream v0.2.1 plus our declared
edits, see `third_party/UPSTREAM.md` — and builds into the gitignored
`vendor/prefix`. Expect a few minutes for the first build.

Install the dependencies first:

```bash
brew install libusb jpeg-turbo cmake                       # macOS
sudo apt install libusb-1.0-0-dev libturbojpeg0-dev cmake  # Debian / Raspberry Pi OS
```

Then, on macOS with Homebrew:

```bash
cmake -S third_party/libfreenect2 -B vendor/build \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DCMAKE_INSTALL_PREFIX="$PWD/vendor/prefix" \
  -DENABLE_CXX11=ON -DENABLE_OPENCL=ON -DENABLE_OPENGL=OFF -DENABLE_CUDA=OFF \
  -DTurboJPEG_INCLUDE_DIRS="$(brew --prefix jpeg-turbo)/include" \
  -DTurboJPEG_LIBRARIES="$(brew --prefix jpeg-turbo)/lib/libturbojpeg.dylib"
cmake --build vendor/build --target install -j8

cmake -S native -B native/build && cmake --build native/build -j8
```

`brew --prefix` rather than a literal `/opt/homebrew` because that path is
Apple-Silicon-only — Intel Macs put it at `/usr/local`, and a hardcoded prefix is a
build failure whose message does not mention the prefix.

On Linux and the Pi, drop both `TurboJPEG_*` flags entirely — pkg-config finds it —
and swap `-DENABLE_OPENCL=ON -DENABLE_OPENGL=OFF` for `OFF`/`ON`. V3D has OpenGL
and no OpenCL, and the grabber's `--pipeline` is guarded by whichever the library
was actually compiled with rather than falling through silently.

`node tools/vendor-check.mjs` proves the source is upstream v0.2.1 plus exactly
the declared edits, offline, before you trust a build of it.

OpenGL is off on macOS deliberately — it only drives libfreenect2's own viewer,
which we don't use, and it's the most deprecated path on the platform.

Depth runs through OpenCL on the GPU, and `--pipeline cpu` exists for comparison
rather than for use. Measured on a healthy link, the two differ by more than 2x:

| pipeline | fps | depth packets skipped |
| --- | --- | --- |
| OpenCL | 30.0 | 0 |
| CPU | 14.4 | 638 |

Both runs saw the same two USB subsequence failures, so delivery was identical
and the solve is the only variable. The CPU path is plain scalar C++ on a single
`AsyncPacketProcessor` thread — libfreenect2 ships no hand-written SIMD for depth
on any architecture — which puts it at roughly 70ms per frame against a 33ms
budget. The OpenCL kernels run the same solve in 0.75–0.85ms, some 80x faster.

That ratio is about the depth solve only. `Registration::apply` costs a further
6.3ms/frame and runs serially in the grabber's frame loop, so it is the number
to watch if the depth solve ever stops being the ceiling. The whole serial half
of that loop measures 7.1ms against a 33ms budget, which `grabber --profile`
will print per segment.

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

Measured over `captures/sample.knct`: 434,176 bytes of depth plus a 49–59KB JPEG,
486KB per frame all in. At 30fps that is 14.6MB/s, or 117Mbit/s per connected
browser. Fine over ethernet, right at the practical ceiling of Wi-Fi.

The grabber writes frames to stdout and every log line to stderr — a single stray
log line on stdout would desync the stream permanently.

The browser needs `fx/fy/cx/cy` from the hello message to unproject; hardcoded
intrinsics skew the cloud in a way that is hard to spot and hard to attribute.

## The one edit we carry in libfreenect2

libfreenect2 assembles each depth frame from ten sub-images and discards the
whole frame unless all ten arrive. But the depth solve reads only sub-images
0–8 — nine measurements, three phase steps for each of three modulation
frequencies. The tenth is commented out in the CPU processor (`// 10th
measurement`) and never fetched by the OpenCL kernel.

So frames were being thrown away over ~300KB of data that nothing reads.
Measured: 6.8% of all discarded frames were missing nothing but sub-image 9.

Accepting them was worth **+12.9%** on the degraded topology — 12.82fps to
14.48fps, measured as an interleaved A/B (old, new, old, new, old, new) with
both paths in one binary behind a temporary switch. Every new-path run beat
every old-path run.

On a healthy topology nothing is dropped, so the patch is inert. It stays as
insurance: it costs nothing and it keeps a marginal link from throwing away
frames it did not need to. Depth output is unchanged, because the bytes the patch stops
waiting for were never an input to the solve.

The interleaving matters: a first pass comparing four runs before against three
after showed +23%, but drift between measurement sessions accounted for most of
the difference. Sequential before/after is not trustworthy on this rig.

It lives in the vendored source itself, at
`third_party/libfreenect2/src/depth_packet_stream_parser.cpp`, and
`tools/vendor-check.mjs` pins its exact content so it cannot quietly revert.
It used to be a `.patch` file applied to a gitignored clone, which meant the
source existed in two representations that could disagree.
`docs/performance-investigation.md` has the full measurements.

## Resolved: USB topology was the whole bottleneck

The sensor ran at 12–15fps for a long time, with ~1000 discarded depth frames a
minute. It was the hub chain, and nothing else. Moving it from three hubs deep on
a Thunderbolt dock to a single hub on its own controller took it to **a flat
30.00fps with zero drops** — 1200 frames in 40 seconds, three runs, identical:

| topology | fps | drops/min |
| --- | --- | --- |
| 3 hubs deep on the dock | 12.82 | ~1000 |
| ditto, with the sub-9 patch | 14.48 | ~950 |
| **1 hub, own controller** | **30.00** | **0** |

Check the link is actually SuperSpeed before measuring anything — a USB 2.0 cable
enumerates fine and then fails to stream:

```bash
ioreg -p IOUSB -w0 -l | grep -A 40 "Xbox NUI Sensor@" | grep "Device Speed"
```

`"Device Speed" = 3` is SuperSpeed and works. `= 2` is High Speed, and the Kinect
v2 cannot stream on it — libfreenect2 fails at `failed to claim interface with
IrInterfaceId(=1)`, which reads like a permissions problem and is not one.

The old topology, kept because it is a good example of what to avoid — the sensor
was a *sibling* of the last hub, sharing its parent with the network interface:

```
AppleT8112USBXHCI@00000000
└─ USB3 HUB@00200000
   └─ USB3.1 Hub@00240000
      ├─ NuiSensor Adaptor@00242000 → Xbox NUI Sensor@00242100
      └─ USB3.0 Hub@00241000
         └─ USB 10/100/1000 LAN@00241400   (en26, the default route)
```

libfreenect2 reports continuous `not all subsequences received` — isochronous USB
packets are being dropped, so most depth frames arrive incomplete and get discarded.

The sensor is greedy in a way that hubs handle badly. Depth arrives as ten raw
11-bit phase images per frame, `512*424*11/8 * 10` = 2.98MB, so 90MB/s (716Mbit/s)
of payload at 30fps before colour. Worse, the depth endpoint declares a max iso
packet size of `0x8400` = 33,792 bytes per 125µs microframe, which *reserves*
2.16Gbit/s of the link whether or not it is used. Anything sharing that controller
is competing for what is left.

Measurements:

| Setup | Result |
| --- | --- |
| CPU depth, through the dock | 597 USB drops, 206 frames lost to slow depth processing |
| OpenCL depth, through the dock | ~1000 drops/min, ~0 lost to processing — GPU keeps up fine |
| Replay from file | a steady 29fps — the browser and GPU path are not the bottleneck |

The Kinect v2 needs sustained isochronous USB3 bandwidth — it reserves
2.16Gbit/s of the link whether it uses it or not — and it will not tolerate a
hub chain. One hub is fine; three was not.

Two workarounds that sound plausible and were measured **not** to work, so nobody
re-derives them:

- **`--no-color` does not halve the drop rate.** An earlier version of this file
  claimed it did. Under a controlled 40s window drops went slightly *up*
  (1046 → 1089/min). SuperSpeed isochronous bandwidth is reserved, so the bulk
  colour stream cannot preempt the depth endpoint's allocation.
- **Transfer-pool tuning does nothing.** libfreenect2 uses a different iso pool
  on macOS (`ir_pkts_per_xfer=128, ir_num_xfers=4`) than elsewhere (`8`/`60`),
  and all four knobs are env-overridable. Across 13 runs sweeping them, delivered
  fps spanned 1.03fps while four runs of the *identical* baseline spanned
  0.60fps — the effect of every knob is inside run-to-run noise, and the Linux
  default was the worst of the set.
