# UI Rework Implementation Proposal

This document proposes how to implement the UI rework designed in `ui-rework.pen` into the
braindance codebase. The design introduces a consistent visual language across all surfaces
while preserving every existing feature.

## Design Changes Summary

The rework introduces:

1. **Menu bar** — macOS-style top bar with `< Surface` back button, File/Output/View menus
2. **Collapsible sections** — `▼` arrows on section headers, consistent spacing
3. **Slider styling** — track with handle, single-decimal values, hard-edged controls
4. **Hard edges** — `cornerRadius: 0` on all buttons, dropdowns, checkboxes
5. **Checkboxes** — replace toggle switches with square checkboxes
6. **Consistent typography** — JetBrains Mono throughout, defined size hierarchy
7. **Unified colour palette** — `--ink`, `--dim`, `--accent` restated per page

## Architecture Constraints

The existing codebase has properties that constrain implementation:

1. **Parameter registry is load-bearing** — `PARAMS` object drives panel generation;
   `registry-check` validates the panel matches the registry exactly
2. **Proof tools assert structure** — `editor-check`, `library-check` count controls,
   verify they exist, and test that pressing them changes something
3. **ID-based DOM access** — `panelControls.set(name, input)` and `getElementById` are
   used throughout; changing IDs breaks proof tools
4. **No framework** — pure vanilla JS with direct DOM manipulation; introducing React/Vue
   is out of scope
5. **Shared nav.css** — one file serves all three pages; changes propagate everywhere

## Implementation Strategy

### Phase 0: Baseline Measurements

Before any code changes, establish baselines that the rework must not regress:

```bash
# Run all proof tools and record pass/fail + timing
node tools/registry-check.mjs --url http://localhost:8080
node tools/editor-check.mjs --url http://localhost:8080
node tools/library-check.mjs
# ... all mutation variants
```

Store results in a scratch file. Every phase below must pass these unchanged.

### Phase 1: CSS Custom Properties & Typography

**Goal:** Update colour palette and typography without touching HTML structure.

**Files:**
- `web/nav.css` — shared navigation
- Inline `<style>` blocks in `index.html`, `library.html`, `menu.html`

**Changes:**

1. Update CSS custom properties to match the design palette:
   ```css
   :root {
     --ink: #e8ecf1;           /* primary text */
     --dim: #7d8794;           /* secondary text */
     --faint: #6d7683;         /* disabled/tertiary */
     --accent: #5ad1c4;        /* teal accent */
     --paper: #0d1014;         /* darkest background */
     --paper-1: #151920;       /* sidebar background */
     --paper-2: #1a1d21;       /* canvas/elevated */
     --line: #ffffff1a;        /* borders */
     --line-2: #ffffff22;      /* lighter borders */
   }
   ```

2. Add JetBrains Mono font import (Google Fonts):
   ```html
   <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
   ```

3. Update `font-family` declarations:
   ```css
   body, input, button, select {
     font-family: 'JetBrains Mono', monospace;
   }
   ```

4. Remove `border-radius` from interactive elements:
   ```css
   button, input, select, .chip, .dropdown {
     border-radius: 0;
   }
   ```

**Verification:**
- All proof tools pass unchanged
- Visual inspection confirms typography and colours match design

### Phase 2: Menu Bar Component

**Goal:** Add top menu bar to all three surfaces.

**Files:**
- `web/index.html` — add menu bar markup
- `web/library.html` — add menu bar markup
- `web/menu.html` — no menu bar (it IS the menu)
- `web/nav.css` — menu bar styles

**HTML Structure:**
```html
<header class="menu-bar">
  <a href="/" class="back-button">
    <span class="back-icon">&lt;</span>
    <span class="back-title">Editor</span>
  </a>
  <nav class="menu-items">
    <button class="menu-item" data-menu="file">File</button>
    <button class="menu-item" data-menu="output">Output</button>
    <button class="menu-item" data-menu="view">View</button>
  </nav>
</header>
```

**CSS:**
```css
.menu-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 32px;
  background: var(--paper);
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  padding: 0 12px;
  z-index: 100;
}

.back-button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 5px;
  border: 1px solid var(--line-2);
  text-decoration: none;
}

.back-icon {
  color: var(--dim);
  font-size: 10px;
}

.back-title {
  color: var(--ink);
  font-size: 11px;
  font-weight: 500;
}

.menu-items {
  display: flex;
  gap: 20px;
  margin-left: 16px;
}

.menu-item {
  background: none;
  border: none;
  color: var(--dim);
  font-size: 10px;
  cursor: pointer;
}
```

**Layout Adjustment:**
- Add `padding-top: 32px` to body or main container to account for fixed menu bar
- Adjust any `top: 0` positioned elements to `top: 32px`

**Verification:**
- All proof tools pass unchanged
- Menu bar appears on Editor, Gallery, Record
- Back button navigates to menu
- No layout shifts or overlapping elements

### Phase 3: Sidebar Section Headers

**Goal:** Update section headers to collapsible style with arrows.

**Files:**
- `web/main.js` — modify `panelGroup()` function
- `web/library.js` — update section headers if any
- CSS in respective HTML files

**Current pattern (main.js):**
```javascript
function panelGroup(key, label, lookgroup) {
  const group = panelNode('div', 'group');
  group.id = key;
  const header = panelNode('div', 'group-header', label);
  group.appendChild(header);
  // ...
}
```

**New pattern:**
```javascript
function panelGroup(key, label, lookgroup) {
  const group = panelNode('div', 'group');
  group.id = key;

  const header = panelNode('div', 'group-header');
  const arrow = panelNode('span', 'group-arrow', '▼');
  const title = panelNode('span', 'group-title', label);
  header.appendChild(arrow);
  header.appendChild(title);

  // Click to collapse (if desired)
  header.addEventListener('click', () => {
    group.classList.toggle('collapsed');
  });

  group.appendChild(header);
  // ...
}
```

**CSS:**
```css
.group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 0;
  cursor: pointer;
}

.group-arrow {
  color: var(--dim);
  font-size: 8px;
  transition: transform 0.15s;
}

.group.collapsed .group-arrow {
  transform: rotate(-90deg);
}

.group-title {
  color: var(--ink);
  font-size: 10px;
  font-weight: 500;
}

.group.collapsed .group-content {
  display: none;
}
```

**Verification:**
- `registry-check` passes (panel structure unchanged)
- `editor-check` passes (controls still exist and function)
- Sections collapse/expand on click
- Arrow rotates on collapse

### Phase 4: Slider Row Styling

**Goal:** Update slider rows to match design — track with handle, single-decimal values.

**Files:**
- `web/main.js` — modify `panelRow()` function
- CSS in `index.html`

**Current slider structure:**
```html
<div class="row">
  <label>brightness</label>
  <input type="range" min="0" max="2" step="0.01">
  <span class="readout">1.00</span>
</div>
```

**New slider structure:**
```html
<div class="row">
  <label>brightness</label>
  <div class="control">
    <div class="track">
      <div class="handle" style="left: 50%"></div>
    </div>
    <span class="value">1.0</span>
  </div>
</div>
```

**Implementation approach:**

The existing `<input type="range">` can be styled with CSS to match the design, avoiding
the need to replace it with a custom implementation:

```css
input[type="range"] {
  -webkit-appearance: none;
  appearance: none;
  width: 70px;
  height: 2px;
  background: var(--line);
  outline: none;
}

input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 4px;
  height: 8px;
  background: var(--ink);
  cursor: pointer;
  border-radius: 0;
}

input[type="range"]::-moz-range-thumb {
  width: 4px;
  height: 8px;
  background: var(--ink);
  cursor: pointer;
  border-radius: 0;
  border: none;
}
```

**Value formatting:**

Modify the readout update to use single decimal:
```javascript
// Current
readout.textContent = value.toFixed(2);

// New
readout.textContent = value.toFixed(1);
```

**Verification:**
- `registry-check` passes
- `editor-check` passes — sliders still respond to input
- Values display with single decimal
- Slider handles match design

### Phase 5: Checkbox Replacement

**Goal:** Replace toggle switches with hard-edged checkboxes.

**Files:**
- `web/main.js` — modify checkbox rendering in `panelRow()`
- CSS in `index.html`

**Current pattern:**
```html
<input type="checkbox" class="toggle">
```

**The native checkbox can be styled:**
```css
input[type="checkbox"] {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border: 1px solid var(--line);
  background: transparent;
  cursor: pointer;
  position: relative;
}

input[type="checkbox"]:checked {
  background: var(--accent);
  border-color: var(--accent);
}

input[type="checkbox"]:checked::after {
  content: '';
  position: absolute;
  left: 3px;
  top: 1px;
  width: 4px;
  height: 8px;
  border: solid var(--paper);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
```

**Verification:**
- `editor-check` passes — checkboxes still toggle
- Visual matches design (square, hard edges, check icon)

### Phase 6: Button & Dropdown Styling

**Goal:** Hard edges on all interactive elements.

**Files:**
- CSS in all HTML files

**Changes:**
```css
button, .button, [role="button"] {
  border-radius: 0;
}

select, .dropdown {
  border-radius: 0;
  -webkit-appearance: none;
  appearance: none;
  background-image: url("data:image/svg+xml,..."); /* chevron */
  background-repeat: no-repeat;
  background-position: right 8px center;
  padding-right: 24px;
}
```

**Verification:**
- All proof tools pass
- Visual inspection confirms hard edges throughout

### Phase 7: Record Surface Rework

**Goal:** Apply all changes to Record surface specifically.

The Record surface shares `index.html` with Editor but shows different controls based on
`body.not(.editing)`. The changes above apply to both, but Record needs:

1. **Different back button text** — "Record" not "Editor"
2. **Record/Mark buttons** — styled with hard edges, record button red
3. **Status text** — consistent typography

**Implementation:**
```javascript
// In main.js, after detecting surface
if (location.pathname === '/record') {
  document.querySelector('.back-title').textContent = 'Record';
}
```

**Record button styling:**
```css
.record-button {
  background: #cc3333;
  color: #ffffff;
  border: none;
  padding: 6px 12px;
  font-weight: 500;
}

.mark-button {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--dim);
  padding: 6px 12px;
}
```

**Verification:**
- Record surface matches design
- Record/Mark buttons function correctly
- Proof tools pass

### Phase 8: Gallery Rework

**Goal:** Apply changes to Gallery surface.

**Files:**
- `web/library.html`
- `web/library.js`

**Changes:**
1. Add menu bar with "Gallery" back button
2. Update tile styling to match design
3. Update header typography
4. Hard edges on all controls

**Verification:**
- `library-check` passes with all mutations
- Navigation works
- Tiles display correctly

### Phase 9: Menu Page Polish

**Goal:** Update menu page to match new visual language.

**Files:**
- `web/menu.html`

**Changes:**
1. Typography update (JetBrains Mono)
2. Tile styling (hard edges)
3. Colour palette alignment

**Verification:**
- Menu displays correctly
- Navigation to all surfaces works

## Risk Mitigation

### Proof Tool Failures

If any proof tool fails after a change:

1. **Do not proceed** to the next phase
2. Identify which assertion failed
3. Either:
   - Fix the implementation to pass the existing assertion, OR
   - If the assertion tests *appearance* not *function*, update the assertion with
     justification in the commit message

### Regression Testing Checklist

After each phase, verify:

- [ ] `registry-check` passes (panel matches PARAMS)
- [ ] `editor-check` passes (controls exist and change state)
- [ ] `editor-check --mutate X` fails for all X (mutations caught)
- [ ] `library-check` passes
- [ ] `library-check --mutate X` fails for all X
- [ ] Manual test: Record a take, open in Editor, play, export
- [ ] Manual test: Gallery navigation, rename, delete

### CSS Specificity

New styles should not fight existing ones. Use:

1. Same selector specificity as existing styles
2. Place new rules after existing ones (cascade wins)
3. Avoid `!important` — if needed, it indicates a specificity problem to fix

### Feature Flags

If a phase is too large or risky, introduce a feature flag:

```javascript
const UI_REWORK = localStorage.getItem('ui-rework') === 'true';

if (UI_REWORK) {
  // New rendering path
} else {
  // Existing rendering path
}
```

Remove the flag once the phase is verified complete.

## Implementation Order

The phases are ordered to minimize risk:

1. **CSS-only changes first** (Phases 1, 4-6) — no structural changes, easy to revert
2. **Additive changes second** (Phase 2) — menu bar adds without removing
3. **Structural changes last** (Phase 3, 7-9) — section headers, surface-specific work

Each phase is independently deployable. If a phase introduces issues, revert only that
phase while keeping earlier phases.

## Timeline Considerations

This proposal does not estimate time (per project conventions). The phases are ordered
by dependency and risk, not by expected duration. Each phase should be:

1. Implemented
2. Verified against proof tools
3. Manually tested
4. Committed with measurements/verification in the commit message

## Files Modified Summary

| File | Phases | Type of Change |
|------|--------|----------------|
| `web/nav.css` | 1, 2 | CSS updates, menu bar styles |
| `web/index.html` | 1, 2, 4, 5, 6, 7 | Font import, menu bar, styles |
| `web/library.html` | 1, 2, 6, 8 | Font import, menu bar, styles |
| `web/menu.html` | 1, 9 | Font import, styles |
| `web/main.js` | 3, 4, 5, 7 | Panel generation, value formatting |
| `web/library.js` | 8 | Section headers if any |

## Success Criteria

The rework is complete when:

1. All proof tools pass, including all mutation variants
2. Visual appearance matches `ui-rework.pen` design
3. All existing functionality works unchanged
4. No new console errors or warnings
5. Performance is not regressed (measure frame times before/after)

## Open Questions

1. **Dropdown menus** — The design shows dropdown menus for File/Output/View. Should these
   be implemented now or deferred? They add complexity and the existing controls work.

2. **Collapsible sections** — Should sections remember collapsed state across sessions
   (localStorage)? The current UI has no collapse.

3. **Keyframe diamonds** — The design shows these removed from Record but the Editor may
   still want them. Clarify scope.

4. **Mobile/touch** — The design appears desktop-focused. Should touch targets be
   considered? The existing UI works on the capture node's touch panel.
