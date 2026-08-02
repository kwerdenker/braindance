// The gallery. Takes are tiles you can skim rather than rows you have to open:
// moving across a tile scrubs that take, and the take's marks sit on the scrub bar
// underneath, so the moments someone flagged in the room are visible before the
// take is opened at all.
//
// **There is no proxy, and that is a deliberate deletion.** An earlier draft of the
// design called for a reduced-resolution depth pyramid built at import; settling
// what a draft scrub actually costs removed the need, and it was then measured at
// 2.7ms against the master. So a skim here is one frame pulled through the same
// frame API the editor reads, decoded and drawn, and nothing is stored: no
// generation pass, no second artifact per take, no staleness question. A rendered
// video poster was rejected separately, because it bakes one look at import and the
// draft image would stop matching the edit the moment the grade changed.
//
// **Skimming costs different amounts depending on where the take is, so it looks
// different.** A local take scrubs at the measured 2.7ms. A remote one goes through
// the decimation parameter - the same depth divisor the monitor negotiates, applied
// to the frame API - at roughly 21ms a position over that 3.8 MB/s link, which is
// browsable and not smooth. A gallery that skimmed both identically would be
// promising a responsiveness the architecture does not have, so remote tiles
// decimate visibly and say so.
//
// **Skimming is a pointer affordance, so nothing is gated behind it.** The library
// runs on the node's touch panel, where there is no hover at all. Download, open,
// reclaim and delete are buttons on the tile at all times; skimming is how you find
// the take you want, never how you act on it.

const DEPTH_W = 512;
const DEPTH_H = 424;

// The depth divisor per state. A local take is read whole; a take that is only on
// the node comes through the divisor, which is what turns a 486KB frame into about
// 79KB - 27KB of depth plus the colour block carried through untouched, since
// colour is what a decimated frame mostly is.
const DIVISOR = { local: 1, both: 1, remote: 4 };

const grid = document.getElementById('grid');
const dlg = document.getElementById('confirm');
const noteEl = document.getElementById('note');

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const gb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(0)} MB`);
// The wall clock the take was shot on, in the zone of whoever is reading the
// gallery. `toISOString` was the first spelling of this and it is UTC by
// definition, so every tile in a CEST room read two hours early - a take shot at
// 03:40 filed as 01:40, which is the one field an operator uses to tell this
// afternoon's takes from last night's. Built from the local getters rather than
// `toLocaleString` so the shape stays the sortable `YYYY-MM-DD HH:MM` the tiles are
// laid out for, whatever locale the browser is set to.
const stamp = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

let library = { takes: [], node: null, here: '?' };
let filter = 'all';

const say = (text) => { noteEl.textContent = text; };

async function jsonOf(url, init) {
  const res = await fetch(url, init);
  const body = await res.json();
  if (body.error) throw new Error(body.error);
  return body;
}

/**
 * Every call on this page that changes something, in one shape.
 *
 * The method and the JSON content type are both required by the server now, and the
 * content type is the load-bearing half: a page you merely visit can send a
 * cross-origin POST without asking permission, but it cannot declare
 * `application/json` while doing it. Written once here because three call sites each
 * spelling out their own headers is three chances for one of them to be the request
 * that gets refused in front of an operator.
 */
const post = (url, body) => jsonOf(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

// ------------------------------------------------------------------ the skim frame

/**
 * One frame of a take, drawn to a 2D canvas at 16:9.
 *
 * Depth rather than the colour JPEG, and the reason is that a poster has to exist
 * for every take: a node shooting with `--no-color` records no JPEG at all, and a
 * gallery whose tiles went blank for those takes would be unusable in exactly the
 * setup that produces them. Depth is also what the take *is* - the colour stream is
 * half-rate and lags - so a depth poster is the honest preview of the material.
 *
 * Unprojected through the take's own intrinsics rather than drawn as a range image.
 * A raw depth buffer laid out as pixels is a picture of the sensor's grid, where
 * what someone skimming needs to recognise is where a body was standing.
 */
function drawFrame(canvas, take, payload, divisor) {
  const r = Math.min(devicePixelRatio || 1, 2);
  const w = canvas.parentElement.clientWidth;
  if (!w) return;
  const h = Math.round((w * 9) / 16);
  canvas.style.height = `${h}px`;
  if (canvas.width !== Math.round(w * r) || canvas.height !== Math.round(h * r)) {
    canvas.width = Math.round(w * r);
    canvas.height = Math.round(h * r);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(r, 0, 0, r, 0, 0);
  ctx.fillStyle = '#04060a';
  ctx.fillRect(0, 0, w, h);
  if (!payload) return;

  const view = new DataView(payload);
  const depthBytes = view.getUint32(0, true);
  const gw = Math.ceil(DEPTH_W / divisor);
  const gh = Math.ceil(DEPTH_H / divisor);
  if (depthBytes !== gw * gh * 2) return;
  const depth = new Uint16Array(payload, 16, depthBytes / 2);

  // The take's own intrinsics, scaled by the divisor - the grid shrank, so the
  // focal length and the principal point shrank with it. A poster drawn on the boot
  // defaults would translate every point together, which is an error nothing on
  // screen can show.
  const fx = (take.hello?.fx ?? 366) / divisor;
  const fy = (take.hello?.fy ?? 366) / divisor;
  const cx = (take.hello?.cx ?? DEPTH_W / 2) / divisor;
  const cy = (take.hello?.cy ?? DEPTH_H / 2) / divisor;

  const scale = h * 1.15;
  const ox = w / 2;
  const oy = h * 0.42;
  const img = ctx.createImageData(Math.round(w * r), Math.round(h * r));
  const px = img.data;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const mm = depth[y * gw + x];
      if (mm === 0) continue;
      const z = mm / 1000;
      if (z < 0.4 || z > 6) continue;
      const wx = ((x - cx) * z) / fx;
      const wy = -((y - cy) * z) / fy;
      const sx = Math.round((ox + (wx * scale) / z) * r);
      const sy = Math.round((oy - (wy * scale) / z) * r);
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
      // Near is bright, far falls away. One channel, because a poster is a shape
      // rather than a grade and a colour ramp here would be inventing a look.
      const v = Math.max(24, Math.round(255 * Math.max(0, (5 - z) / 5)));
      const i = (sy * img.width + sx) * 4;
      px[i] = v; px[i + 1] = v; px[i + 2] = Math.min(255, v + 12); px[i + 3] = 255;
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.putImageData(img, 0, 0);
  ctx.setTransform(r, 0, 0, r, 0, 0);
}

// ------------------------------------------------------------------------- tiles

function buildTile(take) {
  const tile = document.createElement('article');
  tile.className = 'tile';
  tile.dataset.id = take.id;
  // The hash, because a filename is not an identity here. Two machines can hold
  // genuinely different takes under one name, the library lists them as two
  // entries, and a tile keyed by name would be two tiles one selector cannot tell
  // apart - which is the same mistake the reconciliation refuses one layer down.
  tile.dataset.hash = take.hash ?? '';
  tile.dataset.state = take.state;
  // A take the recorder still has open. It is deliberately unscanned - no hash, no
  // frame count, no duration - because scanning a file that is still growing costs a
  // full read and a sha256 of a multi-gigabyte take against the disk the recorder is
  // writing to, and produces numbers that stop being true immediately. So its tile
  // says what it is rather than drawing zeros that look like facts.
  const shooting = take.recording === true;
  tile.dataset.recording = String(shooting);
  const divisor = DIVISOR[take.state] ?? 1;
  const marks = take.marks ?? [];
  const durationMs = Math.max(1, take.durationSec * 1000);

  tile.innerHTML = `
    <div class="skim"><canvas></canvas><span class="t">00:00</span>
      ${divisor > 1 ? `<span class="coarse">decimated ÷${divisor}</span>` : ''}</div>
    <div class="bar"><span class="done"></span><span class="pos"></span></div>
    <div class="meta">
      <div class="top"><span class="name"></span><span class="dur">${shooting ? '···' : mmss(take.durationSec)}</span></div>
      <div class="sub">
        <span class="state ${take.state}"><i></i>${take.state === 'remote' ? 'node' : take.state}</span>
        <span>${gb(take.bytes)}</span>
        <span>${shooting ? 'recording now' : `${take.frames} frames`}</span>
        <span>${marks.length ? `${marks.length} mark${marks.length === 1 ? '' : 's'}` : 'no marks'}</span>
        <span>${shooting ? 'no hash until it closes' : `${take.hash.slice(0, 15)}…`}</span>
        <span>${stamp(take.capturedAt)}${take.dateSource === 'mtime' ? ' (file date)' : ''}</span>
        ${take.truncated ? '<span class="flag">truncated — writer stopped mid-frame</span>' : ''}
        ${take.hasHello === false ? '<span class="flag">no sensor hello — intrinsics unknown</span>' : ''}
        ${!shooting && take.frames < 2 ? '<span class="flag">under two frames — nothing to bracket</span>' : ''}
        ${shooting ? '<span class="flag">still being written — stop the take to open, download or remove it</span>' : ''}
      </div>
      <div class="acts"></div>
    </div>`;

  // **A take's id is a filename, so it is text from outside this page too, and the
  // rule below applies to it exactly as it applies to a mark's label.** The id is
  // `basename(path)` with `.knct` taken off (`server/capture.js`), and `scanTakes`
  // admits any file whose name ends that way - `VALID_ID` guards the ids that arrive
  // from a *node*, and the recorder names its own takes, but nothing constrains a
  // file somebody dropped into the captures directory by hand. That is an ordinary
  // move in a design built around carrying takes between machines, and interpolating
  // the name into the template made `<img src=x onerror=...>.knct` run script on this
  // page's real origin the moment the gallery drew it - with every mutating route
  // then reachable, because the guard has nothing to say about a request the page
  // itself makes. Filtering the file out of the listing would be the wrong repair:
  // a gallery that hides footage is how footage gets lost.
  tile.querySelector('.name').textContent = take.id;

  // The marks go on through the DOM rather than through the template above. A
  // label is written by whoever pressed mark - on this machine or on a node whose
  // log arrived over the link - so it is text from outside this page, and text from
  // outside this page is never markup.
  const barEl = tile.querySelector('.bar');
  for (const m of marks) {
    const tick = document.createElement('span');
    tick.className = 'mk';
    tick.style.left = `${Math.max(0, Math.min(1, m.sourceMs / durationMs)) * 100}%`;
    tick.title = `${m.label ?? m.id} · ${(m.sourceMs / 1000).toFixed(2)}s`;
    barEl.appendChild(tick);
  }

  const acts = tile.querySelector('.acts');
  const button = (label, cls, onClick, disabled = false, why = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `act ${cls}`;
    b.textContent = label;
    b.disabled = disabled;
    if (why) b.title = why;
    b.dataset.act = label.toLowerCase();
    b.addEventListener('click', onClick);
    acts.appendChild(b);
    return b;
  };

  if (shooting) {
    // Every action on this tile needs a hash the take does not have yet, and the
    // server refuses all three for exactly that reason. Buttons that are there and
    // say why beat buttons that are missing: the library runs on the node's touch
    // panel, where a control that vanishes reads as the page being broken.
    const why = 'this take is still being recorded, so it has no hash to verify anything against';
    button('Open', 'primary', () => {}, true, why);
    button('Delete', 'danger', () => {}, true, why);
  } else if (take.state === 'remote') {
    button('Download', 'primary', () => run(
      tile,
      `downloading ${take.id} — asking ${library.node?.name ?? 'the node'} for ${gb(take.bytes)}`,
      () => post(`/library/download/${take.id}`),
      () => downloadProgress(take.id),
    ));
  } else {
    // A take that cannot be opened says so on the button rather than throwing when
    // pressed. Two frames is the floor for a pair source and a hello is what
    // carries the intrinsics, so both are properties of the take rather than of the
    // editor - and the gallery is where they are visible.
    const why = !take.hasHello
      ? 'this take carries no sensor hello, so its intrinsics are unknown'
      : take.frames < 2 ? 'a take needs two frames to bracket a position' : '';
    button('Open', 'primary', () => { location.href = `/edit?take=${encodeURIComponent(take.id)}`; }, !take.openable, why);
  }
  if (!shooting) {
    if (take.state === 'both') button('Reclaim', '', () => askReclaim(tile, take));
    button('Delete', 'danger', () => askDelete(tile, take));
  }

  // ---- skimming
  const canvas = tile.querySelector('canvas');
  const bar = tile.querySelector('.bar');
  const pos = tile.querySelector('.pos');
  const done = tile.querySelector('.done');
  const label = tile.querySelector('.t');
  const skim = tile.querySelector('.skim');
  let wanted = 0;
  let busy = false;

  const frameAt = async (t) => {
    // The take's frame count is what a position indexes into. A remote take is
    // read through the node, which this side proxies rather than reaching across
    // from the browser - one origin, and the node never learns a browser exists.
    const n = Math.max(0, Math.min(take.frames - 1, Math.round(t * (take.frames - 1))));
    const url = take.state === 'remote'
      ? `/library/remote-frame/${take.id}/${n}?decimate=${divisor}`
      : `/capture/${take.id}/frame/${n}?decimate=${divisor}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    return res.arrayBuffer();
  };

  // One request in flight at a time, with the latest wanted position kept. A scrub
  // fires a pointer event per pixel and a queue of them would draw the whole drag
  // in order, arriving later and later behind the finger - which is the shape of
  // lag people read as "the file is slow".
  const pump = async () => {
    if (busy) return;
    busy = true;
    try {
      while (true) {
        const t = wanted;
        let payload = null;
        try {
          payload = await frameAt(t);
        } catch { /* a take deleted mid-skim draws nothing rather than throwing */ }
        drawFrame(canvas, take, payload, divisor);
        // Counted, because "the poster is drawn" is otherwise unobservable from
        // outside: the first draw is a fetch behind a requestAnimationFrame, and a
        // reader that arrived before it landed would be measuring a blank canvas
        // and calling it the take.
        tile.dataset.draws = String(Number(tile.dataset.draws ?? 0) + 1);
        if (t === wanted) break;
      }
    } finally {
      busy = false;
    }
  };

  const setT = (t) => {
    const clamped = Math.max(0, Math.min(1, t));
    wanted = clamped;
    // Written straight from the pointer with no transition: skimming is direct
    // manipulation, and a position line that eased would lag the finger.
    pos.style.left = `${clamped * 100}%`;
    done.style.width = `${clamped * 100}%`;
    label.textContent = mmss(clamped * take.durationSec);
    pump();
  };

  const fromX = (clientX) => {
    const r = skim.getBoundingClientRect();
    setT((clientX - r.left) / r.width);
  };
  // A take still being recorded has no frame count to index a position into - it is
  // listed without being scanned - so it gets no skim at all rather than a scrub bar
  // that divides by a null. The tile still says what it is; there is simply nothing
  // to scrub through yet.
  if (!shooting) {
    skim.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' || e.buttons) fromX(e.clientX); });
    skim.addEventListener('pointerdown', (e) => { skim.setPointerCapture(e.pointerId); fromX(e.clientX); });
    skim.addEventListener('pointerleave', () => setT(0));
    bar.addEventListener('pointerdown', (e) => fromX(e.clientX));
    requestAnimationFrame(() => setT(0));
  }

  return tile;
}

/**
 * Runs a tile's action with its buttons held down, and reports on it while it runs.
 *
 * `watch` is a function returning the sentence to show right now, or null for
 * nothing new to say. It exists for the download, which is gigabytes over a room's
 * wifi behind one request that answers when it is done - so without it this printed
 * a fixed word for four minutes, indistinguishable from a transfer that had died.
 */
async function run(tile, message, action, watch = null) {
  for (const b of tile.querySelectorAll('.act')) b.disabled = true;
  say(message);
  // Polled rather than streamed: the progress is a number that changes slowly and a
  // second connection to carry it would be a second thing that can fail while the
  // transfer it describes is fine.
  const ticking = watch ? setInterval(async () => {
    try {
      const line = await watch();
      if (line) say(line);
    } catch { /* a poll that failed says nothing rather than replacing the state with an error */ }
  }, 700) : null;
  try {
    await action();
    say('');
    await refresh();
  } catch (err) {
    say(err.message);
    for (const b of tile.querySelectorAll('.act')) b.disabled = false;
  } finally {
    if (ticking) clearInterval(ticking);
  }
}

/** The sentence for a download in flight, or null once the server stops listing it. */
async function downloadProgress(id) {
  const res = await fetch('/library/downloads');
  const d = (await res.json()).downloading?.find((x) => x.id === id);
  if (!d) return null;
  if (d.phase === 'verifying') return `verifying ${id} — hashing ${gb(d.bytes)} to check the copy against the node`;
  const pct = d.bytes ? Math.min(100, (d.received / d.bytes) * 100) : 0;
  const rate = d.bytesPerSec / 1e6;
  // Remaining time from the average rate so far, which is the only rate that does
  // not swing by a factor of three between two polls of a wifi link.
  const left = d.bytesPerSec > 0 ? (d.bytes - d.received) / d.bytesPerSec : 0;
  return `downloading ${id} — ${pct.toFixed(0)}% of ${gb(d.bytes)} at ${rate.toFixed(1)} MB/s, `
    + `about ${left < 90 ? `${Math.ceil(left)}s` : `${Math.ceil(left / 60)}m`} left`;
}

// ------------------------------------------------------------------- the confirms

let confirmAction = null;
document.getElementById('cCancel').addEventListener('click', () => dlg.close());
document.getElementById('cGo').addEventListener('click', () => {
  dlg.close();
  confirmAction?.();
});

/**
 * The delete confirm, which now says what the server will actually do.
 *
 * **A `both` take cannot be deleted here, and the dialog used to promise it could.**
 * It read "a copy exists on both machines; this removes the one here", and
 * `serveRemoval` answers that exact request with a 409 - delete is the last copy,
 * reclaim is a copy while another survives, and they are two actions rather than one
 * action with two buttons. So the operator pressed Delete, agreed to something, and
 * got a refusal. It errs safe, which is why it survived a review, but a confirm that
 * describes an outcome the server declines is a confirm nobody can trust the next
 * time it says something irreversible.
 *
 * So a `both` take gets the explanation and no destructive button at all. Pointing
 * at Reclaim rather than quietly performing one: reclaim removes the copy on the
 * *node*, which is the opposite end from the one this dialog was offering, and
 * silently substituting it would be the wrong action confirmed under the right name.
 */
function askDelete(tile, take) {
  const alsoOnNode = take.state === 'both';
  document.getElementById('cTitle').textContent = alsoOnNode ? 'Two copies exist' : 'Delete take';
  // The id goes in as text, for the reason `buildTile` states: it is a filename and
  // nobody promised it was not markup. The dialogs are the worse place for it of the
  // two, because this one is the confirm in front of the only irreversible action.
  const body = document.getElementById('cBody');
  body.innerHTML =
    `<b class="tid"></b> · ${mmss(take.durationSec)} · ${gb(take.bytes)}`
    + (take.marks?.length ? ` · ${take.marks.length} marks` : ' · no marks')
    + `<br>on ${take.state === 'remote' ? library.node?.name : alsoOnNode ? `this ${library.here} and ${library.node?.name}` : `this ${library.here}`}.`;
  body.querySelector('.tid').textContent = take.id;
  document.getElementById('cWarn').textContent = alsoOnNode
    ? `Delete removes the last copy, and this take has two - so it is refused while ${library.node?.name} still holds one. `
      + 'Reclaim removes the copy over there, after re-hashing the one here.'
    : 'This is the only copy. Deleting it cannot be undone, and any project built on it loses its footage.';
  const go = document.getElementById('cGo');
  go.textContent = 'Delete';
  go.disabled = alsoOnNode;
  // The hash goes with the request, so a confirm built against one listing cannot
  // remove a take that changed since it was drawn.
  confirmAction = alsoOnNode ? null : () => run(tile, `deleting ${take.id}`,
    () => post(`/library/delete/${take.id}`, { hash: take.hash, confirm: true }));
  dlg.showModal();
}

function askReclaim(tile, take) {
  document.getElementById('cGo').disabled = false;
  document.getElementById('cTitle').textContent = `Reclaim on ${library.node?.name}`;
  const rBody = document.getElementById('cBody');
  rBody.innerHTML =
    `Free <b>${gb(take.bytes)}</b> on ${library.node?.name} by removing its copy of <b class="tid"></b>. `
    + `The copy here is re-hashed before anything is removed, and stays.`;
  rBody.querySelector('.tid').textContent = take.id;
  document.getElementById('cWarn').textContent = '';
  document.getElementById('cGo').textContent = 'Reclaim';
  confirmAction = () => run(tile, `reclaiming ${take.id}`, () => post(`/library/reclaim/${take.id}`));
  dlg.showModal();
}

// ------------------------------------------------------------------------ the list

function paint() {
  const shown = library.takes.filter((t) => filter === 'all' || t.state === filter);
  grid.replaceChildren();
  if (shown.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    // An empty library and a filtered-empty library are different facts and the
    // line says which. So is a node that could not be reached: reporting it as
    // having no takes would make a dropped link look like an operator who deleted
    // everything, and the Delete on the last copy would then be offered on a
    // belief that is wrong.
    empty.textContent = library.takes.length === 0
      ? 'No takes here yet. Record one, or link a capture node with --node.'
      : `No takes are ${filter}.`;
    grid.appendChild(empty);
  }
  for (const take of shown) grid.appendChild(buildTile(take));

  const total = library.takes.reduce((a, t) => a + t.durationSec, 0);
  document.getElementById('sum').innerHTML =
    `<b>${library.takes.length}</b> take${library.takes.length === 1 ? '' : 's'} · <b>${mmss(total)}</b>`;
  const node = library.node;
  document.getElementById('where').innerHTML = node
    ? `<span class="dot${node.reachable ? '' : ' off'}"></span>on <b>${library.here}</b> · node <b>${node.name}</b> ${node.reachable ? 'linked' : 'unreachable'} · reconciled by hash`
    : `<span class="dot"></span>on <b>${library.here}</b> · no node linked`;
  const space = document.getElementById('space');
  space.textContent = `${library.storage.label} left at current settings`;
  space.classList.toggle('low', library.storage.secondsLeft < 15 * 60);

  for (const tab of document.querySelectorAll('.tab')) {
    const f = tab.dataset.filter;
    const n = library.takes.filter((t) => f === 'all' || t.state === f).length;
    tab.textContent = `${f === 'remote' ? 'node only' : f} ${n}`;
    tab.setAttribute('aria-pressed', String(f === filter));
  }
  if (library.node && !library.node.reachable) say(`${library.node.name} is unreachable: ${library.node.error}`);
}

async function refresh() {
  library = await (await fetch('/library/all')).json();
  paint();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => { filter = tab.dataset.filter; paint(); });
}

await refresh();

// What a check reads. Every number here comes from the library's own state rather
// than from the DOM, except the mark ticks - those are read back off the page on
// purpose, because a tile that drew the right count in the wrong places is exactly
// the failure a state-only assertion would pass.
globalThis.__library = {
  state: () => library,
  filter: (f) => { filter = f; paint(); },
  refresh,
  tiles: () => [...grid.querySelectorAll('.tile')].map((el) => ({
    id: el.dataset.id,
    hash: el.dataset.hash,
    state: el.dataset.state,
    acts: [...el.querySelectorAll('.act')].map((b) => ({ label: b.textContent, disabled: b.disabled })),
    marks: [...el.querySelectorAll('.bar .mk')].map((m) => Number.parseFloat(m.style.left)),
    coarse: el.querySelector('.coarse')?.textContent ?? null,
    empty: false,
  })),
  emptyLine: () => grid.querySelector('.empty')?.textContent ?? null,
  /**
   * What a tile's confirm actually says, opened by pressing the tile's own button.
   *
   * Read off the dialog rather than off the function that fills it, because the
   * defect this exists for was a promise in the copy: the confirm offered to remove
   * one of two copies and the server answered that request with a 409. A check that
   * asserted what `askDelete` was called with could not have seen it.
   */
  confirmFor: (hash, act) => {
    const tile = grid.querySelector(`.tile[data-hash="${hash}"]`);
    const button = [...tile.querySelectorAll('.act')].find((b) => b.textContent === act);
    button.click();
    const out = {
      title: document.getElementById('cTitle').textContent,
      warn: document.getElementById('cWarn').textContent,
      go: document.getElementById('cGo').textContent,
      goDisabled: document.getElementById('cGo').disabled,
    };
    dlg.close();
    return out;
  },
  /** How many frames a tile has drawn. Waited on rather than slept against. */
  draws: (hash) => Number(grid.querySelector(`.tile[data-hash="${hash}"]`)?.dataset.draws ?? 0),

  async drawn(hash, atLeast = 1) {
    for (let i = 0; i < 200; i++) {
      if (this.draws(hash) >= atLeast) return this.draws(hash);
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error(`tile ${hash} never drew ${atLeast} frames`);
  },

  /** Skims a tile to a position and resolves once the frame it asked for is drawn. */
  async skimTo(hash, t) {
    const tile = grid.querySelector(`.tile[data-hash="${hash}"]`);
    const before = this.draws(hash);
    const skim = tile.querySelector('.skim');
    const r = skim.getBoundingClientRect();
    skim.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: r.left + r.width * t, clientY: r.top + r.height / 2, bubbles: true, pointerId: 1,
    }));
    // Waited on the draw counter rather than on a duration, so the assertion that
    // follows is about the frame the pointer asked for rather than about whatever
    // had been drawn when a timer happened to expire.
    await this.drawn(hash, before + 1);
    return { label: tile.querySelector('.t').textContent, left: tile.querySelector('.pos').style.left };
  },
  /**
   * What is actually on a tile's canvas: how bright it is on average, and a
   * signature over every pixel.
   *
   * Both, because they answer different questions and a check that only had the
   * mean would be blind to the one that matters. Two frames of the same take a
   * second apart have almost the same mean - the room did not get brighter - so a
   * mean-only assertion that a skim moved would sit on a threshold barely above its
   * own noise. The signature says whether the picture changed at all; the mean says
   * whether there is a picture there and how dense it is.
   */
  poster(hash) {
    const canvas = grid.querySelector(`.tile[data-hash="${hash}"] canvas`);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0;
    let h = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      sum += data[i];
      h = Math.imul(h ^ data[i], 16777619) >>> 0;
    }
    return { mean: sum / (data.length / 4), signature: h.toString(16) };
  },
};
