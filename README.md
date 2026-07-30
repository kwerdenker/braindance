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
capture at a full 30fps so you can work on the visuals with the sensor unplugged.

## Viewer controls

Drag to orbit, scroll to zoom, right-drag to pan, `H` hides the panel.

| Mode | What it does |
| --- | --- |
| RGB | registered colour mapped onto the depth points |
| Depth | cool-to-warm ramp across the clip range |
| Ghost | luminance shell that glows along depth discontinuities |
| Contour | topographic bands sweeping through depth |

`turbulence` displaces points with a time-varying noise field. The `near`/`far`
depth clip is the most useful control for isolating a person from the room.
`cull speckle` drops points whose neighbours disagree, which cleans up the noise
that dropped USB packets leave behind.

## Building the native side

Both builds are one-time. libfreenect2 installs into `vendor/prefix`:

```bash
git clone --depth 1 https://github.com/OpenKinect/libfreenect2.git vendor/libfreenect2
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
path on macOS. Depth runs through OpenCL on the GPU; the CPU pipeline loses its
SSE/AVX paths on Apple Silicon and can't hold 30fps.

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

Roughly 500KB per frame, so ~15MB/s at 30fps. The grabber writes frames to stdout
and every log line to stderr — a single stray log line on stdout would desync the
stream permanently.

The browser needs `fx/fy/cx/cy` from the hello message to unproject; hardcoded
intrinsics skew the cloud in a way that is hard to spot and hard to attribute.

## Known issue: USB bandwidth

The sensor currently runs at **8–15fps instead of 30**, because it is connected
through a chain of hubs on a Thunderbolt dock:

```
Intel USB3 HUB → VIA USB3.1 Hub → VIA USB3.0 Hub → NuiSensor Adaptor → Xbox NUI Sensor
```

libfreenect2 reports continuous `not all subsequences received` — isochronous USB
packets are being dropped, so most depth frames arrive incomplete and get discarded.
Measurements:

| Setup | Result |
| --- | --- |
| CPU depth, through the dock | 597 USB drops, 206 frames lost to slow depth processing |
| OpenCL depth, through the dock | 947 USB drops, 4 lost to processing — GPU keeps up fine |
| OpenCL, `--no-color` | drop rate roughly halves, confirming bandwidth contention |
| Replay from file | a steady 29fps — the browser and GPU path are not the bottleneck |

The fix is physical: plug the Kinect adapter straight into a Mac port with a plain
passive USB-A→USB-C adapter, no hub in between. The Kinect v2 needs sustained
isochronous USB3 bandwidth and is well known for refusing to share a hub chain.
`--no-color` is a partial workaround if the dock has to stay.
