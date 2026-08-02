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

/**
 * The sentence a document from the wrong version gets, in one place because the two
 * doors were saying different things about the same file - and one of them was false.
 *
 * The refusal used to be two branches: version 3 was told to run the converter, and
 * *everything else* was told that point size was pixels at the drawing buffer before
 * version 1, so its look could not be reconstructed. That is only true of a document
 * from before the version field existed, and the history above says there are none -
 * so a version 1 or 2 project, whose point sizes are already 1080p and perfectly
 * recoverable, was sent looking for a scale factor that is not its problem, and a
 * document from a *later* build was told something about a format that predates it by
 * four versions. A refusal that diagnoses the wrong thing is worse than one that says
 * only "no", because it is followed.
 *
 * Three bands, which is what the shipped conversion actually distinguishes.
 * `convert-presets.mjs` is the only migration this repo has and it starts at 3, so 1
 * and 2 are honestly "known, and there is no path from here" rather than either
 * "convertible" or "unreadable units". Everything else - a later version, a version
 * field that is absent or is not a number - collapses into one sentence because the
 * true statement about all of them is the same: nothing here knows what the document
 * means, and guessing is the failure the version field exists to prevent.
 */
export function versionRefusal(what, version) {
  const across = version === PROJECT_VERSION - 1
    ? `version ${PROJECT_VERSION} carries the five reading weights where 3 carried a shading mode, `
      + 'so run tools/convert-presets.mjs over the directory it is in to bring it across'
    : version === 1 || version === 2
      ? 'versions 1 and 2 predate the split into look and composition and the deliverable store, '
        + `and the conversion this repo ships starts at 3, so there is no path from here to ${PROJECT_VERSION}`
      : `nothing in this build knows what a version ${JSON.stringify(version)} document means - it is `
        + 'either from a later build or was never one of these - so it is refused rather than guessed at';
  return `${what} is version ${JSON.stringify(version)} and this build reads version ${PROJECT_VERSION}: ${across}`;
}

/**
 * What may be a take id, a document name, or anything else this program joins to a
 * path - and it is here, beside the version, for the same delivery reason.
 *
 * It began in `server/library.js` and was moved when the gallery grew a rename box.
 * A rename that only learns its name was refused after a round trip is a rename that
 * spells the rule out in an error message; a box that greys its own button says the
 * same thing before the request. Those are two statements of one rule, and the
 * failure mode of two copies is not that they disagree loudly - it is that the page
 * quietly accepts something the server refuses, or refuses something the server would
 * have taken, and the operator learns which by trying. So there is one regular
 * expression and both sides import it.
 *
 * **The page's copy is a courtesy and never a gate.** `server/library.js` asserts it
 * on every path it forms, because a request does not have to come from this page at
 * all - a node's manifest and a `curl` are both callers, and neither ran any
 * JavaScript this repo wrote.
 *
 * The leading character rules out `..` on its own; the rest rules out a separator. An
 * underscore is allowed so the editor's reserved auto-save name `__working__` is a
 * valid document name.
 */
export const VALID_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
