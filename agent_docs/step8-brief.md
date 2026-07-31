# Step 8 brief: the job queue and the headless worker

Rewritten 2026-07-31 from `docs/recording-and-nle.md`'s "Deferred and remote encoding"
(line 1208) plus the build-order entry at line 1726, because the original brief lived in
a session scratchpad and is gone. Nothing here is new design — where this file and the
design doc disagree, the design doc wins and the disagreement is a bug in this file.

**Step 8 is not started.** This is the brief, not a progress report.

## What it is

A render job is a project file, a capture reference and output settings, and the project
references the capture **by content hash** so the job is self-contained and reproducible.
A worker pulls jobs, runs headless Chrome plus FFmpeg, and writes the output back. The
motivating case is "record on the laptop, encode overnight"; build that and remote capture
becomes a deployment detail rather than a second architecture.

```
job: { project, capture: "sha256:…", renderer: "ANGLE Metal / Apple M2 Max" }
```

## The two things it must carry

**1. The namespace seam is a hardcoded list and adding `jobs` walks straight past it.**
`server/index.js:957` reads

```js
if (/^\/(capture|library|projects|presets|record)(\/|$)/.test(urlPath)) {
```

Anything under one of those five namespaces that matches no route answers 404 instead of
falling through to the static file server. `jobs` is not in that regex, so `/jobs/...`
falls through to the file tree.

**The traversal story attached to this is wrong, and it was measured rather than reasoned
about.** The handoff this brief replaces said `/jobs/../web/main.js` traverses. It does
not, and neither does any encoded form: `new URL()` removes dot segments — including
`%2e%2e`, because the WHATWG parser decodes those before resolving `..` — and whatever
survives is joined onto one of three roots and rejected by `isInside` with a 403. Four
attempts to escape (`/jobs/%2e%2e/%2e%2e/package.json`, `/%2e%2e/package.json`,
`/jobs/../../package.json`, `/../package.json`) all answer 404 with nothing served. The
containment check is what stops traversal, and it already works.

What the seam actually protects is narrower and real: **the file tree must not shadow an
API namespace.** Measured with a planted file — `web/jobs/leak.js` is served, 200, with
its contents, because `jobs` is not in the literal; `web/library/leak.js` is 404 because
`library` is. So the day `/jobs/...` routes exist, a file under `web/jobs/` answers for
the API instead of the route table, and the 404 an unknown job route should give becomes
whatever the file tree happens to hold. Adding `jobs` to the literal would fix that
instance and leave the next namespace anybody adds outside the list, which is the failure
mode `CLAUDE.md` names by name. **Derive the list from `ROUTES`**
(`server/index.js:811`) — every entry already carries a `path` like `/capture/:id/hello`,
so the first segment of each is the namespace set, computed once at startup. Then a route
added later is covered by existing, and `library-check`'s route sweep — which already walks
`/library/routes` and asks every write handler for its method, content type and origin —
picks the new namespace up without being told about it.

The falsification control this needs is a **mutation that puts the namespace set back to a
literal**, checked by planting a file under every namespace the route table declares and
requiring the API's 404 rather than the file. A control that merely counts registered
routes cannot see it, for the same reason `stop-route-reads` could not see a planted read
route that writes — a count does not answer "was this path answered by the file tree".

**2. `server/export.js` already writes the job record, and it was put there for this step.**
`server/export.js:250-257` writes `project`, `capture` and `renderer` onto every export,
because step 6 knew step 8 would need them. Do not invent a second record beside it.

The renderer field is the part worth being careful about. It is pinned because bit-exactness
was measured between headed and headless Chrome **on one GPU** and does not survive a
different one: the Pi renders through `ANGLE (Broadcom, V3D 7.1.10.2, OpenGL ES 3.1)` and
the Mac through ANGLE Metal, and those are different rasterisers rather than two speeds of
one. Since the hash-referenced project model exists so a re-render reproduces the original,
a queue that silently handed a re-render to a different class of machine would break the
property the model is built on. So **a mismatch is an explicit scheduling failure the queue
surfaces**, and the accepted cost is that a Pi cannot finish a job a Mac started and a spare
machine of the wrong class cannot help drain a backlog.

There is one render machine today, so the constraint binds on nothing. Recording the field
from the first job is what matters, because a job record without it cannot be retrofitted
once old jobs exist.

## What is already measured, so do not re-derive it

- **The Pi has no hardware video encoder.** `rpi-hevc-dec` is a decoder, the fifteen
  `pispbe` devices are the camera ISP, and `vcgencmd codec_enabled` reports H264 and HEVC
  both disabled; ffmpeg's `h264_v4l2m2m` and `hevc_v4l2m2m` are wrappers with nothing to
  bind to. Every export there is software `libx264` on four cores, competing with the render.
- **The Pi is ~9-24x slower than the M2 Max** depending on the pass, and the structural
  finding replicates: the point pass is resolution-independent on both, the post chain scales
  with area. Extrapolated to 1080p a frame is north of 33ms of render alone, before
  `readPixels` and before encoding.
- **A capture-capable node is not a render-capable node**, but it is a genuinely good preview
  machine — 43fps with the full chain at its 800x480 display.
- **Offload was never mainly about capability.** Slower than real time is the point of this
  design, so a node that *could* render still should not be occupied for hours when it could
  be capturing the next take.

## Where it sits against the rest

Step 9's spec item "negotiate decimation while recording" is **socket-side, not HTTP**, and
step 7 is what settled that: the take being written answers 409 on its capture routes before
the handler runs, so decimated frames cannot be pulled over HTTP for a take in progress.
That is recorded in the step-7 commit body and in `handoff-resume.md`.

The security commit that landed just before this one gives `listen()` a `--host` flag
defaulting to loopback. A worker on another machine reaching a queue therefore needs the
server started with `--host`, exactly as a capture node does, and `tools/guard-check.mjs`
is where that behaviour is proved.
