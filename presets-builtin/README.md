# The looks that ship

Five preset documents, one per reading, in exactly the shape `PUT /presets/:name` writes
and `applyStoredPreset` reads: `{ version, values }`. They are the same kind of file a
user's own preset is, and they are read-only only in the sense that the store serves them
from here and writes go to the user's directory — saving over one forks it rather than
overwriting it.

They exist as files rather than as constants in `web/main.js`, and that is the whole point
of the change they arrived with. `BLACKWALL` and `NEUTRAL` used to be two hardcoded objects
that `setMode` applied on the way past, so picking a *reading* and picking a *look* were one
gesture and neither could be had without the other. A preset is a document now, so the five
that ship are starting points a user can edit, fork and export, rather than the only two
looks the program could name.

**`blackwall.json` carries the twelve values the old constant did**, and the point sizes in
these files are the rebased ones — `pointSize` is pixels at 1080p, and the buffer these looks
were graded against was 600 tall, so 4.5 and 5 pixels there are 8.1 and 9 here. That
rebase happened once, when the screen-space terms went resolution-relative; nothing else in
either look was in pixels.

The four non-Blackwall looks are deliberately identical apart from their reading. They are
the neutral grade, which is what leaving Blackwall used to restore, and their job is to be a
clean place to start rather than a look in their own right.

**Each file carries the seven reading-detail values as well as the reading**, and writing
them in changed no pixel: every one of the seven defaults to exactly the literal it replaced
when the shader's per-reading constants became parameters, so these are the numbers all five
looks were graded against, stated rather than inherited. What it changes is what applying a
preset *does*. `applyStoredPreset` walks the keys the document names and nothing else, so
while they were absent, picking `contour` after somebody had pulled `contourBands` to 60 gave
them a contour at 60 bands and called it the shipped look — a document that renders
differently depending on what you touched before it is not a look that ships. The line is
drawn at the reading's own detail rather than at every look parameter: these seven are what
the five readings *are*, where turbulence and the region box are grading you do on top of one,
and a preset that reset those would stop being a starting point and become a document.
