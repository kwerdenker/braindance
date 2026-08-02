# Contributing

Braindance is a personal project that got large. Contributions are welcome, but the hardware
situation and the way this repository argues about evidence are both unusual enough to be worth
reading before you spend an evening on a patch.

## You probably do not have the hardware

Most of this needs a Kinect v2, which has not been manufactured since 2017. A lot of it also
needs a capture, and none ships in the repository.

What you can work on with nothing but a checkout:

- The browser side — the viewer, the timeline editor, the gallery — against a capture you record
  yourself, or against the fixture generator if you have one capture to loop.
- The server's pure logic: the wire format, the index, the job queue, the origin guard. Several
  proof tools drive these with no sensor at all.
- Documentation, and the design doc's build order.

What you cannot check without the sensor: registration, the grabber, delivered frame rate, and
anything measured in milliseconds. If you change one of those, say in the pull request that you
could not measure it, and it will get measured here before it lands. That is a normal outcome,
not a rejection.

## How this repo decides things

`docs/recording-and-nle.md` is the canonical design and it is long. Its decisions are settled.
If reality contradicts it, **report the contradiction rather than quietly redesigning around
it** — that has happened several times and reporting was the right move every time.

The other thing to know is that this repository measures rather than reasons, and it is strict
about it:

- **"This should be faster" is not evidence.** Measure it. Several inherited estimates here
  turned out about 40% wrong when finally profiled, and the docs record the corrections.
- **Interleave A/B comparisons, never run them sequentially.** A sequential comparison on this
  rig once produced a 23% figure that was really 12.9%.
- **State the method with every number**: window length, sample count, warmup discarded, and
  whether the page cache was warm.
- **A passing unit test is not a rendered frame.** For anything user-visible, drive the real UI
  and show it working.

`CLAUDE.md` carries the long version, including the war stories behind each rule. It is written
for an AI agent working in the repository, but the method is not agent-specific and it is
probably the most transferable thing here.

## Proof tools

There is no `npm test` that runs everything, because most of the suite needs a server, a GPU
browser, or a sensor. Instead `tools/` holds a set of proof tools, each of which takes a running
server and exits non-zero on failure. `CLAUDE.md` lists them with what each one needs.

Two conventions matter if you touch them:

**Count failed assertions, never exit codes.** A tool that cannot find a mutation's anchor text
exits 1 having asserted nothing, which reads as a caught mutation to anything checking only the
exit status. A run reporting zero failed assertions and a non-zero exit is a crash to
investigate, not a success to record. The two vendoring tools also invert the usual convention —
for them a caught mutation exits 0 — so reading the code rather than the count will mislead you
in the one direction that matters.

**A mutation is a piece of source text, so editing the code it names breaks it.** If you change
something a mutation anchors to, re-anchor the mutation in the same commit and say in the message
which ones moved. A mutation that silently stopped matching is worse than no mutation, because it
reports the check as having missed a bug it was never shown.

If you add a claim, add the control that would falsify it. The rule this repository keeps
relearning is that an instrument must *enforce* its claims rather than assert them in its header:
ask what a broken implementation would have to do to still pass your check, and close that.

## Before you open a pull request

1. Run the proof tools that own the code you touched, and their mutations.
2. Say in the pull request which ones you ran, which you could not, and why.
3. Include measurements for anything performance-shaped, with the method.
4. If you changed a mutation's anchor, say so.

## Style

- No emojis in console or debug output.
- **One implementation only.** No legacy path left beside a new one and no compatibility flag to
  switch between them — a second path that drifts is the failure this design keeps rejecting.
- Comments explain *why*, usually by naming the failure mode being avoided, in flowing prose.
  Match the density and voice already in the file you are editing. The comments here are unusually
  long on purpose; they are where the reasoning lives.
- Commits: imperative subject, then a body explaining the why and carrying the measurements with
  their methods.

## Reporting something that does not need a fix from you

Bug reports, measurements that contradict the docs, and "this section of the design doc is wrong"
are all genuinely useful and do not require a patch. A contradiction found and reported is worth
more here than a fix that quietly routes around it.
