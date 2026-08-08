# The looks that ship

Nine preset documents in exactly the shape `PUT /presets/:name` writes and
`applyStoredPreset` reads: `{ version, values }`. They are the same kind of file a
user's own preset is, and they are read-only only in the sense that the store serves them
from here and writes go to the user's directory — saving over one forks it rather than
overwriting it.

**Five of them are readings and four are looks, and nothing but this paragraph tells the
two kinds apart.** `rgb`, `depth`, `ghost`, `contour` and `blackwall` are one per reading and
are where a grade starts: the first four differ from each other in nothing but the reading,
`blackwall` adds the post chain its mode always wrote, and what goes on top of any of them is
yours. `ember`, `grille`, `voxel` and `tearline` are graded looks in
their own right — each of them reads Blackwall and then spends a duotone, a raster, a toe
and whatever else its picture wanted, so applying one is taking somebody else's grade
rather than clearing the desk to begin your own. No field in the format says which kind a
file is, and none should: a kind field would be a mechanism carrying a sentence, and every
preset a user saves would have to answer it too, where the question has no answer.

They exist as files rather than as constants in `web/main.js`, and that is the whole point
of the change they arrived with. `BLACKWALL` and `NEUTRAL` used to be two hardcoded objects
that `setMode` applied on the way past, so picking a *reading* and picking a *look* were one
gesture and neither could be had without the other. A preset is a document now, so what
ships is a set to edit, fork and export, rather than the only two looks the program could
name.

**`blackwall.json` carries the twelve values the old constant did**, and the point sizes in
the five readings are the rebased ones — `pointSize` is pixels at 1080p, and the buffer those
looks were graded against was 600 tall, so 4.5 and 5 pixels there are 8.1 and 9 here. That
rebase happened once, when the screen-space terms went resolution-relative; nothing else in
either look was in pixels. The four graded looks came after it and are in 1080p pixels
throughout: three of them sit on Blackwall's 8.1, and `voxel` names 6.5 because its lattice
wanted a smaller point, which is a value somebody chose rather than a rebase of one.

`rgb`, `depth`, `ghost` and `contour` are deliberately identical apart from their reading.
They are the neutral grade, which is what leaving Blackwall used to restore, and their job is
to be a clean place to start rather than a look in their own right.

**A look that switches a term on names all of that term's parameters**, and that is a
narrower rule than "name everything". A preset is allowed to be sparse — that is the whole
point of the picker's tick boxes, and applying one deliberately leaves everything it does not
name where your grading left it, so `tearline` inherits a lattice you had raised and should.
What it may not do is switch a term on and leave one of that term's own parameters unstated:
`tearline` shipped naming `duotoneDepth` and `duotoneSplit` but not `duotoneHue`, so the
duotone came up in whatever colour the previous look had left behind — hue 0 from a clean
start and −10 after `voxel`, from a document that specifies neither. Fixed by naming the hue
it was graded at.

That is the same failure as the `contourBands` one below, arriving through a term rather than
through a reading, and the same test tells them apart: **ask what the document turns on, and
whether the document says what it looks like.** The residue after the fix is exactly
`lattice` and `latticeCell` carrying from `voxel`, which is the sparse behaviour working
rather than failing.

**Each file carries the seven reading-detail values as well as the reading**, and writing
them in changed no pixel: every one of the seven defaults to exactly the literal it replaced
when the shader's per-reading constants became parameters, so these are the numbers all nine
looks were graded against, stated rather than inherited. What it changes is what applying a
preset *does*. `applyStoredPreset` walks the keys the document names and nothing else, so
while they were absent, picking `contour` after somebody had pulled `contourBands` to 60 gave
them a contour at 60 bands and called it the shipped look — a document that renders
differently depending on what you touched before it is not a look that ships. The line is
drawn at the reading's own detail rather than at every look parameter: these seven are what
the five readings *are*, where turbulence and the region box are grading you do on top of one,
and a preset that reset those would stop being a starting point and become a document.

**The four graded looks stop at that same line, and between themselves that leaves terms
carried over.** `voxel` is the only one of the nine that names `lattice`, `tearline` the only
one that names the glitch's six terms and the streak's angle, `ember` the only one that names
`duotoneMotion` — and `tearline` is the sharpest of them, because it turns the duotone on with
a depth and a split and does not name the hue that tone is keyed to. So picking `ember`
straight after `voxel` draws its amber over a lattice nobody asked for, which is the
`contourBands: 60` failure above with a look in place of a slider.

Measured through the picker on one page load, parked at 22.000s of `2026-08-07-take2`: each of
the four applied on its own after `none`, then the four applied in order with nothing cleared
between them. **All four render a different frame in the sequence from the frame they render
alone** — `ember` 820b34857e05 against aeea493c411c, `grille` 058f60489367 against fd7eb1b2f181,
`voxel` 78ae4205e266 against 19869db262ae, `tearline` eb59b11491cd against b7e3b826f37c — so
this runs in every direction rather than into `ember`. They ship as they were graded rather
than padded out with the zeros that would close it, because a zero written into one of these
files is a value somebody chose and none of these four chose one. What closes it is `none`,
which resets every look parameter to its default and sits at the top of the picker for exactly
this.
