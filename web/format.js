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
 */
export const PROJECT_VERSION = 2;
