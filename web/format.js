/**
 * The document format's version, in one place because two copies of a constant
 * that must agree is the drift this design keeps refusing.
 *
 * Both sides need it and they need the *same* one. The page stamps it on every
 * project and preset it saves and refuses to open anything else; the server stamps
 * it again as documents are written to disk, so a file that reached the store some
 * other way still carries it. A check that caught the two disagreeing would only be
 * proving they can, which is not the same as there being one number.
 *
 * It lives under `web/` because that is the side with a delivery constraint: the
 * browser can only import what the server serves, and `web/` is served. Node has no
 * such constraint and reaches for it by path.
 *
 * ---
 *
 * **Version 1 means every screen-space term is expressed against a 1080p
 * reference.** `pointSize` above all: it is pixels at 1080p now and was pixels at
 * the drawing buffer before step 6, so the same number means two different sizes
 * either side of that change, and both built-in presets were rebased by 1080/600 to
 * follow it. There are no documents older than version 1, which is exactly why the
 * field went in when it did - once files exist there is no way to add it
 * retroactively, and a document whose units cannot be recovered is one that renders
 * wrong with nothing to say why.
 *
 * A version rather than an authored buffer height, and the difference is what a
 * loader can *do* with it. An authored height answers one question - what to scale
 * `pointSize` by - and from here on would record 1080 in every file forever, a
 * constant that looks like data. A version answers "can this build faithfully
 * interpret this document", which is the question that recurs: the next thing to
 * move will be a track kind, an easing rule or an audio reference, and none of those
 * is a scale factor. So a file this build does not recognise is refused, naming the
 * version it found, rather than opened on a best guess.
 *
 * **Version 2 adds clip in/out points in program seconds.** They are composition,
 * not look, so they sit in the project and not in a preset. `in` defaults to 0 and
 * `out` defaults to null, meaning the end of the clip. The version is the same
 * "can this build faithfully interpret this document" signal as before.
 *
 * **Version 3 splits the document into look and composition.** Look holds the
 * mode, static params and keyed tracks for look parameters; composition holds the
 * retime curve and the camera track. Deliverables (in/out points, output fps,
 * output size and codec) now live in their own store, not inside the project.
 * Saved projects also carry an undo history (`history.stack` and
 * `history.baseline`) so a reload can restore it.
 *
 * **Version 4 dissolves the mode into five reading weights.** `look.mode` is gone
 * from the project and `mode` is gone from the preset; what replaces both is five
 * ordinary look parameters - `readRgb`, `readDepth`, `readGhost`, `readContour`,
 * `readBlackwall` - which travel with every other value and need no special case.
 *
 * This is the version that most needs to be a refusal rather than a best guess, and
 * for a reason the earlier ones did not have. A version 3 document read by this build
 * would parse: its `values` are all still parameters this registry knows, so
 * `params.apply` would write every one of them without complaint, and the reading
 * would simply be missing - leaving whatever the previous document happened to
 * select. A file that renders as somebody else's shading, silently, is worse than one
 * that fails to open. `tools/convert-presets.mjs` is the way across, and it is a
 * one-shot over files on disk rather than a path inside the program, because a loader
 * that could read both shapes is the second implementation this design keeps refusing.
 */
export const PROJECT_VERSION = 4;
