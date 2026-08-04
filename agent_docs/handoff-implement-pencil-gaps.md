# Implement: the remaining Pencil-fidelity gaps (G1-G12)

Refresher copy of the settled spec. `design-qa.md` in the repo root carries the same
list plus the full audit it came from, but it is **untracked**, so this file exists so the
spec survives compaction, subagent dispatch and loop cycles. Re-read this at cycle start.

## State this work starts from

Branch `ui-rework`, dirty worktree that must be preserved. PR #51 is open against `main`
and its *committed* content is only `ui-rework.pen` plus `docs/ui-rework-proposal.md` —
every UI change is uncommitted working-tree work. `web/`, `server/` and `tools/` at
branch HEAD are byte-identical to `origin/main`; nothing has landed on `main` since.

Green at handoff, all on one hashed build:

- `editor-check --url http://localhost:8080 --no-render` -> **396 assertions, 0 failed**
- `registry-check --url http://localhost:8080` -> **PASS**
- `syntax-check` -> 40 files, 0 failed, all 331 anchors in 14 tables match once
- `npm test` -> 0 failed
- `git diff --check` clean; 0 console errors/warnings on `/`, `/gallery`, `/record`, `/edit`

Already done and **not** to be redone: per-parameter reset controls (51, all four
inspector tabs, seven mutations); sentence-case group headings; left-hand disclosure
triangles on collapsible groups only; the Export dialog's format segments over `codec`;
MOV (`prores`) and PNG-sequence (`pngseq`) support in `server/export.js`; and regressions
R1, R2, R4, R6 (R5 was withdrawn as not-a-regression).

## Decided — implement as written, do not re-open

### G1 — OBS footer status

Currently the hardcoded literal `ready`, wired to nothing. **Add a minimal consumer count
to the server.** The routes already hold connections open — `/camera.mjpg` goes through
`webcam.attach(req, res)`. Count attached responses per route and report it; light the dot
only when something is actually reading. **Drop the Stop button** — no start/stop API
exists and none is to be invented.

### G2 — Preset picker

Product ships a native `<select>` plus save/export/import buttons. **Build the custom
listbox in full**, as Pencil draws it: checkmark on the active preset, `lucide/trash-2` on
removable entries only, 24x24 add button, populated from the real preset API (builtins are
`blackwall, contour, depth, ghost, rgb` — Pencil's names are illustrative). Owning it means
owning `role="listbox"`/`role="option"`, arrow-key navigation, type-ahead, and **focus that
survives the rebuild a delete causes** — the class `viewer-drops-focus-on-rebuild` already
polices. Needs its own proof-tool section with falsification controls.

### G3 — prev/next keyframe buttons

Pencil nodes `YWZ9b` and `I4Fys` in the key-options panel. They exist nowhere in `web/`,
before or after the fork. **Build as real keyframe navigation** for the selected parameter:
seek the playhead to its previous/next key, disabled when there is none in that direction.
Note any seek-then-assert proof row is suspect under load before it is a finding.

### G4 — proof coverage for the new formats

**Close both.** Add `export-check` arms driving a real MOV and a real PNG sequence with
falsification controls, and the `EXPORT_CODECS` drift row in `editor-check` that presses
**every** format segment and asserts each writes its own codec (a stale `EXPORT_CODECS`
throws on the entry it lacks; that is the discriminator, and it needs no new page hook —
about fifteen lines plus a control that drops one entry from the array).

## Carried forward, already specified

- **G5** Home / Gallery / Record full-surface comparisons — redo from scratch. The first
  pass's comparisons are untrustworthy: its inspector crops were judged against the
  superseded 260px artboards. Re-render sources through Pencil MCP at 1440x900,
  `deviceScaleFactor: 1`, and judge the combined image.
- **G6** Group naming — **closed by decision, no work**. Pencil's type treatment adopted,
  registry structure kept.
- **G7** Pencil draws `glow` as a slider in Points; the product has `additive glow` as a
  checkbox (`additive`, kind `step`), and the only scalar that could answer to "glow" is
  `bloom`, which the registry puts in `optical`. A registry change either way — report,
  do not guess.
- **G8** Row density: Pencil pitches rows ~20px against the implementation's ~24px.
- **G9** Dead code from the first pass: `.tpin` + its four descendant rules match nothing;
  `ui.cameraGroup` has no readers; `--line-3` unused by `nav.css`.
- **G10** `input[type=checkbox]` scope creep — the first pass replaced `.check input` with a
  bare `input[type=checkbox]`, so the 12px box styles every checkbox on every page.
- **G11** `aria-current="page"` removed from all three surfaces with the `.surfacenav`
  block and never replaced. No surface says which one it is.
- **G12** Write the `DRIVER_RULES` lesson into `docs/instruments.md`: a panel control whose
  `type` no entry matches falls outside a sweep that looks exhaustive.

## The one genuine contradiction — do not resolve, do not fake

**The Browse save-path picker.** Pencil draws a `Browse` button beside an editable output
path. A browser cannot open a native save-path picker portably, and the product addresses
output through the deliverables API with real resolved paths. Not implementable as drawn.

## Non-goals

Do not redesign beyond the Pencil source. Do not fake unsupported server APIs. Do not
weaken current data, capture, export, security or ownership behaviour. Do not edit
`ui-rework.pen`. Do not discard the dirty worktree. Do not push, merge, commit, close
PR #51, label, or post public comments.

## Hard-won operational rules

- **Never `git stash`** in a worktree of this repo — one stash stack is shared across
  worktrees and a concurrent session's pop has already restored the wrong tree's files.
- **Never run two `editor-check` sweeps at once, and never edit `web/` under one.** Both
  mistakes were made this session and cost two whole measurements: a sweep straddling a
  `web/main.js` edit produced five runs at 389 assertions and a sixth at 396. Check
  `pgrep -f "tools/.*-check.mjs"` first; hash the files a run depends on before the
  baseline and again after the last mutation, and report the hashes with the numbers.
- **Count failed assertions, never exit codes**, and read *which* assertions fired. Zero
  failed with a non-zero exit is a crash to investigate. A stale assertion crashed the
  whole tool this session at 17 of 396 with 0 failed, and while a non-zero baseline
  persisted **no mutation in the file could be reported as missed**, because the count it
  is missed by was never zero.
- **A mutation cannot discriminate on a build that already carries the defect it plants.**
  `format-segments-paint-the-press` measured nothing until the underlying bug was fixed.
- Section 13's resume/autosave rows are **known flaky** — four different fired subsets
  across two builds, precondition green every time. Documented in `docs/proof-tools.md`.
  A run reddening only those is a re-run, not a finding.
- The `:8080` server holds its codec table in memory from process start. **Restart it
  before any run that actually encodes**, or the run proves nothing.

## Required reading before touching anything

`CLAUDE.md` (the shipped program is the design; report contradictions rather than silently
redesigning; one implementation only). `docs/instruments.md` before writing or modifying
any proof tool. `docs/proof-tools.md` before running one. `docs/measurement.md` before
reporting a number.

## Validation bar

Every UI claim needs real browser proof at 1440x900, `deviceScaleFactor: 1` — a passing
unit test is not a rendered frame. Every new enforced class needs a falsification control,
reported with its failed-assertion count and the exact assertion names it fired. Rerun the
`editor-check` and `registry-check` baselines and keep them at 0 failed. Update
`design-qa.md` from fresh evidence; it may say `passed` only when every row is closed by
implementation plus evidence.
