// The full sweep, with the mutation list taken from each tool rather than written
// down beside it.
//
// The list used to be four arrays in a shell script, and the step 7 fix round grew
// library-check from 18 mutations to 37 - so that script would have run 59 of 78 and
// printed "all caught", which is the shape of failure this repo keeps naming: a check
// whose coverage claim is an assertion rather than something it enforces. Each tool
// already refuses an unknown mutation with `have a, b, c`, so that refusal is the
// enumeration and nothing has to agree with anything.
//
// Judged by failed-assertion count and never by exit code. A refused anchor, a
// Playwright context destruction and a real catch all exit non-zero, so fails=0 is a
// crash to investigate rather than a success to record - retried on the crash
// signature alone and reported UNPROVEN otherwise.
//
//   node tools/sweep-all.mjs [--out <dir>]     # SWEEP_URL picks the server, :8080 by default
//
// It needs a running server and a browser, and it takes hours - this is the sweep a
// merge waits on, not something to reach for while iterating.

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
// Aliased because every promise in this file names its own `resolve`, and a path
// helper that four callbacks quietly shadow is a trap for whoever edits it next.
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

// Both of these were absolute paths belonging to the session that wrote this file - a
// worktree and a scratchpad that exist on one machine, for one afternoon. So the tool
// ran nothing anywhere else, and the way it failed was to spawn `node tools/...` in a
// directory that is not a checkout, which arrives as every mutation reporting UNPROVEN
// rather than as a missing path. The repo is found from this file instead, because a
// tool that lives in `tools/` already knows where the tree is.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const OUT = resolvePath(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : join(ROOT, '.sweep-all'));
const URL = process.env.SWEEP_URL ?? 'http://localhost:8080';
const CRASH = 'Execution context was destroyed';
const TOOLS = ['library', 'timeline', 'keyframe', 'export'];

mkdirSync(OUT, { recursive: true });
// The summary is written once, at the end. So a previous run's file sits here for
// the whole of this one, and anything waiting on "does SUMMARY.txt say it is done"
// is answered immediately by the run before - which is how a 78-mutation result
// got read as this run's while it was 17 into 85. Removed up front so the
// artifact cannot outlive the thing it describes: absent means running, present
// means finished, and there is no third state that looks like the second.
rmSync(join(OUT, 'SUMMARY.txt'), { force: true });

function run(tool, args, timeoutMs = 900_000) {
  return new Promise((resolve) => {
    const child = spawn('node', [`tools/${tool}-check.mjs`, ...args], { cwd: ROOT });
    // Decoded through a StringDecoder rather than by concatenating Buffers. `out += c`
    // calls toString() per chunk, so a multi-byte sequence straddling a chunk boundary
    // becomes two replacement characters and the line it was on is corrupted - which
    // would silently cost a `  FAIL ` match and report a mutation as uncaught. A stray
    // byte in one of these logs already made a plain grep return nothing during the
    // review, which is the same failure with the same consequence: a check that found
    // nothing and a check nobody could read look identical to a counter.
    const decoder = new StringDecoder('utf8');
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c) => { out += decoder.write(c); });
    child.stderr.on('data', (c) => { out += decoder.write(c); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      out += decoder.end();
      resolve({ code, signal, out });
    });
  });
}

// The refusal message is the enumeration. A tool that stopped refusing - or that
// changed the wording - has to be noticed rather than silently yielding zero
// mutations, so an unparseable refusal throws.
async function enumerate(tool) {
  const { out } = await run(tool, ['--mutate', '__enumerate__'], 60_000);
  const m = out.match(/unknown mutation __enumerate__ - have ([^\n]+)/);
  if (!m) throw new Error(`${tool}-check did not enumerate its mutations:\n${out.slice(0, 800)}`);
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

const rows = [];
let unproven = 0;

for (const tool of TOOLS) {
  const names = await enumerate(tool);
  console.log(`[sweep] ${tool}: ${names.length} mutations declared`);
  for (const name of names) {
    let attempt = 0;
    for (;;) {
      attempt++;
      const { code, out } = await run(tool, ['--url', URL, '--mutate', name]);
      writeFileSync(join(OUT, `${tool}-${name}.log`), out);
      const fails = (out.match(/^ {2}FAIL /gm) ?? []).length;
      if (fails > 0) {
        rows.push({ tool, name, verdict: 'CAUGHT', fails, code, attempt });
        console.log(`  CAUGHT   ${tool}/${name} fails=${fails} rc=${code} attempt=${attempt}`);
        break;
      }
      if (out.includes(CRASH) && attempt < 3) {
        writeFileSync(join(OUT, `${tool}-${name}.crash${attempt}.log`), out);
        console.log(`  ...crash ${tool}/${name} attempt=${attempt}, retrying`);
        continue;
      }
      rows.push({ tool, name, verdict: 'UNPROVEN', fails: 0, code, attempt });
      unproven++;
      console.log(`  UNPROVEN ${tool}/${name} fails=0 rc=${code} attempt=${attempt}`);
      break;
    }
  }
}

const byTool = Object.fromEntries(TOOLS.map((t) => [t, rows.filter((r) => r.tool === t).length]));
const summary = [
  ...rows.map((r) => `${r.tool.padEnd(9)} ${r.name.padEnd(32)} ${r.verdict.padEnd(9)} fails=${String(r.fails).padEnd(3)} rc=${r.code} attempt=${r.attempt}`),
  '--- totals ---',
  ...TOOLS.map((t) => `${t}: ${byTool[t]}`),
  `total mutations: ${rows.length}`,
  `caught:          ${rows.filter((r) => r.verdict === 'CAUGHT').length}`,
  `unproven:        ${unproven}`,
].join('\n');
writeFileSync(join(OUT, 'SUMMARY.txt'), `${summary}\n`);
console.log(`\n${summary}`);
process.exit(unproven === 0 ? 0 : 1);
