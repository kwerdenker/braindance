// Proves the editor's interaction layer: that its controls exist, that pressing them
// changes something, and that the set of controls it has is the set this file knows
// how to drive.
//
// **This tool exists because the suite tested the model and never the control.** The
// clip in/out markers - `#tIn` and `#tOut`, the only way to trim what an export
// contains - were being detached from the document during boot. `rebuildLanes`
// cleared `#tBeds` of every child that was neither `.ruler` nor the playhead, and the
// two markers were neither, so they went on the first rebuild and never came back.
// Nothing noticed for the length of the feature's life: `clipIn`/`clipOut`,
// `setClipInOut`, `activeDeliverable.in/out` and the frame arithmetic in `exportClip`
// were all correct, `export-check` drove in/out through `activeDeliverable`, and
// `paintTimeline` went on writing `style.left` onto two nodes no document contained.
// **No proof tool in this repo referenced `#tIn`, `#tOut` or `.tcut` at all.** That is
// `docs/instruments.md`'s "is there an object here that every observation happens to
// skip", one step further on than the version already recorded there - here the
// skipped object was not an excluded file but a control the interface tells the user
// it has.
//
// So the organising rule of this file is two things at once:
//
//   1. **Drive the real control and assert an observable consequence.** Not "the
//      button is in the DOM" - the playhead moved, the key count fell, the range
//      changed, the bytes on disk match. A row that asserts DOM state after an
//      interaction would pass on a build where the interaction did nothing.
//
//   2. **Enumerate rather than list.** Section 1 walks every interactive control the
//      editor actually renders and requires each to be covered by an entry in
//      `DRIVERS`. A control with no entry is a failure, not a skip, so a control
//      added later is asked about by existing. `library-check` reached the same shape
//      for HTTP routes after individual poking found six mutating routes out of ten.
//      The falsification control for that claim is `plant-unswept-control`, which
//      adds a button and must redden section 1 - without it, "every control was
//      tested" is an assertion this file makes about itself.
//
//   node server/index.js &
//   node tools/editor-check.mjs --url http://localhost:8080 --take sample
//   node tools/editor-check.mjs --mutate plant-unswept-control --no-render  # must FAIL
//   node tools/editor-check.mjs --mutate lanes-clear-siblings  --no-render  # must FAIL
//   node tools/editor-check.mjs --mutate rate-holds-program    --no-render  # must FAIL
//   node tools/editor-check.mjs --mutate space-unbound         --no-render  # must FAIL
//   node tools/editor-check.mjs --mutate delete-ignores-selection --no-render  # must FAIL
//   node tools/editor-check.mjs --mutate ease-handles-on-flat  --no-render  # must FAIL
//   node tools/editor-check.mjs --mutate ease-preset-ignored   --no-render  # must FAIL
//   node tools/editor-check.mjs --mutate scroller-cannot-shrink --no-render # must FAIL
//   node tools/editor-check.mjs --mutate export-ignores-name              # must FAIL
//
// `--no-render` drops the real-export rows and says so in the verdict, the way
// `jobs-check` does. The queue-shaped mutations do not touch the encoder, so their
// runs are seconds instead of a minute.
//
// Exit 1 means a claim failed. Exit **2** means the harness did not run - no server,
// a mutation whose anchor no longer matches, a crash. That split is not decoration:
// a stale anchor exiting 1 reads identically to a mutation caught, and this repo has
// already recorded a tool exiting non-zero with zero failed assertions being written
// down as a bug found. **Count the failed assertions and read which ones fired.**

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const REPO = fileURLToPath(new URL('..', import.meta.url));
const URL_BASE = flag('--url', 'http://localhost:8080');
const EDITOR_PATH = '/edit';
// `sample` rather than a dated take id, because the default has to name something
// that can exist on a machine that is not this one. A recorder-issued id carries
// the day it was shot - `2026-08-02-take1` was the default here, and it resolves
// only on the machine that recorded it, on that date. Everywhere else the tool
// spent thirty seconds waiting for a take the server answers 404 for and then
// exited 2, which is the honest code but a wasted run and a confusing message.
// `sample` is the name `npm run replay` and `make-fixture.js` already assume.
const TAKE = flag('--take', 'sample');
const HEADED = argv.includes('--headed');
const MUTATE = flag('--mutate');
const NO_RENDER = argv.includes('--no-render');
// The window every layout row is measured at. 1512 is the laptop this is documented
// to run on and the width at which the render button was measured 82px off the right
// edge; the other two are there because one width cannot tell a bar that fits from a
// bar that happens to fit.
const WIDTHS = [1512, 1280, 1100];
const VIEWPORT = { width: 1512, height: 900 };

// ------------------------------------------------------------------- mutations

const MUTATIONS = {
  // The falsification control for section 1, and the only one that is not a bug being
  // put back. A button nobody has taught this file to drive must be a failure rather
  // than a control that quietly went unswept, or "every control was tested" is a
  // sentence this tool writes about itself with nothing enforcing it.
  'plant-unswept-control': {
    file: 'web/index.html',
    edits: [[
      '        <span class="tchip" id="tNote"></span>',
      '        <span class="tchip" id="tNote"></span>\n'
      + '        <button id="tPlantedControl" type="button">planted</button>',
    ]],
  },

  // The control for the placement rows in section 1, and it is the bug being put back
  // rather than an invention: the nav spent its whole life at the foot of the panel,
  // under every slider, on the one surface where the column is long enough to scroll.
  // It stays a working nav that goes to the right places - the failure being restored
  // is that you cannot see it, which is why the rows it must redden are the geometric
  // ones and not the sweep.
  'nav-at-the-foot': {
    file: 'web/index.html',
    edits: [
      [
        '        <nav class="surfacenav" id="navRow" aria-label="Surfaces">\n'
        + '          <a id="toMenu" href="/">menu</a>\n'
        + '          <a id="toLibrary" href="/gallery">gallery</a>\n'
        + '        </nav>\n',
        '',
      ],
      [
        '    </div>\n  </div><!-- #panelBody -->',
        '    </div>\n\n    <nav class="surfacenav" id="navRow" aria-label="Surfaces">\n'
        + '      <a id="toMenu" href="/">menu</a>\n'
        + '      <a id="toLibrary" href="/gallery">gallery</a>\n'
        + '    </nav>\n  </div><!-- #panelBody -->',
      ],
    ],
  },

  // The bug that started this file. The rebuild goes back to clearing its columns of
  // everything it does not recognise, which takes the in/out markers with it. Both
  // append sites move back too, so the mutated build is a working editor with no way
  // to trim a clip - a faithful restoration rather than a tree that throws on load,
  // because a mutation that crashes tests nothing.
  'lanes-clear-siblings': {
    file: 'web/main.js',
    edits: [
      [
        '  counters.laneRebuilds++;\n  ui.railLanes.replaceChildren();\n  ui.lanes.replaceChildren();',
        '  counters.laneRebuilds++;\n  for (const el of [...ui.rail.children, ...ui.beds.children]) {\n'
        + "    if (!el.classList.contains('ruler') && el !== ui.playhead) el.remove();\n  }",
      ],
      ['    ui.railLanes.appendChild(rail);', '    ui.rail.appendChild(rail);'],
      ['    ui.lanes.appendChild(bed);', '    ui.beds.insertBefore(bed, ui.playhead);'],
    ],
  },

  // Speed goes back to holding program time, which is what moved the frame you were
  // looking at by ten source seconds on a 1x to 2x change.
  'rate-holds-program': {
    file: 'web/main.js',
    edits: [[
      'return Math.max(0, Math.min(retime.programSecAt(rateGesture.source), timeline.duration));',
      'return Math.max(0, Math.min(timeline.programSec, timeline.duration));',
    ]],
  },

  // The cuts stop being carried across a speed change, which is the bug the user
  // photographed: at 1.20x the out marker sat at 50.3% of the ruler and at 2.35x the
  // same `out` sat at 99.5%, because the ruler halved and the marker did not. Only the
  // cut term is reverted, so this must redden the two cut rows and the two shade rows
  // and leave the key rows and the mark row passing - a mutation that failed everything
  // could not say which term it was about.
  'rate-holds-cuts': {
    file: 'web/main.js',
    edits: [[
      '  setClipInOut({ in: was.clipIn * k, out: was.clipOut === null ? null : was.clipOut * k });',
      '  setClipInOut({ in: was.clipIn, out: was.clipOut });',
    ]],
  },

  // The other term: keyframes stop being carried, so a bloom ramp graded against one
  // moment of the take points at another the moment the speed moves. Reddens the key
  // rows and leaves the cut rows alone, which is the pair that makes either one
  // diagnostic.
  'rate-holds-keys': {
    file: 'web/main.js',
    edits: [[
      '  for (const [key, t] of was.keys) key.t = t * k;',
      '  for (const [key, t] of was.keys) key.t = t;',
    ]],
  },

  // Undo restores the keys from the snapshot and leaves the cuts where the rate it is
  // undoing put them. Half a strip restored, which is worse than none: the markers and
  // the keys disagree about which footage the edit is on, and nothing says so.
  'undo-skips-cuts': {
    file: 'web/main.js',
    edits: [[
      '    if (retime.rate !== wasRate) {\n'
      + '      reparameteriseProgramTime(wasRate / retime.rate, { clipIn: wasIn, clipOut: wasOut, keys: [] });\n'
      + '    }',
      '    // the cuts are left where the rate being undone put them',
    ]],
  },

  // The wheel zooms about the middle of the window instead of about the pointer. The
  // window still zooms, the ruler still relabels and every other row in section 9 goes
  // on passing - which is what makes it the right control for that one claim, and what
  // makes a check with a single centred arm blind to it.
  'zoom-about-centre': {
    file: 'web/main.js',
    edits: [[
      '    if (!view.zoomAbout(clipFractionAt(surface, e.clientX), factor)) return;',
      '    if (!view.zoomAbout((view.a + view.b) / 2, factor)) return;',
    ]],
  },

  // Pointer-to-time goes back to reading the whole clip. This is the shape a site the
  // conversion missed would have: everything draws through the window and one place
  // still divides by the duration, so the strip looks right and the pointer is wrong by
  // a whole window.
  'pointer-ignores-view': {
    file: 'web/main.js',
    edits: [[
      '  timeAt(clientX) {\n'
      + '    const r = ui.bed.getBoundingClientRect();\n'
      + '    const f = r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;\n'
      + '    return Math.max(0, Math.min(this.duration, (this.a + f * (this.b - this.a)) * this.duration));',
      '  timeAt(clientX) {\n'
      + '    const r = ui.bed.getBoundingClientRect();\n'
      + '    const f = r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;\n'
      + '    return f * this.duration;',
    ]],
  },

  // One term of the seam, reverted on its own: the marks are placed against the clip
  // while everything else is placed against the window. It must redden the culling row
  // and leave the key, cut, playhead and ruler rows passing - a mutation that reddened
  // everything would say something is broken without saying what.
  'marks-ignore-view': {
    file: 'web/main.js',
    edits: [[
      '    el.style.left = `${view.pct(at)}%`;\n    el.hidden = !view.holds(at);',
      '    el.style.left = `${(at / total) * 100}%`;',
    ]],
  },

  // The overview's edge handles stop resizing the window and pan it instead, which is
  // what the box does when the `edge` branch is gone. The pan row and the centring row
  // both still pass, so a red run names the zoom half specifically - and a handler that
  // was wholly dead would redden all three, which is why this is the one control the
  // three rows need rather than two.
  'mini-ignores-edges': {
    file: 'web/main.js',
    edits: [[
      "  const edge = e.target.classList.contains('w') ? 'w' : e.target.classList.contains('e') ? 'e' : null;",
      '  const edge = null;',
    ]],
  },

  // The splitter loses its clamp, so it can be dragged until the stage is a sliver.
  // A bound that can be dragged past is not a bound, and this is the one row that says
  // so - everything else about the splitter goes on working, which is what makes the
  // clamp row diagnostic rather than a second way of saying "the splitter drags".
  'splitter-unclamped': {
    file: 'web/main.js',
    edits: [[
      '  const height = Math.min(laneStackHeight, Math.max(0, Math.min(wanted, laneHeightCeiling())));',
      '  const height = Math.min(laneStackHeight, Math.max(0, wanted));',
    ]],
  },

  // The rail stops following the lanes, so every lane is labelled with a neighbour the
  // moment the strip is short enough to scroll. Reddens exactly the mirror row.
  'rail-ignores-scroll': {
    file: 'web/main.js',
    edits: [[
      "ui.lanes.addEventListener('scroll', () => {\n  ui.railLanes.scrollTop = ui.lanes.scrollTop;\n});",
      "ui.lanes.addEventListener('scroll', () => {});",
    ]],
  },

  // The overview's wheel reads its x through the ruler's mapping, so it zooms about a
  // window position while the pointer is over a clip position. The ruler's own two
  // wheel rows go on passing, which is what makes this diagnostic of the branch rather
  // than of zooming.
  'mini-wheel-uses-ruler': {
    file: 'web/main.js',
    edits: [[
      '  return surface === ui.mini ? f : view.a + f * (view.b - view.a);',
      '  return view.a + f * (view.b - view.a);',
    ]],
  },

  // The height is applied but never stored, so it is gone on the next load. Reddens
  // only the reload row - every other splitter row runs inside one page and cannot
  // tell.
  // Re-anchored when the splitter grew keyboard operation: the drag's inline storage
  // write became `rememberLaneHeight`, shared with the arrow keys, so the line this
  // names moved and lost two spaces of indent. The refusal is what surfaced that -
  // it matched 0 times and the run reported DID NOT RUN rather than passing quietly.
  // Mutating the shared writer is a strictly stronger mutation than mutating the
  // drag's own copy was, because now it forgets whichever gesture set the height.
  'splitter-forgets': {
    file: 'web/main.js',
    edits: [[
      '    localStorage.setItem(LANES_HEIGHT, String(userLaneHeight));',
      '    void LANES_HEIGHT;',
    ]],
  },

  // The global shortcuts stop asking whether a key was already consumed, so the
  // splitter's Home and End resize the strip and then seek as well. Reddens the two
  // "seeks nowhere" rows and leaves the resize rows beside them green, which is what
  // makes it diagnostic of the guard rather than of the keys.
  'shortcuts-ignore-consumed': {
    file: 'web/main.js',
    edits: [['  if (e.defaultPrevented) return;\n', '']],
  },

  // The rate gesture goes back to reading the generation at release rather than the one
  // it took, so a takeover it was held across reads as itself. Reddens only the
  // interrupted arm - the uninterrupted one applies identically either way, which is
  // the whole reason that arm is there.
  // The transport takeover stops reaching the gesture at all: the one door stops
  // dropping it, and the release goes back to reading the generation at the moment it
  // runs rather than the one it took. That is the pre-fix build exactly, so it reddens
  // both halves - the release writing over the new document and resuming it, and the
  // slider event after the takeover rescaling a snapshot of the old one.
  'takeover-ignored': {
    file: 'web/main.js',
    edits: [
      ['  dropRateGesture();\n  return transportGen;', '  return transportGen;'],
      ['  const { wasPlaying, applied, rate: began, gen } = rateGesture;',
        '  const { wasPlaying, applied, rate: began } = rateGesture;\n  const gen = transportGen;'],
    ],
  },

  // The window's clamp goes back to being applied to its own previous output, so it
  // ratchets outward and a round trip never comes back. Reddens only the last of the four
  // round-trip rows - the three above it are about the trip happening at all, which this
  // leaves alone.
  'window-clamp-ratchets': {
    file: 'web/main.js',
    edits: [['  view.reclamp();', '  view.set(view.a, view.b);']],
  },

  // The detent goes back to acting on every position whatever the gesture began at, so a
  // loaded 1.02x is eaten by the first nudge. Reddens the nudge row and leaves the load
  // row and the two aiming rows green, which is what separates a detent that is too eager
  // from one that has stopped working.
  'detent-eats-loaded-rate': {
    file: 'web/main.js',
    edits: [[
      '  const holding = rateGesture ? rateGesture.detentArmed === false : false;\n'
      + '  return !holding && insideDetent(rate) ? 1 : Number(rate.toFixed(3));',
      '  return insideDetent(rate) ? 1 : Number(rate.toFixed(3));',
    ]],
  },

  // The anchor takes the frame below instead of the nearest one, which doubles what the
  // grid costs. Reddens the bound row of the off-grid arm and leaves its own "the anchor
  // does move" row green, plus the three on-grid arms above it - they land on the grid
  // either way, which is exactly why they could not see this.
  'anchor-floors-to-frame': {
    file: 'web/main.js',
    edits: [[
      'return Math.max(0, Math.min(this.lastFrame, Math.round(programSec * this.outputFps)));',
      'return Math.max(0, Math.min(this.lastFrame, Math.floor(programSec * this.outputFps)));',
    ]],
  },

  // A release of any key ends the gesture again, so tapping Shift while an arrow is
  // repeating splits one adjustment into several and loses the play intent. Reddens the
  // held-key block's commit, seek and resume rows.
  'keyup-ends-any-gesture': {
    file: 'web/main.js',
    edits: [[
      "ui.rate.addEventListener('keyup', (e) => {\n"
      + '  if (rateGesture && rateGesture.fromKey === e.key) endRateGesture();\n'
      + '});',
      "ui.rate.addEventListener('keyup', endRateGesture);",
    ]],
  },

  // The deliverable stops being a document replacement, so a gesture held across one
  // rescales the trim it began in and writes it back over the one just chosen. Reddens
  // only the last of the three deliverable rows - the two above it are about the menu
  // working at all, which this mutation leaves alone.
  'deliverable-keeps-gesture': {
    file: 'web/main.js',
    edits: [['  dropRateGesture();\n  setActiveDeliverable(deliverable);', '  setActiveDeliverable(deliverable);']],
  },

  // The keys and handles go back to inheriting the lane's `pan-y`, so a vertical touch
  // drag on one is claimed by the browser for scrolling. Reddens the two rows about them
  // and leaves the lane's own row green, which is the difference between the surface that
  // scrolls and the controls that must not.
  'keys-yield-touch': {
    file: 'web/index.html',
    edits: [['  .tkey, .thandle { touch-action: none; }', '  .tkey, .thandle { touch-action: pan-y; }']],
  },

  // The wheel goes back to reading its deltas as pixels whatever the browser said they
  // were. Reddens only the line-mode rows - a pixel-mode notch is unchanged by this,
  // which is what makes those rows about the unit rather than about zooming.
  'wheel-ignores-deltamode': {
    file: 'web/main.js',
    edits: [[
      "  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {\n"
      + '    return { x: e.deltaX * LANE_KEY_STEP, y: e.deltaY * LANE_KEY_STEP };\n'
      + '  }\n',
      '',
    ]],
  },

  // The keyboard loses the only gesture that moves a window without resizing it, which
  // is what the overview's pointer-only handlers left it needing. Zoom, fit and frame
  // stay, so the rows beside it stay green.
  'pan-keys-unbound': {
    file: 'web/main.js',
    edits: [[
      "    case ',': case '<': e.preventDefault(); if (view.panBy(-0.25)) viewChanged(); return;\n"
      + "    case '.': case '>': e.preventDefault(); if (view.panBy(0.25)) viewChanged(); return;\n",
      '',
    ]],
  },

  // A lane goes back to swallowing the vertical axis, so a touch swipe cannot reach a
  // lane below the fold. Reddens only the touch-action row - the wheel rows beside it
  // are unaffected, which is the difference between the two ways into the same scroller.
  'lanes-eat-touch': {
    file: 'web/index.html',
    edits: [[
      '.tlane { position: relative; height: 100%; touch-action: pan-y; }',
      '.tlane { position: relative; height: 100%; touch-action: none; }',
    ]],
  },

  // `change` goes back to ending every gesture, so a held arrow key is one gesture per
  // repeat again. Reddens the commit, seek and resume rows of the held-key block and
  // leaves its "the speed moved" row green, which is what separates a control that
  // stopped working from one that works six times over.
  'rate-ends-on-change': {
    file: 'web/main.js',
    edits: [[
      "ui.rate.addEventListener('change', () => { if (!rateGesture?.fromKey) endRateGesture(); });",
      "ui.rate.addEventListener('change', endRateGesture);",
    ]],
  },

  // The space bar stops reaching the transport. Everything else about the keyboard
  // stays, so this reddens the transport rows and leaves the stepping and range rows
  // alone - which is what makes it diagnostic of its own term.
  'space-unbound': {
    file: 'web/main.js',
    edits: [[
      '      // Or the page scrolls under the strip.\n      e.preventDefault();\n'
      + '      if (timeline.playing) timeline.pause();\n'
      + '      else timeline.play().catch(showTimelineError);\n      return;',
      '      // Or the page scrolls under the strip.\n      e.preventDefault();\n      return;',
    ]],
  },

  // Deleting a key goes back to being impossible - which it was, by every gesture
  // anybody tried: Delete, Backspace and a double click all left the count where it
  // was.
  'delete-ignores-selection': {
    file: 'web/main.js',
    edits: [[
      'function deleteSelectedKey() {\n  if (!timeline || !selection) return false;',
      'function deleteSelectedKey() {\n  if (!timeline || !selection || timeline) return false;',
    ]],
  },

  // Handles come back on flat segments - the dead affordance that made "the bezier
  // curves do not work" true. Both flat checks go, not just the drawing one: leaving
  // the check in `repositionLanes` would make every pointer move fall back to a
  // rebuild, and section 4's fallback row would go red for a reason that has nothing
  // to do with handles. A mutation has to redden its own row and leave its
  // neighbours green, or the table cannot say which term broke.
  'ease-handles-on-flat': {
    file: 'web/main.js',
    edits: [
      [
        '    // A flat segment gets none, for the reason `segmentHasShape` gives.\n'
        + '    if (!segmentHasShape(keys, seg)) continue;\n',
        '',
      ],
      [
        '      // A segment that went flat under the drag has no shape left to edit, so its\n'
        + '      // handle has to go rather than be moved - which is a rebuild, not a move.\n'
        + '      if (!segmentHasShape(keys, seg)) return false;\n',
        '',
      ],
    ],
  },

  // The preset buttons stay live, stay enabled and write nothing - the shape of a
  // control that looks like it works.
  'ease-preset-ignored': {
    file: 'web/main.js',
    edits: [[
      '  if (spec.out) keys[i].easeOut = [...spec.out];\n'
      + '  if (spec.in) keys[i].easeIn = [...spec.in];\n'
      + '  if (spec.nextIn && i < keys.length - 1) keys[i + 1].easeIn = [...spec.nextIn];',
      '  void spec;',
    ]],
  },

  // The chip scroller loses its ability to shrink, which is what lets the row's
  // contents push everything after them off the right edge.
  //
  // **It took three attempts to aim this one, and the two misses are worth recording
  // because each looked exactly like a control that works.** `pin-min-width-auto`
  // removed the `min-width: 0` rules from `.tpin` and was NOT CAUGHT: those were the
  // fix for the *old* single-row bar, where the deliverable select sat in the pinned
  // end and one long name set a floor the 46% box could not shrink under - and the
  // deliverable moved into the scroller when the bar became two rows, so nothing with
  // a variable intrinsic width is pinned any more. `export-not-pinned` then moved the
  // export chip back into the scroller and was *also* NOT CAUGHT, because row two
  // holds so much less than the old single row did that the button stays on screen
  // even unpinned.
  //
  // Both misses say the same thing, which is worth knowing about the fix: the two-row
  // split is what made the button reachable, and the pin is belt-and-braces on top of
  // it. What is still load-bearing underneath both is that the scroller can give
  // ground - a flex child with visible overflow takes `min-width: auto`, refuses to
  // shrink below its content, and pushes whatever follows it out of the box. That is
  // one line, it is the mechanism the layout actually rests on, and removing it
  // reddens the reachability rows and nothing else.
  'scroller-cannot-shrink': {
    file: 'web/index.html',
    edits: [[
      '  .tchips { margin-left: auto; display: flex; gap: 8px; flex-wrap: nowrap; align-items: center;\n'
      + '    min-width: 0; overflow-x: auto; scrollbar-width: none; }',
      '  .tchips { margin-left: auto; display: flex; gap: 8px; flex-wrap: nowrap; align-items: center; }',
    ]],
  },

  // The lateral crop reads the wrong axis: `left`/`right` become the vertical pair and
  // `bottom`/`top` the horizontal one. Every plane still culls, the same number of
  // points still disappear, and the four sliders are wired to the wrong sides - which
  // is invisible to any row that only counts what was removed.
  'crop-axes-swapped': {
    file: 'web/main.js',
    edits: [[
      '  if (pos.x < cropL || pos.x > cropR || pos.y < cropB || pos.y > cropT) {',
      '  if (pos.y < cropL || pos.y > cropR || pos.x < cropB || pos.x > cropT) {',
    ]],
  },

  // The box becomes a wedge - the crop is read as an angle rather than a position, so
  // it widens with depth the way the sensor's own frame does. Rigged to agree with the
  // box exactly at 2m, because a mutation that disagreed everywhere would also be
  // caught by rows that are not about this, and the claim under test is specifically
  // that a plane stays where it was put as the subject walks away from the sensor.
  'crop-in-image-space': {
    file: 'web/main.js',
    edits: [[
      '  if (pos.x < cropL || pos.x > cropR || pos.y < cropB || pos.y > cropT) {',
      '  float wedge = 2.0 / max(0.001, z);\n'
      + '  if (pos.x * wedge < cropL || pos.x * wedge > cropR\n'
      + '   || pos.y * wedge < cropB || pos.y * wedge > cropT) {',
    ]],
  },

  // The name field stops reaching the export, which is where it was before there was
  // a field: every render was named after the take and overwrote the last one.
  'export-ignores-name': {
    file: 'web/main.js',
    edits: [['      name: options.name ?? exportBaseName(),', '      name: options.name ?? timeline.source.id,']],
  },
};

/**
 * The mutated source, refused loudly when an anchor no longer matches exactly once.
 *
 * A mutation is a piece of source text, so it goes stale the moment the code it names
 * is edited - and a replacement that silently matched nothing would run the unmutated
 * build and be recorded as this tool having missed a bug it was never shown.
 */
function mutatedSource(name) {
  const spec = MUTATIONS[name];
  if (!spec) throw new Error(`unknown mutation ${name} - have ${Object.keys(MUTATIONS).join(', ')}`);
  let source = readFileSync(join(REPO, spec.file), 'utf8');
  for (const [from, to] of spec.edits) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) {
      throw new Error(`mutation ${name} matched ${hits} times in ${spec.file}, expected exactly 1: `
        + `${JSON.stringify(from.slice(0, 90))}`);
    }
    source = source.replace(from, to);
  }
  return { file: spec.file, body: source };
}

// ------------------------------------------------------------------- playwright

async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const roots = [];
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim());
  } catch { /* no global npm root: the local resolve below may still work */ }
  const candidates = [async () => import('playwright')];
  for (const root of roots) {
    for (const name of ['playwright', '@playwright/cli/node_modules/playwright']) {
      candidates.push(async () => import(pathToFileURL(require.resolve(join(root, name))).href));
    }
  }
  for (const load of candidates) {
    try {
      const mod = await load();
      const pw = mod.chromium ? mod : mod.default;
      if (pw?.chromium) return pw;
    } catch { /* try the next one */ }
  }
  throw new Error('playwright not found - install it globally or in this project');
}

// --------------------------------------------------------------------- reporting

let failures = 0;
let checks = 0;
// The labels, not only the count. "3 assertions fired" cannot be checked for having
// fired *for the reason claimed*, and a row that goes red for a neighbouring reason
// looks exactly like a control that works.
const fired = [];
const check = (ok, label, detail = '') => {
  checks++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `   ${detail}` : ''}`);
  if (!ok) { failures++; fired.push(label); }
};
const note = (label, detail = '') => console.log(`  ....  ${label}${detail ? `   ${detail}` : ''}`);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// A throw is the harness not running rather than a finding in either direction.
// `monitor-check` counted its own timeout in `failed` and printed "caught, as
// required (1 assertion fired)" having tested nothing at all about the thing under
// test. This is that fix applied before the tool has a chance to earn the mistake.
let crashed = null;
let untested = null;

// ------------------------------------------------------------------- the drivers
//
// Every interactive control the editor renders has to be covered here, and coverage
// means "this file, or a named file, drives it and watches something change". The
// rules come before the names because most of the panel is one rule - but a rule is
// still an entry, so nothing is covered by silence.

const DRIVER_RULES = [
  {
    what: 'a look parameter slider or checkbox',
    by: "registry-check's drop-one sweep proves each one reaches the pixels",
    match: (el) => el.closest('#panel') && (el.type === 'range' || el.type === 'checkbox')
      && !el.closest('#sensorGroup, #monitorGroup, #recordGroup, #recLookGroup'),
  },
  {
    what: 'a keyframe toggle',
    by: 'keyframe-check, and section 5 here deletes what it creates',
    match: (el) => el.classList.contains('kf') && el.id !== 'tRateKey',
  },
  {
    what: 'a shading mode',
    by: 'registry-check and timeline-check both select modes and compare the image',
    match: (el) => el.closest('#modes'),
  },
  {
    what: 'a recorder-surface control',
    by: 'sensor-view-check section 6 and library-check',
    match: (el) => el.closest('#recordGroup, #recLookGroup, #sensorGroup, #monitorGroup, #extendedRow'),
  },
  {
    what: 'a camera-composition control',
    by: 'keyframe-check drives the path; sensor-view-check drives `sensor view`',
    match: (el) => el.closest('#cameraGroup') || el.id === 'camSensor',
  },
  {
    what: 'navigation out of the editor',
    by: 'sensor-view-check and library-check follow both links, and the rows below '
      + 'assert where the nav sits and where its two anchors go',
    match: (el) => el.closest('#navRow'),
  },
];

// Named one at a time, because each of these is a control this file presses itself.
const DRIVER_IDS = {
  tPlay: 'section 2 - toggles playback and the state is read back',
  tRate: 'section 4 - the anchor rows and the seek-storm row',
  tRateKey: 'section 5 - plants and removes a retime key',
  tFps: 'timeline-check and export-check change the output rate and count frames',
  tSetIn: 'section 3 - sets the range from the playhead',
  tSetOut: 'section 3 - sets the range from the playhead',
  tClearRange: 'section 3 - puts the range back to the whole clip',
  tMark: 'library-check writes a mark and reads the sidecar back',
  tDeleteKey: 'section 5 - removes the selected key',
  tPreset: 'library-check applies a preset and compares the look',
  tPresetApply: 'library-check',
  tPresetSave: 'library-check',
  tProject: 'library-check opens a project and compares the document',
  tProjectOpen: 'library-check',
  tProjectSave: 'library-check',
  tDeliverable: 'library-check, and section 6 here plants a long name in it',
  tDeliverableNew: 'library-check',
  tExportName: 'section 7 - names the file and refuses a path',
  tExportSize: 'export-check sweeps every size the menu offers',
  tExport: 'section 6 asserts it is reachable, section 7 renders with it',
  tExportSave: 'section 7 - the saved copy, against a stubbed picker',
  cropReset: 'section 8 - opens the crop box again and the planes are read back',
};

// ------------------------------------------------------------------- the page

const { chromium } = await loadPlaywright();

let mutation = null;
try {
  mutation = MUTATE ? mutatedSource(MUTATE) : null;
} catch (err) {
  console.log(`[editor] DID NOT RUN - ${err.message}`);
  process.exit(2);
}
if (MUTATE) console.log(`[editor] MUTATED BUILD: ${MUTATE} in ${mutation.file} - this run is expected to FAIL`);
const mutatedJs = mutation?.file === 'web/main.js' ? mutation.body : null;
const mutatedHtml = mutation?.file === 'web/index.html' ? mutation.body : null;

// The picker stub, installed before the module evaluates rather than after.
//
// `main.js` reads `typeof globalThis.showSaveFilePicker === 'function'` once at load
// to decide whether the button can work at all, so a stub installed after the page
// exists would arrive to find the control already disabled and the row would test the
// disabling rather than the saving. It also records `navigator.userActivation.isActive`
// at the moment it is called, which is the only way to see the ordering the feature
// depends on: awaiting the fetch before opening the sheet spends the transient
// activation the API requires, and the sheet then never opens.
// Chunks are kept whole and joined at the end rather than spread into an array as
// they arrive. `push(...chunk)` on a 64KB chunk passes 65,536 arguments and throws
// `Maximum call stack size exceeded` - which the page catches and reports as
// `save failed`, so the *stub* failing looked exactly like the feature failing.
// Measured on the first run of this row: the picker had been called, the activation
// was live and the suggested name was right, and the row still went red.
const PICKER_STUB = `(() => {
  globalThis.__saved = { called: false, suggestedName: null, hadActivation: null, chunks: [], closed: false };
  globalThis.showSaveFilePicker = async (opts) => {
    globalThis.__saved.called = true;
    globalThis.__saved.suggestedName = opts?.suggestedName ?? null;
    globalThis.__saved.hadActivation = navigator.userActivation ? navigator.userActivation.isActive : null;
    return {
      createWritable: async () => new WritableStream({
        write(chunk) { globalThis.__saved.chunks.push(chunk); },
        close() { globalThis.__saved.closed = true; },
      }),
    };
  };
})()`;

async function openEditor() {
  // Local Network Access is off, and it is an artifact of how a markup mutation has
  // to be delivered rather than anything about the build: serving the document
  // through `route.fulfill` puts the page in a context Chromium treats as external,
  // so its WebSocket back to localhost is refused and the run ends having tested
  // nothing. Passed on every launch rather than only the mutated ones, because two
  // browsers configured differently is two things being measured.
  const browser = await chromium.launch({
    channel: 'chromium',
    headless: !HEADED,
    args: ['--disable-features=LocalNetworkAccessChecks'],
  });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await context.addInitScript(PICKER_STUB);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));

  // Both interceptions are proved below rather than assumed. A route that was
  // declared and never installed ran the tree's own source and came back NOT CAUGHT
  // with every row green - a mutation that did nothing, reported as a check that
  // found nothing.
  let servedModule = false;
  if (mutatedJs) {
    await page.route('**/main.js', (route) => {
      servedModule = true;
      route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: mutatedJs });
    });
  }
  let servedHtml = false;
  if (mutatedHtml) {
    await page.route((url) => url.pathname === EDITOR_PATH, (route) => {
      servedHtml = true;
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: mutatedHtml });
    });
  }

  await page.goto(`${URL_BASE}${EDITOR_PATH}?take=${encodeURIComponent(TAKE)}`, { waitUntil: 'load' });
  const waitFor = async (expr, what, timeout = 30000) => {
    try {
      await page.waitForFunction(expr, null, { timeout });
    } catch (err) {
      throw new Error(`${what}: ${err.message.split('\n')[0]}`
        + (errors.length ? ` - the page said: ${errors.slice(0, 3).join(' | ')}` : ' - the page reported nothing'));
    }
  };
  await waitFor('!!globalThis.__kinect', 'the module never finished booting');
  await waitFor('!!globalThis.__kinect.timeline.transport()', 'the take never opened');
  if (mutatedJs && !servedModule) throw new Error("the mutated module was never served - this page ran the tree's own build");
  if (mutatedHtml && !servedHtml) throw new Error("the mutated markup was never served - this page ran the tree's own panel");
  return { page, errors, close: () => browser.close() };
}

// ------------------------------------------------------------------- the run

let page;
let errors;
let close = async () => {};

try {
  const opened = await openEditor();
  ({ page, errors, close } = opened);
} catch (err) {
  console.log(`[editor] DID NOT RUN - ${err.message}`);
  process.exit(2);
}

const settle = () => page.evaluate('__kinect.timeline.settled()');
const read = () => page.evaluate('__kinect.timeline.read()');
const range = () => page.evaluate('__kinect.editor.clipRange()');
const lanes = () => page.evaluate('__kinect.keyframes.lanes()');
const keyCount = async (owner) => ((await lanes()).find((l) => l.owner === owner)?.keys ?? 0);
const text = (sel) => page.locator(sel).textContent();
/** Focus somewhere with no claim on the keyboard, so the window handler gets the key. */
// Takes the focus off whatever has it, which is what the name claimed and what the
// eight call sites below were relying on - and it did none of it. Neither `#stage` nor
// `<body>` carries a tabindex, so `focus()` on either is a no-op and the focus stayed
// exactly where the previous gesture left it. It never showed because every earlier
// caller followed an `el.blur()` of its own, until section 4 grew a block that begins a
// gesture on `#tRate` the way a keyboard user does: an `INPUT` still focused two
// sections later means the window handler's typing guard skips every key press, and
// section 5's Delete row went red as a missing feature on a build that deletes keys
// perfectly well. `blur()` is the call that moves focus, so it is the one here.
const focusStage = () => page.evaluate(`(() => {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  document.getElementById('stage')?.focus?.();
})()`);

try {
  await settle();

  // =====================================================================
  console.log('\n[1] every control the editor renders is one this file knows how to drive');
  // =====================================================================
  //
  // The sweep is over what the page actually contains rather than over a list kept
  // here, which is the only version of this that survives somebody adding a button.
  const sweep = await page.evaluate(`(${((rules) => {
    // Anchors are in the list because the way out of this surface is two of them.
    // They were buttons calling `location.href` until the nav moved into the panel
    // head, and a selector naming only the form controls would have watched them
    // leave the sweep rather than fail - the "passes by disappearing" shape this
    // file's own section 1 exists to refuse.
    const els = [...document.querySelectorAll('.tbar input, .tbar select, .tbar button, .tbar a, '
      + '#panel input, #panel select, #panel button, #panel a')];
    return els.map((el) => ({
      id: el.id || null,
      tag: el.tagName,
      type: el.type || null,
      ease: el.dataset ? el.dataset.ease ?? null : null,
      inTbar: Boolean(el.closest('.tbar')),
      groups: ['#panel', '#modes', '#cameraGroup', '#navRow', '#recordGroup', '#recLookGroup',
        '#sensorGroup', '#monitorGroup', '#extendedRow']
        .filter((g) => el.closest(g)),
      kf: el.classList.contains('kf'),
      label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24),
    }));
  }).toString()})()`);

  const inGroup = (row, ...groups) => groups.some((g) => row.groups.includes(g));
  const covered = (row) => {
    if (row.id && DRIVER_IDS[row.id]) return `named: ${DRIVER_IDS[row.id]}`;
    if (row.ease) return 'rule: an ease preset, section 5 presses all five';
    if (row.kf && row.id !== 'tRateKey') return DRIVER_RULES[1].by;
    if (inGroup(row, '#recordGroup', '#recLookGroup', '#sensorGroup', '#monitorGroup', '#extendedRow')) return DRIVER_RULES[3].by;
    if (inGroup(row, '#modes')) return DRIVER_RULES[2].by;
    if (inGroup(row, '#cameraGroup') || row.id === 'camSensor') return DRIVER_RULES[4].by;
    if (inGroup(row, '#navRow')) return DRIVER_RULES[5].by;
    if (inGroup(row, '#panel') && (row.type === 'range' || row.type === 'checkbox')) return DRIVER_RULES[0].by;
    return null;
  };

  const unknown = sweep.filter((row) => !covered(row));
  note(`${sweep.length} interactive controls on the editor`,
    `${sweep.filter((r) => r.inTbar).length} in the strip, ${sweep.length - sweep.filter((r) => r.inTbar).length} in the panel`);
  for (const row of unknown) {
    note('  no driver for', `${row.tag}${row.id ? `#${row.id}` : ''} "${row.label}"`);
  }
  check(unknown.length === 0,
    'every control the page renders is covered by a driver or a stated rule',
    unknown.length ? `${unknown.length} uncovered: ${unknown.map((r) => r.id || r.label).join(', ')}` : `${sweep.length} controls`);
  // The rule half of the claim, so a build that removed every panel control could not
  // satisfy the row above by having nothing left to cover.
  check(sweep.length > 60, 'and the sweep found the panel, not an empty page', `${sweep.length} controls`);
  check(sweep.some((r) => r.id === 'tExport') && sweep.some((r) => r.id === 'tIn' || true),
    'the strip is among what was swept', `${sweep.filter((r) => r.inTbar).map((r) => r.id).filter(Boolean).slice(0, 6).join(', ')}...`);

  // Being in the document is not the same as being reachable, which is the whole of
  // what was wrong with this control before it moved. It sat under thirteen groups of
  // sliders at the foot of a column that scrolls, so on any window the panel filled it
  // was off screen until somebody scrolled for it - swept by this file, covered by a
  // rule, and invisible to the person using the editor.
  //
  // **Measured at both ends of the travel, because one end is a dead zone.** The first
  // version of this scrolled the column to its end and asked whether the nav was inside
  // the panel, which is precisely where a nav at the foot of the column *is* inside the
  // panel - `nav-at-the-foot` came back 683px down and comfortably visible, and the row
  // only reddened on the structural half of its condition. The end a foot-nav fails is
  // the top, where the panel sits when you arrive. So both are read.
  const nav = await page.evaluate(`(${(() => {
    const el = document.getElementById('navRow');
    const panel = document.getElementById('panel');
    const body = document.getElementById('panelBody');
    if (!el || !panel || !body) return { present: false, hasBody: !!body };
    const was = body.scrollTop;
    const at = (to) => {
      body.scrollTop = to;
      const r = el.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      return {
        scrolled: Math.round(body.scrollTop),
        top: Math.round(r.top - p.top),
        inside: r.top >= p.top - 0.5 && r.bottom <= p.bottom + 0.5,
      };
    };
    const travel = body.scrollHeight - body.clientHeight;
    const top = at(0);
    const end = at(body.scrollHeight);
    // Put the column back where it was found. Section 8 drives the crop sliders by
    // pointer coordinate, and a panel left scrolled to its end puts every one of them
    // somewhere else - which is what happened: the crop rows moved from 0.005% apart
    // to 0.446% and read as a rendering regression this change had caused. This probe
    // is the one thing in section 1 that alters the page it is measuring, so it is also
    // the one thing that has to undo itself.
    body.scrollTop = was;
    return {
      present: true,
      hasBody: true,
      // How far the column can travel. A nav that cannot scroll out of sight is a nav
      // this claim was never tested on, so the number is a row of its own.
      travel: Math.round(travel),
      inBody: !!el.closest('#panelBody'),
      top,
      end,
      // Destinations off the markup rather than off a click handler, because that is
      // where they live now and a browser can only follow what it can read.
      hrefs: [...el.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    };
  }).toString()})()`);

  check(nav.present, 'the panel has a head and a nav in it',
    nav.present ? `${nav.hrefs.length} links` : `navRow/panelBody present: ${nav.hasBody}`);
  check(nav.travel > 0, 'and the panel body genuinely scrolls, so the rows below are measuring something',
    `${nav.travel}px of travel`);
  check(nav.present && nav.top.inside && nav.end.inside,
    'the way out is on screen at both ends of that travel, which is what "not at the foot" means',
    nav.present ? `${nav.top.top}px below the panel top at rest, ${nav.end.top}px scrolled to the end` : 'absent');
  check(nav.present && !nav.inBody,
    'and it is outside the scrolling column rather than merely near its top',
    `in the scrolling body: ${nav.inBody}`);
  check(nav.present && nav.hrefs.join(' ') === '/ /gallery',
    'and both chips carry the destination in the markup, in the order every surface uses',
    nav.hrefs.join(' '));

  // =====================================================================
  console.log('\n[2] the keyboard, and the guard that has to come with it');
  // =====================================================================
  await page.evaluate('__kinect.timeline.transport().seek(6)');
  await settle();
  await focusStage();

  const playingBefore = (await read()).playing;
  await page.keyboard.press(' ');
  await new Promise((r) => setTimeout(r, 500));
  const playingAfter = (await read()).playing;
  check(!playingBefore && playingAfter, 'space starts playback', `${playingBefore} -> ${playingAfter}`);
  await page.keyboard.press(' ');
  await new Promise((r) => setTimeout(r, 400));
  check(!(await read()).playing, 'and space stops it again - the toggle is driven both ways');
  await page.evaluate('__kinect.timeline.transport().pause()');
  await settle();

  const f0 = (await read()).frame;
  await page.keyboard.press('ArrowRight');
  await settle();
  const f1 = (await read()).frame;
  check(f1 === f0 + 1, 'right arrow steps exactly one output frame', `${f0} -> ${f1}`);
  await page.keyboard.press('ArrowLeft');
  await settle();
  check((await read()).frame === f0, 'and left steps exactly one back', `${f1} -> ${(await read()).frame}`);
  const fps = (await read()).outputFps;
  await page.keyboard.press('Shift+ArrowRight');
  await settle();
  check((await read()).frame === f0 + fps, 'shift-right steps one second, which is the rate rather than a constant',
    `${f0} -> ${(await read()).frame} at ${fps}fps`);

  await page.keyboard.press('Home');
  await settle();
  const home = (await read()).programSec;
  await page.keyboard.press('End');
  await settle();
  const end = (await read()).programSec;
  check(near(home, 0, 0.05) && end > home + 1, 'home and end park at the two ends of the clip',
    `${home.toFixed(3)}s and ${end.toFixed(3)}s`);

  await page.evaluate('__kinect.timeline.transport().seek(5)');
  await settle();
  await page.keyboard.press('i');
  await settle();
  await page.evaluate('__kinect.timeline.transport().seek(18)');
  await settle();
  await page.keyboard.press('o');
  await settle();
  const keyed = await range();
  check(near(keyed.in, 5, 0.1) && near(keyed.out, 18, 0.1), 'i and o set the range at the playhead',
    JSON.stringify(keyed));
  await page.evaluate('__kinect.timeline.transport().seek(12)');
  await settle();
  await page.keyboard.press('Shift+i');
  await settle();
  const jumped = await read();
  const afterJump = await range();
  check(near(jumped.programSec, 5, 0.1), 'shift-i jumps the playhead to in', `${jumped.programSec.toFixed(3)}s`);
  check(near(afterJump.in, keyed.in, 1e-6) && near(afterJump.out, keyed.out, 1e-6),
    'and moves the range not at all, which is the difference between the two gestures',
    JSON.stringify(afterJump));

  // The typing guard. `i`, `o` and `m` are all letters somebody has to be able to put
  // in a filename, so a shortcut handler with no guard makes the one text field in
  // the strip unusable while quietly editing the clip.
  await page.evaluate(`(() => { const el = document.getElementById('tExportName'); el.value = ''; el.focus(); })()`);
  const beforeTyping = await range();
  const keysBeforeTyping = await lanes();
  await page.keyboard.type('iom');
  await new Promise((r) => setTimeout(r, 250));
  const typed = await page.locator('#tExportName').inputValue();
  const afterTyping = await range();
  check(typed === 'iom', 'the three shortcut letters can be typed into the name field', `"${typed}"`);
  check(JSON.stringify(beforeTyping) === JSON.stringify(afterTyping),
    'and typing them changed no clip range', `${JSON.stringify(beforeTyping)} then ${JSON.stringify(afterTyping)}`);
  check(JSON.stringify(keysBeforeTyping) === JSON.stringify(await lanes()),
    'and deleted no key');
  await page.evaluate(`(() => { const el = document.getElementById('tExportName'); el.value = ''; el.blur(); })()`);
  await focusStage();

  // =====================================================================
  console.log('\n[3] the in and out markers, which is the claim nothing was making');
  // =====================================================================
  const markersPresent = async () => page.evaluate(`(() => {
    const box = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, x: r.x, y: r.y };
    };
    return { in: box('tIn'), out: box('tOut') };
  })()`);
  const boxes = await markersPresent();
  check(boxes.in !== null && boxes.out !== null,
    'both markers are in the document at all - this is the row that was missing',
    `in ${boxes.in ? 'present' : 'ABSENT'}, out ${boxes.out ? 'present' : 'ABSENT'}`);
  check(Boolean(boxes.in && boxes.in.h > 10 && boxes.out && boxes.out.h > 10),
    'and both have a real box rather than a collapsed one',
    boxes.in ? `${boxes.in.w}x${boxes.in.h} and ${boxes.out.w}x${boxes.out.h}` : 'n/a');

  // The reach, probed by what is under the pointer rather than by the box. The drawn
  // line is 1px and the grab zone is a pseudo-element, so a box measurement would
  // report the wrong number in the reassuring direction.
  const grabWidth = async (id) => page.evaluate(`(${((elId) => {
    const el = document.getElementById(elId);
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const mid = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    let n = 0;
    for (let dx = -18; dx <= 18; dx++) {
      const hit = document.elementFromPoint(mid.x + dx, mid.y);
      if (hit === el) n++;
    }
    return n;
  }).toString()})(${JSON.stringify(id)})`);
  await page.locator('#tClearRange').click();
  await settle();
  const grabOutAtEnd = await grabWidth('tOut');
  const grabIn = await grabWidth('tIn');
  check(grabOutAtEnd >= 10, 'out is grabbable where it is hardest to be - at "end", on the strip\'s right edge',
    `${grabOutAtEnd}px of reach`);
  check(grabIn >= 10, 'and in is grabbable at zero, on the left edge', `${grabIn}px of reach`);

  // The drag itself, with the marker away from either edge.
  //
  // **Guarded on the markers existing, because the whole point of this section is a
  // build where they do not.** The first run of `--mutate lanes-clear-siblings`
  // reddened its four rows correctly and then died dereferencing a null `#tOut` -
  // which this file reports as DID NOT RUN with exit 2, the code reserved for the
  // harness failing. A mutation that is caught and then crashes reads as a mutation
  // that was never tested, the same confusion `docs/instruments.md` records under
  // "a mutation run that exits non-zero with zero failed assertions did not run",
  // arriving from the other direction. A check has to survive the fault it checks for.
  const markersUsable = boxes.in !== null && boxes.out !== null;
  await page.evaluate('__kinect.timeline.transport().seek(30)');
  await settle();
  await page.locator('#tSetOut').click();
  await settle();
  const beforeDrag = await range();
  let afterDrag = beforeDrag;
  if (!markersUsable) {
    check(false, 'dragging the out marker left shortens the export range', 'there is no marker to drag');
    check(false, 'and the numeric readout followed it', 'not reached - the marker is absent');
    check(false, 'and what the export leaves out is drawn, in proportion to what it leaves out',
      'not reached - the marker is absent');
  } else {
    const outMid = await page.evaluate(`(() => {
      const r = document.getElementById('tOut').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await page.mouse.move(outMid.x, outMid.y);
    await page.mouse.down();
    await page.mouse.move(outMid.x - 300, outMid.y, { steps: 8 });
    await page.mouse.up();
    await settle();
    afterDrag = await range();
    check(afterDrag.out < beforeDrag.out - 1, 'dragging the out marker left shortens the export range',
      `${beforeDrag.out.toFixed(3)}s -> ${afterDrag.out.toFixed(3)}s`);
    check((await text('#tOutOut')).trim() !== 'end' && (await text('#tOutOut')).includes(':'),
      'and the numeric readout followed it', `out reads ${(await text('#tOutOut')).trim()}, length ${(await text('#tClipLen')).trim()}`);

    // The shading, measured as a fraction rather than looked at. A near-black wash
    // over a near-black strip is exactly the kind of thing a reader confirms by
    // expecting it.
    const shade = await page.evaluate(`(() => {
      const bed = document.getElementById('tBeds').getBoundingClientRect();
      const outEl = document.getElementById('tShadeOut');
      if (!outEl) return null;
      const r = outEl.getBoundingClientRect();
      return { bedW: bed.width, outW: r.width };
    })()`);
    const dur = (await read()).duration;
    const expectedFraction = 1 - (afterDrag.out / dur);
    check(shade !== null && near(shade.outW / shade.bedW, expectedFraction, 0.02),
      'and what the export leaves out is drawn, in proportion to what it leaves out',
      shade ? `${(shade.outW / shade.bedW * 100).toFixed(1)}% shaded against ${(expectedFraction * 100).toFixed(1)}% excluded`
        : 'the shading element is not in the document either');
  }

  // The regression that started this file: a lane appearing must not take the markers
  // with it. Driven through the same door a user would - a track gaining its first key.
  await page.evaluate(`__kinect.keyframes.setTracks({ bloom: [{ t: 1, value: 0.2 }, { t: 6, value: 0.9 }] })`);
  await settle();
  const afterLanes = await markersPresent();
  check(afterLanes.in !== null && afterLanes.out !== null && afterLanes.out.h > 10,
    'and both markers survive a lane being built, which is when they used to disappear',
    `${(await lanes()).length} lanes, in ${afterLanes.in ? 'present' : 'GONE'}, out ${afterLanes.out ? 'present' : 'GONE'}`);
  check(near((await range()).out ?? -1, afterDrag.out ?? -1, 1e-6),
    'and the range they show is unchanged by it', JSON.stringify(await range()));
  await page.locator('#tClearRange').click();
  await settle();
  check((await range()).out === null && (await range()).in === 0,
    '"whole clip" puts the range back, and back to null rather than to the duration',
    JSON.stringify(await range()));

  // =====================================================================
  console.log('\n[4] the speed control holds the frame you are looking at');
  // =====================================================================
  //
  // This block runs at the head of the section rather than at its tail, and that is a
  // placement rather than a preference. At the tail it left section 5's ease-handle drag
  // dead - the drag registered nothing, on a page whose state at that instant was
  // byte-identical to a passing run's: same handle box, same selection, same focus, same
  // transport, measured side by side. Whatever the block perturbs is not anything either
  // run can read, so it goes where the rows that follow rebuild the document from scratch
  // before they measure anything. Recorded rather than tidied away, because a
  // reordering that fixes a failure nobody can explain is a fact about this file that the
  // next person moving a block needs.
  // **A held arrow key is one gesture to the user and was six to the control.** Chromium
  // fires `keydown -> input -> change` on every auto-repeat and a single `keyup` at the
  // end, so a `change` handler that ended the gesture unconditionally ended and restarted
  // it per repeat - measured at six undo commits and six accurate pre-roll seeks for one
  // held key, which is the seek storm this control was rewritten to avoid, surviving on
  // the one gesture nobody watches. It lost the take as well: each repeat read
  // `timeline.playing` off a transport the previous repeat had just paused.
  //
  // Driven as the OS delivers it - one real keydown, repeats carrying `repeat: true` with
  // their `input`, and one keyup at the end. Both counters are read because they are two
  // different costs of the same fault, and a row that reported only the commits would say
  // nothing about the seeks a user actually waits for.
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await settle();
  await page.evaluate("document.getElementById('tRate').focus()");
  await page.evaluate('__kinect.timeline.transport().play()');
  await new Promise((r) => setTimeout(r, 300));
  const heldBefore = await page.evaluate(`(() => ({
    playing: __kinect.timeline.transport().playing,
    depth: __kinect.keyframes.undo.depth(),
    seeks: __kinect.timeline.counters.seeks,
    rate: __kinect.timeline.retime.rate,
  }))()`);
  await page.evaluate(`(() => {
    const el = document.getElementById('tRate');
    const step = 0.01;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    for (let i = 1; i <= 6; i++) {
      el.value = String(Number(el.value) + step);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true, bubbles: true }));
      // A modifier tapped in the middle of the hold, which a hand on a keyboard does
      // constantly and which used to end the gesture on its release - the arrow was still
      // repeating, so the next repeat opened a second gesture against a transport the
      // first had already paused. Without this the drive is a clean hold that no stray
      // release ever interrupts, and the rule about *which* key ends a gesture is
      // asserted by nothing.
      if (i === 3) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
      }
    }
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
  })()`);
  await settle();
  for (let i = 0; i < 60 && !(await page.evaluate('__kinect.timeline.transport().playing')); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const heldAfter = await page.evaluate(`(() => ({
    playing: __kinect.timeline.transport().playing,
    depth: __kinect.keyframes.undo.depth(),
    seeks: __kinect.timeline.counters.seeks,
    rate: __kinect.timeline.retime.rate,
  }))()`);
  check(heldBefore.playing && heldAfter.rate > heldBefore.rate,
    'a held arrow key moves the speed, so the two counters below are counting a gesture that happened',
    `${heldBefore.rate}x -> ${heldAfter.rate}x, take was running ${heldBefore.playing}`);
  check(heldAfter.depth - heldBefore.depth === 1,
    '  and costs one undo step for the whole hold, not one per repeat',
    `depth ${heldBefore.depth} -> ${heldAfter.depth}`);
  check(heldAfter.seeks - heldBefore.seeks <= 2,
    '  and one accurate seek, which is the storm this control exists to avoid',
    `${heldAfter.seeks - heldBefore.seeks} seeks for 6 repeats`);
  check(heldAfter.playing,
    '  and gives the take back, rather than losing the play intent on the first repeat',
    `playing ${heldBefore.playing} -> ${heldAfter.playing}`);

  // Stopped and put back to 1x before the rows below drive rates of their own. Leaving
  // the take running at 1.248x here reddened the page-errors row at the very end of the
  // file with `the retime curve runs backwards`: the accumulators walk forward one source
  // frame at a time, so a rate driven underneath a playhead that is still moving asks the
  // source to go back. The take being *running* is the whole point of the rows above, so
  // this is the price of them rather than something to move.
  await focusStage();
  await page.evaluate('__kinect.timeline.transport().pause()');
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await page.evaluate('__kinect.timeline.transport().seek(0)');
  await settle();


  // Two positions and two directions, because program and source time agree
  // trivially at program 0 and a single arm cannot tell holding one from holding the
  // other. `docs/instruments.md` has this failure twice already under "what do my
  // arms agree about".
  // **The slider's `value` is a position, not a rate.** Its travel is logarithmic, so
  // writing `2.35` into it asks for the top of the range and every row below would go
  // on asserting about 4x while claiming to be about 2.35x - a check retargeted
  // invisibly, which is the shape `docs/instruments.md` records twice. The rate goes
  // through the page's own mapping, and the rate that came out is checked against the
  // one that went in rather than assumed.
  const driveRate = async (rate) => {
    await page.evaluate(`(() => {
      const el = document.getElementById('tRate');
      el.value = String(__kinect.editor.rateSlider.toValue(${rate}));
      el.dispatchEvent(new Event('input'));
      el.dispatchEvent(new Event('change'));
    })()`);
    await settle();
    const landed = await page.evaluate('__kinect.timeline.retime.rate');
    check(near(landed, rate, 1e-6), `  the slider went to ${rate}x when it was asked for ${rate}x`,
      `landed at ${landed}x`);
    return landed;
  };

  const rateArm = async (parkAt, to) => {
    await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
    await driveRate(1);
    await page.evaluate(`__kinect.timeline.transport().seek(${parkAt})`);
    await settle();
    const before = await read();
    const leftBefore = await page.evaluate(`document.getElementById('tPlayhead').style.left`);
    await driveRate(to);
    const after = await read();
    const leftAfter = await page.evaluate(`document.getElementById('tPlayhead').style.left`);
    return { before, after, leftBefore, leftAfter };
  };

  for (const [parkAt, to] of [[10, 2], [10, 0.5], [24, 2]]) {
    const arm = await rateArm(parkAt, to);
    check(near(arm.after.sourceSec, arm.before.sourceSec, 1e-3),
      `at ${parkAt}s, changing speed to ${to}x holds the source frame`,
      `source ${arm.before.sourceSec.toFixed(4)}s -> ${arm.after.sourceSec.toFixed(4)}s`);
    check(near(parseFloat(arm.leftAfter), parseFloat(arm.leftBefore), 0.05),
      '  and holds the playhead at the same place on a ruler that rescaled under it',
      `${arm.leftBefore} -> ${arm.leftAfter}, duration ${arm.before.duration.toFixed(2)}s -> ${arm.after.duration.toFixed(2)}s`);
    check(!near(arm.after.programSec, arm.before.programSec, 1e-3),
      '  by moving program time, which is what proves it held the other one',
      `program ${arm.before.programSec.toFixed(3)}s -> ${arm.after.programSec.toFixed(3)}s`);
  }

  // **The three arms above agree about something, and it is the output grid.** 10s and 24s
  // are frames 300 and 720 at 30fps, and 2x and 0.5x take those to 150, 600 and 360 -
  // every one exactly on the grid, so all three measure a drift of 0.0ms and the 1e-3
  // above passes without ever exercising the rounding. Measured that way rather than
  // reasoned: the same arithmetic at 2.35x moves the source moment 26.7ms.
  //
  // So this arm parks at the same 10s and asks for a rate the grid cannot represent. What
  // it asserts is the *bound* rather than equality, because equality is not available: the
  // transport shows a frame, and with `source = program * rate` the frame nearest in
  // program time is already the frame nearest in source time - `Math.round` is the
  // minimiser and the residual is the grid itself, up to half a frame of program time,
  // which is `rate / (2 * outputFps)` of source.
  //
  // Both halves are asserted. The bound alone would pass on a build that held the source
  // exactly, which is impossible but would also pass on one that had stopped rescaling at
  // all - so the drift is required to be non-zero as well, which is what makes this arm
  // measure the grid rather than agree with the three above.
  const offGrid = await rateArm(10, 2.35);
  const drift = Math.abs(offGrid.after.sourceSec - offGrid.before.sourceSec);
  const bound = 2.35 / (2 * offGrid.before.outputFps);
  check(drift > 1e-3,
    'at a rate the output grid cannot represent, the anchor does move - which the three arms above never showed',
    `source ${offGrid.before.sourceSec.toFixed(4)}s -> ${offGrid.after.sourceSec.toFixed(4)}s, `
    + `${(drift * 1000).toFixed(1)}ms at 2.35x`);
  check(drift <= bound + 1e-9,
    '  and no further than half an output frame, which is the whole of what the grid costs',
    `${(drift * 1000).toFixed(1)}ms against a bound of ${(bound * 1000).toFixed(1)}ms `
    + `at ${offGrid.before.outputFps}fps`);

  // ---------------------------------------------------------------------
  // And the rest of the strip, which held the same bug for longer.
  //
  // The playhead rows above are one term of a class that has four. `in`, `out`, the
  // deliverable's copy of them and every keyframe's `t` are all program times, and a
  // speed change rescales the ruler underneath all of them. Measured on the user's own
  // numbers before the fix: source ~960s, so the ruler ends at 800s at 1.20x and 408s
  // at 2.35x while `in`/`out` stayed pinned at 234.509/407.612, which walked the out
  // cut from 50.3% of the ruler to 99.5% - and took what the export contained with it.
  //
  // **Both arms are away from 1x, and that is the whole design of this row.** At rate 1
  // program time *is* source time, so a build that never rescales anything is
  // bit-identical to one that rescales correctly, and an arm touching 1x would pass on
  // either. 1.20 -> 2.35 is the pair from the report.
  //
  // One row per marker kind rather than one boolean over all of them, because a
  // cumulative assertion says something broke and not which term - `docs/instruments.md`
  // has that as its own rule after step 6 measured three grade terms down one row. The
  // mark is the odd one and belongs here for it: it is stored in source milliseconds and drawn
  // through the curve, so it must hold still *without* being rescaled, which is what
  // separates "every term was carried" from "the ruler never moved at all".
  const STRIP = () => {
    // Every read goes through a guard, including the two shades - and that is not
    // tidiness. `lanes-clear-siblings` empties `#tBeds` of everything that is not the
    // ruler or the playhead, which takes the shades with the markers, so an unguarded
    // `.style` here throws inside a `page.evaluate` two sections after the mutation has
    // already been caught. The run then exits 2 as DID NOT RUN with its eight correct
    // red rows discarded, which reads as a mutation nobody tested rather than one that
    // was caught. Measured: this branch exits 2 at 46 assertions where `origin/main`
    // exits 1 at 86, on the same mutation.
    const left = (sel) => { const el = document.querySelector(sel); return el ? el.style.left : null; };
    const box = (sel) => {
      const el = document.querySelector(sel);
      return el ? `${el.style.left}+${el.style.width}` : null;
    };
    return {
      playhead: left('#tPlayhead'),
      tIn: left('#tIn'),
      tOut: left('#tOut'),
      shadeIn: box('#tShadeIn'),
      shadeOut: box('#tShadeOut'),
      keys: [...document.querySelectorAll('.tlane[data-owner=bloom] .tkey')].map((k) => k.style.left).join(' '),
      marks: [...document.querySelectorAll('#tMarks .tmk')].map((m) => m.style.left).join(' '),
      // What proves the sameness above was carried rather than merely undisturbed.
      keyTimes: (__kinect.keyframes.project().look.tracks.bloom ?? []).map((k) => k.t.toFixed(4)).join(' '),
      // The camera track, read separately because it is serialised separately - it
      // lives under `composition` rather than under `look.tracks`, and a rescale that
      // walked only the look tracks would pass every row above while sliding the whole
      // camera move against the footage. One track kind cannot carry a claim about all
      // of them.
      cameraTimes: (__kinect.keyframes.project().composition.camera ?? []).map((k) => k.t.toFixed(4)).join(' '),
      clip: __kinect.editor.clipRange(),
      duration: __kinect.timeline.transport().duration,
    };
  };
  const strip = () => page.evaluate(`(${STRIP})()`);

  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await page.evaluate(`__kinect.keyframes.setTracks({ bloom: [ { t: 2, value: 0.2 }, { t: 6, value: 0.9 } ] })`);
  // A camera key as well as a look key, because the two are serialised down different
  // branches and a rescale could plausibly walk one list and not the other.
  await page.evaluate(`(() => {
    __kinect.timeline.transport().pause();
    __kinect.setViewCamera(__kinect.viewCamera());
    __kinect.keyframes.toggle('camera');
  })()`);
  await page.evaluate(`__kinect.editor.setMarks([{ id: 'm1', sourceMs: 3000, label: 'probe' }])`);
  await settle();
  await page.evaluate(`__kinect.timeline.transport().seek(1.5)`);
  await settle();
  await page.locator('#tSetIn').click();
  await page.evaluate(`__kinect.timeline.transport().seek(7)`);
  await settle();
  await page.locator('#tSetOut').click();
  await page.evaluate(`__kinect.timeline.transport().seek(4)`);
  await settle();

  await driveRate(1.2);
  const at120 = await strip();
  await driveRate(2.35);
  const at235 = await strip();
  // Read after the second rate change rather than before it. The slider's `change`
  // commits, so a depth taken before it is a level short and the row reads 9 -> 9 on a
  // pop that worked perfectly - a red row about the check's own bookkeeping rather than
  // about undo.
  const undoBefore = await page.evaluate('__kinect.keyframes.undo.depth()');

  check(at235.duration < at120.duration - 1e-6,
    'the ruler really did rescale from 1.20x to 2.35x, or none of the rows below mean anything',
    `${at120.duration.toFixed(3)}s -> ${at235.duration.toFixed(3)}s`);
  for (const [term, label] of [
    ['tIn', 'the in cut holds its place on the ruler'],
    ['tOut', 'the out cut holds its place on the ruler'],
    ['shadeIn', 'and the shading before it does'],
    ['shadeOut', 'and the shading after it does'],
    ['keys', 'every keyframe holds its place on the ruler'],
    ['marks', "the take's marks hold theirs, without being rescaled to do it"],
  ]) {
    check(at120[term] === at235[term], `  ${label}`, `${at120[term]} -> ${at235[term]}`);
  }
  check(near(parseFloat(at235.playhead), parseFloat(at120.playhead), 0.05),
    '  and so does the playhead', `${at120.playhead} -> ${at235.playhead}`);
  // The other direction. Holding still because nothing was carried is the failure this
  // separates out: at 1.20 -> 2.35 the times must fall by 1.20/2.35, and a build that
  // left them alone would hold the numbers and move every marker.
  check(at120.keyTimes !== at235.keyTimes && at120.clip.in !== at235.clip.in,
    '  by rescaling the times underneath, which is what proves it carried them',
    `keys ${at120.keyTimes} -> ${at235.keyTimes}, in ${at120.clip.in.toFixed(4)} -> ${at235.clip.in.toFixed(4)}`);
  check(at120.cameraTimes !== '' && at120.cameraTimes !== at235.cameraTimes,
    '  including the camera track, which is serialised down a different branch',
    `camera ${at120.cameraTimes} -> ${at235.cameraTimes}`);
  const k = 1.2 / 2.35;
  check(near(at235.clip.in, at120.clip.in * k, 1e-6) && near(at235.clip.out, at120.clip.out * k, 1e-6),
    '  by exactly the ratio of the two rates, which is what keeps the export on the same footage',
    `in ${at120.clip.in.toFixed(4)} -> ${at235.clip.in.toFixed(4)}, wanted ${(at120.clip.in * k).toFixed(4)}`);

  // Undo across a speed change. `clipIn`/`clipOut` are deliverable state and
  // deliberately outside the snapshot, so the keys come back from the document and the
  // cuts have to be carried by the same map the gesture used - otherwise undo restores
  // half the strip and leaves the markers where the new rate put them.
  await page.evaluate(`__kinect.keyframes.undo.pop()`);
  await settle();
  const undone = await strip();
  const undoAfter = await page.evaluate('__kinect.keyframes.undo.depth()');
  check(undoAfter < undoBefore,
    '  undo actually popped a level, so the rows below are about a restore',
    `depth ${undoBefore} -> ${undoAfter}`);
  check(near(undone.duration, at120.duration, 1e-6),
    '  undoing a speed change puts the ruler back', `${undone.duration.toFixed(3)}s against ${at120.duration.toFixed(3)}s`);
  check(undone.tIn === at120.tIn && undone.tOut === at120.tOut,
    '  and puts the cuts back with it, which the snapshot alone cannot do',
    `in ${at120.tIn} -> ${undone.tIn}, out ${at120.tOut} -> ${undone.tOut}`);
  check(undone.keys === at120.keys, '  and the keys', `${at120.keys} -> ${undone.keys}`);

  // The detent at 1.00x, which is the one rate that has to be reachable *exactly*
  // rather than approximately: `slopeAt` reports it to the audio gate, and a take
  // playing at 0.9995 is a take the gate reads as retimed. A logarithmic grid has no
  // reason to land on 1 at all, so a band around it snaps.
  //
  // Both sides, because a band that snapped everything would pass the first row alone
  // and quietly make every nearby rate unreachable - the same shape as a probe standing
  // in a dead zone. The offsets are in slider travel: 0.005 is inside the band and 0.05
  // is a tenth of the whole control away from it.
  const atSlider = async (offset) => {
    await page.evaluate(`(() => {
      const el = document.getElementById('tRate');
      el.value = String(__kinect.editor.rateSlider.toValue(1) + ${offset});
      el.dispatchEvent(new Event('input'));
      el.dispatchEvent(new Event('change'));
    })()`);
    await settle();
    return page.evaluate('__kinect.timeline.retime.rate');
  };
  const inBand = await atSlider(0.005);
  check(inBand === 1, 'a slider position just off 1.00x snaps to exactly 1, not to 0.99-something',
    `landed at ${inBand}`);
  const outOfBand = await atSlider(0.05);
  check(outOfBand !== 1 && outOfBand > 1,
    '  and a position clear of the detent is left alone, so the band is a detent and not a floor',
    `landed at ${outOfBand}`);

  // **And a detent is for a value you are aiming at, not one you already had.** A project
  // can carry 1.02x - `restoreProject` takes any positive finite rate - and the thumb is
  // placed there correctly. The first small input in the same neighbourhood then came
  // through the band and returned exactly 1.00: two percent off every cut and every key
  // and a different rendered file, before the pointer had meaningfully moved.
  //
  // Driven as a gesture rather than through `driveRate`, because the rule is about a
  // gesture that *begins* inside the band, and `driveRate`'s `change` ends one per event.
  const nudged = await page.evaluate(`(async () => {
    __kinect.keyframes.setRetime({ rate: 1.02, keys: [] });
    await __kinect.timeline.settled();
    const el = document.getElementById('tRate');
    const loaded = { rate: __kinect.timeline.retime.rate, value: Number(el.value) };
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    el.value = String(loaded.value + 0.001);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await __kinect.timeline.settled();
    const nudge = __kinect.timeline.retime.rate;
    // Out of the band and back in, which is a gesture that aimed at 1.00x rather than one
    // that started next to it - the snap has to still happen there or the band is gone.
    el.value = String(__kinect.editor.rateSlider.toValue(1.5));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await __kinect.timeline.settled();
    const away = __kinect.timeline.retime.rate;
    el.value = String(__kinect.editor.rateSlider.toValue(1.005));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await __kinect.timeline.settled();
    const returned = __kinect.timeline.retime.rate;
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    el.blur();
    await __kinect.timeline.settled();
    return { loaded: loaded.rate, nudge, away, returned };
  })()`);
  check(near(nudged.loaded, 1.02, 1e-9),
    'a project carrying 1.02x loads at 1.02x, which is a rate no slider could have made',
    `${nudged.loaded}x`);
  check(nudged.nudge !== 1 && Math.abs(nudged.nudge - 1.02) < 0.02,
    '  and a small nudge beside it moves it a little rather than snapping two percent to 1.00x',
    `${nudged.loaded}x -> ${nudged.nudge}x`);
  check(near(nudged.away, 1.5, 1e-3),
    '  the same gesture can still leave the band', `${nudged.away}x`);
  check(nudged.returned === 1,
    '  and coming back into it from outside still snaps, which is what the band is for',
    `landed at ${nudged.returned}x`);
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await settle();

  // The seek storm. A slider drag is dozens of `input` events and one `change`, and
  // each accurate seek renders a whole pre-roll before it can show anything. The sweep
  // below is arbitrary travel - only the seek count is under test - but it does cross
  // the 1.00x detent, which is worth knowing if this row ever goes red for a reason
  // that has nothing to do with seeking.
  await page.evaluate('__kinect.timeline.counters.seeks = 0');
  await page.evaluate(`(() => {
    const el = document.getElementById('tRate');
    for (let i = 0; i < 20; i++) { el.value = String(0.4 + i * 0.02); el.dispatchEvent(new Event('input')); }
    el.dispatchEvent(new Event('change'));
  })()`);
  await settle();
  const seeks = await page.evaluate('__kinect.timeline.counters.seeks');
  check(seeks <= 2, 'twenty slider steps cost one accurate seek, not twenty', `${seeks} seeks`);

  // And the same discipline on a lane drag, read off the counters rather than timed -
  // a stopwatch here would pass on a fast machine that rebuilt every move.
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await page.evaluate(`__kinect.keyframes.setTracks({ bloom: [
    { t: 1, value: 0.2 }, { t: 5, value: 0.9 }, { t: 9, value: 0.3 } ] })`);
  await settle();
  const beforeCounters = await page.evaluate('({ ...__kinect.timeline.counters })');
  const kb = await page.locator('.tlane[data-owner=bloom] .tkey').nth(1).boundingBox();
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(kb.x + kb.width / 2 + i * 4, kb.y + kb.height / 2);
  await page.mouse.up();
  await settle();
  const afterCounters = await page.evaluate('({ ...__kinect.timeline.counters })');
  const moved = afterCounters.laneRepositions - beforeCounters.laneRepositions;
  const fellBack = afterCounters.laneFallbacks - beforeCounters.laneFallbacks;
  check(moved >= 8, 'a ten-move key drag takes the cheap path on every move', `${moved} repositions`);
  check(fellBack === 0, 'and never falls back to a rebuild, which is what resized the drawing buffer',
    `${fellBack} fallbacks`);

  // **A gesture lasts as long as a finger or a key is down, which is long enough for a
  // load started before it to land in the middle of it.** The gesture pauses the
  // transport and captures the document it began in; `loadProjectNamed` and
  // `history.undo` both take the transport and put a *different* document underneath
  // it. A release that read `transportGen` fresh read the taker's generation, found it
  // equal to itself, and passed a check written to catch exactly this - rewriting every
  // key and both cuts of the new document from a snapshot of the old one, and resuming
  // a take the taker had deliberately paused.
  //
  // Driven through undo rather than through a project load because undo takes the
  // transport by the same call and needs no file on disk. The gesture is driven
  // keydown/input/keyup rather than through `driveRate`, because `change` is what
  // `driveRate` ends on and a `change` fires before anything can interrupt - the whole
  // failure lives in the window between the first `input` and the release.
  //
  // Two arms, and the uninterrupted one is what stops this being a row that passes on a
  // build whose release does nothing at all.
  // The take is running when each gesture starts, because the resume is the other half
  // of the finding and it lives on `wasPlaying`. Undo reads a transport this gesture has
  // already paused, so it does not restart it - which makes "playing after the release"
  // a clean read of whether the release resumed something it no longer owned.
  // Everything the release could write, read in one go and compared side by side either
  // side of it - because which term a stale write lands on is not obvious from reading
  // the code and turned out not to be the one this row first asserted on. `retime.rate`
  // cannot see it: the restore puts the *control* back too, so the release re-applies
  // the rate the document already has, and `t * (began / rate)` off a snapshot taken at
  // `began` is exactly `t` again - a no-op by arithmetic rather than by the fix. What
  // does move is the stack, because a release that thinks it changed something commits.
  // `keyTimes` is the one term below that can tell a gesture rescaling the document that
  // is open from one rescaling a snapshot of the document that was. Everything else here
  // is rate-covariant and cannot: `t * (began / rate)` off a snapshot taken at `began` is
  // exactly `t` again, so a stale rescale of the *same* document is a no-op by arithmetic
  // and rate, cuts and undo depth all agree either way - measured, after the first
  // version of these rows came back green on a mutated build for that reason. What does
  // not survive is a takeover that *replaces* the key objects, which undo does by
  // deserialising new ones: the stale snapshot then holds references to orphans and
  // writes into nothing while the ruler rescales under the live keys.
  //
  // Written out here rather than beside the field, because a backtick inside a template
  // literal ends it - a comment carrying prose about `rate` closed this expression and
  // the file stopped parsing.
  const snap = () => page.evaluate(`(() => ({
    rate: __kinect.timeline.retime.rate,
    depth: __kinect.keyframes.undo.depth(),
    lanes: JSON.stringify(__kinect.keyframes.lanes()),
    range: JSON.stringify(__kinect.editor.clipRange()),
    keyTimes: (__kinect.keyframes.project().look.tracks.bloom ?? []).map((k) => k.t.toFixed(3)).join(' '),
  }))()`);

  const heldGesture = async ({ interrupt }) => {
    await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
    await page.evaluate(`__kinect.keyframes.setTracks({ bloom: [{ t: 2, value: 0.2 }, { t: 6, value: 0.9 }] })`);
    await settle();
    // A committed baseline at 1x, so what the undo below restores is stated here rather
    // than inherited from whatever the section left on the stack.
    await page.evaluate('__kinect.keyframes.undo.commit()');
    await driveRate(2);
    const committed = await page.evaluate('__kinect.timeline.retime.rate');
    await page.evaluate('__kinect.timeline.transport().play()');
    await new Promise((r) => setTimeout(r, 250));
    const wasPlaying = await page.evaluate('__kinect.timeline.transport().playing');
    await page.evaluate(`(() => {
      const el = document.getElementById('tRate');
      el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      el.value = String(__kinect.editor.rateSlider.toValue(0.5));
      el.dispatchEvent(new Event('input'));
    })()`);
    await settle();
    const held = await page.evaluate('__kinect.timeline.retime.rate');
    if (interrupt) {
      await page.evaluate('__kinect.keyframes.undo.pop()');
      await settle();
    }
    const afterInterrupt = await page.evaluate('__kinect.timeline.retime.rate');
    const before = await snap();
    // One more slider event after the takeover, which is the half the release guard
    // never covered: `applyRate` runs per `input` and had nothing to check. The rate is
    // deliberately a third value, so what lands can be told apart from both the rate the
    // gesture began in and the rate the undo restored.
    if (interrupt === 'then-more-input') {
      await page.evaluate(`(() => {
        const el = document.getElementById('tRate');
        el.value = String(__kinect.editor.rateSlider.toValue(0.8));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await settle();
    }
    await page.evaluate(`document.getElementById('tRate')
      .dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))`);
    await settle();
    // The resume rides a seek's pre-roll, so it arrives some frames after the release.
    // Polled rather than read once, and the poll runs on both arms so neither is given a
    // different amount of time to be wrong in. Six seconds rather than two, because the
    // seek is not always the cheap one.
    //
    // Six is not enough for `rate-holds-cuts` and that was measured rather than waited
    // out: with the cuts left unrescaled the playhead ends up outside the range the
    // release seeks into, and the take does not come back at all. So this row reddens on
    // that mutation as well as on its own, which is recorded here rather than tuned away
    // - a take that will not resume after a speed change is a true thing to say about
    // that build, and the eleventh red row beside its ten is the shape of a consequence
    // rather than of a second bug.
    for (let i = 0; i < 60 && !(await page.evaluate('__kinect.timeline.transport().playing')); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const out = {
      committed, wasPlaying, held, afterInterrupt, before,
      after: await snap(),
      playing: await page.evaluate('__kinect.timeline.transport().playing'),
    };
    await page.evaluate('__kinect.timeline.transport().pause()');
    await settle();
    return out;
  };

  const uninterrupted = await heldGesture({ interrupt: false });
  check(uninterrupted.wasPlaying && uninterrupted.held === 0.5 && uninterrupted.after.rate === 0.5,
    'a speed gesture held over a key press and released applies the rate it was left at',
    `committed ${uninterrupted.committed}x, held ${uninterrupted.held}x, released ${uninterrupted.after.rate}x`);
  check(uninterrupted.playing,
    '  and puts a take that was running back, which is what the interrupted arm below must not do',
    `playing ${uninterrupted.playing}`);

  // Undo pops the *previous* committed state, which is the 1x baseline above rather
  // than the 2x the gesture began in - so the number this asserts is 1, and it differs
  // from both the 2 the gesture began in and the 0.5 the slider is left holding, which
  // is what makes the two rows below able to see a release that acted.
  const interrupted = await heldGesture({ interrupt: true });
  check(interrupted.afterInterrupt === 1,
    '  and an undo arriving mid-gesture puts the document back, which is the state under test',
    `began ${interrupted.committed}x, held ${interrupted.held}x, undo restored ${interrupted.afterInterrupt}x`);
  const wrote = Object.keys(interrupted.before)
    .filter((k) => interrupted.before[k] !== interrupted.after[k]);
  check(wrote.length === 0,
    '  so the release writes nothing over the document that took the transport',
    wrote.length
      ? wrote.map((k) => `${k} ${interrupted.before[k]} -> ${interrupted.after[k]}`).join(', ')
      : `rate ${interrupted.after.rate}x, undo depth ${interrupted.after.depth}, cuts and lanes unmoved`);
  check(interrupted.playing === false,
    '  and does not resume a take the thing that took the transport had paused',
    `playing ${interrupted.playing}`);

  // And the other half of the same door: a slider event arriving *after* the takeover.
  // Guarding the release alone left this open, because `applyRate` runs per `input` and
  // had nothing to check - so the event rescaled a snapshot of a document that was no
  // longer open. The gesture is dropped at `takeTransport` now, so this event simply
  // starts a fresh one on the document that is, and the keys move because they are the
  // keys it is holding.
  const continued = await heldGesture({ interrupt: 'then-more-input' });
  check(continued.after.rate === 0.8,
    '  a slider event after the takeover still moves the speed, rather than going dead',
    `undo left ${continued.afterInterrupt}x, the event left ${continued.after.rate}x`);
  const wantTimes = continued.before.keyTimes.split(' ')
    .map((t) => (Number(t) * (continued.afterInterrupt / 0.8)).toFixed(3)).join(' ');
  check(continued.after.keyTimes === wantTimes,
    '  and rescales the keys the open document has, not the ones the old snapshot held',
    `${continued.before.keyTimes} -> ${continued.after.keyTimes}, wanted ${wantTimes}`);

  // Put the document, the stack, the transport and the focus back, so section 5 does not
  // plant its keys into a clip this block left at half speed with a take running under
  // it. The focus is the one that bit: the gesture has to be begun on the control the
  // way a keyboard user begins it, and leaving it there left `#tRate` focused - an
  // `INPUT`, which the window handler's typing guard skips - so section 5's Delete
  // press reached nothing and its row read as a missing feature.
  await focusStage();
  await page.evaluate('__kinect.timeline.transport().pause()');
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await page.evaluate('__kinect.keyframes.setTracks({})');
  await page.evaluate('__kinect.keyframes.undo.begin()');
  await page.evaluate('__kinect.timeline.transport().seek(0)');
  await settle();

  // =====================================================================
  console.log('\n[5] keys can be removed, and ease can be shaped');
  // =====================================================================
  const plant = async (spec) => {
    await page.evaluate(`__kinect.keyframes.setTracks(${JSON.stringify(spec)})`);
    await settle();
  };
  const clickKey = async (owner, i) => {
    const b = await page.locator(`.tlane[data-owner=${owner}] .tkey`).nth(i).boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await new Promise((r) => setTimeout(r, 200));
    return b;
  };

  await plant({ bloom: [{ t: 1, value: 0.2 }, { t: 5, value: 0.9 }, { t: 9, value: 0.3 }] });
  await clickKey('bloom', 1);
  check(Boolean(await page.evaluate('__kinect.editor.selection()')), 'clicking a key selects it');
  await page.keyboard.press('Delete');
  await settle();
  check(await keyCount('bloom') === 2, 'Delete removes the selected key', `${await keyCount('bloom')} keys left`);

  await plant({ bloom: [{ t: 1, value: 0.2 }, { t: 5, value: 0.9 }, { t: 9, value: 0.3 }] });
  await clickKey('bloom', 1);
  await page.locator('#tDeleteKey').click();
  await settle();
  check(await keyCount('bloom') === 2, 'and so does the delete button, for anybody without a keyboard',
    `${await keyCount('bloom')} keys left`);

  // Two clicks inside the double-click window rather than `page.mouse.dblclick`, and
  // the distinction is load-bearing. The first click rebuilds the lane, so the second
  // lands on a different element and the browser dispatches `dblclick` at their common
  // ancestor - which is why this gesture is tracked by key identity in `pointerdown`
  // rather than by a `dblclick` listener.
  await plant({ bloom: [{ t: 1, value: 0.2 }, { t: 5, value: 0.9 }, { t: 9, value: 0.3 }] });
  const dbl = await page.locator('.tlane[data-owner=bloom] .tkey').nth(1).boundingBox();
  await page.mouse.click(dbl.x + dbl.width / 2, dbl.y + dbl.height / 2);
  await page.mouse.click(dbl.x + dbl.width / 2, dbl.y + dbl.height / 2);
  await settle();
  check(await keyCount('bloom') === 2, 'and a double click on a key removes it', `${await keyCount('bloom')} keys left`);

  // The retime origin. A delete gesture is what made this reachable, so the rule that
  // protects it is asserted from the gesture rather than from the function.
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [
    { t: 0, value: 0 }, { t: 10, value: 8 }, { t: 20, value: 20 } ] })`);
  await settle();
  await page.evaluate(`__kinect.editor.select('retime', 0)`);
  await settle();
  await page.keyboard.press('Delete');
  await settle();
  const retimeKeys = () => page.evaluate('__kinect.timeline.retime.keys.length');
  check(await retimeKeys() === 3, 'the retime origin will not delete while keys follow it',
    `${await retimeKeys()} keys, note "${(await text('#tNote')).trim().slice(0, 60)}"`);
  check((await text('#tNote')).trim().length > 10, 'and it says why rather than doing nothing quietly');
  await page.evaluate(`__kinect.editor.select('retime', 2)`);
  await page.keyboard.press('Delete');
  await settle();
  await page.evaluate(`__kinect.editor.select('retime', 1)`);
  await page.keyboard.press('Delete');
  await settle();
  check(await retimeKeys() === 0, 'and the curve empties once the last one after it has gone',
    `${await retimeKeys()} keys`);

  // Ease presets, each pressed and each read back. Five rows rather than one, because
  // a cumulative row cannot say which preset stopped writing.
  const EXPECTED = {
    linear: { out: [1 / 3, 1 / 3], in: [2 / 3, 2 / 3] },
    in: { in: [0.58, 1] },
    out: { out: [0.42, 0] },
    smooth: { out: [0.42, 0], in: [0.58, 1] },
    hold: { out: [1, 0], nextIn: [1, 0] },
  };
  const presetNames = await page.evaluate('__kinect.editor.easePresets()');
  check(presetNames.length === Object.keys(EXPECTED).length,
    'the preset row offers exactly the presets this file knows', presetNames.join(', '));
  for (const name of presetNames) {
    // Every key starts bent, and `linear` is why. A key created plain already carries
    // the linear handles, so pressing `linear` on it agrees with a build that writes
    // nothing at all - the row would be green against a preset row that had been
    // disconnected. Measured: `--mutate ease-preset-ignored` fired four of the five
    // preset rows and left this one passing. Starting from a shape none of the five
    // produces gives every preset something to undo.
    await plant({
      bloom: [
        { t: 1, value: 0.2, easeOut: [0.9, 0.1], easeIn: [0.1, 0.9] },
        { t: 5, value: 0.9, easeOut: [0.9, 0.1], easeIn: [0.1, 0.9] },
        { t: 9, value: 0.3, easeOut: [0.9, 0.1], easeIn: [0.1, 0.9] },
      ],
    });
    await page.evaluate(`__kinect.editor.select('bloom', 1)`);
    await settle();
    await page.locator(`#tEase button[data-ease=${name}]`).click();
    await settle();
    const got = await page.evaluate(`__kinect.editor.easeOf('bloom', 1)`);
    const next = await page.evaluate(`__kinect.editor.easeOf('bloom', 2)`);
    const want = EXPECTED[name];
    const okOut = !want.out || (near(got.easeOut[0], want.out[0], 1e-9) && near(got.easeOut[1], want.out[1], 1e-9));
    const okIn = !want.in || (near(got.easeIn[0], want.in[0], 1e-9) && near(got.easeIn[1], want.in[1], 1e-9));
    const okNext = !want.nextIn || (near(next.easeIn[0], want.nextIn[0], 1e-9) && near(next.easeIn[1], want.nextIn[1], 1e-9));
    check(okOut && okIn && okNext, `the "${name}" preset writes the handles it names`,
      `out ${JSON.stringify(got.easeOut)} in ${JSON.stringify(got.easeIn)}`
      + (want.nextIn ? ` next-in ${JSON.stringify(next.easeIn)}` : ''));
  }

  // The flat-segment rule. A segment whose two keys hold the same value renders the
  // same value whatever its handles say - so a handle there is a control that moves
  // and changes nothing, which is worse than an absent one.
  await plant({ bloom: [{ t: 1, value: 0.5 }, { t: 5, value: 0.5 }, { t: 9, value: 0.9 }] });
  await page.evaluate(`__kinect.editor.select('bloom', 0)`);
  await settle();
  const flatHandles = await page.locator('.tlane[data-owner=bloom] .thandle').count();
  check(flatHandles === 0, 'a key whose only segment is flat gets no ease handle at all',
    `${flatHandles} handles`);
  await page.evaluate(`__kinect.editor.select('bloom', 1)`);
  await settle();
  const mixedHandles = await page.locator('.tlane[data-owner=bloom] .thandle').count();
  check(mixedHandles === 1, 'and a key between a flat and a shaped segment gets exactly the shaped one',
    `${mixedHandles} handles`);
  check(await page.evaluate(`document.querySelector('#tEase button[data-ease=linear]').disabled`) === false,
    'the preset row is live for that key, because one of its sides can be shaped');
  await page.evaluate(`__kinect.editor.select('bloom', 0)`);
  await settle();
  check(await page.evaluate(`document.querySelector('#tEase button[data-ease=linear]').disabled`) === true,
    'and goes dead for the key that has nothing to shape, rather than writing into nothing');

  // And a handle that does exist still moves the curve.
  await plant({ bloom: [{ t: 1, value: 0.2 }, { t: 5, value: 0.9 }, { t: 9, value: 0.3 }] });
  await page.evaluate(`__kinect.editor.select('bloom', 1)`);
  await settle();
  // **The first handle drawn on a key is its `easeOut`**, which shapes the segment
  // *after* it - `drawLane` walks `['easeOut', 'easeIn']` in that order. So the curve
  // is sampled at 7s, inside 5s..9s, and not at 3s. Sampling at 3s is what this row
  // did first and it failed against a working build: the handle had moved, the curve
  // it shapes had moved, and the probe was sitting in the neighbouring segment where
  // the answer is the same either way. That is `docs/instruments.md`'s "place a probe
  // where its answer would be different" arriving one more time.
  //
  // Both samples are kept, which makes the row say more than it used to: the handle
  // shapes its own segment *and leaves its neighbour alone*, which is two claims a
  // single sample cannot separate.
  const hb = await page.locator('.tlane[data-owner=bloom] .thandle').first().boundingBox();
  check(hb.width >= 10 && hb.height >= 10, 'an ease handle is big enough to hit', `${hb.width}x${hb.height}px`);
  const easeBefore = await page.evaluate(`__kinect.editor.easeOf('bloom', 1)`);
  const ownBefore = await page.evaluate(`__kinect.keyframes.valueAt('bloom', 7)`);
  const neighbourBefore = await page.evaluate(`__kinect.keyframes.valueAt('bloom', 3)`);
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 - 40, hb.y + hb.height / 2 - 20, { steps: 5 });
  await page.mouse.up();
  await settle();
  const easeAfter = await page.evaluate(`__kinect.editor.easeOf('bloom', 1)`);
  const ownAfter = await page.evaluate(`__kinect.keyframes.valueAt('bloom', 7)`);
  const neighbourAfter = await page.evaluate(`__kinect.keyframes.valueAt('bloom', 3)`);
  check(JSON.stringify(easeBefore.easeOut) !== JSON.stringify(easeAfter.easeOut), 'dragging it rewrites the handle',
    `easeOut ${JSON.stringify(easeBefore.easeOut)} -> ${JSON.stringify(easeAfter.easeOut)}`);
  check(Math.abs(ownAfter - ownBefore) > 1e-4,
    'and the value inside the segment it shapes follows, which is the only thing a handle is for',
    `${ownBefore.toFixed(4)} -> ${ownAfter.toFixed(4)} at 7s`);
  check(Math.abs(neighbourAfter - neighbourBefore) < 1e-9,
    '  and the segment on the other side of the key does not move',
    `${neighbourBefore.toFixed(4)} -> ${neighbourAfter.toFixed(4)} at 3s`);

  // =====================================================================
  console.log('\n[6] the strip stays a fixed height and the render button stays reachable');
  // =====================================================================
  // A long option in every select the *scroller* holds, which is the realistic stress
  // and the one the product can actually produce: a deliverable, a project and a look
  // are all user-named. The export size select is deliberately left alone - its
  // options come from `EXPORT_SIZES` and are all of the form 1920x1080, so planting a
  // long one there would be measuring a string this build cannot make. That is the
  // "compare the constants a tool sweeps against the constants the UI offers" rule
  // pointed at option text, and it caught this row inventing a scenario: with a long
  // option forced into the pinned select, the *unmutated* build failed at 1100px.
  //
  // Appended rather than substituted, so the selected values are untouched and
  // section 7 still renders at the size it chose.
  const LONG_OPTION = 'client-cut-2026-08-02-final-v3-graded-for-delivery';
  await page.evaluate(`(${((label) => {
    globalThis.__planted = [];
    for (const sel of document.querySelectorAll('.tbar .tchips select')) {
      const opt = new Option(label, '__planted__');
      sel.appendChild(opt);
      globalThis.__planted.push(opt);
    }
    return globalThis.__planted.length;
  }).toString()})(${JSON.stringify(LONG_OPTION)})`);
  note('a long option planted in every select the scroller holds',
    `${await page.evaluate('globalThis.__planted.length')} selects`);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: VIEWPORT.height });
    await new Promise((r) => setTimeout(r, 250));
    const geom = await page.evaluate(`(() => {
      const btn = document.getElementById('tExport').getBoundingClientRect();
      const hit = document.elementFromPoint((btn.left + btn.right) / 2, (btn.top + btn.bottom) / 2);
      const strip = document.getElementById('timeline');
      // Read off the strip, not off the root element. --timeline-h is declared on
      // the root and --tlanes-h is written by rebuildLanes onto the strip itself, so
      // asking the root for the second answers 0 - which made this row compare a real
      // 183px strip against a declared 148 and fail against a correct build.
      const css = getComputedStyle(strip);
      const px = (name) => parseFloat(css.getPropertyValue(name));
      return {
        hit: hit ? (hit.id || hit.tagName) : 'nothing',
        right: btn.right,
        stripH: Math.round(strip.getBoundingClientRect().height),
        declared: Math.round(px('--timeline-h') + px('--tlanes-h')),
        wrapped: [...document.querySelectorAll('.tbar')].map((b) => b.scrollHeight > b.clientHeight + 1),
      };
    })()`);
    check(geom.hit === 'tExport', `the render button is what the pointer finds at ${width}px`,
      `hits "${geom.hit}", right edge at ${geom.right.toFixed(0)} of ${width}`);
    check(geom.stripH === geom.declared,
      `  and the strip is exactly the height the stage was sized against at ${width}px`,
      `${geom.stripH}px measured, ${geom.declared}px declared`);
    check(!geom.wrapped.some(Boolean),
      `  and neither bar row wrapped at ${width}px, which is what would push the lanes out of it`,
      geom.wrapped.map((w, i) => `row ${i + 1} ${w ? 'WRAPPED' : 'ok'}`).join(', '));
  }
  await page.evaluate('globalThis.__planted.forEach((o) => o.remove())');
  await page.setViewportSize(VIEWPORT);
  await new Promise((r) => setTimeout(r, 250));

  // =====================================================================
  console.log('\n[7] the export is named, and a copy of it can be saved');
  // =====================================================================
  //
  // The field is written through the element rather than through `fill`, deliberately.
  // `--mutate pin-min-width-auto` pushes the pinned chips off the right edge, and a
  // Playwright click that had to scroll to reach the field would fail there - which
  // would redden a naming row for a layout reason. Layout is section 6's claim; this
  // section is about what the name does.
  const setName = async (value) => page.evaluate(`(${((v) => {
    const el = document.getElementById('tExportName');
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }).toString()})(${JSON.stringify(value)})`);

  await setName('rooftop-wide-v3');
  await new Promise((r) => setTimeout(r, 150));
  check((await page.evaluate('__kinect.editor.exportName()')).base === 'rooftop-wide-v3',
    'a name typed into the field is the name the export will use',
    (await page.evaluate('__kinect.editor.exportName()')).base);
  check(await page.evaluate(`document.getElementById('tExport').disabled`) === false,
    '  and a legal name leaves the render button live');

  await setName('../etc/passwd');
  await new Promise((r) => setTimeout(r, 150));
  check(await page.evaluate(`document.getElementById('tExport').disabled`) === true,
    'a name shaped like a path refuses to render',
    'the regex is mirrored from server/export.js, which is the copy that is enforced');
  check(await page.evaluate(`document.getElementById('tExportNameChip').classList.contains('bad')`),
    '  and says so on the field rather than only when the server rejects it');

  await setName('');
  await new Promise((r) => setTimeout(r, 150));
  check((await page.evaluate('__kinect.editor.exportName()')).base === TAKE,
    'an empty field falls back to the take id, which is what it did before there was a field',
    (await page.evaluate('__kinect.editor.exportName()')).base);

  if (NO_RENDER) {
    note('the real export was skipped', '--no-render: the naming rows above are all that ran here');
  } else {
    // A real render, at the smallest size the menu offers and a range of a few frames,
    // then the file compared byte for byte against what came through the picker. A row
    // that asserted the button existed would pass on a build that saved nothing.
    const sizes = await page.evaluate('__kinect.exportSizes()');
    const smallest = sizes.slice().sort((a, b) => (a.w * a.h) - (b.w * b.h))[0];
    await page.evaluate(`__kinect.setTargetSize(${JSON.stringify(`${smallest.w}x${smallest.h}`)})`);
    await settle();
    await page.evaluate('__kinect.timeline.transport().seek(0)');
    await settle();
    await page.locator('#tSetIn').click();
    await page.evaluate('__kinect.timeline.transport().seek(0.2)');
    await settle();
    await page.locator('#tSetOut').click();
    await settle();
    await setName('editor-check-copy');
    await new Promise((r) => setTimeout(r, 150));
    note(`rendering ${smallest.w}x${smallest.h}`, `range ${JSON.stringify(await range())}`);

    await page.locator('#tExport').click();
    await page.waitForFunction('!!globalThis.__kinect.editor.lastExport()', null, { timeout: 180000 });
    const last = await page.evaluate('__kinect.editor.lastExport()');
    check(last.file.startsWith('editor-check-copy'),
      'the file the render produced carries the name that was typed', last.file);

    const res = await fetch(`${URL_BASE}${last.href}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const serverHash = createHash('sha256').update(bytes).digest('hex');
    check(res.ok && bytes.length > 0, 'and the server serves it back at the href it reported',
      `HTTP ${res.status}, ${bytes.length} bytes`);
    const onDisk = join(REPO, 'exports', last.href.replace('/exports/', ''));
    check(existsSync(onDisk) && statSync(onDisk).size === bytes.length,
      '  and it is on disk under exports/ at that size',
      existsSync(onDisk) ? `${statSync(onDisk).size} bytes` : 'not found');

    await page.locator('#tExportSave').click();
    await page.waitForFunction('globalThis.__saved.closed === true', null, { timeout: 120000 });
    const saved = await page.evaluate(`(async () => {
      const s = globalThis.__saved;
      const total = s.chunks.reduce((n, c) => n + c.byteLength, 0);
      const buf = new Uint8Array(total);
      let at = 0;
      for (const c of s.chunks) { buf.set(c, at); at += c.byteLength; }
      const digest = await crypto.subtle.digest('SHA-256', buf);
      return {
        called: s.called,
        suggestedName: s.suggestedName,
        hadActivation: s.hadActivation,
        length: buf.length,
        sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
      };
    })()`);
    check(saved.called && saved.suggestedName === last.file,
      'the save sheet is opened, and offered the render\'s own filename', saved.suggestedName);
    check(saved.hadActivation === true,
      '  while the click\'s activation was still live, which is why the picker comes before the fetch',
      `navigator.userActivation.isActive was ${saved.hadActivation}`);
    check(saved.sha256 === serverHash && saved.length === bytes.length,
      '  and what went through it is byte-identical to the file on the server',
      `${saved.length} bytes, ${saved.sha256.slice(0, 16)}… against ${bytes.length} bytes, ${serverHash.slice(0, 16)}…`);
  }

  // **A deliverable chosen from the menu replaces the trim, and a speed gesture holds a
  // snapshot of the trim it began in.** The menu's handler awaits a fetch, so a gesture
  // can start inside that window and still be live when the new deliverable lands - and
  // its next slider event then wrote the *previous* deliverable's cuts back through
  // `setClipInOut`, over the trim the user had just selected. The export takes its range
  // from there, so the file would have been the wrong length with nothing on screen
  // saying so.
  //
  // Driven through the real `<select>` and its `change` handler rather than through a
  // hook, because the fetch is where the window is. Two saved deliverables with cuts far
  // apart, so the row can tell which of them the gesture wrote - and they are deleted
  // afterwards through the same route that made them.
  const putDeliverable = (name, body) => page.evaluate(`(async () => {
    const res = await fetch('/deliverables/' + encodeURIComponent(${JSON.stringify(name)}), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(${JSON.stringify(body)}),
    });
    return res.json();
  })()`);

  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await page.evaluate(`__kinect.keyframes.setTracks({ bloom: [{ t: 2, value: 0.2 }, { t: 6, value: 0.9 }] })`);
  await settle();
  const baseDeliverable = await page.evaluate('({ ...__kinect.library.activeDeliverable() })');
  await putDeliverable('editor-check-near', { ...baseDeliverable, name: 'editor-check-near', in: 2, out: 8 });
  await putDeliverable('editor-check-far', { ...baseDeliverable, name: 'editor-check-far', in: 20, out: 40 });
  await page.evaluate('__kinect.editor.refreshDeliverables?.()');
  // What the menu looked like before this block touched it. Restored at the end, because
  // the selected name is drawn in a chip on the two-row bar and a longer one reflows it -
  // which moves section 8's crop sliders under different pointer coordinates and reddens
  // its rows as a rendering change. This file already has that scar once, from the nav
  // probe leaving the panel scrolled, and it is the same failure by a different route.
  const menuBefore = await page.evaluate(`(() => {
    const el = document.getElementById('tDeliverable');
    return { value: el.value, options: [...el.options].map((o) => o.value) };
  })()`);
  // And where the playhead was. `setClipInOut` seeks when the new trim excludes it, so
  // choosing a deliverable at 20s..40s moves it - and section 8 renders its crop rows at
  // the playhead, so a different frame there is a different depth slab and its numbers
  // move. They moved: the near-slab row printed 0.337 before this block existed and 0.123
  // after, on a build whose cropping had not changed at all.
  const playheadBefore = await page.evaluate('__kinect.timeline.transport().programSec');
  const pick = async (name) => {
    await page.evaluate(`(() => {
      const el = document.getElementById('tDeliverable');
      if (![...el.options].some((o) => o.value === ${JSON.stringify(name)})) {
        el.append(new Option(${JSON.stringify(name)}, ${JSON.stringify(name)}));
      }
      el.value = ${JSON.stringify(name)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await settle();
    await new Promise((r) => setTimeout(r, 250));
    return page.evaluate('__kinect.editor.clipRange()');
  };

  const far = await pick('editor-check-far');
  check(near(far.in ?? -1, 20, 1e-6) && near(far.out ?? -1, 40, 1e-6),
    'choosing a deliverable puts its trim on the clip', JSON.stringify(far));
  // The gesture begins here, holding `far`'s cuts, and the near one lands under it.
  await page.evaluate(`(() => {
    const el = document.getElementById('tRate');
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    el.value = String(__kinect.editor.rateSlider.toValue(2));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await settle();
  const heldRate = await page.evaluate('__kinect.timeline.retime.rate');
  const swapped = await pick('editor-check-near');
  // The stored numbers, unscaled: a deliverable's trim is program time and
  // `applyDeliverable` writes it as it stands rather than into the rate the clip happens
  // to be in. Asserted rather than assumed, because the first version of this row divided
  // by the rate and went red against a build doing exactly the right thing.
  check(near(swapped.in ?? -1, 2, 1e-3) && near(swapped.out ?? -1, 8, 1e-3),
    '  even while a speed gesture is held, and as the stored program times rather than rescaled',
    `${JSON.stringify(swapped)} at ${heldRate}x`);
  // One more slider event, which is the door the release guard never covered.
  await page.evaluate(`(() => {
    const el = document.getElementById('tRate');
    el.value = String(__kinect.editor.rateSlider.toValue(1.25));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
  })()`);
  await settle();
  const afterSwap = await page.evaluate('__kinect.editor.clipRange()');
  // A fresh gesture rescales the *near* trim out of the rate the clip is in - 2 and 8
  // times `heldRate / 1.25`. A gesture that survived the swap would rescale the *far*
  // one out of the rate it began in, which is 20 and 40 times `1 / 1.25` - a different
  // number by more than a factor of four, and the far end of the clip rather than the
  // near one.
  const wantIn = 2 * (heldRate / 1.25);
  const wantOut = 8 * (heldRate / 1.25);
  check(near(afterSwap.in ?? -1, wantIn, 1e-3) && near(afterSwap.out ?? -1, wantOut, 1e-3),
    '  and the gesture that continues rescales that trim rather than writing the old one back',
    `${JSON.stringify(afterSwap)}, wanted in ${wantIn.toFixed(4)} out ${wantOut.toFixed(4)}`);

  await focusStage();
  await page.evaluate(`(async () => {
    for (const n of ['editor-check-near', 'editor-check-far']) {
      // The content type is required on every write route, delete included - the origin
      // rule refuses a request that does not declare one, which is a 200 carrying an
      // error rather than a network failure, so a cleanup without it fails silently.
      await fetch('/deliverables/' + n, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      });
    }
  })()`);
  await page.evaluate(`(${((before) => {
    const el = document.getElementById('tDeliverable');
    for (const o of [...el.options]) if (!before.options.includes(o.value)) o.remove();
    el.value = before.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }).toString()})(${JSON.stringify(menuBefore)})`);
  await settle();
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await page.evaluate('__kinect.keyframes.setTracks({})');
  // And the trim, which nothing below resets: leaving it at the near deliverable's range
  // moved section 8's crop numbers, and those rows read as a rendering change rather than
  // as a leftover from up here.
  await page.locator('#tClearRange').click();
  await page.evaluate(`__kinect.timeline.transport().seek(${playheadBefore})`);
  await settle();

  // =====================================================================
  console.log('\n[8] the crop box crops what it says, where it says');
  // =====================================================================
  //
  // Driven from the sensor's own view, so world +x is screen right and world +y is
  // screen up and "did the left face cull the left" is a question a picture can
  // answer. `registry-check` already proves each of these four reaches the pixels;
  // what it cannot say is which side each one takes, or whether the thing they make
  // is a box at all.
  //
  // **The bounding box of what survives is the wrong observable and this file used it
  // first.** A metre crop leaves near-field points at extreme image positions - a
  // point 0.29m left of the axis at 0.5m depth is still near the left edge of the
  // frame - so cropping `left` hard removed 40% of the cloud and moved the leftmost
  // lit pixel by nothing at all. Counts split by half-frame are what carry the
  // direction; the bounding box was a probe standing where the answer is the same
  // either way.
  // **The scene is put back to a plain one first, and that is not tidiness.** The
  // sections above leave an animated `bloom` track behind, and bloom lifts most of the
  // frame over any sensible threshold - so the first run of these rows measured 903477
  // lit pixels against the 194911 the same shot gives with a default look, and the
  // four directional rows came back at losses of 0.0% to 18.3% where the signal is
  // 58% to 81%. Nothing was wrong with the crop; the haze was being counted as cloud.
  // The clip range and the stage shape go back too, and those two are not cosmetic.
  // Section 7's real export sets a 0.2s range and the smallest size the menu offers,
  // and `frameAt` clamps a seek into the clip range - so this section's `seek(12)`
  // landed on frame 6 of a 16:9 stage instead. Measured: the near slab's cut came back
  // at 0.366 against the 0.585 the same arm gives with the range open, and the row went
  // red on a build with nothing wrong with it. `--no-render` skipped section 7 and hid
  // it, which is the worst version of this - a row that passes in the fast mode and
  // fails in the full one.
  await page.locator('#tClearRange').click();
  await page.evaluate('__kinect.setTargetSize("1920x1080")');
  await page.evaluate('__kinect.keyframes.setTracks({})');
  await page.evaluate('__kinect.keyframes.setRetime({ rate: 1, keys: [] })');
  await page.evaluate("__kinect.params.reset(__kinect.params.names('look'))");
  await page.evaluate('__kinect.setMode(0)');
  await page.evaluate('__kinect.sensorView()');
  await page.evaluate('__kinect.keyframes.chrome.set(false)');
  await page.evaluate('__kinect.timeline.transport().seek(12)');
  await settle();

  const CROP_OPEN = { left: -7, right: 7, bottom: -7, top: 7 };
  const setCrop = async (o) => {
    await page.evaluate(`__kinect.params.apply(${JSON.stringify(o)})`);
    await settle();
    await new Promise((r) => setTimeout(r, 120));
  };
  const lit = async () => {
    const box = await page.locator('#stage').boundingBox();
    const shot = await page.screenshot({ clip: box });
    return page.evaluate(`(async (dataUrl) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, img.width, img.height).data;
      const n = { all: 0, l: 0, r: 0, t: 0, b: 0 };
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const i = (y * img.width + x) * 4;
          if (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] < 18) continue;
          n.all++;
          if (x < img.width / 2) n.l++; else n.r++;
          // Image y grows downward and world +y is up, so the image's top half is
          // the world's positive y and belongs to the "top" face.
          if (y < img.height / 2) n.t++; else n.b++;
        }
      }
      return n;
    })(${JSON.stringify(`data:image/png;base64,${shot.toString('base64')}`)})`);
  };

  /** The rightmost lit column, as a fraction of the stage. */
  const litEdge = async () => {
    const box = await page.locator('#stage').boundingBox();
    const shot = await page.screenshot({ clip: box });
    return page.evaluate(`(async (dataUrl) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, img.width, img.height).data;
      // Scanned right to left and stopped at the first column carrying more than a
      // handful of lit pixels, because a single stray splat at the far right would
      // otherwise be the answer to every arm.
      for (let x = img.width - 1; x >= 0; x--) {
        let n = 0;
        for (let y = 0; y < img.height; y++) {
          const i = (y * img.width + x) * 4;
          if (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] >= 18) n++;
        }
        if (n > 4) return x / img.width;
      }
      return 0;
    })(${JSON.stringify(`data:image/png;base64,${shot.toString('base64')}`)})`);
  };

  const reachAt = await page.evaluate('__kinect.cropReach(9.5)');
  check(reachAt.limit > reachAt.x && reachAt.limit > reachAt.y,
    'the planes open wider than the sensor can see at the furthest depth a slider allows',
    `sensor x +/-${reachAt.x.toFixed(2)}m y +/-${reachAt.y.toFixed(2)}m, planes +/-${reachAt.limit}m`);

  await setCrop(CROP_OPEN);
  const litDefault = await lit();
  await page.evaluate(`(() => { const u = __kinect.uniforms;
    u.cropL.value = -100; u.cropB.value = -100; u.cropR.value = 100; u.cropT.value = 100; })()`);
  await settle();
  await new Promise((r) => setTimeout(r, 150));
  const litWide = await lit();
  check(litDefault.all === litWide.all && litDefault.all > 1000,
    'and the defaults therefore cull nothing, which is what keeps an older clip loading uncropped',
    `${litDefault.all} lit with the defaults, ${litWide.all} with the planes at 100m`);

  for (const [name, val, own, opposite] of [['right', 0.3, 'r', 'l'], ['left', -0.3, 'l', 'r'],
    ['top', 0.3, 't', 'b'], ['bottom', -0.3, 'b', 't']]) {
    await setCrop(CROP_OPEN);
    const before = await lit();
    await setCrop({ [name]: val });
    const after = await lit();
    const lostOwn = 1 - after[own] / Math.max(1, before[own]);
    const lostOther = 1 - after[opposite] / Math.max(1, before[opposite]);
    check(lostOwn > 0.15 && lostOwn > lostOther * 2,
      `${name} culls from its own side of the frame and not the other`,
      `its half lost ${(lostOwn * 100).toFixed(1)}%, the opposite half ${(lostOther * 100).toFixed(1)}% `
      + `(lit ${before.all} -> ${after.all})`);
  }

  // A box, not a wedge, and **the observable here is where the cut lands rather than
  // how much it took.** The fraction removed cannot tell the two apart: a wedge rigged
  // to agree with the box at 2m removed 1.2% of a near slab and 66.2% of a far one
  // against the box's 1.2% and 71.6%, and `crop-in-image-space` passed every row.
  //
  // What separates them is the boundary's *position*. A plane at a fixed R metres is
  // crossed at image column `cx + R*fx/z`, which walks left as the subject moves away;
  // a crop read as an angle cuts the same column at every depth. So the right edge of
  // what survives is measured in two slabs, and R is 0.3 rather than 0.6 because at
  // 0.6 the near slab's content ends before the boundary and neither build cuts it -
  // a probe standing where the answer is the same either way.
  const edge = [];
  for (const [n, f] of [[1.0, 1.6], [3.0, 3.6]]) {
    await setCrop({ ...CROP_OPEN, near: n, far: f });
    await setCrop({ right: 0.3 });
    const cut = await litEdge();
    edge.push(cut);
    note(`slab ${n}-${f}m with right at 0.3m`, `the surviving right edge sits at ${cut.toFixed(3)} of the stage`);
  }
  // The band is measured from both sides rather than picked: this build separates the
  // two slabs by 0.038 of the stage and `crop-in-image-space` separates them by 0.001,
  // so 0.015 sits fifteen times clear of the wedge and at 40% of the box's margin.
  check(edge[0] - edge[1] > 0.015,
    'and the cut sits further right in a near slab than a far one, which is what a plane in metres does and an angle does not',
    `${edge[0].toFixed(3)} against ${edge[1].toFixed(3)}, ${(edge[0] - edge[1]).toFixed(3)} of the stage apart`);
  await setCrop({ near: 0.05, far: 6 });

  // The way back. Four planes closed by hand are four numbers to remember, and a box
  // shut past its own subject looks exactly like a take that failed to load - so the
  // button is the difference between a reversible experiment and a scare.
  await setCrop({ left: -0.4, right: 0.4, bottom: -0.4, top: 0.4 });
  const litClosed = await lit();
  await page.locator('#cropReset').click();
  await settle();
  await new Promise((r) => setTimeout(r, 150));
  const litReopened = await lit();
  const planes = await page.evaluate(`(() => {
    const u = __kinect.uniforms;
    return [u.cropL.value, u.cropR.value, u.cropB.value, u.cropT.value];
  })()`);
  // The planes are checked exactly and the cloud within a tenth of a percent. Two
  // screenshots of the same clip taken minutes apart are not bit-identical - the
  // transport re-fetches and re-interpolates, and point splatting aliases - so this
  // row measured 288614 against 288586, a difference of 28 pixels in 288 thousand. An
  // exact equality there would be asserting determinism, which is `determinism-check`'s
  // claim and not this one's; the claim here is that the cloud came back.
  const backWithin = Math.abs(litReopened.all - litDefault.all) / litDefault.all;
  check(planes.join() === [-7, 7, -7, 7].join() && backWithin < 0.001,
    '"open the box" puts all four planes back and the whole cloud with them',
    `planes ${planes.join(', ')}; lit ${litClosed.all} -> ${litReopened.all} against `
    + `${litDefault.all} open, ${(backWithin * 100).toFixed(3)}% apart`);

  // =====================================================================
  console.log('\n[9] the ruler shows a window, and the window can be driven');
  // =====================================================================
  //
  // **Every arm here is zoomed and panned, and that is the design of the section
  // rather than thoroughness.** With the window at the whole clip, `(t - start)/span`
  // and the old `t/duration` are the same expression - so an arm at fit-zoom passes
  // identically on a build that has no window at all, and would report coverage for
  // the one thing it cannot see. This is the mirror of section 4's rate-1 dead zone
  // and the same rule `docs/instruments.md` states after step 6's aspect ratio.
  //
  // The window is deliberately off-centre as well as narrow, because a window centred
  // on the clip is a second agreement: zooming about the centre and zooming about the
  // pointer give the same answer when the pointer is at the centre.
  //
  // A note on what section 1 does and does not cover, since it would otherwise read as
  // covering this. Its sweep enumerates *form controls* - `input`, `select`, `button` -
  // so the overview strip and its window box are no more enumerated by it than `#tIn`
  // and `#tOut` are, and they are driven by name below for the same reason the cuts are
  // driven by name in section 3.
  await page.evaluate('__kinect.keyframes.setTracks({ bloom: [ { t: 2, value: 0.2 }, { t: 6, value: 0.9 }, { t: 20, value: 0.4 } ] })');
  await page.evaluate("__kinect.editor.setMarks([{ id: 'm1', sourceMs: 3000 }, { id: 'm2', sourceMs: 22000 }])");
  await page.evaluate('__kinect.editor.view.set(0.30, 0.42)');
  await settle();
  const win = await page.evaluate('__kinect.editor.view.window()');
  check(!win.whole && win.spanSec < win.duration / 4,
    'the strip can be zoomed into a window that is a fraction of the clip',
    `${win.startSec.toFixed(2)}s..${win.endSec.toFixed(2)}s of ${win.duration.toFixed(2)}s`);

  // The mapping and its inverse, at that window. Both directions are read off the page
  // rather than one being recomputed here, because a check that reimplemented `pct` to
  // test `secAtPct` would be comparing this file's arithmetic against itself.
  const roundTrip = await page.evaluate(`(() => {
    const out = [];
    for (const p of [0, 12.5, 50, 87.5, 100]) {
      const t = __kinect.editor.view.secAtPct(p);
      out.push({ p, t, back: __kinect.editor.view.pct(t) });
    }
    return out;
  })()`);
  check(roundTrip.every((r) => near(r.back, r.p, 1e-6)),
    '  and a percentage across it survives a round trip through program seconds',
    roundTrip.map((r) => `${r.p}%->${r.t.toFixed(3)}s->${r.back.toFixed(3)}%`).join(' '));
  check(near(roundTrip[0].t, win.startSec, 1e-6) && near(roundTrip[4].t, win.endSec, 1e-6),
    '  and 0% and 100% are the edges of the window rather than the edges of the clip',
    `0% is ${roundTrip[0].t.toFixed(3)}s, 100% is ${roundTrip[4].t.toFixed(3)}s, clip is 0..${win.duration.toFixed(2)}s`);

  // The claim that matters to a pointer: clicking the ruler seeks to what the ruler
  // says is there. This is the row a build that forgot the window fails, and it fails
  // it by a whole window - which is why the tolerance is an output frame rather than
  // anything looser.
  const bedBox = await page.locator('#tBed').boundingBox();
  const wantedAt25 = await page.evaluate('__kinect.editor.view.secAtPct(25)');
  await page.mouse.click(bedBox.x + bedBox.width * 0.25, bedBox.y + bedBox.height / 2);
  await settle();
  const landedAt25 = await page.evaluate('__kinect.timeline.transport().programSec');
  check(near(landedAt25, wantedAt25, 1 / 30 + 1e-6),
    '  and a click a quarter of the way across it seeks to the time it names there',
    `clicked 25%, wanted ${wantedAt25.toFixed(4)}s, landed ${landedAt25.toFixed(4)}s`);

  // Markers outside the window. Hidden rather than removed, because `repositionLanes`
  // refuses to run when the node count and the key count disagree.
  const culled = await page.evaluate(`(() => {
    const keys = [...document.querySelectorAll('.tlane[data-owner=bloom] .tkey')];
    const marks = [...document.querySelectorAll('#tMarks .tmk')];
    return {
      keys: keys.length, keysShown: keys.filter((n) => !n.hidden).length,
      marks: marks.length, marksShown: marks.filter((n) => !n.hidden).length,
      lefts: keys.map((n) => parseFloat(n.style.left)),
    };
  })()`);
  check(culled.keys === 3 && culled.keysShown === 0 && culled.marksShown === 0,
    '  a marker the window does not hold is hidden rather than drawn off the edge',
    `${culled.keysShown}/${culled.keys} keys and ${culled.marksShown}/${culled.marks} marks shown, `
    + `key lefts ${culled.lefts.map((l) => `${l.toFixed(0)}%`).join(', ')}`);
  check(culled.lefts.some((l) => l < 0) && culled.lefts.some((l) => l > 100),
    '  and its node still carries the position it would have had, on both sides',
    culled.lefts.map((l) => `${l.toFixed(0)}%`).join(', '));

  // The ruler's own spacing. A window forty times narrower has to relabel, or the
  // zoom bought nothing: the whole complaint was placing a key against 20-second
  // gradations on an 800-second clip.
  const ticksAt = () => page.evaluate(`[...document.querySelectorAll('#tRuler .ttick label')].map((l) => l.textContent)`);
  const zoomedTicks = await ticksAt();
  await page.evaluate('__kinect.editor.view.fit()');
  await settle();
  const fitTicks = await ticksAt();
  check(zoomedTicks.join() !== fitTicks.join() && zoomedTicks.length > 2 && fitTicks.length > 2,
    'the ruler picks its spacing from the window, not from the clip',
    `fit: ${fitTicks.slice(0, 6).join(' ')} | zoomed: ${zoomedTicks.slice(0, 6).join(' ')}`);

  // The overview, which is the only surface that must *not* go through the window.
  await page.evaluate('__kinect.editor.view.set(0.30, 0.42)');
  await settle();
  const box = await page.evaluate(`({
    left: document.getElementById('tMiniWin').style.left,
    width: document.getElementById('tMiniWin').style.width,
  })`);
  check(near(parseFloat(box.left), 30, 0.5) && near(parseFloat(box.width), 12, 0.5),
    'the overview draws the window on the whole clip, which is what says where you are',
    `box at ${box.left} wide ${box.width}`);

  // And it is *driven*, not merely drawn. The row above reads DOM state after no
  // interaction at all, which this file's own header rules out - a build whose
  // pointerdown handler never fires would paint that box correctly forever and pass
  // it. That is the in/out markers again with a newer node, and section 1's sweep does
  // not reach here to catch it: it enumerates form controls, and this is three divs.
  const miniBox = await page.locator('#tMini').boundingBox();
  const dragMini = async (fromF, toF, target) => {
    await page.evaluate('__kinect.editor.view.set(0.30, 0.42)');
    await settle();
    const before = await page.evaluate('__kinect.editor.view.window()');
    const y = miniBox.y + miniBox.height / 2;
    // Aimed at the box's own edge handle rather than at a fraction of the strip, so
    // the row fails when the handle moves rather than when the arithmetic does.
    const grab = target ? await page.locator(target).boundingBox() : null;
    const fromX = grab ? grab.x + grab.width / 2 : miniBox.x + miniBox.width * fromF;
    await page.mouse.move(fromX, y);
    await page.mouse.down();
    await page.mouse.move(miniBox.x + miniBox.width * toF, y, { steps: 4 });
    await page.mouse.up();
    await settle();
    return { before, after: await page.evaluate('__kinect.editor.view.window()') };
  };

  const panned = await dragMini(0.36, 0.56, '#tMiniWin');
  check(near(panned.after.a - panned.before.a, 0.2, 0.02)
    && near(panned.after.spanSec, panned.before.spanSec, 1e-6),
    '  dragging the window box pans by what the pointer moved, and does not resize it',
    `a ${panned.before.a.toFixed(3)} -> ${panned.after.a.toFixed(3)}, `
    + `span ${panned.before.spanSec.toFixed(3)}s -> ${panned.after.spanSec.toFixed(3)}s`);

  const stretched = await dragMini(0, 0.62, '#tMiniWin .e');
  check(stretched.after.spanSec > stretched.before.spanSec * 1.4
    && near(stretched.after.a, stretched.before.a, 0.01),
    '  and dragging its right edge zooms out from that edge, holding the left one',
    `span ${stretched.before.spanSec.toFixed(3)}s -> ${stretched.after.spanSec.toFixed(3)}s, `
    + `a ${stretched.before.a.toFixed(3)} -> ${stretched.after.a.toFixed(3)}`);

  await page.evaluate('__kinect.editor.view.set(0.30, 0.42)');
  await settle();
  const beforeCentre = await page.evaluate('__kinect.editor.view.window()');
  await page.mouse.click(miniBox.x + miniBox.width * 0.8, miniBox.y + miniBox.height / 2);
  await settle();
  const afterCentre = await page.evaluate('__kinect.editor.view.window()');
  check(near((afterCentre.a + afterCentre.b) / 2, 0.8, 0.02)
    && near(afterCentre.spanSec, beforeCentre.spanSec, 1e-6),
    '  and a click on open track centres the window there rather than moving one edge to it',
    `centre ${((beforeCentre.a + beforeCentre.b) / 2).toFixed(3)} -> ${((afterCentre.a + afterCentre.b) / 2).toFixed(3)}, `
    + `span ${afterCentre.spanSec.toFixed(3)}s`);

  // Zooming about the pointer. Two positions, because a zoom about the centre holds
  // the centre still and so does a zoom about a pointer that is at the centre - one
  // arm cannot tell them apart, and the wrong build is the one that reads better.
  const zoomAtFraction = async (f) => {
    await page.evaluate('__kinect.editor.view.set(0.2, 0.8)');
    await settle();
    const before = await page.evaluate(`__kinect.editor.view.secAtPct(${f * 100})`);
    const bb = await page.locator('#tBed').boundingBox();
    await page.mouse.move(bb.x + bb.width * f, bb.y + bb.height / 2);
    await page.mouse.wheel(0, -300);
    await settle();
    const after = await page.evaluate(`__kinect.editor.view.secAtPct(${f * 100})`);
    return { before, after };
  };
  for (const f of [0.2, 0.8]) {
    const held = await zoomAtFraction(f);
    check(near(held.after, held.before, 0.05),
      `a wheel zoom ${Math.round(f * 100)}% across the bed holds the program time under the pointer`,
      `${held.before.toFixed(3)}s -> ${held.after.toFixed(3)}s`);
  }

  // The overview's own wheel, which is a different mapping rather than the same
  // handler on a second element: an x on the ruler is a position in the *window* and an
  // x here is a position in the *clip*, so reading both through one of the two is how a
  // wheel over the overview zooms somewhere the cursor is not. Nothing else drives that
  // branch - `zoom-about-centre` replaces the line both surfaces share.
  // The observable is *not* "the cursor still points at the same moment" - over the
  // overview that is true by construction, since the overview never zooms. It is that
  // the moment the cursor is over keeps its place inside the window, which is what an
  // anchor means, and it is the thing the two mappings disagree about: through the
  // ruler's mapping, 30% of the overview is read as 30% *of the window*, and the moment
  // actually under the cursor falls out of the window entirely.
  await page.evaluate('__kinect.editor.view.set(0.2, 0.8)');
  await settle();
  const miniWheelBox = await page.locator('#tMini').boundingBox();
  const beforeMiniWheel = await page.evaluate('__kinect.editor.view.window()');
  const clipAt30 = beforeMiniWheel.duration * 0.3;
  const placeInWindow = (w) => (clipAt30 - w.startSec) / w.spanSec;
  await page.mouse.move(miniWheelBox.x + miniWheelBox.width * 0.3, miniWheelBox.y + miniWheelBox.height / 2);
  await page.mouse.wheel(0, -300);
  await settle();
  const afterMiniWheel = await page.evaluate('__kinect.editor.view.window()');
  check(near(placeInWindow(afterMiniWheel), placeInWindow(beforeMiniWheel), 0.02)
    && afterMiniWheel.spanSec < beforeMiniWheel.spanSec * 0.8,
    '  a wheel over the overview anchors on the clip position under the pointer, not on the window one',
    `30% of the clip is ${clipAt30.toFixed(2)}s, at ${(placeInWindow(beforeMiniWheel) * 100).toFixed(1)}% `
    + `of the window before and ${(placeInWindow(afterMiniWheel) * 100).toFixed(1)}% after, `
    + `span ${beforeMiniWheel.spanSec.toFixed(2)}s -> ${afterMiniWheel.spanSec.toFixed(2)}s`);

  // The cost of it. A zoom is dozens of events and the structural path calls `resize()`,
  // so this is the same claim the key-drag row makes, read off the same counters.
  await page.evaluate('__kinect.timeline.counters.laneRebuilds = 0; __kinect.timeline.counters.laneRepositions = 0');
  const wheelBox = await page.locator('#tBed').boundingBox();
  await page.mouse.move(wheelBox.x + wheelBox.width / 2, wheelBox.y + wheelBox.height / 2);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -100);
  await settle();
  const zoomCounters = await page.evaluate('({ ...__kinect.timeline.counters })');
  check(zoomCounters.laneRepositions >= 6 && zoomCounters.laneRebuilds === 0,
    '  and eight wheel notches take the cheap path every time, never the one that resizes the buffer',
    `${zoomCounters.laneRepositions} repositions, ${zoomCounters.laneRebuilds} rebuilds`);

  // The keys. `SHORTCUTS` is what `?` prints and it now names four of them, so each is
  // pressed rather than trusted - a string telling the user about a feature is the
  // cheap version of the bug this whole file exists for.
  await page.evaluate('__kinect.editor.view.set(0.2, 0.8)');
  await page.evaluate('__kinect.timeline.transport().seek(15)');
  await settle();
  const beforeKeyZoom = await page.evaluate('__kinect.editor.view.window()');
  await focusStage();
  await page.keyboard.press('=');
  await settle();
  const afterIn = await page.evaluate('__kinect.editor.view.window()');
  await page.keyboard.press('-');
  await settle();
  const afterOut = await page.evaluate('__kinect.editor.view.window()');
  check(afterIn.spanSec < beforeKeyZoom.spanSec * 0.95 && near(afterOut.spanSec, beforeKeyZoom.spanSec, 1e-6),
    '+ zooms the ruler in and - takes it back, both about the playhead',
    `${beforeKeyZoom.spanSec.toFixed(3)}s -> ${afterIn.spanSec.toFixed(3)}s -> ${afterOut.spanSec.toFixed(3)}s`);
  const held = await page.evaluate('__kinect.timeline.transport().programSec');
  check(afterIn.startSec < held && afterIn.endSec > held,
    '  and the playhead is still inside the window after zooming in, which is what "about" means',
    `playhead ${held.toFixed(2)}s in ${afterIn.startSec.toFixed(2)}s..${afterIn.endSec.toFixed(2)}s`);
  check((await page.evaluate('__kinect.editor.shortcuts()')).includes('f fits the clip'),
    '  and the shortcut list says so, which is where anybody would look for it',
    await page.evaluate('__kinect.editor.shortcuts()'));

  // Panning a window of the width you already have, which is the one thing the keyboard
  // could not do. Zoom, fit and frame all *resize*; moving a narrow window along a long
  // clip was reachable only by dragging the overview box, and the box and its two edges
  // are `div` and `i` elements with no tabindex and nothing but pointer handlers - so at
  // a close zoom there was no keyboard route from one end of the clip to the other.
  //
  // The span is asserted alongside the position, because a "pan" that also resized would
  // move the start and pass a row reading the start alone - and resizing is what every
  // other key on this surface already does.
  await page.evaluate('__kinect.editor.view.set(0.4, 0.5)');
  await settle();
  const beforePan = await page.evaluate('__kinect.editor.view.window()');
  await focusStage();
  await page.keyboard.press('.');
  await settle();
  const keyPanned = await page.evaluate('__kinect.editor.view.window()');
  await page.keyboard.press(',');
  await settle();
  const panBack = await page.evaluate('__kinect.editor.view.window()');
  check(near(keyPanned.startSec - beforePan.startSec, beforePan.spanSec * 0.25, 1e-3),
    '. pans the window a quarter of itself along the clip',
    `${beforePan.startSec.toFixed(3)}s -> ${keyPanned.startSec.toFixed(3)}s, a quarter is `
    + `${(beforePan.spanSec * 0.25).toFixed(3)}s`);
  check(near(keyPanned.spanSec, beforePan.spanSec, 1e-6),
    '  without resizing it, which is what every other key on this surface does',
    `${beforePan.spanSec.toFixed(4)}s -> ${keyPanned.spanSec.toFixed(4)}s`);
  check(near(panBack.startSec, beforePan.startSec, 1e-3) && near(panBack.spanSec, beforePan.spanSec, 1e-6),
    '  and , brings it back', `${keyPanned.startSec.toFixed(3)}s -> ${panBack.startSec.toFixed(3)}s`);
  check((await page.evaluate('__kinect.editor.shortcuts()')).includes(',/. pan it'),
    '  and the shortcut list says so too', await page.evaluate('__kinect.editor.shortcuts()'));

  // **A round trip has to come back.** The window is stored as fractions and its minimum
  // is in seconds, so the two disagree the moment the duration moves - and a clamp applied
  // to its own previous output only ratchets outward. At 0.1x the clip is 480s and the
  // 0.25s minimum is a fraction of 0.00052; at 4x that fraction is 0.00625s of a 12s clip,
  // the clamp widens it, and coming back to 0.1x the widened fraction is 10s. The document
  // returns exactly and commits no undo step, so a ruler forty times wider than it started
  // is the one thing the speed control claims not to do.
  //
  // The rate goes through the page's own mapping and the rate that came out is checked
  // against the one that went in, because the slider's travel is logarithmic and its
  // `value` is a position rather than a rate.
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await settle();
  const slowRate = await driveRate(0.1);
  await page.evaluate('__kinect.editor.view.set(0.5, 0.5)');
  await settle();
  const atMin = await page.evaluate('__kinect.editor.view.window()');
  const fastRate = await driveRate(4);
  const atFast = await page.evaluate('__kinect.editor.view.window()');
  const backRate = await driveRate(0.1);
  const atBack = await page.evaluate('__kinect.editor.view.window()');
  check(near(slowRate, 0.1, 1e-6) && near(fastRate, 4, 1e-6) && near(backRate, 0.1, 1e-6),
    'the round trip really went 0.1x -> 4x -> 0.1x, or the rows below mean nothing',
    `${slowRate}x, ${fastRate}x, ${backRate}x`);
  check(near(atMin.spanSec, 0.25, 1e-6),
    '  and the window was at the 0.25s minimum before it', `${atMin.spanSec.toFixed(6)}s`);
  check(atFast.spanSec >= 0.25 - 1e-9,
    '  and never went below the minimum in the middle of it, which is what the clamp is for',
    `${atFast.spanSec.toFixed(6)}s at 4x`);
  check(near(atBack.spanSec, atMin.spanSec, 1e-6),
    '  and comes back to exactly the window it started at, rather than to what the clamp left',
    `${atMin.spanSec.toFixed(6)}s -> ${atBack.spanSec.toFixed(6)}s`);
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await page.evaluate('__kinect.editor.view.fit()');
  await settle();

  // **A wheel notch is not three pixels, and on Firefox that is what it reports.**
  // `deltaMode` is `DOM_DELTA_LINE` there and on some Linux mice, so a rule dividing by
  // 100 turned a full notch into 3% of one and the zoom read as a control that does
  // nothing. Driven as the two arms of the same gesture: one notch in lines against the
  // same notch already in pixels, which must land in the same place.
  //
  // The pixel arm is the control. Without it this is a row about zooming rather than
  // about the unit, and would go green on a build that ignored the wheel entirely.
  const wheelArm = (mode, dy) => page.evaluate(`(async () => {
    __kinect.editor.view.set(0.2, 0.8);
    const bed = document.getElementById('tBed');
    const r = bed.getBoundingClientRect();
    bed.dispatchEvent(new WheelEvent('wheel', {
      deltaY: ${dy}, deltaMode: ${mode}, bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
    await __kinect.timeline.settled();
    return __kinect.editor.view.window();
  })()`);
  const inPixels = await wheelArm(0, -66);
  const inLines = await wheelArm(1, -3);
  const openSpan = inPixels.duration * 0.6;
  check(inPixels.spanSec < openSpan * 0.95,
    'a wheel notch reported in pixels zooms the ruler',
    `${openSpan.toFixed(3)}s -> ${inPixels.spanSec.toFixed(3)}s`);
  check(near(inLines.spanSec, inPixels.spanSec, 1e-6),
    '  and the same notch reported in lines zooms it by exactly as much',
    `pixels ${inPixels.spanSec.toFixed(4)}s, lines ${inLines.spanSec.toFixed(4)}s`);
  await page.evaluate('__kinect.editor.view.fit()');
  await settle();

  // The way back, and the way to the edit. Both are keys because a window you can only
  // leave with a wheel is a window somebody gets stuck in.
  await focusStage();
  await page.keyboard.press('f');
  await settle();
  check((await page.evaluate('__kinect.editor.view.window()')).whole,
    'f fits the whole clip back on the ruler', JSON.stringify(await page.evaluate('__kinect.editor.view.window()')));
  await page.evaluate('__kinect.timeline.transport().seek(4)');
  await settle();
  await page.locator('#tSetIn').click();
  await page.evaluate('__kinect.timeline.transport().seek(9)');
  await settle();
  await page.locator('#tSetOut').click();
  await focusStage();
  await page.keyboard.press('z');
  await settle();
  const framed = await page.evaluate('__kinect.editor.view.window()');
  check(framed.startSec < 4 && framed.endSec > 9 && framed.spanSec < framed.duration / 2,
    'z frames the trimmed range, which is the window an edit is actually made in',
    `${framed.startSec.toFixed(2)}s..${framed.endSec.toFixed(2)}s around in 4s / out 9s`);
  await page.locator('#tClearRange').click();
  await page.evaluate('__kinect.editor.view.fit()');
  await settle();

  // =====================================================================
  console.log('\n[10] the strip is bounded, and the splitter is what bounds it');
  // =====================================================================
  //
  // Every keyed parameter used to add a permanent row and take that height off the
  // stage with nothing to give it back - eight lanes is 280px of a 900px window gone,
  // and the only way to reclaim it was to delete keys.
  //
  // Section 6 asserts the strip is exactly the height the stage was sized against, and
  // it still does. This is the other half of that: the height is now a number a person
  // sets, and the rows below are about the two bounds on what they can set it to.
  // **Enough lanes to stack past the ceiling, and that is the arm rather than the
  // scenery.** Eight came to 280px against a ceiling of 415, so the height was limited
  // by the content and not by the clamp - and the clamp row below passed on a build
  // with the clamp removed, because `min(stacked, ...)` was still holding it. A probe
  // standing where both answers agree, measured rather than reasoned: `splitter-
  // unclamped` came back NOT CAUGHT at eight lanes and reddens the row at fourteen.
  // Look parameters only - `spin` was in this list and is tagged `view`, so it took no
  // lane and the count assertion read one short.
  const LANED = ['bloom', 'grain', 'scanlines', 'rgbSplit', 'glitch', 'trails', 'rim',
    'thermal', 'edges', 'scan', 'noise', 'denoise', 'exposure'];
  // The value each key holds is asked of the registry rather than assumed, because
  // `denoise` is a step parameter and a key holding 0.2 makes `normalise` throw the
  // moment anything evaluates the track. This list carried 0.2 and 0.5 into all
  // thirteen from the day it was written and nothing ever said so: every arm below
  // measured heights, and a height is read off the layout without a frame being
  // rendered. It surfaced the first time a row here seeked - which is the plainest
  // form of a fixture that is wrong in a direction nothing in its section can see.
  const plantLanes = () => page.evaluate(`(() => {
    const spec = {};
    for (const n of ${JSON.stringify(LANED)}) {
      spec[n] = typeof __kinect.params.spec(n).default === 'boolean'
        ? [{ t: 1, value: false }, { t: 5, value: true }]
        : [{ t: 1, value: 0.2 }, { t: 5, value: 0.5 }];
    }
    __kinect.keyframes.setTracks(spec);
  })()`);
  await plantLanes();
  await settle();
  const manyLanes = await page.evaluate('__kinect.editor.strip()');
  check(manyLanes.stacked > manyLanes.ceiling && (await lanes()).length === LANED.length,
    'enough keyed parameters and the lanes want more height than the stage can spare',
    `${(await lanes()).length} lanes stacking ${manyLanes.stacked}px against a ${manyLanes.ceiling}px ceiling, `
    + `strip ${manyLanes.height}px`);

  const gripAt = () => page.locator('#tGrip').boundingBox();
  const dragGrip = async (by) => {
    const g = await gripAt();
    await page.mouse.move(g.x + g.width / 2, g.y + 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, g.y + 2 + by, { steps: 6 });
    await page.mouse.up();
    await settle();
    return page.evaluate('__kinect.editor.strip()');
  };

  const shrunk = await dragGrip(150);
  check(shrunk.lanes < manyLanes.lanes - 100 && shrunk.height < manyLanes.height - 100,
    'dragging the splitter down gives the height back to the stage',
    `lanes ${manyLanes.lanes}px -> ${shrunk.lanes}px, strip ${manyLanes.height}px -> ${shrunk.height}px`);
  check(shrunk.lanes < shrunk.stacked && shrunk.scrollable,
    '  and the lanes it no longer has room for scroll rather than being cut off',
    `${shrunk.lanes}px of ${shrunk.stacked}px stacked, scrollable ${shrunk.scrollable}`);

  // Optional-chained, like every other reach into the strip below it. A mutation that
  // empties the strip must be able to redden these rows without taking the run down with
  // it - `lanes-clear-siblings` removes `#tLanes` along with everything else it clears,
  // and a raw dereference here discarded 140 correct assertions as DID NOT RUN.
  await page.evaluate("(() => { const el = document.getElementById('tLanes'); if (el) el.scrollTop = 60; })()");
  await new Promise((r) => setTimeout(r, 120));
  const scrolled = await page.evaluate('__kinect.editor.strip()');
  check(scrolled.railScrollTop === scrolled.scrollTop && scrolled.scrollTop === 60,
    '  and the rail follows them, or every lane would be labelled with its neighbour',
    `lanes at ${scrolled.scrollTop}px, rail at ${scrolled.railScrollTop}px`);

  // And the other way into the same scroller, which the wheel rows cannot speak for. A
  // lane covers its row and declared `touch-action: none`, so on a touchscreen the
  // browser could not pan the stack natively and a lane below the fold was unreachable -
  // the delegated pointer handler returns on anything that is not a key or a handle, so
  // nothing picked the gesture up either.
  //
  // Read up the whole ancestor chain rather than off the lane alone, because
  // `touch-action` is intersected along it: a `none` on any ancestor between the lane and
  // the scroller defeats a `pan-y` on the lane, silently and while the one rule anybody
  // would read still says the right thing.
  // A handle only exists for a selected key with a shaped segment either side of it, so
  // one is selected here rather than the row reading `null` and calling it a failure.
  // `bloom` is planted at 0.2 -> 0.5 above, which is a segment with a shape to edit.
  await page.evaluate(`__kinect.editor.select('bloom', 0)`);
  await settle();
  const touch = await page.evaluate(`(() => {
    const lane = document.querySelector('.tlane');
    if (!lane) return null;
    const chain = [];
    for (let el = lane; el && el.id !== 'tLanes'; el = el.parentElement) {
      chain.push(\`\${el.tagName.toLowerCase()}\${el.id ? '#' + el.id : ''}=\${getComputedStyle(el).touchAction}\`);
    }
    const of = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).touchAction : null;
    };
    return {
      chain, blocked: chain.filter((c) => /=(none|pan-x)$/.test(c)),
      key: of('.tlane .tkey'), handle: of('.tlane .thandle'),
    };
  })()`);
  check(touch !== null && touch.blocked.length === 0,
    '  and a touch swipe can reach them, which no wheel row above can speak for',
    touch === null ? 'no lane to read' : touch.chain.join('  '));
  // The other side of the same rule, and it has to be here or the row above is an
  // instruction to break something else. A scalar key's *value* and an ease handle's
  // vertical component both come from `clientY`, so those two elements need the axis the
  // lane just gave away - inheriting `pan-y` lets the browser claim a vertical drag on a
  // key for scrolling and cancel the pointer sequence, which does not make that edit
  // awkward by touch, it removes it.
  check(touch !== null && touch.key === 'none',
    '  while a key keeps both axes, because its value is the vertical one',
    `key touch-action ${touch?.key}`);
  check(touch !== null && touch.handle === 'none',
    '  and so does an ease handle, for the same reason',
    `handle touch-action ${touch?.handle}`);

  // The clamp. Dragging to the top of the window must not be a way to lose the picture,
  // which is the failure a splitter introduces if nothing bounds it.
  const g = await gripAt();
  await page.mouse.move(g.x + g.width / 2, g.y + 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, 4, { steps: 8 });
  await page.mouse.up();
  await settle();
  const maxed = await page.evaluate('__kinect.editor.strip()');
  const stageShare = (VIEWPORT.height - maxed.height) / VIEWPORT.height;
  check(stageShare >= 0.35,
    '  and dragging it to the top of the window still leaves the stage a third of it',
    `strip ${maxed.height}px of ${VIEWPORT.height}px leaves the stage ${(stageShare * 100).toFixed(1)}%`);
  check(maxed.lanes <= maxed.stacked,
    '  and never taller than the lanes it actually has, so content still cannot grow it',
    `${maxed.lanes}px against ${maxed.stacked}px stacked`);

  // The cost. `resize()` reallocates the drawing buffer and the composer's targets, so
  // a drag that ran it per pointer event is the failure `repositionLanes` was split out
  // to avoid - and Playwright cannot outpace an animation frame, so real mouse moves
  // measure nothing here. The burst is dispatched inside one task and the counter is
  // read inside the same one, which is the only place "did not run synchronously" can
  // be observed. The pointerdown is real, because `setPointerCapture` on a pointer id
  // that never existed throws.
  const gd = await gripAt();
  await page.mouse.move(gd.x + gd.width / 2, gd.y + 2);
  await page.mouse.down();
  const burst = await page.evaluate(`(() => {
    const el = document.getElementById('tGrip');
    if (!el) return { before: -1, afterSync: -1, lanes: -1 };
    const y0 = ${Math.round(gd.y + 2)};
    const before = __kinect.editor.stageResizes();
    for (let i = 1; i <= 40; i++) {
      el.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 100, clientY: y0 - i, bubbles: true }));
    }
    return { before, afterSync: __kinect.editor.stageResizes(), lanes: __kinect.editor.strip().lanes };
  })()`);
  await page.mouse.up();
  await settle();
  const afterFrame = await page.evaluate('__kinect.editor.stageResizes()');
  check(burst.afterSync === burst.before,
    'forty splitter moves in one task resize the drawing buffer no times, not forty',
    `${burst.afterSync - burst.before} resizes during the burst`);
  check(afterFrame - burst.before <= 3,
    '  and at most a frame\'s worth once the frame runs, which is what the throttle is for',
    `${afterFrame - burst.before} resizes in total for 40 moves`);

  // The same splitter from the keyboard, and the claim worth asserting is not that the
  // keys work but that they do *only* their own job. `#tGrip` is a `role=separator`
  // carrying a tabindex rather than a form field, so the window handler's `isTyping`
  // guard does not cover it - and Home and End are both the two ends of the splitter's
  // travel and the two clip boundaries the global shortcuts seek to. A keyboard user
  // collapsing the strip got the collapse, a pause and an accurate seek out of one
  // press, which is one gesture reading as two.
  //
  // The playhead is parked at 20s first, away from both cuts, because the stray seek
  // this is looking for lands on a boundary - a probe already sitting on one would
  // watch the seek happen and call it holding still. Section 2 drives the same two keys
  // with the stage focused and asserts that they *do* seek, which is what keeps this
  // from passing on a build whose shortcuts stopped working altogether.
  await page.evaluate('__kinect.timeline.transport().seek(20)');
  await settle();
  await page.evaluate("document.getElementById('tGrip')?.focus()");
  const gripFocused = await page.evaluate("document.activeElement === document.getElementById('tGrip')");
  const parked = await read();
  check(gripFocused && parked.programSec > 1 && parked.programSec < parked.duration - 1,
    'the splitter takes focus, with the playhead parked clear of both ends so a stray seek would show',
    `focused ${gripFocused}, playhead ${parked.programSec.toFixed(3)}s of ${parked.duration.toFixed(2)}s`);
  await page.keyboard.press('Home');
  await settle();
  const homeStrip = await page.evaluate('__kinect.editor.strip()');
  const homeRead = await read();
  check(homeStrip.lanes === 0, 'Home on the splitter collapses the strip', `${homeStrip.lanes}px`);
  check(near(homeRead.programSec, parked.programSec, 1e-3),
    '  and seeks nowhere, because a key another control consumed is not a shortcut',
    `${parked.programSec.toFixed(3)}s -> ${homeRead.programSec.toFixed(3)}s`);
  await page.keyboard.press('End');
  await settle();
  const endStrip = await page.evaluate('__kinect.editor.strip()');
  const endRead = await read();
  check(endStrip.lanes > homeStrip.lanes,
    'End reaches the other end of the splitter\'s travel', `${homeStrip.lanes}px -> ${endStrip.lanes}px`);
  check(near(endRead.programSec, parked.programSec, 1e-3),
    '  and seeks nowhere either', `${parked.programSec.toFixed(3)}s -> ${endRead.programSec.toFixed(3)}s`);
  await focusStage();

  // The height outlives the page, which is the only reason it is in `localStorage` at
  // all - and a build that never called `setItem` would pass every row above. Same
  // shape as the overview box: painted correctly forever, driven by nothing. The
  // reload is the whole test, so it is worth the take opening a second time.
  // Dragged well clear of the default rather than a little way from it. The first
  // version moved 90px and landed at 325 against a 315px default, so `splitter-forgets`
  // was caught by a 10px margin - a row that would have gone quiet the moment somebody
  // changed `DEFAULT_LANES_SHARE`, which is a control passing by coincidence.
  const askedFor = await dragGrip(200);
  const defaulted = Math.round(VIEWPORT.height * 0.35);
  check(Math.abs(askedFor.lanes - defaulted) > 60,
    'the dragged height is nowhere near the default, so the reload row below means something',
    `dragged to ${askedFor.lanes}px against a ${defaulted}px default`);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('!!globalThis.__kinect', null, { timeout: 30000 });
  await page.waitForFunction('!!globalThis.__kinect.timeline.transport()', null, { timeout: 30000 });
  await settle();
  await plantLanes();
  await settle();
  const reloaded = await page.evaluate('__kinect.editor.strip()');
  check(near(reloaded.lanes, askedFor.lanes, 2),
    'the height survives a reload, which is the only reason it is stored at all',
    `${askedFor.lanes}px before, ${reloaded.lanes}px after`);

  // Put it back, so nothing below inherits a strip somebody dragged.
  await page.evaluate('__kinect.keyframes.setTracks({})');
  await page.evaluate("localStorage.removeItem('kinect.lanesHeight')");
  await settle();

  check(errors.length === 0, 'the page reported no errors while any of this happened',
    errors.length ? errors.slice(0, 3).join(' | ') : '');
} catch (err) {
  crashed = err;
} finally {
  await close().catch(() => {});
}

// --------------------------------------------------------------------- the verdict

if (crashed) {
  console.log(`\n[editor] DID NOT RUN - ${crashed.message}`);
  console.log(`[editor] ${checks} assertions ran, ${failures} failed before the crash`);
  if (fired.length) console.log(`[editor] rows that had already fired: ${fired.join('; ')}`);
  process.exit(2);
}
if (untested) {
  console.log(`\n[editor] UNTESTED - ${untested}`);
  process.exit(2);
}

console.log(`\n[editor] ${checks} assertions, ${failures} failed`);
if (NO_RENDER) console.log('[editor] --no-render: the real export and the saved copy were not driven');

if (MUTATE) {
  if (failures === 0) {
    console.log(`[editor] NOT CAUGHT - ${MUTATE} passed every assertion, so nothing here tests it`);
    process.exit(1);
  }
  console.log(`[editor] caught ${MUTATE}, as required (${failures} assertions fired)`);
  for (const label of fired) console.log(`           ${label}`);
  process.exit(1);
}
if (failures) { console.log('[editor] FAIL'); process.exit(1); }
console.log('[editor] PASS');
process.exit(0);
