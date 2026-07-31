# CLAUDE.md merge resolution — the one conflicting hunk

Only one of the seven hunks collides: the branch inserts at base line 163 and I insert
at base 169, both into the proof-tools block. Everything else is far enough apart to
apply cleanly — the branch's measurement-culture bullets at base 18 and its fixtures
note at base 197, mine at base 58, 81 and 146.

Resolution is a union, plus the `library-check` invocation line that block has been
missing since step 7 landed. That gap and this conflict are in the same six lines, so
they get fixed together.

## The resolved block

Take my side's fence and append `library-check` to it, then the branch's paragraph and
fence, then both sides' following prose in that order.

```
node tools/export-check.mjs --url http://localhost:8080   # step 6: resolution, export, the file
node tools/export-check.mjs --mutate pointsize-absolute   # ... and must FAIL mutated
node tools/library-check.mjs --url http://localhost:8080  # step 7: library, recorder, routes
node tools/library-check.mjs --mutate plant-open-take     # ... and must FAIL mutated
```

`library-check` had no invocation line at all until this merge, while being referenced
twice below it — so the list taught a six-tool sweep where there are seven. `plant-open-take`
is the right mutation to name here rather than a milder one: it is the control for the
hole that let a read route destroy the take being shot.

Then the branch's addition, verbatim — the two tools needing no server, the note that
`registration-check` rebuilds both sides every run and exits 2 for a build failure against
1 for a fired assertion, `prof-summary` and `pi-registration-ab.sh`, and the corpus
regeneration command.

Then my side's following prose, with one correction the merge forces:

- `export-check` ffmpeg note — unchanged.
- `--clock` note — unchanged.
- `library-check` exit-2 note — unchanged, and it now sits beside `registration-check`'s
  exit-2 note, which is the same idea reached independently by both branches. Worth one
  sentence saying so rather than leaving two neighbouring paragraphs describing the same
  convention as if unrelated.
- **`--mutate <name>` paragraph: "Both tools refuse a mutation whose text they cannot
  find exactly once" is now wrong twice over.** It dated from when timeline and keyframe
  were the only mutating tools; this side made it four, and the merge makes it six with
  `vendor-check` and `registration-check`. Say "all six".

## Not to be resolved by taking a side

The two `CLAUDE.md` additions describe different things and neither supersedes the other:

- This side: close the class rather than the instance; assert against the resource rather
  than the bookkeeping that tracks it; `p.x.__proto__ = v` in a probe is not what a file on
  disk does; before believing a mutation was *caught*, confirm it was caught for the reason
  claimed; the blindness rule's second form.
- The other side: read a health number the measurement itself reports and throw the run
  away when it is wrong; a tight loop cannot measure an allocation, because the allocator
  hands the same block straight back and the baseline arm was already effectively
  persistent.

The second of those is worth noting beside this side's own measurement rules, because it
is the same failure this repo keeps recording — a screening measurement that removes the
effect it is screening for will confidently report its absence.
