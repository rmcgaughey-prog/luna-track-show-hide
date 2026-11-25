// Track Show/Hide: logic that does not touch the DOM, so tests can exercise it against Luna.MockEngine.
//
// LUNA keeps the hidden tracks as a list of channel uids on the session's main edit context,
// `/sessions/<uid>/contexts/main/hidden_tracks`. Track and aux-bus uids (folders are aux buses)
// go in the same list. The SDK reads it as `session.context.hiddenTracks` (read-only), so writes
// go through `luna.raw.set`. Measured on LUNA 3.1.x: a write hides or shows the channels in
// the Timeline and Mixer at once, makes no undo entry, and is not pushed back to the client
// that wrote it (only to others), so HiddenTracks below keeps its own copy of what it wrote.
//
// Presets ("views") are lists of channel uids. The stock ones are computed from channel kinds;
// the user's own are kept in session storage, so they travel with the session.

const PRESET_CONTEXT = 'com.track_show_hide.presets';

/** LUNA colours are 0xAARRGGBB numbers; the page wants CSS. */
function cssColor(argb) {
  if (typeof argb !== 'number') return '#666';
  return `#${(argb & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Path of the hidden-tracks property on a session. */
function hiddenTracksPath(session) {
  return `/sessions/${session.id}/contexts/main/hidden_tracks`;
}

const isBus = (ch) => ch && 'busType' in ch;

/** What kind of channel this is, for display and the stock presets. */
function kindOf(ch) {
  if (isBus(ch)) return ch.isFolder ? 'folder' : 'bus';
  const t = ch.trackType?.value;
  if (t === 'midi_matrix') return 'midi';
  if (t === 'multi_output') return 'instrument';
  return t ?? 'audio';
}

const SYSTEM_TRACKS = new Set(['click', 'count_in']);

/**
 * The channels a user can show or hide, in LUNA's order: tracks (no click or count-in) and
 * aux buses, folders included. The master and cue buses are left out.
 */
function channels(session) {
  return session.channelsInOrder.filter((ch) => {
    if (isBus(ch)) return ch.busType.value === 'aux';
    return !SYSTEM_TRACKS.has(ch.trackType.value ?? '');
  });
}

/** The built-in presets, one per kind of channel. */
const STOCK_PRESETS = [
  { id: 'stock:all', name: 'All', kinds: null },
  { id: 'stock:audio', name: 'Audio', kinds: ['audio'] },
  { id: 'stock:instrument', name: 'Instrument', kinds: ['instrument'] },
  { id: 'stock:midi', name: 'MIDI', kinds: ['midi'] },
  { id: 'stock:bus', name: 'Buses', kinds: ['bus'] },
  { id: 'stock:folder', name: 'Folders', kinds: ['folder'] },
];

/**
 * The hidden-channel list of one session: LUNA's value, or what this page last wrote until
 * LUNA says otherwise. `onChange(fn)` fires for both.
 */
class HiddenTracks {
  constructor(luna, session) {
    this.luna = luna;
    this.session = session;
    this.listeners = new Set();
    this.local = null; // what we wrote; LUNA does not echo our own write back
    this.unsubscribe = session.context.hiddenTracks.onChange(() => {
      this.local = null; // a push from LUNA (the user hid something there) wins
      this.emit();
    });
  }

  /** Uids of the hidden channels. */
  get ids() {
    return [...(this.local ?? this.session.context.hiddenTracks.value ?? [])];
  }

  isHidden(id) {
    return this.ids.includes(id);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  /** Replace the whole hidden list. */
  async set(ids) {
    const next = [...new Set(ids)];
    const previous = this.local;
    this.local = next;
    this.emit();
    try {
      await this.luna.raw.set(hiddenTracksPath(this.session), next);
    } catch (e) {
      this.local = previous;
      this.emit();
      throw e;
    }
  }

  async hide(ids) {
    await this.set([...this.ids, ...ids]);
  }

  async show(ids) {
    const drop = new Set(ids);
    await this.set(this.ids.filter((id) => !drop.has(id)));
  }

  async toggle(id) {
    if (this.isHidden(id)) await this.show([id]);
    else await this.hide([id]);
  }

  /** Hide or show these channels in one write. */
  async setState(ids, hide) {
    if (hide) await this.hide(ids);
    else await this.show(ids);
  }

  /** Show every channel. */
  async showAll() {
    await this.set([]);
  }

  /** Hide every listed channel. */
  async hideAll() {
    await this.hide(channels(this.session).map((c) => c.id));
  }

  /** Show only these channels; hide every other one. Hidden uids that are not listed channels stay hidden. */
  async showOnly(ids) {
    const keep = new Set(ids);
    const listed = channels(this.session).map((c) => c.id);
    const listedSet = new Set(listed);
    const others = this.ids.filter((id) => !listedSet.has(id));
    await this.set([...others, ...listed.filter((id) => !keep.has(id))]);
  }

  /** Swap hidden and shown among the listed channels. */
  async invert() {
    const listed = channels(this.session).map((c) => c.id);
    const listedSet = new Set(listed);
    const hidden = new Set(this.ids);
    const others = this.ids.filter((id) => !listedSet.has(id));
    await this.set([...others, ...listed.filter((id) => !hidden.has(id))]);
  }

  dispose() {
    this.unsubscribe();
    this.listeners.clear();
  }
}

/**
 * The user's presets, kept in session storage: one record per preset with a `name` and a
 * `channels` field (a list of uids).
 */
class PresetStore {
  constructor(session) {
    this.session = session;
    this.store = session.storage.context(PRESET_CONTEXT);
  }

  async load() {
    await this.store.load();
  }

  /** The presets, sorted by name. */
  list() {
    return (this.store.records.value ?? [])
      .map((id) => ({
        id,
        name: this.store.value(id, 'name').value,
        ids: this.store.value(id, 'channels').value ?? [],
      }))
      .filter((p) => typeof p.name === 'string')
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }

  /** Call fn when a preset is added, removed, renamed or changed. Returns an unsubscribe. */
  onChange(fn) {
    let inner = [];
    const rebind = () => {
      for (const u of inner) u();
      inner = [];
      for (const id of this.store.records.value ?? []) {
        inner.push(this.store.value(id, 'name').onChange(fn));
        inner.push(this.store.value(id, 'channels').onChange(fn));
      }
    };
    const outer = this.store.records.onChange(() => {
      rebind();
      fn();
    });
    rebind();
    return () => {
      outer();
      for (const u of inner) u();
    };
  }

  /** The preset with this name (case-insensitive), if any. */
  byName(name) {
    const n = name.trim().toLowerCase();
    return this.list().find((p) => p.name.toLowerCase() === n);
  }

  /** Save a new preset, or replace the channels of one with the same name. Resolves to its id. */
  async save(name, ids) {
    const clean = name.trim();
    if (!clean) throw new Error('A preset needs a name');
    const existing = this.byName(clean);
    if (existing) {
      await this.store.set(existing.id, 'channels', [...ids]);
      return existing.id;
    }
    const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await this.store.add(id, 'name', clean);
    await this.store.add(id, 'channels', [...ids]);
    return id;
  }

  async update(id, ids) {
    await this.store.set(id, 'channels', [...ids]);
  }

  async rename(id, name) {
    const clean = name.trim();
    if (!clean) throw new Error('A preset needs a name');
    await this.store.set(id, 'name', clean);
  }

  async remove(id) {
    await this.store.remove(id);
  }
}

const AddOnLogic = {
  HiddenTracks,
  PresetStore,
  PRESET_CONTEXT,
  STOCK_PRESETS,
  cssColor,
  hiddenTracksPath,
  kindOf,
  channels,

  /** One row of the list. */
  row(ch, hidden) {
    return {
      id: ch.id,
      name: ch.name.value ?? ch.id,
      kind: kindOf(ch),
      color: cssColor(ch.color?.value),
      folder: ch.folderUid?.value ?? null,
      hidden: hidden.isHidden(ch.id),
    };
  },

  /** Rows for every listed channel, filtered by a search string (case-insensitive, name or kind). */
  rows(session, hidden, query = '') {
    const q = query.trim().toLowerCase();
    return channels(session)
      .map((ch) => AddOnLogic.row(ch, hidden))
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.kind.includes(q));
  },

  /** Uids of the listed channels that are showing. */
  shownIds(session, hidden) {
    return channels(session).filter((ch) => !hidden.isHidden(ch.id)).map((ch) => ch.id);
  },

  /**
   * The ids of the rows from one index to another, inclusive, in either direction. Used for a
   * shift-click range and a drag across the list, which act on the rows as listed (filtered).
   */
  rangeIds(rows, from, to) {
    const a = Math.max(0, Math.min(from, to));
    const b = Math.min(rows.length - 1, Math.max(from, to));
    return rows.slice(a, b + 1).map((r) => r.id);
  },

  /** "12 of 40 shown". */
  summary(session, hidden) {
    const all = channels(session);
    return `${AddOnLogic.shownIds(session, hidden).length} of ${all.length} shown`;
  },

  /** Uids of the channels selected in LUNA. */
  selectedIds(session) {
    return session.context.selectionTracks.value ?? [];
  },

  /** The uids a stock preset shows in this session. */
  stockIds(session, preset) {
    const list = channels(session);
    return (preset.kinds ? list.filter((ch) => preset.kinds.includes(kindOf(ch))) : list).map((ch) => ch.id);
  },

  /** The stock presets with something to show in this session ("All" always). */
  stockPresets(session) {
    return STOCK_PRESETS.map((p) => ({ ...p, ids: AddOnLogic.stockIds(session, p), stock: true })).filter(
      (p) => !p.kinds || p.ids.length > 0,
    );
  },

  /** A preset's uids that still exist in the session. */
  presentIds(session, ids) {
    const listed = new Set(channels(session).map((ch) => ch.id));
    return ids.filter((id) => listed.has(id));
  },

  /** Recall a preset: show only its channels, or with `add` show them on top of what is shown. */
  async recall(session, hidden, ids, { add = false } = {}) {
    const present = AddOnLogic.presentIds(session, ids);
    if (add) await hidden.show(present);
    else await hidden.showOnly(present);
  },

  /** Whether what is shown now is exactly this preset. */
  isActive(session, hidden, ids) {
    const present = AddOnLogic.presentIds(session, ids);
    const shown = AddOnLogic.shownIds(session, hidden);
    if (present.length === 0 || present.length !== shown.length) return false;
    const set = new Set(present);
    return shown.every((id) => set.has(id));
  },
};

globalThis.AddOnLogic = AddOnLogic;
