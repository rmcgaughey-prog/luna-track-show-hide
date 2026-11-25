// Track Show/Hide: DOM wiring. Connects to LUNA, follows the focused session, and renders
// what logic.js computes. Every listener is kept so it can be released when the session changes.

const $ = (id) => document.getElementById(id);
const EYE_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_SHUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.9 17.9A10.1 10.1 0 0 1 12 19C5 19 1 12 1 12a18.5 18.5 0 0 1 5.1-5.9M9.9 5.2A9.2 9.2 0 0 1 12 5c7 0 11 7 11 7a18.5 18.5 0 0 1-2.2 3.2M1 1l22 22"/></svg>';
const KIND_LABEL = { audio: 'audio', instrument: 'inst', midi: 'midi', video: 'video', bus: 'bus', folder: 'folder' };

let luna;
let session;
let hidden;
let presets;
let editing = false;
let armedDelete = null; // preset id whose Delete was clicked once
let releases = [];
let channelReleases = [];
const keep = (u) => releases.push(u);
const releaseAll = () => {
  for (const u of [...releases, ...channelReleases]) u();
  releases = [];
  channelReleases = [];
  hidden?.dispose();
  hidden = null;
  presets = null;
};

const query = () => $('search').value;

/** Run an action, showing an engine error rather than failing silently. */
async function act(fn) {
  try {
    await fn();
  } catch (e) {
    $('status').textContent = `error: ${e.code ?? e.message}`;
  }
}

// ---------------------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------------------

function allPresets() {
  const custom = presets ? presets.list().map((p) => ({ ...p, stock: false })) : [];
  return [...AddOnLogic.stockPresets(session), ...custom];
}

function renderPresets() {
  const root = $('presets');
  root.innerHTML = '';
  for (const p of allPresets()) {
    const b = document.createElement('button');
    const present = AddOnLogic.presentIds(session, p.ids);
    b.className = `chip${p.stock ? '' : ' custom'}`;
    b.classList.toggle('active', AddOnLogic.isActive(session, hidden, p.ids));
    b.textContent = p.name;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = present.length;
    b.appendChild(n);
    b.disabled = present.length === 0;
    b.title = `${p.stock ? 'Built in' : 'Saved with this session'}: ${present.length} track(s). Shift-click to add to what's shown.`;
    b.onclick = (e) => act(() => AddOnLogic.recall(session, hidden, p.ids, { add: e.shiftKey }));
    root.appendChild(b);
  }
  const add = document.createElement('button');
  add.className = 'chip add';
  add.textContent = '+ Save';
  add.title = 'Save the tracks shown now (or selected in LUNA) as a preset';
  add.disabled = !presets;
  add.onclick = openSavePanel;
  root.appendChild(add);

  $('editPresets').classList.toggle('on', editing);
  $('editPresets').disabled = !presets || (!editing && presets.list().length === 0);
  renderEditPanel();
  renderSaveCount();
}

function sourceIds() {
  return $('presetSource').value === 'selected' ? AddOnLogic.selectedIds(session) : AddOnLogic.shownIds(session, hidden);
}

function renderSaveCount() {
  if ($('savePanel').hidden) return;
  const ids = AddOnLogic.presentIds(session, sourceIds());
  $('saveCount').textContent = `${ids.length} track(s)`;
  const name = $('presetName').value.trim();
  $('saveConfirm').disabled = !name || ids.length === 0;
  $('saveConfirm').textContent = name && presets?.byName(name) ? 'Replace' : 'Save';
  $('presetSource').querySelector('[value=selected]').disabled = AddOnLogic.selectedIds(session).length === 0;
}

function openSavePanel() {
  $('savePanel').hidden = false;
  $('presetSource').value = 'shown';
  $('presetName').value = '';
  renderSaveCount();
  $('presetName').focus();
}

function closeSavePanel() {
  $('savePanel').hidden = true;
}

async function savePreset() {
  const name = $('presetName').value.trim();
  const ids = AddOnLogic.presentIds(session, sourceIds());
  if (!name || !ids.length || !presets) return;
  await act(async () => {
    await presets.save(name, ids);
    closeSavePanel();
    $('status').textContent = `Saved "${name}"`;
  });
}

function renderEditPanel() {
  const panel = $('editPanel');
  const list = presets ? presets.list() : [];
  if (!editing || !list.length) {
    panel.hidden = true;
    if (editing && !list.length) editing = false;
    return;
  }
  panel.hidden = false;
  // Keep a rename in progress: do not rebuild while one of its inputs has focus.
  if (panel.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  panel.innerHTML = '';
  for (const p of list) {
    const row = document.createElement('div');
    row.className = 'edit-row';
    row.innerHTML = '<input type="text" spellcheck="false"><span class="count"></span><button class="upd" title="Replace with the tracks shown now">Update</button><button class="del danger">Delete</button>';
    const input = row.querySelector('input');
    input.value = p.name;
    const commit = () => {
      const v = input.value.trim();
      if (v && v !== p.name) act(() => presets.rename(p.id, v));
      else input.value = p.name;
    };
    input.onchange = commit;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') {
        input.value = p.name;
        input.blur();
      }
    };
    input.onblur = () => setTimeout(renderPresets, 0);
    row.querySelector('.count').textContent = AddOnLogic.presentIds(session, p.ids).length;
    row.querySelector('.upd').onclick = () =>
      act(async () => {
        await presets.update(p.id, AddOnLogic.shownIds(session, hidden));
        $('status').textContent = `Updated "${p.name}"`;
      });
    const del = row.querySelector('.del');
    if (armedDelete === p.id) del.textContent = 'Confirm';
    del.onclick = () => {
      if (armedDelete !== p.id) {
        armedDelete = p.id;
        renderEditPanel();
        return;
      }
      armedDelete = null;
      act(() => presets.remove(p.id));
    };
    panel.appendChild(row);
  }
}

// ---------------------------------------------------------------------------------------
// Track list
// ---------------------------------------------------------------------------------------

// Click a row to toggle it; shift-click another to give every row in between the same state;
// press and drag across rows to paint them. A drag previews locally and writes once on release.
let listRows = []; // rows as listed (filtered), in order
let listEls = [];
let anchor = null; // { id, hide } of the last row clicked
let drag = null; // { start, end, hide }
let listStale = false; // a render arrived mid-drag

function paintRow(el, isHidden) {
  el.classList.toggle('hidden', isHidden);
  el.querySelector('.eye').innerHTML = isHidden ? EYE_SHUT : EYE_OPEN;
}

function previewDrag() {
  const lo = Math.min(drag.start, drag.end);
  const hi = Math.max(drag.start, drag.end);
  listEls.forEach((el, i) => {
    paintRow(el, i >= lo && i <= hi ? drag.hide : listRows[i].hidden);
    el.classList.toggle('painting', i >= lo && i <= hi);
  });
}

function rowIndexAt(x, y) {
  const el = document.elementFromPoint(x, y)?.closest('.track');
  return el ? Number(el.dataset.index) : null;
}

let lastPointerY = 0;
function autoScroll() {
  if (!drag) return;
  const main = $('tracks');
  const box = main.getBoundingClientRect();
  const edge = 28;
  let dy = 0;
  if (lastPointerY < box.top + edge) dy = -Math.ceil((box.top + edge - lastPointerY) / 3);
  else if (lastPointerY > box.bottom - edge) dy = Math.ceil((lastPointerY - (box.bottom - edge)) / 3);
  if (dy) {
    main.scrollTop += dy;
    const i = rowIndexAt(box.left + 40, Math.min(Math.max(lastPointerY, box.top + 2), box.bottom - 2));
    if (i !== null && i !== drag.end) {
      drag.end = i;
      previewDrag();
    }
  }
  requestAnimationFrame(autoScroll);
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  const i = rowIndexAt(e.clientX, e.clientY);
  if (i === null) return;
  e.preventDefault();
  const row = listRows[i];
  if (e.shiftKey && anchor) {
    const from = listRows.findIndex((r) => r.id === anchor.id);
    if (from >= 0) {
      const ids = AddOnLogic.rangeIds(listRows, from, i);
      act(() => hidden.setState(ids, anchor.hide));
      return;
    }
  }
  drag = { start: i, end: i, hide: !row.hidden };
  anchor = { id: row.id, hide: drag.hide };
  lastPointerY = e.clientY;
  $('tracks').setPointerCapture(e.pointerId);
  previewDrag();
  requestAnimationFrame(autoScroll);
}

function onPointerMove(e) {
  if (!drag) return;
  lastPointerY = e.clientY;
  const box = $('tracks').getBoundingClientRect();
  const i = rowIndexAt(box.left + 40, Math.min(Math.max(e.clientY, box.top + 2), box.bottom - 2));
  if (i !== null && i !== drag.end) {
    drag.end = i;
    previewDrag();
  }
}

function onPointerUp(e) {
  if (!drag) return;
  const { start, end, hide } = drag;
  drag = null;
  $('tracks').releasePointerCapture?.(e.pointerId);
  const ids = AddOnLogic.rangeIds(listRows, start, end);
  if (e.type === 'pointercancel') {
    render();
    return;
  }
  act(() => hidden.setState(ids, hide)).then(() => {
    if (listStale) render();
  });
}

function renderList() {
  if (drag) {
    listStale = true;
    return;
  }
  listStale = false;
  const root = $('tracks');
  const rows = AddOnLogic.rows(session, hidden, query());
  const scroll = root.scrollTop;
  root.innerHTML = '';
  listRows = rows;
  listEls = rows.map((row, i) => {
    const el = document.createElement('div');
    el.className = 'track';
    el.dataset.index = i;
    el.classList.toggle('in-folder', !!row.folder);
    el.classList.toggle('anchor', anchor?.id === row.id);
    el.innerHTML = '<span class="swatch"></span><span class="name"></span><span class="type"></span><span class="eye"></span>';
    el.querySelector('.swatch').style.background = row.color;
    el.querySelector('.name').textContent = row.name;
    el.querySelector('.type').textContent = KIND_LABEL[row.kind] ?? row.kind;
    paintRow(el, row.hidden);
    root.appendChild(el);
    return el;
  });
  root.scrollTop = scroll;
  if (!rows.length) root.innerHTML = `<div id="empty">${query() ? 'No tracks match.' : 'No tracks in this session.'}</div>`;

  $('count').textContent = AddOnLogic.summary(session, hidden);
  const selected = AddOnLogic.selectedIds(session).length > 0;
  $('onlySelected').disabled = !selected;
  $('hideSelected').disabled = !selected;
  const shownCount = AddOnLogic.shownIds(session, hidden).length;
  $('showAll').disabled = shownCount === AddOnLogic.channels(session).length;
  $('hideAll').disabled = shownCount === 0;
  $('matchActions').hidden = !query().trim();
}

function render() {
  if (!session || !hidden) return;
  renderList();
  renderPresets();
}

/** Follow each channel's name, colour and folder mode; rebuilt whenever the channel list changes. */
function bindChannels() {
  for (const u of channelReleases) u();
  channelReleases = [];
  for (const ch of AddOnLogic.channels(session)) {
    channelReleases.push(ch.name.onChange(render));
    if (ch.color) channelReleases.push(ch.color.onChange(render));
    if (ch.folderMode) channelReleases.push(ch.folderMode.onChange(render));
  }
  render();
}

async function bindSession() {
  releaseAll();
  closeSavePanel();
  editing = false;
  session = luna.sessions.current();
  if (!session) {
    $('status').textContent = 'no session open';
    $('count').textContent = '';
    $('tracks').innerHTML = '';
    $('presets').innerHTML = '';
    return;
  }
  const current = session;
  await session.ready();
  if (current !== session) return;
  $('status').textContent = session.name.value ?? '';
  hidden = new AddOnLogic.HiddenTracks(luna, session);

  keep(hidden.onChange(render));
  keep(session.tracks.onChange(bindChannels));
  keep(session.buses.onChange(bindChannels));
  keep(session.context.selectionTracks.onChange(render));
  keep(session.name.onChange(() => ($('status').textContent = session.name.value ?? '')));
  bindChannels();

  // Presets live in session storage, which an older LUNA does not have: the stock ones still work.
  const store = new AddOnLogic.PresetStore(session);
  try {
    await store.load();
    if (current !== session) return;
    presets = store;
    keep(presets.onChange(render));
  } catch (e) {
    $('status').textContent = `presets unavailable: ${e.code ?? e.message}`;
  }
  render();
}

function matchingIds() {
  return AddOnLogic.rows(session, hidden, query()).map((r) => r.id);
}

function wireButtons() {
  $('search').oninput = render;
  $('search').onkeydown = (e) => {
    if (e.key === 'Escape') {
      $('search').value = '';
      render();
      e.preventDefault();
    }
  };
  $('showAll').onclick = () => act(() => hidden.showAll());
  $('hideAll').onclick = () => act(() => hidden.hideAll());
  const list = $('tracks');
  list.addEventListener('pointerdown', onPointerDown);
  list.addEventListener('pointermove', onPointerMove);
  list.addEventListener('pointerup', onPointerUp);
  list.addEventListener('pointercancel', onPointerUp);
  $('invert').onclick = () => act(() => hidden.invert());
  $('onlySelected').onclick = () => act(() => hidden.showOnly(AddOnLogic.selectedIds(session)));
  $('hideSelected').onclick = () => act(() => hidden.hide(AddOnLogic.selectedIds(session)));
  $('showMatching').onclick = () => act(() => hidden.show(matchingIds()));
  $('hideMatching').onclick = () => act(() => hidden.hide(matchingIds()));
  $('onlyMatching').onclick = () => act(() => hidden.showOnly(matchingIds()));

  $('editPresets').onclick = () => {
    editing = !editing;
    armedDelete = null;
    renderPresets();
  };
  $('presetName').oninput = renderSaveCount;
  $('presetSource').onchange = renderSaveCount;
  $('presetName').onkeydown = (e) => {
    if (e.key === 'Enter') savePreset();
    if (e.key === 'Escape') {
      closeSavePanel();
      e.preventDefault();
    }
  };
  $('saveConfirm').onclick = savePreset;
  $('saveCancel').onclick = closeSavePanel;
}

async function connect() {
  wireButtons();
  for (;;) {
    try {
      // Inside LUNA the page URL carries ?port=; in a browser this falls back to LUNA on localhost.
      luna = await Luna.connect();
      break;
    } catch (e) {
      $('status').textContent = e instanceof Luna.NotRunning ? 'waiting for LUNA...' : e.message;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  // LUNA's undo, redo, play and record keys for anything this page does not handle itself.
  Luna.bindShortcuts(luna);
  await luna.sessions.ready();
  luna.sessions.focused.onChange(bindSession);
  luna.sessions.items.onChange(bindSession);
  luna.status.onChange(() => {
    if (luna.status.value === 'disconnected') $('status').textContent = 'reconnecting...';
  });
  await bindSession();
}

connect();
