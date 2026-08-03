// ---------------------------------------------------------------------------
// state.js — Global state, settings, LRU meta cache, ReplayGain audio graph,
// shared icon SVGs, core DOM element refs, and the api() fetch helper.
// Must load FIRST: every other file depends on globals defined here.
// ---------------------------------------------------------------------------

let currentPath = '';
let preSearchPath = '';
let isSearching = false;
let searchDebounce = null;
let queue = []; // array of {path, name} — the currently displayed/playing order
let originalQueue = []; // baseline (unshuffled) order, used to restore when shuffle is toggled off
let shuffled = false;
let queueIndex = -1;
let playlists = {};
let loopMode = 'off'; // 'off' | 'all' | 'one'
let playerArtTrackPath = null; // guards against a slow-loading image resolving after the track changed again
const speeds = [0.5, 1, 1.5, 2];
let speedIndex = 1;
// Capped LRU for track metadata (title/artist/duration/etc). Wrapped in a
// Proxy so every existing call site (metaCache[path], delete metaCache[path])
// keeps working unchanged, while eviction happens underneath via a Map that
// re-orders itself on every read/write - Maps preserve insertion order, so
// the first key is always the least-recently-used one.
const METACACHE_MAX = 20000;
function createLruCache(max) {
  const store = new Map();
  const touch = (key) => {
    const val = store.get(key);
    store.delete(key);
    store.set(key, val);
    return val;
  };
  return new Proxy({}, {
    get(_, key) {
      if (typeof key !== 'string') return undefined;
      return store.has(key) ? touch(key) : undefined;
    },
    set(_, key, value) {
      if (typeof key === 'string') {
        store.delete(key);
        store.set(key, value);
        if (store.size > max) store.delete(store.keys().next().value);
      }
      return true;
    },
    deleteProperty(_, key) {
      if (typeof key === 'string') store.delete(key);
      return true;
    },
    has(_, key) {
      return typeof key === 'string' && store.has(key);
    }
  });
}
const metaCache = createLruCache(METACACHE_MAX); // path -> {title, artist, duration, hasArt}

// ---------- Shared icons (flat, monochrome to match the app's style; folder uses the accent blue) ----------
const TRASH_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>`;
const FOLDER_ICON_SVG = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
const GLOBE_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`;
const EDIT_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
const PLUS_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
const PLAYLIST_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>`;
const RENAME_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>`;

// ---------- Settings ----------
const DEFAULT_SETTINGS = {
  seekBack: 5,
  seekForward: 10,
  skipDeleteConfirm: false,
  rememberVolume: false,
  hideNonMusic: false,
  replayGainEnabled: true,
  maxItemsLoad: 100 // rows loaded per chunk in file lists/queue/playlists; 0 = unlimited (load everything at once)
};
let settings = { ...DEFAULT_SETTINGS };
function loadSettings() {
  try {
    const raw = localStorage.getItem('musicapp-settings');
    if (raw) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {}
}
function saveSettings() {
  try { localStorage.setItem('musicapp-settings', JSON.stringify(settings)); } catch {}
}
loadSettings();

const audioEl = document.getElementById('audioEl');

// ---------- ReplayGain volume normalization ----------
let gainNode = null;
let audioCtx = null;
const RG_MAX_BOOST_DB = 6; // don't boost a quiet track more than this, to avoid clipping/distortion
function ensureAudioGraph() {
  if (gainNode) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaElementSource(audioEl);
  gainNode = audioCtx.createGain();
  source.connect(gainNode).connect(audioCtx.destination);
}
function applyReplayGain(db) {
  if (!settings.replayGainEnabled) {
    if (gainNode) gainNode.gain.value = 1;
    return;
  }
  ensureAudioGraph();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const clamped = (typeof db === 'number') ? Math.min(db, RG_MAX_BOOST_DB) : 0;
  gainNode.gain.value = Math.pow(10, clamped / 20);
}
const fileList = document.getElementById('fileList');
const breadcrumb = document.getElementById('breadcrumb');
const queuePanel = document.getElementById('queuePanel');
const playlistsPanel = document.getElementById('playlistsPanel');
const contextMenu = document.getElementById('contextMenu');
const modalOverlay = document.getElementById('modalOverlay');
const modalInput = document.getElementById('modalInput');
const modalTitle = document.getElementById('modalTitle');
const searchInput = document.getElementById('searchInput');
const searchClearBtn = document.getElementById('searchClearBtn');

// ---------- API helpers ----------
let isAuthenticated = false;
let authConfigured = true;