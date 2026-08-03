/**
 * The one poll of `/record/state`, shared by the two surfaces that need it.
 *
 * **What is shared is the fetch and the change detection, and deliberately not the
 * painting.** The editor's `pollRecord` was welded to `paintRecord`, `recordState`
 * and the recorder's own elements, none of which exist on the gallery page - so
 * lifting the whole thing would have brought a pile of `null` element writes with
 * it, and copying the fetch into `library.js` would have been the second drifting
 * path this design keeps rejecting. What both surfaces genuinely have in common is
 * "ask the recorder what it is doing, on a cadence, and say whether it moved".
 *
 * **The gate lives at the caller, and that is not an accident of layering.** The two
 * surfaces want opposite things from the same tick. The editor paints on every one,
 * because the remaining-space readout changes on its own - another process writing,
 * a card filling - and a number that only moved when the recorder did would be stale
 * in the one direction that matters. The gallery must repaint on almost none of them:
 * `paint()` closes every menu, releases every skim and replaces every tile, so a
 * gallery that repainted every five seconds would fight the operator's pointer. A
 * module that decided this would have to be wrong for one of them.
 *
 * `/record/state` rather than `/library/all`, because it is the cheap question, and
 * that is measured rather than assumed. The library listing walks the captures
 * directory, reads a marks sidecar per take, and where a node is linked crosses the
 * network to have the same thing done over there; the recorder's state is memory the
 * process already holds, plus one small request to the node. Interleaved A/B on this
 * rig, 20 pairs against a 200-take library with both indexes warm and the first eight
 * pairs discarded as the page cache settling: **1.2ms for `/record/state` against
 * 145ms for `/library/all`**, so polling the listing itself would spend two hundred
 * sidecar reads every five seconds on both machines to answer a question that is
 * almost always no. The gallery pays for a listing only when the answer has changed.
 *
 * Not under a `record/` directory: `/record` is a namespace the server's route table
 * owns, and the dispatcher answers for every path under an owned namespace before the
 * file server gets a turn - so a module living there would be a 404 with a very
 * confusing shape. A flat name at the web root has no namespace to collide with.
 */

// Five seconds, which is what the editor's own poll ran at and is short enough that a
// gallery tile stops lying within one of them. Not a parameter: two surfaces polling
// the same route at two cadences is two behaviours to reason about, and neither of
// them has a reason to want a different one.
const EVERY_MS = 5000;

/**
 * What a tick has to differ in for the answer drawn from it to be worth redrawing.
 *
 * The take each recorder still owns, on both machines - the one fact that decides what
 * a gallery tile is allowed to say about a take. Frame counts and free space move
 * constantly and are deliberately not in it, or the flag would be true on every tick
 * and mean nothing.
 *
 * **`writingId` rather than the recording flag and the take id, and the difference is
 * the several seconds between them.** A take stops being recorded well before it stops
 * being the recorder's: the stream still has to flush, the marks still have to land and
 * the index and the content hash - which are what make the take a gallery entry at all
 * - are built after that. The flag went false at the front of that window, so a gallery
 * following it reread the library into the middle of a close and drew Download, Rename
 * and Remove over a take with no hash yet. `writingId` spans the whole of it, so the
 * one repaint this poll pays for lands where the answer actually changed.
 *
 * **Both recorders, because the gallery is a view of both libraries.** A station with
 * a `--node` draws the node's takes into the same grid, and it is the machine the
 * gallery is actually used from - so a fingerprint over the local recorder alone was
 * constant for the life of that page and the remote tile never stopped claiming a
 * finished take was still being written. Whether the node can be reached is in it for
 * the same reason: the gallery prints "unreachable" beside the node's name, so a link
 * dropping or coming back changes what is on screen.
 */
const fingerprint = (state) => [
  state.writingId ?? '',
  state.node ? `${state.node.reachable}:${state.node.writingId ?? ''}` : '',
].join('|');

/**
 * Polls the recorder and hands every tick to `saw(state, changed)`.
 *
 * `changed` is true when this tick's fingerprint differs from the previous one's.
 *
 * **`believed` is what the caller has already drawn, and passing it is what makes the
 * first tick able to answer at all.** Without it the first tick has nothing to compare
 * against and must report `changed: false`, which is a hole rather than a caution: the
 * gallery reads `/library/all`, paints a take as being written, and only then asks the
 * recorder - so a take that stopped inside that gap is stopped in every fingerprint
 * this poll will ever compute, none of them differ, and the tile goes on refusing to
 * open a finished take until somebody reloads the page. Seeded, the first tick is a
 * comparison like every other one, against the world the caller actually drew.
 *
 * It is a state-shaped object rather than a fingerprint string, and it goes through
 * the same `fingerprint` above, so there is one expression of what counts as a change
 * rather than a caller's copy of it to drift.
 *
 * A caller with nothing painted yet passes nothing, and gets the old behaviour: the
 * first tick reports no change, because a first tick claiming one would make it do its
 * expensive thing once at load for no reason.
 *
 * Returns the tick itself, so a caller that has just changed something - pressing
 * record is the case - can ask again immediately instead of waiting out the cadence.
 * That is the same poll rather than a second one: it updates the same `previous`, so
 * the tick it displaces cannot report a change that has already been seen.
 */
export function pollRecordState(saw, believed = null) {
  let previous = believed === null ? null : fingerprint(believed);
  const tick = async () => {
    let state;
    try {
      state = await (await fetch('/record/state')).json();
    } catch {
      // A server that went away is the status line's problem, not this one's, and a
      // poll that stopped on the first failed fetch would never notice it come back.
      return;
    }
    const mark = fingerprint(state);
    const changed = previous !== null && previous !== mark;
    previous = mark;
    saw(state, changed);
  };
  tick();
  setInterval(tick, EVERY_MS);
  return tick;
}
