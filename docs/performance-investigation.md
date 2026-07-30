# Performance investigation, 2026-07-30

Measured on the M2 Max, sensor on its usual dock topology. Every number here
comes from a fixed 40–45s window with a 6s warmup, load average recorded
alongside. Where an earlier claim did not survive re-measurement, it is called
out rather than quietly dropped.

## The headline: we discard 2.98MB frames over one missing tenth

libfreenect2 assembles each depth frame from ten sub-images and discards the
whole frame unless all ten arrive
(`depth_packet_stream_parser.cpp:110`). The debug log already prints the arrival
bitmask, so the loss distribution is directly measurable. Over 45s:

| sub-images present | discarded frames | share |
| --- | --- | --- |
| 9 of 10 | 485 | 70.5% |
| 8 of 10 | 161 | 23.4% |
| 7 of 10 | 37 | 5.4% |
| 6 or fewer | 5 | 0.7% |

Mean present in a discarded frame: **8.63 of 10**.

In the same run, 585 frames were delivered and 688 discarded — so **27.7 fps is
arriving at the host** and we surface 12.7 of it. The sensor is very nearly
keeping up; the loss is almost entirely at the last assembly step.

Loss is uniform across the ten slots (12.4%–15.6%, a 1.30x spread), so this is
random bus contention rather than a structural scheduling boundary tied to one
particular sub-image. That matters: uniform loss is what makes substitution
viable, because no single sub-image is systematically absent.

Recovery arithmetic, from the same window:

| policy | frames in 46s | delivered fps |
| --- | --- | --- |
| today: require all 10 | 585 | 12.7 |
| accept ≤1 missing | 1070 | 23.3 |
| accept ≤2 missing | 1231 | 26.8 |

Those two rows are an upper bound on what recovery could yield, not a plan. How
to actually reach them depends on what the ten sub-images *are*, which is
resolved in the two sections at the end: one part of it turned out to be free
and is now implemented, and the rest needs a new solve path rather than the
naive substitution this table implies.

## What did not work, measured rather than assumed

**Transfer-pool tuning does nothing.** libfreenect2 uses a different iso
transfer pool on macOS (`ir_pkts_per_xfer=128, ir_num_xfers=4`) than everywhere
else (`8`/`60`), and all four knobs are env-overridable. Sweeping them:

| config (TRANSFERS × PACKETS) | fps | drops/min |
| --- | --- | --- |
| 4×128 (Apple default) | 12.10 | 996 |
| 8×64 | 11.65 | 1020 |
| 16×32 | 12.35 | 981 |
| 32×16 | 11.95 | 1003 |
| 60×8 (Linux default) | 11.40 | 1046 |
| 16×128 | 12.43 | 968 |

Across 13 runs total, delivered fps spans 1.03 fps. Four runs of the *identical*
baseline configuration span 0.60 fps. The effect of every knob is barely above
run-to-run noise, and the Linux default was the worst of the set — Apple's
choice is not a bug to be fixed.

**`--no-color` does not halve the drop rate.** An earlier README claim said it
did. Under controlled measurement it does not reproduce:

| | fps | drops/min |
| --- | --- | --- |
| control, colour on | 11.50 | 1046 |
| `--no-color` | 11.85 | 1089 |
| `--no-color` + 16×128 | 11.40 | 1116 |

Drops went slightly *up*. The mechanism was always weak — SuperSpeed
isochronous bandwidth is reserved, so bulk colour transfers should not be able
to preempt the depth endpoint's allocation. Colour is exonerated.

**The depth pipeline is not a bottleneck and Metal will not help.** The vendored
OpenCL kernels were compiled and benchmarked standalone: 0.75–0.85ms mean per
frame against an 80–90ms frame interval. `skipping depth packet` was logged 1
time across 13 runs. The solve also runs on its own worker thread —
`packet_pipeline.cpp:87-91` already wraps it in an `AsyncPacketProcessor` — so
making it faster cannot raise USB intake by a single frame. A Metal port is a
contingency plan against Apple removing OpenCL, not a performance change.

**The render stack is not a bottleneck either.** The point pass is 0.83ms of an
8.33ms budget at 120Hz and flat across resolutions. Replay from file sustains
29fps, which proves the browser path holds sensor-max rate.

## Topology correction

The README described the chain as the sensor sitting behind three hubs. `ioreg`
shows the sensor is a *sibling* of the third hub, and that it shares its parent
with the machine's network interface:

```
AppleT8112USBXHCI@00000000
└─ USB3 HUB@00200000
   └─ USB3.1 Hub@00240000
      ├─ NuiSensor Adaptor@00242000 → Xbox NUI Sensor@00242100
      └─ USB3.0 Hub@00241000
         └─ USB 10/100/1000 LAN@00241400   (en26, the default route)
```

Whether NIC traffic actually costs Kinect frames is **untested**: a saturation
attempt only reached 4 Mbit/s, far too little to stress a USB3 hub. At that
level there was no effect (12.02 → 12.12 fps). Heavy NIC traffic remains an open
question, and the cheap way to settle it is to move the sensor to a different
controller and re-measure.

## Smaller, real findings

- **`Registration::apply` costs 4.5ms/frame**, of which 3.8ms is the occlusion
  filter, and it runs *serially* in the grabber's frame loop, so it lands
  directly on capture-to-wire latency. `enable_filter=false` is a one-argument
  change; the cost is colour bleed at silhouette edges.
- **434KB of the 486KB frame is uncompressed depth.** RVL (a lossless codec
  built for depth) or zstd-over-temporal-deltas would take 117 Mbit/s to
  ~35–45. Irrelevant on localhost, decisive for Wi-Fi or multiple clients.
- **The 4-neighbour speckle classification re-runs at 120Hz** although it
  depends only on data that changes at 8–30Hz. Moving it to a sensor-rate
  precompute saves ~0.3ms today (invisible), but it is the enabler for a
  2M-point accumulation design, where it is worth ~2x.
- `WithPerfLogging` is always compiled into libfreenect2 and reports depth solve
  timing at Info level, so `--log info` gives live telemetry with no rebuild.

## Method notes

`--log` was added to the grabber for this work: `not all subsequences received`
is a DEBUG line, so the drop counter is invisible at the default Warning level.

The sensor is a singleton — only one process can claim the USB interface — so
every measurement here had to run serially on one machine. Load average was
recorded per run and ranged 2.77–10.77 with no visible effect on fps, which is
worth knowing given that an earlier session mistakenly attributed packet loss to
hardware when the real cause was a load average of 417.

## Implemented: accept frames missing only sub-image 9

Confirmed from both processors that the depth solve reads sub-images 0–8 only.
`processPixelStage1` in the OpenCL kernel decodes exactly nine measurements,
grouped `v0={0,1,2}`, `v1={3,4,5}`, `v2={6,7,8}` — each triple dotted against one
modulation frequency's three phase steps. The CPU processor has the tenth
commented out with `// 10th measurement` and `// WTF?`.

Patch: `patches/0001-accept-depth-frames-missing-only-the-unused-10th-sub-image.patch`
relaxes the gate from `current_subsequence_ == 0x3ff` to
`(current_subsequence_ & 0x1ff) == 0x1ff`.

Measured as an **interleaved A/B** — old, new, old, new, old, new — with both
paths compiled into one binary behind a temporary env switch that was removed
afterwards:

| run | old (require all 10) | new (ignore sub 9) |
| --- | --- | --- |
| 1 | 12.90 | 14.80 |
| 2 | 12.95 | 13.57 |
| 3 | 12.62 | 15.07 |
| **mean** | **12.82** | **14.48** |

**+12.9%**, all three paired deltas positive (+1.90, +0.62, +2.45), and no
overlap between the two sets — the worst new run (13.57) beats the best old run
(12.95).

Interleaving was not fussiness. A first pass comparing four runs before the
patch against three after gave **+23%**, and that was wrong: the sessions were
separated in time and the PSU was swapped between them. Re-measuring the old
path afterwards gave 12.82 rather than the 11.93 recorded earlier, so roughly
half the apparent gain was drift. Sequential before/after does not survive on
this rig; anything claimed here should be measured interleaved.

Verified in the real viewer, not just the harness: the cloud is structurally
coherent, walls stay planar, the depth ramp is smooth, and there is no confetti.
That is expected — the patch stops waiting for bytes that were never an input to
the solve, so the depth output is bit-identical to before.

## Designed but not built: the two-frequency solve

Because each group of three sub-images *is* one modulation frequency, losing a
single sub-image kills exactly one frequency and leaves two fully intact and
self-consistent. Re-cutting the same 45s window by that grouping:

| | share of discards |
| --- | --- |
| only sub-image 9 missing (now recovered) | 6.8% |
| exactly 1 frequency compromised, 2 intact | 73.3% |
| 2 frequencies compromised, 1 intact | 18.2% |
| all 3 compromised | 1.7% |

So **80.1% of discards still retain two good frequencies.** Recovering them
would take delivered fps to roughly 24–25.

The dealiasing in `processPixelStage2` uses relative periods (3, 15, 2), and the
unwrap interlocks all three, so this needs a new solve path per missing
frequency plus plumbing the arrival bitmask through `DepthPacket`. The range
math is favourable — with a 0.625m base unit the surviving pair gives:

| frequency lost | surviving pair | unambiguous range |
| --- | --- | --- |
| ratio 2 (120MHz) | (3, 15) | 9.4m |
| ratio 3 (80MHz) | (15, 2) | 18.75m |
| ratio 15 (16MHz) | (3, 2) | 3.75m |

Two of the three cases cover the full 0.5–4.5m clip range; the third covers
3.75m of it. Pixels beyond the shortened range wrap and would need clamping.

Rejected alternative: filling the missing frequency from the previous frame.
Phase is cyclic, so a 33ms-stale phase on a *moving* pixel does not blur it, it
relocates it to an arbitrary depth — and the existing speckle cull would not
catch that, because a wrongly-unwrapped pixel can land in a locally consistent
neighbourhood. Correct for a static scene, confetti on a moving subject.

## Temporal reconstruction: what the stutter actually is

Measured from the capture's own timestamps rather than assumed. Arrival gaps run
p25 33ms, p50 64ms, p75 121ms, p90 222ms, p99 678ms — a 7x spread. The current
`mixT` schedules against an EMA point estimate of that distribution, which is why
it fails in both directions at once: gaps shorter than the estimate produce a
jump, longer ones a freeze. Display frames sit frozen at `mixT == 1` **42.5%** of
the time, and at each arrival `mixT` has only reached 0.743 on average, so a
quarter of the interframe motion is skipped in a single display frame.

The larger artifact is not interpolation at all. **3.14% of pixels toggle
valid/zero per frame pair** — about 6,800 points appearing and vanishing with no
fade, 44x more pixels than the snap threshold ever touches (0.071%). Treating
those transitions as alpha cross-fades rather than position events is the highest
value change in the viewer, and it needs no motion estimation.

Optical flow was assessed and **rejected for correctness**. The mis-reconstructed
band at a motion boundary is real and visible (~19 sprite widths at 25fps), but
it sits exactly at occlusion boundaries, where brightness constancy fails outright
— the surface on one side does not exist on the other. A wrong warp can look
worse than a snap; a cross-fade cannot fail that way, and costs ~1/50th as much.

**The frame-rate fix helps the stutter more than its mean suggests.** A long gap
is a *run* of consecutively dropped exposures — the sensor keeps exposing on its
fixed 33.3ms cadence underneath — so a 222ms gap is six or seven drops in a row.
Recovering each independently at probability p makes a whole run survive at p^6,
so the tail evaporates rather than shrinking. Modelled wall-clock time spent in
gaps over 100ms: 63.9% at 9.3fps, 39.4% at 14fps, 1.2% at 25.8fps. Caveat: the
model recovers slots independently, and real drops are plausibly bursty, which
would make the 25.8fps tail worse than modelled.

### The artistic direction worth building

Rather than interpolating more accurately, spend the spare budget on a **shedding
wake**. When a pixel's ray swaps surfaces, that is a death and a birth — and that
occlusion mask is a free "where is motion happening" signal, landing exactly on
the leading and trailing edges of a moving subject and nowhere on the static wall
behind it. Instead of teleporting the point, let the old one persist at its old 3D
position with decaying alpha while the new one fades in.

Every moving silhouette sheds a wake; a static scene sheds nothing. Under
Blackwall it compounds — the afterimage pass already integrates several frames, so
shed points smear into a volumetric trail and bloom turns the dense parts into hot
nodes. It reads as the wall *seeing* motion, which physically-exact interpolation
never will. Cost is real: it needs the dying and newborn point on screen at once,
so 434k points instead of 217k, roughly 1.7ms against the current 0.83ms — inside
the ~7ms headroom.

Size the wake from a look parameter (wake length in metres), never from
velocity x interval, or it will visibly shorten when the frame rate improves.
