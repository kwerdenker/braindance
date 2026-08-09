#!/usr/bin/env node
// Version 3 documents, rewritten as version 4 documents on disk.
//
// Version 4 dissolved the shading mode into five reading weights. A version 3 preset
// carries `mode: N` beside its values and a version 3 project carries `look.mode`;
// this build carries neither, and refuses both rather than opening them - loudly, at
// the point the file arrives, which is the house convention and the right one. A
// version 3 file read by a version 4 build would otherwise parse perfectly: every
// value it names is still a parameter, `params.apply` would write all of them without
// complaint, and only the reading would be missing - leaving whatever the previous
// document happened to select. A look rendering as somebody else's shading, silently,
// is worse than one that will not open.
//
// So the conversion is a one-shot over files rather than a branch inside the loader.
// **That is not squeamishness about a compatibility path, it is the design rule this
// repo keeps restating**: one implementation, no second reader that can drift from the
// first. The mapping is total and lossless - mode N becomes `read<Name>: 1` with the
// other four at 0 - so there is nothing a runtime reader could do that this cannot do
// once, in advance, where the result is inspectable.
//
//   node tools/convert-presets.mjs presets projects jobs   # rewrite in place
//   node tools/convert-presets.mjs --dry-run presets       # say what it would do
//
// Every rewrite is written aside and renamed, for the reason `DocumentStore.write`
// does it: a crash partway through must not leave a file that parses and describes
// something nobody saved.

import { readdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_VERSION } from '../web/format.js';
// The queue's format number, read from the queue rather than copied, so the gate below
// moves with `server/jobs.js` instead of being a second place that has to be updated.
import { JOB_VERSION } from '../server/jobs.js';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const dirs = argv.filter((a) => !a.startsWith('--'));

if (!dirs.length) {
  console.error('usage: convert-presets.mjs [--dry-run] <dir> [dir...]');
  console.error('  rewrites version 3 presets and projects as version 4 in place,');
  console.error('  including the project snapshot inside a queued render job');
  process.exit(2);
}

// The mode as it was: an integer 0-4, in the order the shader branched on. The five
// names are the registry\'s, and the mapping is the whole of the format change.
const READING_FOR = ['readRgb', 'readDepth', 'readGhost', 'readContour', 'readBlackwall'];
const readingValues = (mode) => Object.fromEntries(READING_FOR.map((n, i) => [n, i === mode ? 1 : 0]));

/**
 * A mode this build cannot map is a refusal rather than a guess.
 *
 * A version 3 document was allowed to carry any integer here by the store - the bounds
 * check lived in the page's loader - so a hand-edited 9 is a shape that really exists
 * on disk. Defaulting it to RGB would produce a file that opens and is not the look it
 * was, which is the failure this whole conversion exists to avoid.
 */
function readingsFrom(mode, what) {
  if (!Number.isInteger(mode) || mode < 0 || mode >= READING_FOR.length) {
    throw new Error(`${what}: mode is ${JSON.stringify(mode)}, which named no shading this build can map`);
  }
  return readingValues(mode);
}

/**
 * **The seven constants each reading is made of, at the literals version 3 rendered
 * them with** - and they are written into the converted file rather than left to
 * default, because one of the two doors does not reset.
 *
 * In version 3 these were literals inside the mode branches of the shader, so a
 * version 3 preset had nothing to say about them and every version 3 build drew them
 * the same. Version 4 made them parameters. `applyStoredPreset` calls `params.apply`,
 * which writes the keys the document names and leaves every other look value exactly
 * where the session left it - so a converted Ghost preset applied after somebody had
 * pulled `ghostRim` to 0.2 renders with 0.2 and is not the look it was saved as. The
 * five shipped presets were given these seven for precisely this reason; the files
 * this tool writes are the other half of that, and were missed.
 *
 * `restoreProject` is the door that does reset, so a converted project would come out
 * right without them. They go in anyway, because "a converted document names what a
 * freshly saved one names" is a rule that survives a future re-grade of a default and
 * "the loader happens to reset" is not: these numbers are what the document rendered
 * in 2026, and a default moved in a later release must not move it with them.
 *
 * Frozen literals for that same reason. If the registry's defaults drift away from
 * this table, the table is still right and drift is not a bug to repair here.
 */
const READING_DETAIL = {
  rgbSaturation: 1,
  depthGamma: 1,
  ghostRim: 0.7,
  ghostFill: 0.35,
  contourBands: 12,
  contourWidth: 0.08,
  blackwallSweep: 0.28,
};

/**
 * The duotone's ramp width, which is here for `READING_DETAIL`'s reason and needs its
 * own paragraph because the honest value is less obvious than the seven above.
 *
 * Version 3 had no such parameter and no way to name one: the ramp ran the whole clip
 * range, and a preset carries no clip range, so what a version 3 document rendered
 * depended on wherever the session's near and far happened to sit. There is no literal
 * that reproduces all of those. 5.95 reproduces the one that can be assumed - the
 * default range, 0.05 to 6 - which is the same assumption the seven constants above
 * make when they freeze a literal rather than reading today's default.
 *
 * Omitting it would be worse than assuming, and for the reason this whole table exists:
 * `applyStoredPreset` leaves an unnamed value where the session left it, so a converted
 * preset applied after somebody had pulled the span to 1.2m would render at 1.2m and not
 * be the look it was saved as.
 */
const DUOTONE_SPAN = { duotoneSpan: 5.95 };

// Everything version 4 added, for a document that named the mode `mode`. Spread ahead
// of the document's own values at both call sites, so anything the file itself carries
// still wins - a hand-edited `ghostRim` is a value somebody chose, in range, and
// visible in the file, which is the opposite of the reading names `refuseReserved`
// stops because those have no honest precedence at all.
const newInVersion4 = (mode, what) => ({ ...readingsFrom(mode, what), ...READING_DETAIL, ...DUOTONE_SPAN });

/**
 * A version 3 document may not already name a reading, and this is a refusal rather
 * than a precedence rule.
 *
 * The five names did not exist in version 3, so a document carrying one was hand-edited
 * and the version 3 loader would have refused it as an unknown parameter. Here they
 * land on the wrong side of a spread: `{ ...readingsFrom(mode), ...values }` lets the
 * document's own `readRgb` win over the one derived from `mode`, so `mode: 4` beside a
 * stray `readRgb: 1` converts to a *valid* version 4 preset naming two readings at 1 -
 * a 50/50 blend of Blackwall and the camera image that nobody authored, in a file that
 * now opens cleanly.
 *
 * Ordering the spread the other way would be worse, not better: it would silently drop
 * a value somebody wrote instead of silently keeping it. And the rewrite is one-way -
 * once the file says 4 this tool skips it - so there is no later pass that could catch
 * it. The only honest answer is to stop.
 */
function refuseReserved(names, what, where) {
  const clash = READING_FOR.filter((n) => names.includes(n));
  if (clash.length) {
    throw new Error(
      `${what}: ${where} already names ${clash.join(', ')}, which version 3 had no such parameter for `
      + '- a hand-edited file, and converting it would let that value override the reading its mode names',
    );
  }
}

function convert(body, what) {
  // **A queued render job carries a whole project and is versioned separately**, so it
  // has to be recognised before the version gate rather than refused by it. A job
  // record is `{ version: 1, project, deliverable, capture, ... }` where `version` is
  // the *queue's* format and has nothing to do with the project's - so pointing this
  // tool at `jobs/` used to throw "version 1 is neither 3 nor 4" and never look inside.
  //
  // That mattered because of when it happens: a job enqueued before the upgrade sits
  // on disk with a version 3 snapshot inside it, and the worker hands that snapshot
  // straight to `restoreProject`, which refuses it. Every pending pre-upgrade render is
  // claimed and then fails, and nothing could repair the records. The job's own version
  // is left exactly as it is - the queue format did not change and is jobs.js's to
  // number; only the project inside moves.
  if (body?.project && typeof body.project === 'object' && !Array.isArray(body.project)) {
    // **The queue's own version is checked before the project inside it is touched.**
    // Recognising a job by its shape is what gets past the document version gate, and
    // it gets past it for every queue format rather than for the one this tool was
    // written against. A record from a later `JOB_VERSION` would be rewritten and
    // handed back still claiming that version, on the assumption that `project` will
    // go on meaning what it means today - which is the guess the rest of this file
    // refuses to make about a document. Left alone and reported instead, so a queue
    // this tool does not understand survives it intact.
    if (body.version !== JOB_VERSION) {
      throw new Error(
        `${what}: this is a queue record at version ${JSON.stringify(body.version)} and this tool `
        + `understands version ${JOB_VERSION} - what \`project\` means at that version is `
        + 'server/jobs.js\'s to say, so the record is left as it is',
      );
    }
    const inner = convert(body.project, `${what} job.project`);
    return inner ? { ...body, project: inner } : null;
  }
  if (body?.version === PROJECT_VERSION) return null;
  if (body?.version !== 3) {
    throw new Error(`${what}: version ${JSON.stringify(body?.version)} is neither 3 nor ${PROJECT_VERSION}`);
  }
  // A preset: `{ version, mode, values }` becomes `{ version, values }` with the
  // reading among the values. The order matters only in that the readings go in ahead
  // of the look, so a converted file reads the way a freshly saved one does.
  if (body.values && !body.look) {
    const { mode, values, ...rest } = body;
    refuseReserved(Object.keys(values ?? {}), what, 'values');
    return { ...rest, version: PROJECT_VERSION, values: { ...newInVersion4(mode, what), ...values } };
  }
  // A project: the same move one level down, inside `look`.
  if (body.look && typeof body.look === 'object') {
    const { mode, params, ...look } = body.look;
    // **A missing parameter map is a refusal, not an empty one.** Defaulting it to `{}`
    // writes a version 4 file carrying only the readings, which then opens - the loader
    // resets to defaults for every key the document does not name - so a damaged
    // project comes back as a plausible look nobody authored. The version 3 loader
    // refused this document; the converter must not be the thing that lets it through.
    // And it is one-way: once the file says 4, this tool skips it, so the mistake
    // cannot be found later by running the conversion again.
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new Error(`${what}: look.params is ${JSON.stringify(params)}, so there is no authored look here to convert`);
    }
    refuseReserved(Object.keys(params), what, 'look.params');
    // The tracks as well, because a keyed reading is the same file saying the same
    // thing in the other place a look lives - and a track survives the spread above
    // untouched, so nothing downstream would ever look at it again.
    if (look.tracks && typeof look.tracks === 'object') {
      refuseReserved(Object.keys(look.tracks), what, 'look.tracks');
    }
    const next = {
      ...body,
      version: PROJECT_VERSION,
      look: { ...look, params: { ...newInVersion4(mode, what), ...params } },
    };
    // **And every undo snapshot with it**, which the spread above does not reach.
    // A saved project carries its history so undo survives a reload, and each entry
    // in `history.stack` - and `history.baseline` - is a JSON string holding a whole
    // project body of its own. Converting only the top level produces a file that
    // opens perfectly and then refuses the first press of undo, because `undo` hands
    // `restoreProject` a parsed version 3 body and the version gate is the first
    // thing it meets. The baseline is worse than the stack: it is what the next edit
    // pushes, so an unconverted one goes on failing after the stack has drained.
    if (body.history !== undefined) next.history = convertHistory(body.history, what);
    return next;
  }
  throw new Error(`${what}: neither a preset nor a project - no values and no look`);
}

// How many snapshots the last `convert` rewrote, for the log line - a conversion that
// silently reached none of them is the failure this exists to prevent, so the count is
// printed beside the reading rather than left to be inferred from the file opening.
let snapshotsConverted = 0;

/**
 * The stack and the baseline, parsed, converted and re-serialised.
 *
 * Shape-checked the way `restoreProject` checks it, and for the same reason: a history
 * that is not an object with a string array is a file this build could not have written,
 * and guessing at one produces a project whose undo does something nobody saved.
 */
function convertHistory(history, what) {
  if (!history || typeof history !== 'object' || !Array.isArray(history.stack)) {
    throw new Error(`${what}: history is an object with a stack array, got ${JSON.stringify(history)}`);
  }
  if (history.baseline !== null && history.baseline !== undefined && typeof history.baseline !== 'string') {
    throw new Error(`${what}: history.baseline is a string or null, got ${JSON.stringify(history.baseline)}`);
  }
  const snapshot = (text, which) => {
    if (typeof text !== 'string') {
      throw new Error(`${what}: ${which} is a JSON string, got ${JSON.stringify(text)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`${what}: ${which} is not JSON: ${err.message}`);
    }
    const next = convert(parsed, `${what} ${which}`);
    if (!next) return text;
    snapshotsConverted++;
    // Serialised compactly, because that is what `history.snapshot` produces -
    // `JSON.stringify` with no spacing - and `commit` compares snapshots as strings.
    // A pretty-printed one would never equal the next one taken, so the first commit
    // after a reload would push a duplicate of what is already the baseline.
    return JSON.stringify(next);
  };
  return {
    ...history,
    stack: history.stack.map((text, i) => snapshot(text, `history.stack[${i}]`)),
    baseline: history.baseline == null ? history.baseline : snapshot(history.baseline, 'history.baseline'),
  };
}

let rewritten = 0;
let alreadyCurrent = 0;
let snapshots = 0;
const failed = [];

for (const dir of dirs) {
  let entries;
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    console.error(`[convert] ${dir}: ${err.message}`);
    process.exitCode = 2;
    continue;
  }
  if (!entries.length) console.log(`[convert] ${dir}: no documents`);
  for (const file of entries) {
    const path = join(dir, file);
    const what = `${dir}/${file}`;
    try {
      const body = JSON.parse(readFileSync(path, 'utf8'));
      snapshotsConverted = 0;
      const next = convert(body, what);
      if (!next) {
        alreadyCurrent++;
        continue;
      }
      const text = `${JSON.stringify(next, null, 2)}\n`;
      // Read off whichever body actually carried the mode. A job record carries none of
      // its own and holds the project that does, so the line names what moved rather
      // than throwing on a `look` the outer record never had.
      const from = body.project ?? body;
      const was = from.values ? `mode ${from.mode}` : `look.mode ${from.look?.mode}`;
      const now = READING_FOR[from.values ? from.mode : from.look.mode];
      // Named in every line rather than only when there were some, because "0 undo
      // snapshots" on a project that has a history is the tell that this reached the
      // top level and nothing else - which is the bug this count was added for.
      const undo = body.history === undefined ? '' : `, ${snapshotsConverted} undo snapshots`;
      snapshots += snapshotsConverted;
      if (DRY) {
        console.log(`[convert] would rewrite ${what}: ${was} -> ${now} 1${undo}`);
      } else {
        // Written aside and renamed, so a crash cannot leave a half-file that parses.
        const scratch = `${path}.convert.tmp`;
        writeFileSync(scratch, text);
        renameSync(scratch, path);
        console.log(`[convert] ${what}: ${was} -> ${now} 1${undo}, ${statSync(path).size} bytes`);
      }
      rewritten++;
    } catch (err) {
      failed.push(`${what}: ${err.message}`);
    }
  }
}

for (const f of failed) console.error(`[convert] FAILED ${f}`);
console.log(`\n[convert] ${DRY ? 'would rewrite' : 'rewrote'} ${rewritten} documents `
  + `and ${snapshots} undo snapshots inside them, `
  + `${alreadyCurrent} already at version ${PROJECT_VERSION}, ${failed.length} failed`);
// A document it could not convert is left exactly as it was and reported, rather than
// skipped quietly: the whole point of refusing a version 3 file at load time is that
// nobody ends up with a look they did not author, and a converter that shrugged at the
// hard ones would hand back a directory that is half converted and says so nowhere.
// **`process.exit` takes an argument, and an argument overrides `process.exitCode`.**
// A directory that could not be read sets the code to 2 on its way past and then
// carries on to the next one, so a run pointed at a missing directory inspected nothing
// and used to say 0 - which is the answer a migration script reads as "everything is on
// version 4 now". A failed document still wins with 1, because "a document failed" is
// the more specific answer than "a directory could not be listed".
process.exit(failed.length ? 1 : (process.exitCode || 0));
