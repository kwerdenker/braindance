#!/usr/bin/env node
// Parses every JavaScript file this repo ships. Nothing else - no server, no browser,
// no sensor, no dependencies - which is what makes it the one thing CI can run on a
// fresh clone and mean it.
//
//   node tools/syntax-check.mjs [--root <dir>]
//
// A syntax checker that finds no files exits 0, and that is the whole reason this is a
// tool rather than a `find | xargs node --check` in package.json. Rename a directory,
// get a glob subtly wrong, run it from the wrong place, and the clean pass it prints is
// about nothing at all - the coverage claim that is an assertion rather than something
// enforced, which this repo keeps writing paragraphs about. So the roots have to exist,
// each has to yield files, the count has to clear a floor, and the count is printed
// beside the verdict so a number that has quietly halved is visible rather than implied.
//
// The floors are a tripwire and not a manifest. They are set well under what the tree
// holds, because a floor that tracks the real count exactly becomes a chore that gets
// bumped without being read, and the failure being guarded against is zero rather than
// one fewer than last week.
//
// **`node --check` can stop detecting syntax errors entirely, and it does it quietly.**
// Found by mutation rather than by reading, on the first control this tool was given: a
// copy of the tree with `const a = {` appended to `web/format.js` passed all 33 files,
// zero failed, exit 0. The copy had no `package.json`, so Node had nothing to say
// whether a `.js` file is a module - and in that state a `.js` file that *looks* like
// ESM and is also broken comes back rc=0 on v26.0.0, while the identical content as
// `.mjs`, or under either `"type"`, comes back rc=1. Measured all four ways. So the root
// must carry a `package.json`, and, because "must" is a word rather than a mechanism,
// the same broken file is fed through first and the run refuses to continue unless it is
// rejected. Without that canary this whole tool is a green light wired to nothing.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : REPO;

// The server, the tools and the browser bundle. Everything else with a .js in it is
// either vendored, built or a capture, and none of those are ours to parse.
const FLOORS = { server: 5, tools: 12, web: 2 };

// **Two different questions, so two different sets, and the difference is the point.**
// `PARSES` is what `node --check` can be handed and have its answer mean anything - a
// shell script fed to it fails as a syntax error about JavaScript, which would be a red
// light wired to the wrong thing. `SHIPPED` is what counts as a tool this repo ships,
// and it is wider because the questions asked of `tools/` below - is it documented, does
// its citation resolve - are about the file being ours rather than about it parsing.
//
// Named once and used by both because the version where each block spelled its own set
// out drifted immediately: the documentation block already read `.sh` while the citation
// scan reused the JavaScript walker, so `pi-registration-ab.sh` was required to be named
// in CLAUDE.md and then never read for the `docs/` pages it might cite. A tool added in
// another language next year joins both questions at once by being added here.
const PARSES = /\.(js|mjs)$/;
const SHIPPED = /\.(js|mjs|sh)$/;

const check = (file) => {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    return null;
  } catch (err) {
    return (err.stderr || err.message || '').toString().trim();
  }
};

let failed = 0;
const fail = (line) => { failed++; console.log(`  FAIL  ${line}`); };

// A missing root, or one with no package.json, is the operator pointing this at
// something that is not a checkout - "the check did not run" rather than "the check
// found something", which is the reading the rest of the suite gives exit 2.
const missing = ['package.json', ...Object.keys(FLOORS)].filter((name) => !existsSync(join(ROOT, name)));
if (missing.length) {
  console.log(`DID NOT RUN - ${ROOT} has no ${missing.join(', ')}, so this is not a checkout of this repo`);
  process.exit(2);
}

// The canary, in a directory of its own governed by this root's own `package.json`, so
// the thing being proved is the parse mode this run will actually get. It is a `.js`
// rather than a `.mjs` on purpose: `.mjs` is unambiguous and would sail through the
// exact configuration that swallows the error.
const scratch = mkdtempSync(join(tmpdir(), 'syntax-check-'));
try {
  copyFileSync(join(ROOT, 'package.json'), join(scratch, 'package.json'));
  const canary = join(scratch, 'canary.js');
  writeFileSync(canary, 'export const broken = {\n');
  if (check(canary) === null) {
    console.log('DID NOT RUN - node --check accepted a file that does not parse, so nothing below would have found one either');
    console.log(`  ${process.execPath} ${process.version}, root ${ROOT}`);
    process.exit(2);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// Symlinked directories are skipped rather than walked. In a git worktree the heavy
// shared trees are symlinked back to the main checkout - .gitignore's own header
// records vendor and node_modules arriving that way - and following one turns a
// six-second check into a parse of somebody else's library.
// Which files it yields is the caller's question rather than the walker's, so the two
// sets above stay one decision made in one place.
function walk(dir, matches, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, matches, out);
    else if (matches.test(entry.name)) out.push(p);
  }
  return out;
}

let total = 0;
for (const [name, floor] of Object.entries(FLOORS)) {
  const files = walk(join(ROOT, name), PARSES);
  total += files.length;
  if (files.length < floor) {
    fail(`${name}/ holds ${files.length} JavaScript files, under the floor of ${floor} - either the tree lost something or this walk stopped finding it`);
  }
  for (const file of files) {
    const err = check(file);
    // Node pads its report with blank lines around the offending source, and a plain
    // head of it printed four of them and cut the `SyntaxError:` line off the bottom -
    // a failure that named the file and nothing about what was wrong with it.
    if (err) fail(`${relative(ROOT, file)}\n          ${err.split('\n').filter((l) => l.trim()).slice(0, 4).join('\n          ')}`);
  }
  console.log(`  ${name}/  ${files.length} files parsed`);
}

// **Every tool has to be named in CLAUDE.md, and this is what makes that true rather
// than aspirational.** The list in that file is how anybody finds the suite, and the
// maintained-by-hand version of it had already rotted badly: it said "all six" tools
// refuse an unmatched mutation where eleven do, documented a `--url` flag
// `library-check` does not have, and omitted `sensor-view-check` altogether - a
// 1277-line proof tool that `editor-check` cites three times by name. A tool nobody
// documented is a tool nobody runs, and the file that was supposed to prevent that was
// itself the thing drifting.
//
// Fixing the names would have closed the instance and left the class open. So the
// question is asked of the directory rather than of a list: anything in `tools/` that
// CLAUDE.md does not mention fails here, and a tool added next year is asked by
// existing. The control is adding a file to `tools/` without documenting it.
//
// Checked by basename rather than by path, because the file refers to them both ways -
// `node tools/vendor-check.mjs` in the invocation blocks and bare `vendor-check` in the
// prose - and requiring one spelling would be a rule about formatting rather than about
// coverage.
const DOC = join(ROOT, 'CLAUDE.md');
if (!existsSync(DOC)) {
  fail('CLAUDE.md is missing, so the claim that every tool is documented cannot be tested');
} else {
  const doc = readFileSync(DOC, 'utf8');
  const shipped = readdirSync(join(ROOT, 'tools'))
    .filter((f) => SHIPPED.test(f))
    .sort();
  const undocumented = shipped.filter((f) => !doc.includes(f));
  if (shipped.length === 0) {
    fail('tools/ yielded no tools to check against CLAUDE.md, so this assertion passed on nothing');
  } else if (undocumented.length) {
    fail(`CLAUDE.md never mentions ${undocumented.join(', ')} - a tool nobody documented is a tool nobody runs`);
  } else {
    console.log(`  tools/  all ${shipped.length} named in CLAUDE.md`);
  }
}

// **And every `docs/*.md` anything points at has to exist**, for the same reason and by
// the same shape as the block above. `CLAUDE.md` was 704 lines and was split into three
// documents it now sends you to by name, with fourteen comments in `tools/` citing those
// documents by section - so the disclosure chain is load-bearing and nothing was checking
// it. Delete one of the three and every citation resolves to nothing while this tool stays
// green, which is a claim asserted in prose with nothing bringing it about.
//
// Enumerated rather than listed: the paths are read out of what actually cites them, so a
// fourth document added next year is checked by existing and a pointer that outlives its
// target fails here. The control is `mv docs/instruments.md /tmp` and a run.
//
// **Every shipped tool, and not every parseable one.** The first version of this block
// reused the JavaScript walker, which is the same class of hole it was written to close:
// `pi-registration-ab.sh` is a documented tool that the scan could not read, so a `docs/`
// page cited from a shell runbook was covered by an assertion that printed "all N cited
// pages exist" and had never opened the file. Measured rather than argued - a citation of
// an absent page appended to that runbook left the check green, and fails here now that
// the walk asks for `SHIPPED`. That is the control, and running it takes a path this
// comment deliberately does not spell: the scan reads its own prose, so a filename
// written here as an example is a citation like any other and fails the run that quotes
// it. Append the line to the runbook, run, revert.
{
  const citing = [join(ROOT, 'CLAUDE.md'), ...walk(join(ROOT, 'tools'), SHIPPED)];
  const cited = new Set();
  for (const file of citing) {
    if (!existsSync(file)) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(/\bdocs\/[A-Za-z0-9._-]+\.md\b/g)) cited.add(m[0]);
  }
  const missing = [...cited].filter((p) => !existsSync(join(ROOT, p))).sort();
  if (cited.size === 0) {
    fail('nothing cites a docs/ page, so this assertion passed on nothing - the disclosure chain is gone or this scan is looking in the wrong place');
  } else if (missing.length) {
    fail(`${missing.join(', ')} is cited but does not exist - a pointer that outlives its target teaches a document nobody can read`);
  } else {
    console.log(`  docs/   all ${cited.size} cited pages exist`);
  }
}

// **A mutation is a piece of source text, and until this row nothing checked that the
// text still existed.** Every claim this suite makes about the tree is proved by running
// a mutation and reading which assertions fired, so a mutation whose anchor no longer
// matches proves nothing at all - and it fails in the direction that reads as success.
// Of the three found when this row was written, two threw at module top level: a stack
// trace, a non-zero exit and **zero failed assertions**, which is precisely what a caught
// mutation looks like to anything reading exit codes instead of counting failures. The
// third refused politely with exit 2. `docs/instruments.md` carries the case file, and
// the previous instance of this same drift was closed at `keyframe-check`'s
// `undo-includes-view` without closing the class - which is how three more went stale.
//
// **A duplicate is as stale as a miss**, and that is the half a naive row drops. The
// defect that prompted this was an anchor matching *two* sites, because one conversion
// had been copied to a second place, and a row asking "does this text appear" rather than
// "exactly once" sails straight past it while looking thorough.
//
// Nothing here executes a tool. The table is read by cutting the tool's source at the end
// of the declaration, appending an export, and importing that prefix from inside `tools/`
// so the tool's own relative imports still resolve. Two properties of that cut were
// measured rather than assumed: no tool that declares a table does side-effectful
// top-level work above the declaration, and the terminator is the first `};` at column
// zero, because no table body contains a line starting there. The second is an invariant
// rather than a guarantee, so a prefix that does not import fails the row instead of being
// quietly read as "this tool has no table".
//
// The target file is resolved from each entry's *shape* rather than from the tool's name,
// because a hardcoded list of tools is the exact failure `sweep-all`'s header records from
// its own shell ancestor: four arrays that would have run 59 of 78 mutations and printed
// "all caught". There are six shapes, which is five more than there should be - and the
// honest fix is normalising them onto `{ file, edits }`, which this row is the regression
// test for. A seventh fails naming the tool rather than being skipped, because a
// deliberate exclusion arrives with a justification that stops anybody looking twice.
//
// Last of the three rows on purpose: it is the only one that writes a file into `tools/`,
// so a crash that leaks the prefix cannot make the same run's documentation row fail for a
// reason that has nothing to do with the tree.
{
  const DECLARATION = /^const MUTATIONS = \{$/m;
  // Where a shape that does not carry its own target points. Both are facts about the
  // shape rather than about any tool: a bare `[from, to]` pair is only ever the C++
  // registration mutation, and the three JavaScript shapes all edit the browser bundle.
  const MAIN = 'web/main.js';
  const REGISTRATION = 'third_party/libfreenect2/src/registration.cpp';
  // One name reused for every extraction, so a crash can leak at most one file, and
  // dotted-and-suffixed so the documentation row above catches it on the next run rather
  // than letting it sit in `tools/` looking like something this repo ships.
  const PROBE = join(ROOT, 'tools', '.mutation-table-probe.mjs');

  /** What a single entry anchors on, or why it anchors on nothing, or null for unknown. */
  const shapeOf = (spec) => {
    if (Array.isArray(spec)) {
      // Both array shapes are pairs, so `Array.isArray` alone cannot tell them apart -
      // it is the first element that says which. Read it wrong and every registration
      // anchor reports hundreds of hits, which is loud and still wrong.
      if (typeof spec[0] === 'string') return { file: REGISTRATION, from: [spec[0]] };
      if (Array.isArray(spec[0])) return { file: MAIN, from: spec.map(([from]) => from) };
      return null;
    }
    if (typeof spec === 'function') return { anchorless: 'functions that redirect the oracle' };
    if (spec === null || typeof spec === 'string') return { anchorless: 'whole replacement file bodies' };
    if (typeof spec === 'object') {
      if (typeof spec.file === 'string' && Array.isArray(spec.edits)) {
        return { file: spec.file, from: spec.edits.map(([from]) => from) };
      }
      if (typeof spec.from === 'string') return { file: MAIN, from: [spec.from] };
    }
    return null;
  };

  const targets = new Map();
  const targetSource = (path) => {
    if (!targets.has(path)) {
      const full = join(ROOT, path);
      targets.set(path, existsSync(full) ? readFileSync(full, 'utf8') : null);
    }
    return targets.get(path);
  };

  let tablesDeclared = 0, tablesWithAnchors = 0, anchorsChecked = 0, stale = 0;
  const anchorless = [];
  for (const name of readdirSync(join(ROOT, 'tools')).filter((f) => PARSES.test(f)).sort()) {
    const source = readFileSync(join(ROOT, 'tools', name), 'utf8');
    const declared = DECLARATION.exec(source);
    if (!declared) continue;
    tablesDeclared++;
    const end = source.indexOf('\n};', declared.index);
    if (end === -1) {
      fail(`${name} declares a MUTATIONS table with no terminator at column zero, so its anchors cannot be read`);
      continue;
    }
    let table = null;
    try {
      writeFileSync(PROBE, `${source.slice(0, end + 3)}\nexport { MUTATIONS };\n`);
      // Cache-busted, because fifteen tools are imported through one filename and Node
      // would otherwise hand back the first tool's table fourteen more times - which
      // would read as every anchor matching and is the quietest possible way for this
      // row to pass on nothing.
      ({ MUTATIONS: table } = await import(`file://${PROBE}?tool=${encodeURIComponent(name)}`));
    } catch (err) {
      fail(`${name}: its MUTATIONS table could not be read - ${String(err.message).split('\n')[0]}`);
    } finally {
      rmSync(PROBE, { force: true });
    }
    if (!table) continue;

    let carriesAnchors = false;
    for (const [mutation, spec] of Object.entries(table)) {
      const shape = shapeOf(spec);
      if (!shape) {
        fail(`${name}/${mutation} declares a MUTATIONS shape this row does not recognise, and a shape nobody checks is a control nobody proved`);
        continue;
      }
      if (shape.anchorless) {
        if (!anchorless.some((a) => a.name === name)) anchorless.push({ name, why: shape.anchorless });
        continue;
      }
      const body = targetSource(shape.file);
      if (body === null) {
        fail(`${name}/${mutation} anchors into ${shape.file}, which does not exist`);
        continue;
      }
      for (const from of shape.from) {
        carriesAnchors = true;
        anchorsChecked++;
        const hits = body.split(from).length - 1;
        if (hits !== 1) {
          stale++;
          fail(`${name}/${mutation} matches ${hits} times in ${shape.file}, expected exactly 1`
            + ` - ${hits === 0 ? 'the text it anchors on has moved, so this control cannot run' : 'the text it anchors on appears more than once, so the tool refuses it'}`);
        }
      }
    }
    if (carriesAnchors) tablesWithAnchors++;
  }

  // Printed rather than absorbed: a table with nothing to check is a real answer, and one
  // the count would otherwise hide behind a total that looks complete.
  for (const { name, why } of anchorless) {
    console.log(`  anchors/ ${name} declares ${why} rather than source anchors, so it has none to check`);
  }
  if (anchorsChecked === 0) {
    fail('no mutation anchors were checked at all, so this assertion passed on nothing - the tables moved or this scan is looking in the wrong place');
  } else if (stale) {
    // Counted separately from the total rather than folded into it, because "239
    // checked" beside three FAIL lines is the number a reader needs and "all 239 match"
    // over the top of them would be this row asserting the very thing it just disproved.
    console.log(`  anchors/ ${anchorsChecked} checked in ${tablesWithAnchors} tables of ${tablesDeclared} declared, ${stale} not matching exactly once`);
  } else {
    console.log(`  anchors/ all ${anchorsChecked} in ${tablesWithAnchors} tables match once, of ${tablesDeclared} declared`);
  }
}

console.log(`\n${total} JavaScript files, ${failed} failed`);
// Said out loud because `npm test` runs this, and a green `npm test` that meant "the
// suite passed" would be the most expensive wrong impression in the repo. Nothing here
// executes a line of what it parsed.
console.log('syntax only - no proof tool ran here; see CLAUDE.md "Proof tools" for the suite and what each of them needs');
process.exit(failed ? 1 : 0);
