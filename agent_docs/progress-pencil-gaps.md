# Progress — implementing G1–G12

Durable companion to `handoff-implement-pencil-gaps.md`. Re-read both at cycle start.

## Baselines, taken on a RESTARTED server (this matters)

The server that was on :8080 at session start had been up since 04:57 and predated the
`server/index.js` (13:25) and `server/export.js` (13:31) edits by eight hours — it did
not carry the working tree's MOV/pngseq support. It was killed and restarted before any
measurement. Baselines on the fresh server:

- `editor-check --url http://localhost:8080 --no-render` → **396 assertions, 0 failed**, PASS, exit 0
- `registry-check --url http://localhost:8080` → **PASS**, 55 of 57 parameters proven
- `syntax-check` → 40 files, **0 failed**, all 331 anchors in 14 tables match once, of 16 declared
- `npm test` → **0 failed**

**First run after a server restart crashes.** The very first `editor-check` against a cold
server died `DID NOT RUN`, exit 2, `page.reload: Timeout 30000ms exceeded`, **311
assertions 0 failed**. Second run on the warm server was 396/0. Environment limit, not a
finding — but budget for it and never read the first post-restart run as a result.

Baseline hashes (before any edit):
```
69b2158a…  web/main.js          bfabb0bd…  web/index.html
1637fbc5…  web/nav.css          24e92234…  web/library.js
ad895d60…  web/library.html     1f2aed0e…  web/menu.html
ceb5e6f7…  server/export.js     c6c8217b…  server/index.js
ab90c1d5…  tools/editor-check.mjs  2ccc593f…  tools/export-check.mjs
```

## Done

- **G9** dead code. `.tpin` + its 4 descendant rules and their comment removed from
  `web/index.html` (`#tExportNote` had moved into `.dialog-actions`, and the global
  `#tExportNote:empty` rule already covers the `:empty` case). `ui.cameraGroup` removed
  from `web/main.js` (the `#cameraGroup` *element* is live via `data-panel-tab` — only
  the JS handle was dead). `--line-3` removed from **`web/menu.html` only**: it is
  declared in three pages and used in two, and menu.html loads only `nav.css`, which
  references `--line`/`--line-2` and never `--line-3`.
- **G10** checkbox scope. `input[type=checkbox]` → `.check input[type=checkbox]` (both
  the base and `:checked` rule). Verified safe: the panel's generated step rows and the
  preset-subset dialog's boxes are all inside `label.check`. The one control that loses
  the 12px box is `#monAcceptCost`, which sits in a `.row` — and `origin/main` shipped
  `.check input { accent-color… }`, so that control drew the platform checkbox before the
  fork too. This restores main's behaviour rather than changing it.
- **G11** `aria-current="page"`. On `main` it was on **two** surfaces, not three —
  index.html's own comment says it deliberately carried none. The new app bar has no
  surface list, so the mark goes on the span that *names* the surface
  (`#surfaceName` in index.html, the `Gallery` span in library.html) and **not** on the
  `.appback` anchor around it, because that anchor points at the menu and marking a link
  to another page as the current page is simply false. menu.html is the root: its
  `<main class="menu">` lists the other three surfaces and none of them is current, so
  it gets nothing — stated rather than silently skipped.
  This edit moved a mutation anchor: `library-check`'s `gallery-has-no-way-back` was
  re-anchored on the new line. `syntax-check` caught it (1 failed → 0 after).
- **G8** row density. **Measured, not reasoned**: at 1440x900 dSF 1 the panel was
  17 rows, pitch `{24: 10 gaps, 48: 1}`, height `{18: 17}`. The 18px came from `.kf` and
  `.reset`, which are the tallest things in a row — not the slider (12px) or output
  (12.6px). `.kf`/`.reset` 18→16px, `.row`/`.check`/`.checkrow` margin-bottom 6→4px.
  Re-measured: pitch `{20: 10, 40: 1}`, height `{16: 17}` — the design's exact rhythm
  (rows h=16 at y=4,24,44,64… = 20px pitch, read off Pencil node `oZacA`).
- **G1** OBS footer, mostly. `webcam.#reap()` added in `server/webcam.js`: drops any
  subscriber whose `res.destroyed || res.writableEnded`, then settles. Called from both
  `get count()` and `describe()`, so the dot and the recorder's refusal read the
  **resource** rather than the Set that tracks it. Client polls `/record/state` (already
  carries `webcam.subscribers`; 1.2ms in-memory route) every 2s **only while the dialog
  is open**, stopping on the dialog's own `close` event so Escape and the glyph are
  covered. Loopback subscribers **count** here deliberately — the costing rule filters
  them, but "is anything reading" is a different question and OBS on the same machine is
  the ordinary answer. Markup: 8px `.obsdot` + `#obsStatusText`, `.note.live` lights both.
  **No Stop button** — the design draws one, the product has no start/stop API, none invented.

- **G3** prev/next keyframe. `#tPrevKey`/`#tNextKey` added to `#tEase` between the label
  and `lin`, matching Pencil's `XtKef` Keyframe Nav. `neighbourKeyTime(direction)` in
  `web/main.js` returns the nearest key strictly past the playhead by more than
  `keyTolerance()` on the **selected** track, or null; the handlers seek through the
  existing `goTo()` so the pause and the clip-range clamp stay stated once. Disabled state
  is recomputed in `paintEase()`, which `paintLanes()` calls on the per-frame chrome paint,
  so it tracks the playhead. Deliberately **not** gated on a selection existing beyond the
  owner — walking is how you reach a key in order to select it.
  New `editor-check` **section 18** (the pin section renumbered to 19, and it must stay
  last because `drive.pin` detaches the animation loop for good). Registered in
  `DRIVER_IDS`, not as a rule. Clean: **404 assertions, 0 failed**, all 8 new rows green
  with landed times printed (`landed 5.0000s against the key's 5.0000s`).
  Controls, one per half of the claim:
  - `keynav-never-disables` → **caught, 3 assertions fired**: the three disabled rows only,
    every landing row green.
  - `keynav-walks-to-the-far-key` → **caught, 5 assertions fired**: the five landing rows
    only, all three disabled rows green.
    First attempt **crashed** (`DID NOT RUN`, exit 2, 397 ran / 1 failed) because walking to
    the far key reaches the end of the track early and the next press hit a disabled button,
    which Playwright waits 30s on. The driver now reads `disabled` before pressing and fails
    the row instead — "a mutation must redden its rows and leave the run able to finish".
- **G4a** the `EXPORT_CODECS` drift row, in `editor-check` section 1 beside the existing
  single-segment press. Walks **every** `#exportFormats button[data-codec]` and asserts each
  writes its own codec into the deliverable and shows itself chosen. No page hook needed:
  `setExportCodec` throws on a codec `EXPORT_CODECS` does not carry, so a stale table cannot
  quietly succeed. Clean: **405 assertions, 0 failed**.
  `export-codecs-drops-an-entry` (drops `pngseq`, keeps `h264` because half of section 1
  falls back to it) → **caught, 2 assertions fired**: the new drift row
  (`pngseq -> document prores, shown prores`) and the console sweep catching
  `unknown export codec "pngseq"`. The pre-existing `format-segments-paint-the-press` rows
  stayed **green**, which is the split that says the new row is what discriminates.
- **G12** written into `docs/instruments.md` as its own entry, placed immediately after the
  "table of rules where the rule bodies are never called" entry and naming the seam with it.
  Grounded rather than invented: `look` is the widest `DRIVER_RULES` entry and is keyed
  `inGroup(row,'#panel') && (row.type === 'range' || row.type === 'checkbox')`, so the
  first pass's per-parameter resets — `<button>`, `el.type === 'submit'` — matched no rule,
  `covered()` returned null, and the sweep named them. The `reset` rule keyed on
  `Boolean(row.reset)` is the repair.

- **G4b** real MOV and real PNG-sequence arms in `export-check` section 5, driven through
  the running server against a restarted `:8080`. Clean, exit 0, all three green:
  `check-mov.mov: 9 frames of 640x400 in prores`; `9 png files in check-pngseq.pngseq,
  first check-pngseq.000001.png, last check-pngseq.000009.png`; `640x400 in png`.
  A PNG sequence is a **directory** (`server/export.js` says so, and `frameExt` is the
  field that decides), so it is asserted by counting frames and probing one, not by a
  MOV-shaped ffprobe row that could not run on it.

  **A proof-tool failure found by running the control rather than reading it, and it is
  the most useful thing in this section.** The two falsification controls were first
  written against `server/export.js` and both came back **exit 0, 45/45 passed, NOT
  CAUGHT**, with the new section 5 rows green — because
  `export-check.mjs:869` reads
  `const mutatedBody = mutation?.file === 'web/main.js' ? mutation.body : null`, so only a
  page mutation is delivered, and section 5 exports through the server named by `--url`,
  a process this tool did not start and cannot stage. The mutated body was built and went
  nowhere. That is the silent-delivery failure `docs/instruments.md` already carries two
  entries about, reproduced exactly.
  Fixed by siting the falsifiable claim where the mutation lands: section 8 imports
  `server/export.js` itself through `serverSource`, so a per-codec block there drives the
  **mutated** module over its own socket. Section 5's rows stay as the end-to-end
  confirmation; section 8's are the half that can be falsified.

- **G2** preset picker, both surfaces. `#tPreset` and `#recPreset` are now
  `button[role=combobox]` triggers over `div[role=listbox]` lists of `div[role=option]`,
  with a check on the applied entry, `lucide/trash-2` (built through `createElementNS`
  like `resetGlyph`, never `innerHTML`) on **user presets only**, and a 24x24 add button on
  the editor's picker alone — Pencil draws the add in the editor's menu and the Record
  surface's preset row has none. Delete goes to the real `DELETE /presets/:name`; builtins
  live in a directory the store reads and never writes, so they carry no delete.
  **The trigger keeps `value`**: `<button>` has a `value` IDL attribute, so `el.value` goes
  on meaning the chosen preset's name and every downstream reader is unchanged — the
  instruments.md failure about a control whose `value` stops meaning its quantity does not
  arise, and section 9 now asserts the name that came out equals the name that went in.
  Driven at 1440x900: 5 builtins listed, 0 deletable, add present, `role=combobox`,
  ArrowDown moves focus, Enter selects and returns the caret to the trigger, **0 console errors**.
  `editor-check` changes: sweep selector widened with `#panel [role=option]`; a `preset`
  DRIVER_RULES entry placed **before** the panel-wide `look` rule (ordering is precedence);
  new **section 19** (pin renumbered to 20, still last). The widened sweep re-read against
  its own floor: `205 of 335 controls are the panel's`, floor `> 60` still means what it says.
  Two `<select>` idioms in the tool crashed the first run and were fixed — `.options` at the
  preset-name read and `page.selectOption('#tPreset', …)`, both now driving the real control.

## Open / next

- **G1 lit arm is in a dead zone on the replay fixture.** Driven at 1440x900: dialog
  opens, reads `idle - nothing is reading`, dot dark. Attaching a real `/camera.mjpg`
  consumer returned **503** — `this server is replaying sample.knct, so there is no
  colour camera to serve` — so no subscriber can ever attach and the lit state is
  unreachable here. The status line now reports the server's own `unavailable` sentence
  as a third state instead of calling it idle. **Still to prove the lit arm on a server
  with a colour camera** (`--grabber "node tools/fake-grabber.mjs …"`, see
  `server/index.js:144`), on a free port, not :8080.
- **G3** prev/next keyframe. Design nodes `YWZ9b`/`I4Fys` sit in Pencil frame `XtKef`
  "Keyframe Nav" inside the key-options row, between the `key options` label and the
  `lin` button. Product equivalent is `#tEase` (`web/index.html`, the span holding
  lin/in/out/smooth/hold/delete). API to use: `selection` = `{owner, key}`,
  `keysOf(owner)` (`main.js:8590`), `playheadSec()` (`main.js:3854`), and **`goTo(sec)`**
  — the existing door that pauses and clamps into the clip range. Do not add a second seek path.
- **G2** preset listbox. `#tPreset` (`index.html:873`) + `#tPresetApply`; recorder has a
  second one, `#recPreset` (`index.html:903`). MUST widen `editor-check` section 1's sweep
  selector to reach `[role=option]`, then re-read the panel floor threshold denominated on
  that count. Preset writes go through the existing in-flight guard (`PRESET_WRITERS`,
  `withPresetGesture`, `main.js:11134`) — drive it via the guard's published state, and
  focus before clicking or a focus row proves nothing.
- **G4** export proof coverage. `EXPORT_CODECS` is at `web/main.js:6821`; editor-check
  already carries `format-segments-paint-the-press` anchors at `tools/editor-check.mjs:979`.
- **G12** docs entry — a first subagent stalled and wrote nothing; instruments.md untouched.
- **G5** Pencil comparisons, **last**, after the surfaces stop moving.
- **G7** report-only. Do not touch the registry.

## Rules being obeyed

Never `git stash`. Never two `*-check` runs at once (`pgrep -f "tools/.*-check.mjs"` first).
Never edit `web/` under a running sweep. Count failed assertions, never exit codes.
Restart :8080 before any run that actually encodes.
