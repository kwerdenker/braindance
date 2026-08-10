# The looks that ship

Nine preset documents in exactly the shape `PUT /presets/:name` writes and
`applyStoredPreset` reads: `{ version, values }`. They are the same kind of file a
user's own preset is, and they are read-only only in the sense that the store serves them
from here and writes go to the user's directory — saving over one forks it rather than
overwriting it.

**Five of them are readings and four are looks, and nothing but this paragraph tells the
two kinds apart.** `rgb`, `depth`, `ghost`, `contour` and `blackwall` are one per reading
and are where a grade starts: the first four differ from each other in nothing but the
reading, `blackwall` adds the post chain its mode always wrote, and what goes on top of any
of them is yours. `ember`, `grille`, `voxel` and `tearline` are graded looks in their own
right — each of them reads Blackwall and then spends a duotone, a raster, a toe and
whatever else its picture wanted, so applying one is taking somebody else's grade rather
than clearing the desk to begin your own. No field in the format says which kind a file is,
and none should: a kind field would be a mechanism carrying a sentence, and every preset a
user saves would have to answer it too, where the question has no answer.

They exist as files rather than as constants in `web/main.js`, and that is the whole point
of the change they arrived with. `BLACKWALL` and `NEUTRAL` used to be two hardcoded objects
that `setMode` applied on the way past, so picking a *reading* and picking a *look* were one
gesture and neither could be had without the other. A preset is a document now, so what
ships is a set to edit, fork and export, rather than the only two looks the program could
name.

## Every one of them names the whole look

All nine carry all 68 values `completeLookNames()` returns — the look tag less its framing —
and **that is the rule a tenth one has to meet**, enforced by `library-check` against the
registry rather than against a list, so a look parameter added next year fails all nine
documents until somebody chooses a value for it in each. Picking a shipped look therefore
gives you that look and nothing else, whatever was on screen before it.

**Framing is the shot, not the look, which is why nine values are outside the rule.**
`tilt`, `roll`, the clip planes and the crop box are in the look tag because that tag is
also what a project saves and what step 5 can keyframe — a crop you could not keyframe would
be a worse program — but they are measured in metres in the room, so a look that named them
would reframe your shot when you picked it. `none` is the control that does reach them: it
resets every look value including the framing, which is why it is the way back to nothing
rather than a tenth look.

**This reverses what this file used to say, and the reversal is the interesting part.** The
nine were each sparse in a *different* set of keys, and the argument written here for that
was that a zero in one of these files is a value somebody chose and none of these four chose
one. It was wrong in the direction that is hard to see: the alternative to writing the zero
was not writing nothing, it was inheriting a value nobody chose at all. `voxel` was the only
document naming `lattice`, so picking `ember` after it drew amber over a lattice from the
previous look — reported as a bug, because it is one. Measured at 22.000s of
`2026-08-07-take2`, **33 of the 72 ordered pairs rendered a different frame in sequence from
the frame that look renders alone**. After the fix, 0 of 72, and all nine render byte-identical
frames from a clean start to the ones they rendered before it, because each padded value was
read back out of the registry while that look was on screen rather than typed in by hand.

The old text had the measurement in it and shipped anyway, which is the lesson worth keeping:
a number written into a document does not fail. `docs/instruments.md` carries that one.

## What is still sparse, and why that is untouched

**A preset you save is whatever you ticked**, and applying it deliberately leaves everything
it does not name where your grading left it. That is the whole point of the picker's tick
boxes and none of it changed — "just my grain and bloom" is still a document you can save and
layer onto a grade in progress. The line is not between kinds of file, because the format has
no kinds: it is that a document naming the whole look *is* a whole look, and one naming part
of a look is an adjustment. The nine shipped documents sit on the first side of that line now,
where they always claimed to be.

That line is the one `wholeLookTag` already drew, and moving the shipped nine across it gets
the provenance stamp back for free: picking `voxel` says `applied voxel · <rev>` rather than
`applied 43 of 77 values from voxel`, because the document now answers the question the stamp
asks.

**A look that switches a term on names all of that term's parameters** was the narrower rule
this file carried before, learned from `tearline` shipping a duotone with a depth and a split
but no hue, so the tone came up in whatever colour the previous look had left — hue 0 from a
clean start and −10 after `voxel`, from a document specifying neither. It is kept here as the
reason rather than as a rule, because naming the whole look makes it unreachable: there is no
term whose parameters can go unstated. The same is true of the older `contourBands` failure,
where picking `contour` after somebody had pulled the band count to 60 gave them a contour at
60 bands and called it the shipped look.

## The values themselves

**`blackwall.json` carries the twelve values the old constant did**, and the point sizes in
the five readings are the rebased ones — `pointSize` is pixels at 1080p, and the buffer those
looks were graded against was 600 tall, so 4.5 and 5 pixels there are 8.1 and 9 here. That
rebase happened once, when the screen-space terms went resolution-relative; nothing else in
either look was in pixels. The four graded looks came after it and are in 1080p pixels
throughout: three of them sit on Blackwall's 8.1, and `voxel` names 6.5 because its lattice
wanted a smaller point, which is a value somebody chose rather than a rebase of one.

`rgb`, `depth`, `ghost` and `contour` are deliberately identical apart from their reading.
They are the neutral grade, which is what leaving Blackwall used to restore, and their job is
to be a clean place to start rather than a look in their own right — a sentence that was not
quite true while they were sparse, since picking `rgb` mid-grade gave you the grade you were
already wearing in a different reading. Switching only the reading is what the five reading
weights in the panel are for; picking a document is going somewhere.

**The reading weights are all or none**, which is a format rule rather than a convention here
and is enforced by `refusePresetBody`: a file naming two of the five leaves the other three at
whatever the clip was wearing, which renders as a mixture nobody authored. Naming none of them
is a legal look that is not about the reading. All nine name all five.
