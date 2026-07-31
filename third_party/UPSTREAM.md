# libfreenect2, vendored

`libfreenect2/` is upstream's source at **v0.2.1**
(`fd64c5d9b214df6f6a55b4419357e51083f15d93`), committed here rather than cloned,
plus the one local edit described below. `node tools/vendor-check.mjs` proves
that sentence mechanically and offline.

## Why the tree and not a clone or a submodule

The build recipe this replaces was:

```bash
git clone --depth 1 https://github.com/OpenKinect/libfreenect2.git vendor/libfreenect2
git -C vendor/libfreenect2 apply ../../patches/*.patch
```

That names a URL and a *branch*, so it pins nothing. It produced the right driver
only because upstream has not committed since 2020-03-01 — `fd64c5d` is
simultaneously the `v0.2.1` tag and the current tip of the default branch. A
single upstream commit would have silently changed what everyone built, and the
recipe would still have looked correct. Reproducibility resting on someone else's
repository staying dormant is not reproducibility.

A submodule fixes the ref but not the dependency: it records a URL and a SHA that
both need GitHub to still be serving that object a year from now. This repo has no
remote and lives on one machine, so "we can re-fetch it" is not a property it has.

Committing the source is the only mechanism where a rebuild in a year is a
function of this repository alone. It also collapses the patch file and the clone
recipe — two representations of one source, which this repo's one-implementation
rule already rejects — into the tree itself. `patches/` is gone; the change lives
in the file it changes, and `vendor-check` is what keeps it honest.

The source is 140 files and 2.0 MB. Nothing was trimmed. Dropping `examples/`,
`doc/` or the OpenNI2 driver would risk the CMake build to save disk that isn't
scarce, and every file removed is a file the manifest can no longer vouch for.

## What we changed

Two files.

### `src/registration.cpp` — thread the occlusion filter

`Registration::apply` spends most of its time in the occlusion filter: an 8.3 MB
init to `+inf`, then a scatter writing a min-z into a 5×3 window of a 1920×1080
map for each of 217,088 depth pixels. Upstream does both single-threaded, and
there is no GPU path and no `PacketPipeline` variant for any of it — the pipeline
abstraction covers depth packet processing only.

The scatter now records its windows into a work list, and threads then split the
init and the scatter together. **Banding is by linear index, not by row**, and
that is the whole subtlety: the loop never bounds-checks `cx` on its own — the
guard is on `c_off`, and upstream's comment argues no check is needed because the
colour image is wider than depth — so at `cx < 2` the window's left edge is a
negative offset that physically lands in the previous row's tail. Threads owning
adjacent *row* stripes would collide precisely there. A linear range has no such
seam. No atomics are needed, because each thread writes only inside its own
half-open range and windows straddling a boundary are clipped by both neighbours.

Worth **2.07 ms of registration's 5.76 ms p50, a 36% reduction**, on an M2 Max at
four threads. Interleaved A/B/A/B/A/B against a build of upstream's own scatter,
three rounds, ~1000 frames per arm after 60 of warmup, all three paired deltas
favouring the threaded build and all six arms sustaining 30.03–30.04 fps:

| round | upstream | threaded | delta |
| --- | --- | --- | --- |
| 1 | 5.71 ms | 3.56 ms | −2.15 |
| 2 | 6.01 ms | 3.60 ms | −2.41 |
| 3 | 5.56 ms | 3.90 ms | −1.66 |
| mean | 5.76 ms | 3.69 ms | **−2.07** |

p90 falls with it, 6.69 ms to 4.59 ms. The tail is occasionally worse — one round
showed p99 10.80 ms against 7.32 ms — which is thread scheduling jitter and is
the thing to watch if this is ever on a latency budget rather than a throughput
one.

**This has not been measured on a Pi, which is the machine it is for.** The Mac
idles 27 ms of every 33 ms interval, so 2 ms buys nothing a user can see there.
The Pi's registration is 13.13 ms of a 15.05 ms serial half, and it has four
cores rather than twelve, so both the scaling and the payoff need measuring on it
before any claim is made. `LIBFREENECT2_REG_THREADS` exists so that measurement
can run both arms from one binary; it defaults to 4 and is not a tuning knob.

### `src/depth_packet_stream_parser.cpp` — accept 9-of-10 sub-images

Accept depth frames missing only
the unused 10th sub-image. The depth solve reads sub-images 0–8 — nine
measurements, three phase steps across three modulation frequencies — and the
tenth is commented out in the CPU processor and never fetched by the OpenCL
kernel, so requiring all ten discarded frames over ~300 KB that nothing reads.

Worth **+12.9%** on a degraded USB topology (12.82 → 14.48 fps), measured as an
interleaved A/B with both paths in one binary. Inert on a healthy link, where
nothing is dropped. `README.md` and `docs/performance-investigation.md` carry the
full measurement.

## How the proof works

`third_party/libfreenect2.manifest` records the git blob hash of all 140 files as
upstream published them at v0.2.1. `tools/vendor-check.mjs` hashes our tree and
asserts three things: every upstream file is present and unchanged except the one
declared above, the declared file matches the exact content we reviewed, and no
file exists that upstream didn't ship.

That middle assertion is there because the first version of this tool didn't have
it. It checked only that the patched file *differed* from upstream, and mutation
testing showed why that is not the same claim: reverting the sub-9 condition while
leaving the patch's comment in place still "differed", so the check passed a tree
with the fix removed. Pinning the content hash is what turns "somebody touched
this file" into "this file is what we signed off".

Run the controls with `--mutate`; each must be caught, and the count of failed
assertions is the thing to read, not the exit code:

```
node tools/vendor-check.mjs                          # PASS, 283 assertions
node tools/vendor-check.mjs --mutate undeclared-edit    # must FAIL
node tools/vendor-check.mjs --mutate revert-local-edit  # must FAIL
node tools/vendor-check.mjs --mutate extra-file         # must FAIL
node tools/vendor-check.mjs --mutate missing-file       # must FAIL
```

Mutations run against a throwaway copy, so a falsification run never leaves the
vendored tree altered.

## Changing the vendored source

Edit the file, then update its pinned hash in `DECLARED_EDITS` in
`tools/vendor-check.mjs` and say why here. The check failing after a deliberate
edit is the design working — a vendored tree should not be quietly editable.
