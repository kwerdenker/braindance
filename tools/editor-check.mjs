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

  // The control for section 9, and it is one line because the bug was one line: a
  // finishing draft starts whatever was armed while it ran. For a scrub that is
  // harmless, since the pointer cannot outrun the display; for an orbit it is the
  // whole failure, because the draft's own render arms the next position through
  // `advanceNavigation`. The mutated build renders correct images at forty-five
  // times the rate anything can show them, which is why the row it must redden is
  // the count and not the picture.
  'orbit-pumps-on-change': {
    file: 'web/main.js',
    edits: [[
      '    draftBusy = false;\n  }\n}',
      '    draftBusy = false;\n    if (draftWanted !== null) pumpDraft();\n  }\n}',
    ]],
  },

  // The second control for section 9, and the one that costs the most if it is
  // missed: an armed position is left standing in a state that will never pump it,
  // so `settled()` runs out its iterations and throws. Nothing about the picture is
  // wrong in that build - the orbit is fast, the release is accurate, and every tool
  // in this suite hangs on the call it uses to know when to look.
  'orbit-arms-into-playback': {
    file: 'web/main.js',
    edits: [[
      '  if (!timeline || timeline.playing || exporting) {\n'
      + '    draftWanted = null;\n    orbitSettling = false;\n    return;\n  }',
      '  if (!timeline || timeline.playing || exporting) return;',
    ]],
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
const focusStage = () => page.evaluate('document.getElementById("stage")?.focus?.(); document.body.focus?.();');

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
  // Two positions and two directions, because program and source time agree
  // trivially at program 0 and a single arm cannot tell holding one from holding the
  // other. `docs/instruments.md` has this failure twice already under "what do my
  // arms agree about".
  const rateArm = async (parkAt, to) => {
    await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
    await page.evaluate(`(() => { const el = document.getElementById('tRate'); el.value = '1'; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); })()`);
    await settle();
    await page.evaluate(`__kinect.timeline.transport().seek(${parkAt})`);
    await settle();
    const before = await read();
    const leftBefore = await page.evaluate(`document.getElementById('tPlayhead').style.left`);
    await page.evaluate(`(() => {
      const el = document.getElementById('tRate');
      el.value = ${JSON.stringify(String(to))};
      el.dispatchEvent(new Event('input'));
      el.dispatchEvent(new Event('change'));
    })()`);
    await settle();
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

  // The seek storm. A slider drag is dozens of `input` events and one `change`, and
  // each accurate seek renders a whole pre-roll before it can show anything.
  await page.evaluate('__kinect.timeline.counters.seeks = 0');
  await page.evaluate(`(() => {
    const el = document.getElementById('tRate');
    for (let i = 0; i < 20; i++) { el.value = String(1 + i * 0.05); el.dispatchEvent(new Event('input')); }
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

  // ================ 9. orbiting the parked viewport costs frames, not settles

  console.log('\n[9] orbiting while paused redraws once per frame, not once per rebuild');

  // The control the editor gives you for looking at the cloud is the drag itself, and
  // it is the one control in this file whose failure is a *rate* rather than a wrong
  // answer. Every image it produced was correct; there were just forty-five of them
  // per pointer move, because `renderProgramFrame` runs `advanceNavigation`, which
  // calls `controls.update()`, which fires `change` on a damped control that moved -
  // so the render asked for the next render and the damping settle ran at whatever
  // rate the machine could rebuild a frame. Measured before the fix: one pointer move
  // raised 35 `change` events, 34 of them from inside a render, and cost 34 drafts.
  //
  // So this is a counted claim rather than a timed one. A threshold in milliseconds
  // would pass on a fast enough machine while the amplification was still there, and
  // the amplification is the bug. `orbit-pumps-on-change` is the control.
  {
    await page.evaluate('__kinect.timeline.transport().pause()');
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    // The page counts its own animation frames. A driver-side clock cannot see this:
    // a saturated main thread starves rAF, which is exactly the symptom, and a
    // stopwatch out here would report the wall time either build takes rather than
    // how many turns the compositor was given.
    await page.evaluate(`(() => {
      globalThis.__orbitFrames = 0;
      const tick = () => { globalThis.__orbitFrames++; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    })()`);

    const stage = await page.evaluate(`(() => {
      const r = document.getElementById('stage').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    const poseOf = () => page.evaluate('(() => { const p = __kinect.freeCamera.position;'
      + ' return [p.x, p.y, p.z]; })()');

    const poseBefore = await poseOf();
    const before = await page.evaluate(
      '({ drafts: __kinect.timeline.counters.drafts, frames: globalThis.__orbitFrames })');
    await page.mouse.move(stage.x, stage.y);
    await page.mouse.down();
    const MOVES = 24;
    for (let i = 0; i < MOVES; i++) {
      await page.mouse.move(stage.x + Math.sin(i / 5) * 110, stage.y + Math.cos(i / 7) * 55);
      await page.evaluate('new Promise(requestAnimationFrame)');
    }
    await page.mouse.up();
    await settle();
    const after = await page.evaluate(
      '({ drafts: __kinect.timeline.counters.drafts, frames: globalThis.__orbitFrames })');
    const poseAfter = await poseOf();

    const drafts = after.drafts - before.drafts;
    const frames = after.frames - before.frames;
    const travelled = Math.hypot(...poseAfter.map((v, i) => v - poseBefore[i]));
    note(`${MOVES} pointer moves across the stage`,
      `${drafts} drafts over ${frames} animation frames, camera moved ${travelled.toFixed(3)} m`);

    // The control for the row below, and it has to come first: a drag that rendered
    // nothing would satisfy any ceiling at all, and so would one that never moved
    // the camera.
    check(drafts > 0 && travelled > 0.05, 'the drag renders, and it moves the camera',
      `${drafts} drafts, ${travelled.toFixed(3)} m`);
    // The invariant rather than a threshold: the animation loop is the only thing
    // that starts a draft while the playhead is parked, so it cannot start more than
    // one per frame. The slack is one frame, for the turn this counter was installed
    // on relative to the loop's.
    check(drafts <= frames + 1, 'and never more than one redraw per frame the display was given',
      `${drafts} drafts against ${frames} frames`);
    check((await read()).drafted === false,
      'and the release still lands the accurate image rather than leaving a draft up');

    // An armed position means something only while something will consume it, and
    // hitting play mid-drag is a state where nothing will - the loop's first act is
    // to hand the frame to `tick`. That was harmless while nothing read the flag. It
    // stopped being harmless when `settled()` started to, and `settled()` is what
    // every tool in this suite waits on, so the failure would not have been a slow
    // orbit but a hang everywhere. Driven through the real controls because the
    // sequence is a real one: a hand lets go of the cloud and reaches for play.
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    await page.mouse.move(stage.x, stage.y);
    await page.mouse.down();
    await page.mouse.move(stage.x + 60, stage.y + 30);
    await page.mouse.up();
    await page.evaluate('__kinect.timeline.transport().play()');
    let settledAfterPlay = true;
    let why = '';
    try {
      await settle();
    } catch (err) {
      settledAfterPlay = false;
      why = err.message.split('\n')[0];
    }
    check(settledAfterPlay, 'and a drag interrupted by playback leaves nothing armed behind it', why);
    await page.evaluate('__kinect.timeline.transport().pause()');
    await settle();
  }

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
