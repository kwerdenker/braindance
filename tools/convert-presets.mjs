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
//   node tools/convert-presets.mjs presets projects        # rewrite in place
//   node tools/convert-presets.mjs --dry-run presets       # say what it would do
//
// Every rewrite is written aside and renamed, for the reason `DocumentStore.write`
// does it: a crash partway through must not leave a file that parses and describes
// something nobody saved.

import { readdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_VERSION } from '../web/format.js';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const dirs = argv.filter((a) => !a.startsWith('--'));

if (!dirs.length) {
  console.error('usage: convert-presets.mjs [--dry-run] <dir> [dir...]');
  console.error('  rewrites version 3 presets and projects as version 4 in place');
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

function convert(body, what) {
  if (body?.version === PROJECT_VERSION) return null;
  if (body?.version !== 3) {
    throw new Error(`${what}: version ${JSON.stringify(body?.version)} is neither 3 nor ${PROJECT_VERSION}`);
  }
  // A preset: `{ version, mode, values }` becomes `{ version, values }` with the
  // reading among the values. The order matters only in that the readings go in ahead
  // of the look, so a converted file reads the way a freshly saved one does.
  if (body.values && !body.look) {
    const { mode, values, ...rest } = body;
    return { ...rest, version: PROJECT_VERSION, values: { ...readingsFrom(mode, what), ...values } };
  }
  // A project: the same move one level down, inside `look`.
  if (body.look && typeof body.look === 'object') {
    const { mode, params, ...look } = body.look;
    return {
      ...body,
      version: PROJECT_VERSION,
      look: { ...look, params: { ...readingsFrom(mode, what), ...(params ?? {}) } },
    };
  }
  throw new Error(`${what}: neither a preset nor a project - no values and no look`);
}

let rewritten = 0;
let alreadyCurrent = 0;
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
      const next = convert(body, what);
      if (!next) {
        alreadyCurrent++;
        continue;
      }
      const text = `${JSON.stringify(next, null, 2)}\n`;
      const was = body.values ? `mode ${body.mode}` : `look.mode ${body.look?.mode}`;
      const now = READING_FOR[body.values ? body.mode : body.look.mode];
      if (DRY) {
        console.log(`[convert] would rewrite ${what}: ${was} -> ${now} 1`);
      } else {
        // Written aside and renamed, so a crash cannot leave a half-file that parses.
        const scratch = `${path}.convert.tmp`;
        writeFileSync(scratch, text);
        renameSync(scratch, path);
        console.log(`[convert] ${what}: ${was} -> ${now} 1, ${statSync(path).size} bytes`);
      }
      rewritten++;
    } catch (err) {
      failed.push(`${what}: ${err.message}`);
    }
  }
}

for (const f of failed) console.error(`[convert] FAILED ${f}`);
console.log(`\n[convert] ${DRY ? 'would rewrite' : 'rewrote'} ${rewritten}, `
  + `${alreadyCurrent} already at version ${PROJECT_VERSION}, ${failed.length} failed`);
// A document it could not convert is left exactly as it was and reported, rather than
// skipped quietly: the whole point of refusing a version 3 file at load time is that
// nobody ends up with a look they did not author, and a converter that shrugged at the
// hard ones would hand back a directory that is half converted and says so nowhere.
process.exit(failed.length ? 1 : 0);
