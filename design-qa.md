# Design QA — the Pencil-fidelity gaps G1–G12

Rewritten from fresh evidence. A row reads `passed` only where there is an implementation
**and** evidence for it; anything else says what is missing. Counts here are failed
assertions read off each run, never exit codes.

The first pass's audit has been deleted rather than kept beside this one. Its inspector crops
were judged against superseded 260px artboards where the current panel is 252px, so its
comparisons were untrustworthy and a second document that disagrees with this one is worse
than none — the same argument the repo already makes for deleting a design doc once the thing
it describes is shipped.

## How these numbers were taken, and what would invalidate them

**The server was restarted first, and it mattered.** The process holding `:8080` at the start
of the session had been up since 04:57 and predated the working tree's `server/index.js`
(13:25) and `server/export.js` (13:31) by eight hours — it did not carry the MOV and
PNG-sequence support under test. Every number below was taken against a server started after
those edits. Measured against the old process, an export check would have been run on a build
whose codec table had never heard of `prores`.

**The first `editor-check` after a restart crashes, and it is not a finding.** Against a cold
server the run died `DID NOT RUN`, exit 2, `page.reload: Timeout 30000ms exceeded`, at **311
assertions with 0 failed**. The second run on the warmed server was 396/0. Budget one
throwaway run after every restart and never read it as a result.

**One run at a time** — `pgrep -f "tools/.*-check.mjs"` before each, and no `web/` edit under
a running sweep.

Files the runs depend on, hashed before the first baseline:

```
69b2158a…  web/main.js       bfabb0bd…  web/index.html    1637fbc5…  web/nav.css
24e92234…  web/library.js    ad895d60…  web/library.html  1f2aed0e…  web/menu.html
ceb5e6f7…  server/export.js  c6c8217b…  server/index.js
ab90c1d5…  tools/editor-check.mjs       2ccc593f…  tools/export-check.mjs
```

## Baselines, before and after

| Check | Before | After |
|---|---|---|
| `editor-check --no-render` | 396 assertions, 0 failed | **415 assertions, 0 failed** |
| `export-check` | 45/45 passed, 0 failed | **47/47 passed, 0 failed** |
| `registry-check` | PASS, 55 of 57 parameters reach the pixels | **PASS**, 55 of 57 |
| `syntax-check` | 40 files, 0 failed, 331 anchors in 14 tables | 40 files, 0 failed, **338 anchors** in 14 tables |
| `npm test` | 0 failed | **0 failed** |
| `git diff --check` | clean | **clean** |

The `editor-check` climb accounts for itself: +8 section 18 (keyframe nav), +1 the
`EXPORT_CODECS` drift row, +1 the picker-holds-its-value row, +9 section 19 (preset picker).

## The gaps

| # | Gap | Status | Evidence |
|---|---|---|---|
| G1 | OBS footer status | **passed** | `webcam.#reap()` drops any subscriber whose `res.destroyed \|\| res.writableEnded` and settles, so the dot and the recorder's refusal both read the **resource** rather than the Set that tracks it. The client polls `/record/state` — a 1.2ms in-memory route already carrying `webcam.subscribers` — every 2s and only while the dialog is open, stopping on the dialog's own `close` event so Escape and the close glyph are covered. Driven at 1440x900 against a server with a real colour camera: idle with the dot dark → one real `/camera.mjpg` consumer → `streaming to 1 source` with the dot lit → consumer gone → idle again. **No Stop button**: the design draws one, the product has no start/stop API, and none was invented. |
| G2 | Preset picker | **passed** | `#tPreset` and `#recPreset` are now `button[role=combobox]` triggers over `div[role=listbox]` lists of `div[role=option]`, with a check on the applied entry, `lucide/trash-2` on user presets only, and a 24x24 add button on the editor's picker. `editor-check` **section 19**, 9 rows, all green; two controls below. |
| G3 | prev/next keyframe | **passed** | `#tPrevKey`/`#tNextKey` in `#tEase`, seeking through the existing `goTo()`. `editor-check` **section 18**, 8 rows, landed times printed; two controls below. |
| G4 | Proof for the new formats | **passed** | A real ProRes `.mov` and a real 9-file PNG sequence encoded and probed, plus the `EXPORT_CODECS` drift row pressing every format segment. Three controls, and a delivery failure found and fixed. |
| G5 | Home / Gallery / Record comparisons | **redone** | `agent_docs/g5-surface-comparisons.md`. Re-rendered from Pencil and re-shot at 1440x900, deviceScaleFactor 1 — the first pass judged inspector crops against superseded 260px artboards where the current panel is 252px. **28 findings: 15 product-wins, 13 gaps, 0 not-implementable.** The three worth acting on are the Record surface's inert section heads (the design draws disclosure triangles and the collapse machinery already ships on that page), its 17px section spacing against the design's 25px with title weight 400 against 500, and the Gallery tab strip's `#05070a` against the design's `#0d1014`. Two findings are design-side drift and belong in the `.pen` rather than the code: the Home artboard declares `SFMono-Regular` where its siblings declare `JetBrains Mono`, and the Record artboard's base fill is `#0d1014` where its siblings are `#05070a`. **None of these 13 were implemented** — G5 was scoped as a comparison, and acting on them is a separate decision. |
| G6 | Group naming | **closed by decision** | No work. The design's type treatment adopted, the registry's structure kept. |
| G7 | `glow` | **reported, not guessed** | Below. No registry change made. |
| G8 | Row density | **passed** | Measured both before and after; table below. |
| G9 | Dead code | **passed** | `.tpin` and its four descendant rules removed with their comment (`#tExportNote` had moved into `.dialog-actions`, and a global `#tExportNote:empty` rule already covers the empty case); `ui.cameraGroup` removed (the `#cameraGroup` **element** is live via `data-panel-tab` — only the JS handle was dead); `--line-3` removed from `menu.html`, which is the one of its three declarations nothing reads, since menu.html loads only `nav.css` and that uses `--line` and `--line-2`. |
| G10 | Checkbox scope creep | **passed** | Below. |
| G11 | `aria-current="page"` | **passed, with a correction to the premise** | Below. |
| G12 | The `DRIVER_RULES` lesson | **passed** | Written into `docs/instruments.md` immediately after the barren-rule entry, naming the seam between them. |

## G8, measured rather than reasoned

At 1440x900, deviceScaleFactor 1, over the editor's visible panel rows:

| | rows | height | pitch |
|---|---|---|---|
| before | 17 | `{18: 17}` | `{24: 10 gaps, 48: 1}` |
| after | 17 | `{16: 17}` | `{20: 10 gaps, 40: 1}` |

Pencil's `oZacA` draws rows at h=16 on y = 4, 24, 44, 64, 84, 104, 124 — a 20px pitch. The
18px came from `.kf` and `.reset`, which are the tallest things in a row and therefore what
decides it, not the slider (12px) or the readout (12.6px). Both boxes went 18→16px and
`.row`/`.check`/`.checkrow` margin-bottom 6→4px. The single 40 is the doubled gap where a
hidden row sits, previously 48.

## G10 — what narrowing costs, checked against `main`

The panel's generated step rows and the preset-subset dialog's boxes all sit inside
`label.check`, so scoping the rule keeps them. The one control that loses the 12px box is
`#monAcceptCost`, which sits in a `.row` — and `origin/main` shipped
`.check input { accent-color: … }`, so that control drew the platform's own checkbox before
the fork too. This restores `main`'s behaviour rather than changing it.

## G11 — the premise was wrong in a way worth recording

The gap said `aria-current="page"` was removed from all three surfaces. On `origin/main` it
was on **two**: `library.html` and `menu.html`. `index.html` deliberately carried none, and
its own comment said so — "neither does here, because this is neither of them".

The new app bar has no surface list at all, so there is no nav item to mark. The mark now
sits on the span that **names** the current surface — `#surfaceName` in `index.html`, the
`Gallery` span in `library.html` — and deliberately **not** on the `.appback` anchor around
it, because that anchor points at the menu and marking a link to another page as the current
page is a false sentence. `menu.html` is the root: its `<main class="menu">` lists the other
three surfaces and none of them is current, so it gets nothing, stated rather than skipped.

The edit moved a mutation anchor. `library-check`'s `gallery-has-no-way-back` was re-anchored
on the new line, and `syntax-check` is what caught it — 1 failed, then 0.

## G7 — reported, not guessed

The design draws `glow` as a slider in Points. The product has `additive glow` as a checkbox:
`additive`, `kind: 'step'`, `group: 'points'`, `label: 'additive glow'`. The only scalar that
could answer to "glow" is `bloom`, which the registry puts in `group: 'optical'` with
`min 0, max 6, step 0.05`.

So the design's single Points slider is two different registry entries in the product — a
boolean in `points` and a scalar in `optical` — and reconciling them is a registry change
either way: either `bloom` moves group, or `additive` changes kind. **Neither was made.**
`registry-check`'s drop-one sweep proves both currently reach the pixels, so any move has to
be re-measured rather than assumed.

## The falsification controls, with what each fired

Every control reddens the rows carrying its claim **and no others**, which is what says the
row it caught is the row asking the question.

| Control | Verdict | Assertions fired |
|---|---|---|
| `keynav-never-disables` | caught | **3** — the three disabled rows only; every landing row green |
| `keynav-walks-to-the-far-key` | caught | **5** — the five landing rows only; all three disabled rows green |
| `export-codecs-drops-an-entry` | caught | **2** — the drift row (`pngseq -> document prores, shown prores`) and the console sweep catching `unknown export codec "pngseq"`; the pre-existing `format-segments-paint-the-press` rows stayed green |
| `prores-writes-h264` | caught | **1** — the prores row (`check-atomic-prores.mov holds h264`); the pngseq row green |
| `pngseq-writes-one-file` | caught | **1** — the pngseq row (`ffmpeg exited 234`); the prores row green |
| `picker-offers-a-builtin-delete` | caught | **1** — the deletable-entries row |
| `picker-drops-focus-on-rebuild` | caught | **1** — the focus row, `focus landed on BODY` |

### Three instrument failures, each found by running a control rather than reading it

**A control that could not be delivered, recorded as a control that passed.** The two export
controls were first written against `server/export.js` and both came back **exit 0, 45/45
passed, NOT CAUGHT**, with the new section 5 rows green — because `tools/export-check.mjs`
reads `const mutatedBody = mutation?.file === 'web/main.js' ? mutation.body : null`, so only a
page mutation is delivered, and section 5 exports through the server named by `--url`, a
process the tool did not start and cannot stage. The mutated body was built and went nowhere.
Fixed by siting the falsifiable claim where the mutation lands: section 8 imports
`server/export.js` itself through `serverSource`, so a per-codec block there drives the
**mutated** module over its own socket. Section 5's rows stay as the end-to-end confirmation
through the real server.

**A mutation that crashed the run instead of reddening it.** `keynav-walks-to-the-far-key`
reaches the end of the track early, so the following press aimed at a disabled button and
Playwright waited out its 30s: `DID NOT RUN`, exit 2, 397 ran with 1 failed — which reads
like a catch and is a run that stopped. The driver reads `disabled` before pressing now and
fails the row instead.

**A probe that reported the empty string and passed.** `picker-drops-focus-on-rebuild` came
back **NOT CAUGHT at 415 assertions and none failed**, because the focus probe used
`document.activeElement?.id` and the DOM answers an absent id with the empty string, which is
not nullish — so nullish-coalescing kept it and a row asking whether focus was off the body
passed on a caret that was exactly on it. It uses or-else now and asks positively (the caret
is on one of the surviving entries or on the trigger), and the control fires.

## Product defects found, and by what

- **The preset delete was refused 415 and the entry stayed in the list.** Every write route in
  the table requires `Content-Type: application/json`, `DELETE` included, even though a delete
  carries no body — the rule is about the request being a deliberate one, not about there
  being JSON to read. The picker's `fetch` sent none. Found by section 19's own row
  (`6 entries: …` after a delete), confirmed with `curl` returning 415, fixed by declaring the
  header.
- **Two `<select>` idioms in `editor-check` crashed against the new picker** — `.options` at
  the preset-name read and `page.selectOption('#tPreset', …)`. Both drive the real control
  now. `DID NOT RUN` at 385 assertions with 0 failed was the tell.

## Environment limits, kept separate from findings

- The first `editor-check` after a server restart crashes on a `page.reload` timeout, 311/0.
- One run reported two failures, both `net::ERR_INTERNET_DISCONNECTED` — the machine's
  network rather than the code. The next run on the same tree was 415/0.
- **`/record` emits four GPU driver warnings**, all
  `GL Driver Message (OpenGL, Performance, …): GPU stall due to ReadPixels`. They are the
  driver's own performance notes about the monitor's readback on this machine, not the
  product's output — nothing in this pass touches that path, and `/`, `/gallery` and `/edit`
  are clean of both errors and warnings. Recorded because the handoff's green bar claimed
  zero warnings on all four, and that claim is true of three.
- **`syntax-check` does not parse the proof tools' own bodies.** A genuine `SyntaxError` in
  `tools/editor-check.mjs` — a backtick inside a comment inside a template literal, the trap
  `docs/instruments.md` records four times — passed `syntax-check` at "40 JavaScript files, 0
  failed" and was found only by running the tool. `syntax-check` reads each tool's `MUTATIONS`
  **declaration** and walks `web/` and `server/`; the rest of a tool's body is parsed by
  nothing. `node --check tools/<tool>.mjs` is the cheap cover. **Not closed.**

## The one genuine contradiction — not resolved, not faked

**The Browse save-path picker.** The design draws a `Browse` button beside an editable output
path. A browser cannot open a native save-path picker portably, and the product addresses
output through the deliverables API with real resolved paths. It is not implementable as
drawn, and nothing was built to look as though it were.

## Open

- **G7** is a registry decision nobody has made. Reported above; no change made.
- **`syntax-check` not parsing tool bodies** is a real hole in the instrument chain, found
  this pass and left open rather than closed quietly.
