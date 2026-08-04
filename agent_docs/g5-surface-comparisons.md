# G5 — Home / Gallery / Record design-fidelity comparison

Redone from scratch against live sources. Supersedes the first pass, whose inspector crops were
judged against the superseded 260px artboards.

## Method

**Design side.** `ui-rework.pen`, read only through the Pencil MCP tools. The three top-level
frames are `dnsxT` (Home), `sHODW` (Gallery), `udPXG` (Record) — each exactly 1440x900, so the
comparison is 1:1 against the product screenshots with no scaling. Frames were exported to PNG at
`scale: 1`. Geometry came from `execute` with a `Get` visitor reading `ctx.bounds`. Because
`ctx.bounds` is **parent-space**, the visitor accumulates the `parentCtx` chain so every number
below is frame-relative and directly comparable to a DOM rect. Clipping came from `ctx.problems`.

**Product side.** Playwright (imported by absolute path from `node_modules`), Chromium, viewport
exactly 1440x900, `deviceScaleFactor: 1`, `waitUntil: 'load'` plus 1500ms. Geometry came from
`getBoundingClientRect`, type and colour from `getComputedStyle`. All three surfaces reported
`scrollHeight === 900`, so nothing was cut off below the fold.

**Rendered colours** were sampled per-pixel from both PNGs through a canvas `getImageData`, not
read off the image by eye. Rows sourced that way say so.

Artefacts: `<scratchpad>/g5/{dnsxT,sHODW,udPXG}.png` (design), `<scratchpad>/g5/product-{home,gallery,record}.png`.

### Two measurement caveats that constrain the rows below

**The Home artboard's font is substituted in the export.** `dnsxT` declares `SFMono-Regular` on
every one of its five text styles; `sHODW` and `udPXG` declare `JetBrains Mono`. Pencil's renderer
does not have SFMono-Regular, so the Home PNG rendered proportional. Every text *width* measured
off the Home design export is therefore unreliable, and any Home row that depends on one is marked.
Declared family and size are still trustworthy, because they were read from the document rather
than from the picture.

**State is not fidelity.** The live server is replaying `sample.knct` rather than reading a sensor,
and no project has been opened on this machine. Rows where the two sides differ only because the
product is in a state the design didn't draw are marked `state` in the verdict column and are
excluded from the finding counts.

### Excluded as already known

Panel width 252px (confirmed below, not re-litigated), 16px panel rows on a 20px pitch, and the
Browse save-path button beside an output path.

---

## Home — `dnsxT` vs `http://localhost:8080/`

The two are near-identical in geometry. Card boxes land on the same pixels; the differences are a
stale font declaration, a 3px header inset, and a third line the product has learned to draw.

| what | design | product | verdict | how measured |
|---|---|---|---|---|
| Body/heading font family | `SFMono-Regular` declared on all 5 text styles in `dnsxT` | `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace` | **product-wins** — the Home artboard is the outlier; `sHODW` and `udPXG` both declare JetBrains Mono, and the product's stack keeps SFMono as a fallback. Fix belongs in the .pen, not the code. | Declared `fontFamily` via `Get(..., {resolveVariables:true})` on both sides; product from `getComputedStyle(body).fontFamily` |
| Header left inset | 12px (`V8azv` at x=12) | 15px (`header.head` padding-left 15px, `h1` at x=15) | **gap** — 3px. Trivial but real, and the design value matches the 12px inset used by the Gallery app bar. (This does not contradict the Record back-control row below, which rewards a 0px inset: that control is a click target, where reaching the screen corner is worth more than grid alignment, whereas this is a static title.) | `ctx.bounds` accumulated to frame-relative vs `getBoundingClientRect().x` |
| Title→subtitle gap | 12px (title ends 109, `bn3dZ` starts 121) | 16px (h1 ends 119, `.sum` starts 135) | **gap** — 4px, *but* the design's title width (97px) is measured in the substituted font, so the true design gap could differ. Verify after the font declaration is fixed. | Both from rects; flagged by the substitution caveat above |
| Header height and fill | 1440x37, `#0d1014` | 1440x37, `rgb(13,16,20)` | **match** | Rect + computed background vs `ctx.bounds` + declared fill |
| Record / Gallery card box | `401,282 638x106` and `401,404 638x106` | `401,282 638x106` and `401,404 638x106` | **match** — exact | Frame-relative `ctx.bounds` vs `getBoundingClientRect` |
| Heading type and colour | 23px / weight 600 / 3.22px tracking; `#ff3b4e` record, `#5ad1c4` gallery+editor | 23px / 600 / 3.22px; `rgb(255,59,78)` and `rgb(90,209,196)` | **match** — exact, including tracking | Declared text props vs `getComputedStyle` fontSize/fontWeight/letterSpacing/color |
| Editor card third line | 2 texts in a 125px card (`kAZW6`, padding `[31,29]`, gap 8); content `"Resumes sample"` | 3 children in a 126px card: adds `span#editorDest`, 9px / 1.26px tracking, `rgb(240,176,74)` | **product-wins** — the design already reserved the extra 19px of card height (125 vs 106) but drew nothing in it. The product spends it on a destination badge that tells you where the card will actually take you. | `Get("kAZW6",{depth:1})` vs DOM walk of `a#editor` |
| Gallery card subtitle copy | `"Every take here and on the node"` | `"Every take here and on the node, skimmable."` | **gap** (copy) — the design node's *name* carries the longer string, so the .pen is a stale edit behind the product, not ahead of it. | `Get(id,{depth:0}).content` vs `textContent` |
| Editor card subtitle copy | `"Resumes sample"` | `"Nothing to resume — nothing has been opened on this machine yet."` | *state* — no project has been opened on this machine. Not a fidelity finding. | Same |

**Home: 5 findings** (2 product-wins, 3 gaps). Excluded: 3 match rows and 1 state row.

---

## Gallery — `sHODW` vs `http://localhost:8080/gallery`

Tile construction is a pixel-level match — every box, fill and action button lands on the design's
numbers. Every difference is in the chrome above the grid, and the product is ahead on three of
the four.

| what | design | product | verdict | how measured |
|---|---|---|---|---|
| Tab strip background | `#0d1014` (tinted to group with the app bar), no bottom border | `#05070a` (same as page), plus 1px `rgba(255,255,255,0.1)` bottom border | **gap** — the design binds the strip to the app bar with fill; the product separates it from the page with a rule instead. Different device, different reading: the design's makes the top 80px one block. | Pixel-sampled at (700,56) in both PNGs via canvas `getImageData`; confirmed against declared fill `#0d1014` and `getComputedStyle(#tabs).backgroundColor` |
| Tab count | 3 — `ALL`, `LOCAL`, `NODE ONLY` | 4 — adds `BOTH` | **product-wins** — a take that exists in both places is a real fourth state, and the design's three tabs cannot express it. | `Get("HUX3N", …)` child walk vs `document.querySelectorAll('#tabs .tab')` |
| App-bar summary | node status only: `"on node · no node linked"` | prepends `"1 take · 00:30"` | **product-wins** — take count and total duration are the two facts a gallery header should carry, and the design's bar is otherwise empty across 1100px. | `Get("QyY5p", …)` contents vs `#sum`/`#where` textContent |
| Capacity readout | absent | `span#space` at x=1250, 9px `#8b94a1`: `"88h 46m left at current settings"` | **product-wins** — the design leaves the right half of the tab strip empty. | DOM rect + textContent; absent from the design frame's child walk |
| Tile box | `252x272` at `12,92` | `252x271` at `12,93` | **match** — 1px | Frame-relative `ctx.bounds` vs rect |
| Tile internals | skim `250x141` `#04060a`; bar `250x14` `#151920`; meta `250x115` | skim `250x141` `rgb(4,6,10)`; bar `250x14` `rgb(21,25,32)`; meta `250x115` | **match** — exact, all three | Declared fills vs `getComputedStyle().backgroundColor`; rects both sides |
| Action buttons | OPEN `110x34` `#5ad1c424`; DELETE `66x34` `#151920`; `⋯` `34x34` `#151920` | OPEN `110x34` `rgba(90,209,196,0.14)`; DELETE `66x34` `rgb(21,25,32)`; `⋯` `34x34` | **match** — exact, including the 0.14 alpha (= `0x24`) | Declared fills vs computed; rects both sides |
| State badge case | renders `"local"` lowercase | renders `"LOCAL"` (`text-transform` applied to `span.state.local`) | **gap** — small, but the design uses lowercase for this badge and uppercase for the tab labels, and the product uppercases both. | Design content string vs rendered product PNG and `textContent` `"local"` |
| Tile skim thumbnail | checkerboard (no image fill) | live depth thumbnail on `canvas` | *mockup artefact* — the design frame has no image; not a fidelity claim either way. | Visual, both PNGs |
| Tile count / marks | 2 tiles, `"2 marks"`, mark diamond drawn on the bar | 1 tile, `"no marks"`, no diamond | *state* — the local library currently holds one take with no marks. | `.tile` count and `.facts` textContent vs design child walk |

**Gallery: 5 findings** (3 product-wins, 2 gaps). Excluded: 3 match rows, 1 mockup artefact, 1 state row.

---

## Record — `udPXG` vs `http://localhost:8080/record`

The surface with real divergence. The panel width matches exactly, but the stage is built on a
different principle, and the design frame clips its own last section.

**No 260px contradiction.** The Record sidebar `S1SjlR` measures **252x838** and is a plain frame,
not a `ref` to the stale `ld6uL`/`oZacA`/`vysNl`/`h38qCI` 260x700 mockups still sitting at the
document root. The product's `div#panel` measures **252x868**. The width agrees; only the height
differs, and that is finding 3 below.

| what | design | product | verdict | how measured |
|---|---|---|---|---|
| Stage geometry | `cFTYv` `1188x838` at `252,32` — fills the area beside the panel, ratio 1.417 | `canvas#stage` `1440x810` at `0,61` — full-width 16:9, letterboxed 29px top and bottom, panel overlaying its left 252px | **product-wins** — 810/1440 is exactly 16:9, so the operator frames the shot in the deliverable's aspect rather than in whatever rectangle is left over beside a panel. The panel occlusion is answered by `H hides panel`, which the product's own hint advertises. | `ctx.bounds` vs rect; 16:9 confirmed by arithmetic, letterbox confirmed by `(900-32-810)/2 = 29` matching the measured y=61 |
| Stage colour | `#1a1d21` | `#05070a` | **product-wins** — a `#1a1d21` stage would wash out a point cloud, and the design frame draws no cloud at all, so the grey reads as a placeholder rather than a specified token. | Pixel-sampled at (900,450) and (300,100) in both PNGs |
| Panel overflow | sidebar `clip: true`, 838 tall; content runs to y=975, so **`Output Section` is clipped by 105px** — `ctx.problems` reports it | `div#panelBody` `scrollHeight 1298` vs `clientHeight 806`, `overflow-y: auto` | **product-wins** — the design frame silently loses its last section; the product scrolls the 492px it cannot show. | `ctx.problems` from the `Get` visitor named `QB3PC Output Section \| partially clipped \| in Sidebar`; product from `scrollHeight`/`clientHeight`/computed `overflowY` |
| Section disclosure triangle | `"▼"` drawn on every section head (JetBrains Mono 8px `#7d8794`) | no marker — `::before` and `::after` both compute to `none`; clicking a section head is inert | **gap** — the strongest one on this surface. The panel needs 1298px in an 806px viewport, which is exactly the deficit collapsing answers, and the machinery already ships on this page: `#panelBody` carries nine `.lookgroup` groups holding the `shut` collapse state, hidden on this surface. The capability is present and the visible sections don't use it. (The counter-reading — an inert chevron is worse than none, so delete it from the design — is available, but it argues for removing an affordance the panel's own overflow says is needed.) | Design child walk of each section head; product `getComputedStyle(head,'::before').content`, class list per `#panelBody > div`, and a Playwright click on `#recordGroup label`: height 150px before and after, class unchanged, `#panelBody.scrollHeight` 1298 before and after, `cursor: default` |
| Section dividers | 1px `#ffffff1a`, full content width, between every section | `border-top: 1px rgba(255,255,255,0.1)` on every group | **match** — exact (0.1 × 255 ≈ `0x1a`) | Declared fill of `fH1Jg` vs computed `borderTopWidth`/`borderTopColor` |
| Slider label/track split | label `14..47` (33px), track `143..213` (70px) | label `14..88` (74px), input `97..186` (89px) | **gap** — the design gives the track only 70px and starts it 46px further right, so the same drag covers less range. The product's 89px track is the more usable of the two, but the design's tighter label column is the more legible; neither side is right on both counts. | Frame-relative `ctx.bounds` on `oDIlf` internals vs rects of `.row` children |
| Slider value column width | `221..238` (17px) | `195..237` (42px) | **product-wins** — 17px fits `"1.0"` and nothing else; the product's 42px holds `"-7"` and `"0.05"`, both of which the live surface actually shows. | Same |
| Slider value formatting | fixed 1 decimal: `0.0`, `6.0`, `-7.0`, `1.0` | variable: `0`, `6`, `-7`, `0.05`, `1` | **gap** — the design's fixed decimal makes the value column read as a column. The product's `0.05` also proves the design's 17px slot was never wide enough, so fix the width with the format. | Design text contents from the `r7IHiV` walk vs `output` textContent |
| Footer hint placement and size | `638,878`, 10px | `266,877`, 9px, `text-align: start` | **gap** — 372px to the left and 1px smaller. The design centres the hint under the stage; the product pins it to the stage's left edge, where it reads as a caption on the panel rather than on the picture. | `Get("vlCRf",{depth:0})` vs `#hint` rect and computed fontSize/textAlign |
| Footer hint content | `"drag to orbit · scroll to zoom · right-drag to pan"` | adds `" · H hides panel"` | **product-wins** — this is the line that makes the full-bleed stage workable, and without it the panel occlusion has no visible escape. | textContent both sides |
| Device info duplication | panel head only: `KINECT V2` / `258741134347 · fw 4.0.3917.0` / `11 fps in` | panel head **and** `div#appStatus` at `1186,11`: `"258741134347 · fw 4.0.3917.0 · 2 fps in"` | **product-wins** — looks redundant until you press `H`; with the panel hidden the app bar is the only place the device and frame rate survive. | Design `CowIL` contents vs `#panelHead` and `#appStatus` textContent + rects |
| Menu bar item positions | text at x=90 / 134 / 190 (File / Output / View), spaced by 20px spacers around text-width targets | uniform `58x31` buttons at x=92 / 150 / 208, text at 102 / 160 / 218 | **product-wins** — full-height uniform hit targets beat text-width ones. Costs up to 28px of drift on `View`. | `ctx.bounds` of the menu text nodes vs button rects and computed padding |
| Back control | `q4Xsv` `62x23` at `12,5` | `a#toMenu` `92x31` at `0,0` | **product-wins** — same reasoning; the product's target reaches the screen corner, which the design's 12px inset gives away. | Rects both sides |
| Panel head height | `CowIL` 71px (32→103) | `#panelHead` 62px (32→94) | **gap** — 9px. Product is tighter; the design's extra room is not obviously spent on anything. | `ctx.bounds` vs rect |
| Group naming | `Input`, `Treatment`, `Framing`, `Monitor` | `Reading · source`, `Reading · treatment`, `Framing (metres)`, `Monitor stream` | **product-wins** — `Framing (metres)` states the unit at the point of use, and `Reading ·` scopes two groups that are otherwise unrelated words. `Output to OBS` matches on both sides. | Design section title contents vs product group `label` textContent |
| Framing controls | 2 buttons: `"sensor view"`, `"level to centre"` | 3 buttons — `sensor view` full-width, then `select floor` + `reset rotation` — plus a 73px explanatory note and an `open the box` button | **product-wins** — plane-selection levelling is a capability the design predates; `level to centre` cannot express picking a floor plane. | Design `r7IHiV` contents vs `#cameraGroup`-area DOM walk |
| Frame base fill | `udPXG` fill `#0d1014`; bottom 30px strip samples `#0d1014` | body `#05070a`; same strip samples `#05070a` | **gap** (design-side) — `dnsxT` and `sHODW` are both `#05070a`, so the Record artboard is the outlier and the product is self-consistent. Fix in the .pen. | Declared frame fills for all three design frames; pixel-sampled at (900,890) in both Record PNGs |
| Section vertical padding | `padding: [12, 0]` on every section frame — 12 above the header, 12 below the content, so 25px between two sections' content across the 1px divider | `padding: 8px 0 0 0` plus `margin-top: 8px` and the 1px border — 16px above the header, 0 below, so 17px between sections | **gap** — 8px tighter per boundary. Across the eight sections that is ~64px, which matters directly given the panel already overflows by 492px, so the product's compression is arguably load-bearing rather than accidental. Worth a deliberate decision either way. | `Get("QB3PC",{depth:0}).padding` and section `ctx.bounds` vs computed `paddingTop`/`paddingBottom`/`marginTop`/`borderTopWidth` on `#recLookGroup` |
| Section title weight | JetBrains Mono 10px, weight **500**, `#e8ecf1` | 10px, weight **400**, `rgb(232,236,241)` | **gap** — same family, size and colour; the product's titles are one step lighter, so section heads separate from their rows less than the design intends. | Declared text props from the font sweep vs `getComputedStyle(label)` on every `#panelBody > div` head |
| Record button state, replay note | red filled `record` button, one-line `"replaying sample.knct · 4h 43m left"` | disabled buttons, 5-line note explaining the server is replaying rather than reading a sensor | *state* — the server is replaying `sample.knct`. Not a fidelity finding. | Rendered PNGs plus `#recNote` textContent |
| Point cloud in stage | empty grey rectangle | live cloud | *mockup artefact* — the design frame draws no cloud. | Both PNGs |

**Record: 18 findings** (10 product-wins, 8 gaps). Excluded: 1 match row, 1 mockup artefact, 1 state row.

---

## Summary

28 findings across the three surfaces — Home 5, Gallery 5, Record 18: **15 product-wins, 13 gaps,
0 not-implementable.** Nothing the design draws turned out to be impossible in a browser beyond the
already-known Browse button. Match rows, mockup artefacts and state rows are excluded from these
counts and are labelled as such in the tables.

The gaps worth acting on, in order:

1. **Record section disclosure triangles** — the design draws `▼` on every section head; a click on
   a product section head is measurably inert. The panel needs 1298px in an 806px viewport and the
   collapse machinery already ships on the same page as `.lookgroup … shut`, so this is the one gap
   where the missing affordance costs real usability and the implementation is mostly already there.
2. **Record section spacing and title weight** — 17px between sections against the design's 25px,
   and weight 400 titles against 500. Together they are why the product panel reads flatter and
   more crowded than the artboard, and they are the cheapest visible win on the surface.
3. **Gallery tab strip fill** — `#0d1014` in the design, `#05070a` in the product. A one-token fix
   that decides whether the top 80px reads as one block.
4. **Two stale .pen declarations** — the Home artboard declares `SFMono-Regular` where its two
   siblings declare `JetBrains Mono`, and the Record artboard's base fill is `#0d1014` where its
   siblings are `#05070a`. Both are design-side drift; the product is the consistent one, so these
   are fixed in the document rather than in the code.

Where the product leads, it leads on principle rather than by accident: the 16:9 letterboxed stage
with `H hides panel` frames the shot in the deliverable's aspect, the scrolling panel refuses to
clip a section the design frame does lose, and the uniform menu-bar hit targets replace text-width
ones. None of those should be reverted toward the design.
