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
// Single choke point for changing playback speed, called by every UI that
// can set it (the discrete speedBtn/speedMenu and mobile fpSpeedBtn in
// controls.js/layout-init.js, and the mixer's continuous slider in
// panel-tabs.js) so they can never drift out of sync with each other -
// each previously called NativeAudioAdapter.setRate directly and updated
// only its own display. speedIndex only tracks the nearest discrete step,
// for highlighting the right entry in the discrete speedMenu - the button
// label itself always shows the real rate, continuous or not.
function setPlaybackSpeed(rate) {
  NativeAudioAdapter.setRate(rate);
  speedIndex = speeds.reduce((best, sp, i) => Math.abs(sp - rate) < Math.abs(speeds[best] - rate) ? i : best, 0);
  if (typeof setSpeedBtnLabel === 'function') setSpeedBtnLabel(rate);
  if (typeof syncMixerSpeedUI === 'function') syncMixerSpeedUI(rate);
}
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
const MUSIC_NOTE_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
const CLOSE_ICON_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
// Note: PLAY_ICON_SVG is already declared in browse.js (used by the
// library "Play all" button) — reused here for the playlist play button
// instead of redeclaring, which would throw a duplicate-const SyntaxError
// and break every script loaded after it.

// ---------- Settings ----------
const DEFAULT_SETTINGS = {
  seekBack: 5,
  seekForward: 10,
  skipDeleteConfirm: false,
  rememberVolume: false,
  hideNonMusic: false,
  mobileFileRowView: 'name', // 'name' | 'meta' — mobile file list row display (see filelist.js/topbar toggle)
  replayGainEnabled: true,
  maxItemsLoad: 20, // rows loaded per chunk in file lists/queue/playlists; 0 = unlimited (load everything at once)
  eqBass: 0, // dB, -12..12 - see ensureAudioGraph()'s bassNode
  eqMid: 0,
  eqTreble: 0,
  visualizerStyle: 'bars', // 'bars' | 'mirror' | 'wave' | 'circular' - see panel-tabs.js's VISUALIZER_DRAWERS
  preservePitch: true, // when true, speed changes use the browser's built-in playbackRate pitch correction; when false, pitchSemitones (below) applies an independent shift via ensurePitchStretchNode()
  pitchSemitones: 0 // -12..12, only active while preservePitch is false - see ensurePitchStretchNode()
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

// ---------- ReplayGain volume normalization / EQ / visualizer ----------
// Single shared WebAudio graph (an HTMLMediaElement can only be captured by
// createMediaElementSource once), used by ReplayGain, the mixer's 3-band EQ,
// and the visualizer's AnalyserNode:
//   source -> bassNode -> midNode -> trebleNode -> [pitchStretchNode] -> analyserNode -> gainNode -> destination
// pitchStretchNode (see ensurePitchStretchNode()) is spliced in later and
// lazily, since it loads a WASM AudioWorklet - only paid for if the mixer's
// pitch control is actually used, rather than on every track load.
let gainNode = null;
let audioCtx = null;
let bassNode = null, midNode = null, trebleNode = null, analyserNode = null;
let pitchStretchNode = null;
const RG_MAX_BOOST_DB = 6; // don't boost a quiet track more than this, to avoid clipping/distortion
function ensureAudioGraph() {
  if (gainNode) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaElementSource(audioEl);
  bassNode = audioCtx.createBiquadFilter();
  bassNode.type = 'lowshelf';
  bassNode.frequency.value = 200;
  bassNode.gain.value = settings.eqBass;
  midNode = audioCtx.createBiquadFilter();
  midNode.type = 'peaking';
  midNode.frequency.value = 1000;
  midNode.Q.value = 0.8;
  midNode.gain.value = settings.eqMid;
  trebleNode = audioCtx.createBiquadFilter();
  trebleNode.type = 'highshelf';
  trebleNode.frequency.value = 3000;
  trebleNode.gain.value = settings.eqTreble;
  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 256;
  gainNode = audioCtx.createGain();
  source.connect(bassNode).connect(midNode).connect(trebleNode).connect(analyserNode).connect(gainNode).connect(audioCtx.destination);
}
function setEQBand(band, db) {
  ensureAudioGraph();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const clamped = Math.max(-12, Math.min(12, db));
  if (band === 'bass') { settings.eqBass = clamped; bassNode.gain.value = clamped; }
  else if (band === 'mid') { settings.eqMid = clamped; midNode.gain.value = clamped; }
  else if (band === 'treble') { settings.eqTreble = clamped; trebleNode.gain.value = clamped; }
  saveSettings();
}

// Lazily creates SignalsmithStretch's live-input AudioWorklet node, so the
// mixer's pitch slider can shift pitch independent of playbackRate (the
// browser's own preservesPitch ties them together and offers no way to
// decouple them - see panel-tabs.js's mixer section for the fuller
// explanation). The node is created once and left permanently connected in
// parallel (trebleNode -> pitchStretchNode -> analyserNode), NOT spliced
// into the main trebleNode -> analyserNode path - an inactive live-input
// stretch node outputs silence rather than passing audio through
// unchanged, so swapping the main path through it would mute playback
// every time preserve-pitch is re-enabled. setPitchStretchActive() instead
// toggles which of the two parallel paths is actually connected to
// analyserNode. Returns a Promise resolving to the node; safe to call
// multiple times, only creates it once.
let pitchStretchNodePromise = null;
function ensurePitchStretchNode() {
  ensureAudioGraph();
  if (pitchStretchNodePromise) return pitchStretchNodePromise;
  pitchStretchNodePromise = SignalsmithStretch(audioCtx).then((node) => {
    trebleNode.connect(node);
    node.start();
    pitchStretchNode = node;
    return node;
  });
  return pitchStretchNodePromise;
}
// preserve=true: normal trebleNode -> analyserNode path (pitch tied to
// playbackRate via the browser). preserve=false: trebleNode -> pitchStretchNode
// -> analyserNode instead, for independent pitch control.
function setPitchStretchActive(active) {
  ensurePitchStretchNode().then((node) => {
    // disconnect(destination) throws if that specific connection doesn't
    // currently exist (e.g. the first time this runs, node was never
    // connected to analyserNode yet) - each call is independent, so one
    // throwing must not stop the other disconnect/connect calls below from
    // running, or the graph is left half-rewired with no path to
    // analyserNode at all (total silence).
    try { trebleNode.disconnect(analyserNode); } catch {}
    try { node.disconnect(analyserNode); } catch {}
    if (active) node.connect(analyserNode);
    else trebleNode.connect(analyserNode);
    node.schedule({ active, semitones: settings.pitchSemitones });
  });
}
// ReplayGain is temporarily disabled on *web* mobile viewports: it requires
// permanently rerouting audio through a WebAudio graph (see
// createMediaElementSource below), and mobile browser OSes suspend/kill
// WebAudio-routed audio far more aggressively than a plain <audio> element
// in the background — this was causing unreliable background playback and a
// stuck-audio-loop bug on resume. The setting/UI and all the graph code are
// left intact; this is the single choke point every call site (playback.js,
// settings-auth-toast-lyrics.js) goes through, so gating it here disables
// ReplayGain on web mobile without touching anything else.
//
// STEP 3: on native, none of that applies — NativeAudioAdapter.setReplayGainFactor()
// sets a plain native player volume multiplier, not a WebAudio graph, so
// there's no backgrounding risk to gate against. REPLAYGAIN_MOBILE_QUERY
// (a *viewport width* check) is intentionally NOT used to gate the native
// path: it's a proxy for "mobile browser layout", not "native app", and a
// native app on a wide/tablet viewport should still get the native
// ReplayGain path, while a same-width *web* mobile view correctly keeps
// using the disabled/GainNode-avoidance behavior below.
const REPLAYGAIN_MOBILE_QUERY = window.matchMedia('(max-width: 780px)');
function applyReplayGain(db) {
  const clamped = (typeof db === 'number') ? Math.min(db, RG_MAX_BOOST_DB) : 0;
  const factor = Math.pow(10, clamped / 20);

  if (NativeAudioAdapter.isNative()) {
    NativeAudioAdapter.setReplayGainFactor(settings.replayGainEnabled ? factor : 1);
    return;
  }

  if (REPLAYGAIN_MOBILE_QUERY.matches || !settings.replayGainEnabled) {
    if (gainNode) gainNode.gain.value = 1;
    return;
  }
  ensureAudioGraph();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  gainNode.gain.value = factor;
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