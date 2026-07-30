# ADR-0001: Program time is the edit coordinate

Status: accepted, 2026-07-30
Context: `docs/recording-and-nle.md`

## Context

The editor renders an image as a function of a playhead position. That position
needs a unit, and retiming makes the obvious two candidates genuinely different
numbers: **source time** is a position inside the capture, **program time** is a
position inside the output. Under normal speed they advance together. Under a
speed ramp, a slow-motion section or a hold, they do not.

Every keyframe — camera pose, look parameters, the speed ramp itself — has to be
timestamped in one of them, and the choice is not visible from the code once it
is made. Both readings produce working software that behaves differently.

## Decision

**The playhead and every keyframe live in program time.** A single retime curve,
itself an ordinary track in program time, maps program time to source time.
Rendering one output frame is a forward-only pipeline:

```
output frame k
  → programTime = k / outputFps
  → evaluate every track at programTime
  → sourceMs = retime(programTime)
  → binary-search the index → frameA, frameB
  → mixT = (sourceMs - tA) / (tB - tA)
```

## Consequences

**Export needs no inverse.** Keyframing in source time reads well until export,
which then has to invert the retime curve to learn which source time each output
frame wants. That requires the curve to stay monotonic, so a hold or a reverse
breaks it outright. Program time has no inverse to compute, which is why a speed
ramp is just another track rather than a special case in the renderer.

**The virtual camera keeps its own pace when the footage slows.** Keys in program
time mean the camera is a camera in the room at viewing time, not something glued
to the subject's action. Slow the footage to quarter speed and the camera move
does not slow with it. This is a creative semantic, not only a technical one, and
it is the one this project wants: the whole idea is re-photographing a take, and
a photographer's movement is independent of what they are filming.

**Two duration parameters stay in source time anyway.** `fade` and `wake` drive
surface memory, which advances per source frame, and `fade` specifically has to
span the gap between two source frames to do its job. Converting them to program
time would require dividing through the local retime slope, which is zero at a
hold — every trail would snap off exactly where a freeze should hold the look
still. They are the documented exception.

**Frame index was rejected as a coordinate.** It makes lookup a `floor`/`ceil`
with no search, but this sensor's arrival spacing was measured at p50 64ms
against p90 222ms on a degraded link. Capture frames are not evenly spaced in
time, so constant motion through index space is visibly variable motion through
real time, and a keyframe's timing would shift with the capture rate of the take
it sits on.

## Reversal cost

High. Every keyframe in every saved project carries an implicit unit, so changing
this later means migrating project files and re-deriving what existing edits
meant. It is worth being deliberate now and cheap to live with afterwards.
