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

// **The hello the grabber emits and the hello the README documents have to be the same
// set of keys, and the constant saying which generation wrote it has to be the same
// number in both languages.**
//
// The prose block was nine keys against the thirteen actually emitted for long enough
// that the four it omitted became the argument for this: `startedAt` is the only durable
// capture date a take has, and somebody implementing a second producer against the
// documented nine writes takes the library dates by file modification time instead - which
// changes the first time a take is copied off the node, and degrades *quietly*, because
// the fallback is legitimate and says `dateSource: 'mtime'` rather than failing.
//
// Three details decide whether this is an instrument or a green light wired to nothing,
// and all three are the same rule as the two blocks above.
//
// **Both directions.** A key emitted and not documented is the failure that already
// happened; a key documented and not emitted is somebody writing against a promise the
// grabber does not keep, which is the same reader misled by the opposite mistake.
//
// **Scoped anchors, and an empty extraction is a failure rather than a pass.** A bare
// `readme.includes('width')` is true of the word appearing anywhere in a 700-line file,
// so the README side is cut to the `type 1 hello` stanza and stops at `type 2`, and the
// grabber side to the one `snprintf` that builds the hello. Zero keys from either side
// means the anchor moved and the comparison ran on nothing, which is exactly the shape
// this tool's own header is about.
//
// **Read textually, never imported.** This tool takes `--root`, so an `import` would bind
// the assertion to this checkout while claiming to have checked another tree - and the C++
// constant could not be imported at all, which is the whole reason it needs watching: it
// is unavoidably a second spelling of a JavaScript number, and nothing else in the repo
// would notice the two drifting.
//
// The controls are run by hand, in the idiom the two blocks above use, because this tool
// carries no `--mutate` harness: add a key to the grabber literal and not to the README,
// then the other way round, then bump the constant in one language, and require a named
// failure each time.
{
  const grabberPath = join(ROOT, 'native/grabber.cpp');
  const readmePath = join(ROOT, 'README.md');
  if (!existsSync(grabberPath) || !existsSync(readmePath)) {
    fail('native/grabber.cpp or README.md is missing, so the hello the format claims to have cannot be tested against the one it emits');
  } else {
    const grabber = readFileSync(grabberPath, 'utf8');
    const readme = readFileSync(readmePath, 'utf8');

    // The literal that builds the hello, from the call to its closing paren. Anchored on
    // the call rather than on the opening brace of the JSON, because the brace is a
    // character that appears everywhere and the call appears once.
    const callAt = grabber.indexOf('std::snprintf(hello, sizeof(hello),');
    const literal = callAt === -1 ? '' : grabber.slice(callAt, grabber.indexOf(');', callAt));
    // `\"name\":` as it is spelled in C++ source. The `%s` values between them cannot
    // match, because a conversion specifier does not start with a letter.
    const emitted = new Set([...literal.matchAll(/\\"([A-Za-z][A-Za-z0-9]*)\\":/g)].map((m) => m[1]));

    // The stanza, and only the stanza: from the type 1 line to the type 2 line, then the
    // braced list inside it. Splitting a brace on commas rather than scanning for words
    // keeps the prose around it - "UTF-8 JSON, once, before any frame" - out of the set.
    const stanzaAt = readme.indexOf('type 1  hello');
    const stanza = stanzaAt === -1 ? '' : readme.slice(stanzaAt, readme.indexOf('type 2', stanzaAt));
    const braced = stanza.match(/\{([^}]*)\}/);
    const documented = new Set((braced?.[1] ?? '').split(',').map((k) => k.trim()).filter(Boolean));

    if (emitted.size === 0) {
      fail('no hello keys found in native/grabber.cpp - the snprintf anchor moved, so this comparison would have passed on nothing');
    } else if (documented.size === 0) {
      fail("no hello keys found in README.md's type 1 hello stanza - the anchor moved, so this comparison would have passed on nothing");
    } else {
      const undocumented = [...emitted].filter((k) => !documented.has(k)).sort();
      const unemitted = [...documented].filter((k) => !emitted.has(k)).sort();
      // Two failures rather than one, because which direction it broke in is the whole
      // diagnosis: one is a writer that grew a key nobody was told about, the other is a
      // reader promised a key that never arrives.
      if (undocumented.length) {
        fail(`the grabber's hello emits ${undocumented.join(', ')} and README.md's type 1 hello does not document ${undocumented.length === 1 ? 'it' : 'them'}`);
      }
      if (unemitted.length) {
        fail(`README.md's type 1 hello documents ${unemitted.join(', ')} and the grabber does not emit ${unemitted.length === 1 ? 'it' : 'them'}`);
      }
      if (!undocumented.length && !unemitted.length) {
        console.log(`  hello/  all ${emitted.size} keys emitted are documented, and back`);
      }
    }

    // The format generation, in the two languages that have to agree about it. Anchored
    // on the declaration in each rather than on any mention, so a comment naming the
    // constant is not a second reading of its value.
    const inJs = readFileSync(join(ROOT, 'web/format.js'), 'utf8').match(/^export const CAPTURE_FORMAT = (\d+);/m);
    const inCpp = grabber.match(/^static const uint32_t CAPTURE_FORMAT = (\d+);/m);
    if (!inJs || !inCpp) {
      fail(`CAPTURE_FORMAT is not declared where this looked: ${inJs ? '' : 'web/format.js '}${inCpp ? '' : 'native/grabber.cpp'}`.trim()
        + ' - one of the two declarations moved, and an undeclared constant cannot be compared with anything');
    } else if (inJs[1] !== inCpp[1]) {
      fail(`CAPTURE_FORMAT is ${inJs[1]} in web/format.js and ${inCpp[1]} in native/grabber.cpp - `
        + 'the grabber would stamp a generation the band that reads it refuses, on every take shot after this');
    } else {
      console.log(`  format/ CAPTURE_FORMAT is ${inJs[1]} in both languages`);
    }
  }
}

console.log(`\n${total} JavaScript files, ${failed} failed`);
// Said out loud because `npm test` runs this, and a green `npm test` that meant "the
// suite passed" would be the most expensive wrong impression in the repo. Nothing here
// executes a line of what it parsed.
console.log('syntax only - no proof tool ran here; see CLAUDE.md "Proof tools" for the suite and what each of them needs');
process.exit(failed ? 1 : 0);
