# kinect-experiments

Realtime Kinect v2 point cloud in the browser. A native grabber pulls depth and
registered colour from [libfreenect2](https://github.com/OpenKinect/libfreenect2),
a Node server fans the frames out over WebSocket, and a Three.js viewer unprojects
them on the GPU using the sensor's own intrinsics.

```
Kinect v2 ──USB3──▶ native/grabber ──framed stdout──▶ server/index.js ──WebSocket──▶ web/main.js
                    (libfreenect2 +                   (fan-out, drop-to-latest)     (GPU unprojection,
                     OpenCL depth,                                                   217k points)
                     TurboJPEG colour)
```

## Run it

```bash
npm start                 # live sensor, viewer on http://localhost:8080
npm run record            # live + write captures/sample.knct
npm run replay            # replay a capture, no sensor needed
```

Options pass through to the grabber:

```bash
node server/index.js --pipeline cpu     # CPU depth instead of OpenCL
node server/index.js --no-color         # depth only, roughly half the USB bandwidth
node server/index.js --port 9000
node server/index.js --record captures/session.knct
node server/index.js --replay captures/session.knct
```

`--replay` is the one to reach for when iterating on shaders: it loops a recorded
capture so you can work on the visuals with the sensor unplugged. It replays the
*recorded* arrival spacing, not a uniform 30fps — a live stream runs p50 64ms
against p90 222ms, and pacing every frame evenly would hand the viewer the one
cadence that never happens, so smoothing tuned against replay would look right
there and stutter on the sensor.

## Viewer controls

Drag to orbit, scroll to zoom, right-drag to pan, `H` hides the panel.

| Mode | What it does |
| --- | --- |
| RGB | registered colour mapped onto the depth points |
| Depth | cool-to-warm ramp across the clip range |
| Ghost | luminance shell that glows along depth discontinuities |
| Contour | topographic bands sweeping through depth |
| Blackwall | crimson containment volume, cyan scan sweep, torn datastream bands |

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
`cull speckle` drops points whose neighbours disagree, which cleans up the noise
that dropped USB packets leave behind. `render %` scales the drawing buffer and is
the one control that reliably buys back frame time on a large display.

## Frame interpolation

The sensor delivers 8–15fps while the display runs at 120Hz, so the vertex shader
blends between the last two depth frames rather than holding each one until the
next arrives. Two details make this an improvement rather than a regression:

- **Blend time comes from measured arrival spacing**, kept as an EMA, not an
  assumed 30fps. The stream is irregular, and guessing the interval wrong stutters
  worse than not blending at all. The blend clamps at 1.0 so a late frame holds on
  the newest data instead of extrapolating past it.
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

Both builds are one-time. libfreenect2 installs into `vendor/prefix`:

```bash
git clone --depth 1 https://github.com/OpenKinect/libfreenect2.git vendor/libfreenect2
git -C vendor/libfreenect2 apply ../../patches/*.patch
cmake -S vendor/libfreenect2 -B vendor/libfreenect2/build \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DCMAKE_INSTALL_PREFIX="$PWD/vendor/prefix" \
  -DENABLE_CXX11=ON -DENABLE_OPENCL=ON -DENABLE_OPENGL=OFF -DENABLE_CUDA=OFF \
  -DTurboJPEG_INCLUDE_DIRS=/opt/homebrew/opt/jpeg-turbo/include \
  -DTurboJPEG_LIBRARIES=/opt/homebrew/opt/jpeg-turbo/lib/libturbojpeg.dylib
cmake --build vendor/libfreenect2/build --target install -j8

cmake -S native -B native/build && cmake --build native/build -j8
```

Needs `brew install libusb jpeg-turbo cmake`. OpenGL is off deliberately — it only
drives libfreenect2's own viewer, which we don't use, and it's the most deprecated
path on macOS. Depth runs through OpenCL on the GPU; the CPU pipeline is plain
scalar C++ — libfreenect2 ships no hand-written SIMD for depth on any
architecture — and a single core can't hold 30fps over ten phase images.

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

## The patch in `patches/`

libfreenect2 assembles each depth frame from ten sub-images and discards the
whole frame unless all ten arrive. But the depth solve reads only sub-images
0–8 — nine measurements, three phase steps for each of three modulation
frequencies. The tenth is commented out in the CPU processor (`// 10th
measurement`) and never fetched by the OpenCL kernel.

So frames were being thrown away over ~300KB of data that nothing reads.
Measured: 6.8% of all discarded frames were missing nothing but sub-image 9.

Accepting them is worth **+12.9%** on delivered frame rate — 12.82fps to
14.48fps, measured as an interleaved A/B (old, new, old, new, old, new) with
both paths in one binary behind a temporary switch. Every new-path run beat
every old-path run. Depth output is unchanged, because the bytes the patch stops
waiting for were never an input to the solve.

The interleaving matters: a first pass comparing four runs before against three
after showed +23%, but drift between measurement sessions accounted for most of
the difference. Sequential before/after is not trustworthy on this rig.

The patch lives in `patches/` rather than in the tree because `vendor/` is
gitignored. `docs/performance-investigation.md` has the full measurements.

## Known issue: USB bandwidth

The sensor runs at **12–15fps instead of 30**, because it is connected through a
chain of hubs on a Thunderbolt dock. `ioreg` shows the sensor is a *sibling* of
the last hub, sharing its parent with the machine's network interface:

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

The fix is physical: plug the Kinect adapter straight into a Mac port with a plain
passive USB-A→USB-C adapter, no hub in between. The Kinect v2 needs sustained
isochronous USB3 bandwidth and is well known for refusing to share a hub chain.

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
