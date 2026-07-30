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
const FOLDER_ICON_SVG = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#6ea8fe" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
const GLOBE_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`;
const EDIT_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;

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

async function api(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({error: res.statusText}));
    if (res.status === 401) {
      isAuthenticated = false;
      updateAuthBtn();
      openLoginModal(err.error || 'Log in to make changes');
    }
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

function fileNameOf(p) { return p.split('/').pop(); }
function dirNameOf(p) { return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''; }

// ---------- Multi-select (ctrl+click, shift+click) ----------
let lastRenderedItems = []; // ordered list of items currently shown, for shift-range selection
let selectedItems = new Map(); // path -> item
let lastClickedPath = null;

function refreshSelectionVisuals() {
  document.querySelectorAll('.file-row').forEach(el => {
    el.classList.toggle('selected', selectedItems.has(el.dataset.path));
  });
}
function clearSelection() {
  if (selectedItems.size === 0 && !lastClickedPath) return;
  selectedItems.clear();
  lastClickedPath = null;
  refreshSelectionVisuals();
}
function selectOnly(item) {
  selectedItems.clear();
  selectedItems.set(item.path, item);
  lastClickedPath = item.path;
  refreshSelectionVisuals();
}
function toggleSelect(item) {
  if (selectedItems.has(item.path)) selectedItems.delete(item.path);
  else selectedItems.set(item.path, item);
  lastClickedPath = item.path;
  refreshSelectionVisuals();
}
function rangeSelect(item) {
  const idx2 = lastRenderedItems.findIndex(i => i.path === item.path);
  let idx1 = lastClickedPath ? lastRenderedItems.findIndex(i => i.path === lastClickedPath) : idx2;
  if (idx1 === -1) idx1 = idx2;
  if (idx2 === -1) return;
  const [start, end] = idx1 < idx2 ? [idx1, idx2] : [idx2, idx1];
  for (let i = start; i <= end; i++) {
    selectedItems.set(lastRenderedItems[i].path, lastRenderedItems[i]);
  }
  lastClickedPath = item.path;
  refreshSelectionVisuals();
}
function handleRowClick(e, item, defaultAction) {
  if (e.ctrlKey || e.metaKey) {
    e.stopPropagation();
    toggleSelect(item);
    return;
  }
  if (e.shiftKey) {
    e.stopPropagation();
    rangeSelect(item);
    return;
  }
  if (selectedItems.size > 0) clearSelection();
  if (defaultAction) defaultAction();
}

async function getMeta(path) {
  if (metaCache[path]) return metaCache[path];
  try {
    const data = await api(`/api/meta?path=${encodeURIComponent(path)}`);
    metaCache[path] = data;
    return data;
  } catch {
    return { title: fileNameOf(path), artist: '', duration: null, hasArt: false };
  }
}

// Fetches metadata for many paths in one request instead of one request per
// track. Populates metaCache so subsequent getMeta() calls for these paths
// (e.g. from buildFileRow) resolve instantly from cache.
async function prefetchMeta(paths) {
  const missing = [...new Set(paths)].filter(p => !metaCache[p]);
  if (missing.length === 0) return;
  try {
    const { meta } = await api('/api/meta/batch', { method: 'POST', body: JSON.stringify({ paths: missing }), headers: { 'Content-Type': 'application/json' } });
    for (const p of missing) {
      if (meta[p]) metaCache[p] = meta[p];
    }
  } catch {
    // Fall through silently - individual getMeta() calls in buildFileRow will
    // still fetch (and cache) whatever this batch call failed to retrieve.
  }
}

// ---------- Browsing ----------
async function browse(relPath, opts = {}) {
  currentPath = relPath;
  isSearching = false;
  libraryView = null;
  hideLibraryBanner();
  fileListWrap.classList.remove('search-mode');
  searchInput.value = '';
  searchClearBtn.classList.add('hidden');
  if (!opts.keepSort) { sortColumn = null; sortDir = 'asc'; }
  if (!opts.skipHistory && relPath !== (history.state && history.state.path)) {
    history.pushState({ path: relPath }, '', '#' + encodeURIComponent(relPath));
  }
  const data = await api(`/api/browse?path=${encodeURIComponent(relPath)}`);
  renderBreadcrumb(relPath);
  renderFileList(data.items);
}

window.addEventListener('popstate', (e) => {
  const s = e.state || {};
  if (s.view === 'artist' || s.view === 'album') {
    openLibrary(s.view, s.name, { skipHistory: true });
  } else {
    browse(typeof s.path === 'string' ? s.path : '', { skipHistory: true });
  }
});

// ---------- Library views (artist / album pages) ----------
let libraryView = null; // null | { type: 'artist'|'album', name }
const libraryBanner = document.getElementById('libraryBanner');

function hideLibraryBanner() {
  libraryBanner.classList.add('hidden');
  libraryBanner.innerHTML = '';
}

function formatLongDuration(totalSec) {
  if (!totalSec || !isFinite(totalSec)) return '0 min';
  const h = Math.floor(totalSec / 3600);
  const m = Math.round((totalSec % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

const MUSIC_NOTE_PLACEHOLDER = '<div class="lib-art-placeholder">🎵</div>';

async function openLibrary(type, name, opts = {}) {
  const settingsCogIcon = document.getElementById('settingsCogIcon');
  settingsCogIcon.classList.add('spinning');
  let data;
  try {
    data = await api(`/api/library/${type}?name=${encodeURIComponent(name)}`);
  } finally {
    settingsCogIcon.classList.remove('spinning');
  }
  libraryView = { type, name: data.name || name };
  isSearching = false;
  searchInput.value = '';
  searchClearBtn.classList.add('hidden');
  fileListWrap.classList.add('search-mode'); // rows get the open-containing-folder button
  if (!opts.keepSort) { sortColumn = null; sortDir = 'asc'; }
  if (!opts.skipHistory) {
    history.pushState({ view: type, name: libraryView.name }, '', `#${type}=${encodeURIComponent(libraryView.name)}`);
  }
  renderLibraryBreadcrumb(type, libraryView.name);
  renderLibraryBanner(type, data);
  searchHasMore = false;
  renderSearchResults(data.songs);
}

function renderLibraryBreadcrumb(type, name) {
  breadcrumb.innerHTML = `
    <span class="crumb-item"><span class="crumb-label" data-path="">Home</span></span>
    <span class="crumb-sep"> / </span>
    <span class="crumb-item"><span class="crumb-current">${type === 'artist' ? 'Artist' : 'Album'}: ${name}</span></span>
  `;
  breadcrumb.querySelector('.crumb-label').addEventListener('click', () => browse(''));
}

const PLAY_ICON_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>`;

function playAllSongs(songs) {
  if (!songs || !songs.length) return;
  resetQueue(songs.map(s => ({ path: s.path, name: s.name })));
  queueIndex = 0;
  playCurrent();
  renderQueue();
}

function renderLibraryBanner(type, data) {
  libraryBanner.innerHTML = '';
  const statsText = `${data.totalSongs} song${data.totalSongs === 1 ? '' : 's'} • ${formatLongDuration(data.totalDuration)} • ${formatSize(data.totalSize || 0)}`;
  const playAllBtn = `<button class="lib-play-all-btn" title="Play all">${PLAY_ICON_SVG}Play all</button>`;

  if (type === 'album') {
    const art = data.artPath
      ? `<img class="lib-art" src="/api/art?path=${encodeURIComponent(data.artPath)}" alt="">`
      : `<div class="lib-art">${MUSIC_NOTE_PLACEHOLDER}</div>`;
    const artistsHtml = (data.artists || []).map(a => `<span class="lib-link" data-artist="${a}">${a}</span>`).join(', ');
    libraryBanner.innerHTML = `
      ${art}
      <div class="lib-info">
        <div class="lib-name-row"><div class="lib-name">${data.name}</div>${playAllBtn}</div>
        <div class="lib-meta">${artistsHtml}${data.year ? ` • ${data.year}` : ''}</div>
        <div class="lib-stats">${statsText}</div>
      </div>
    `;
    libraryBanner.querySelectorAll('.lib-link[data-artist]').forEach(el => {
      el.addEventListener('click', () => openLibrary('artist', el.dataset.artist));
    });
  } else {
    const albumCards = (data.albums || []).map(a => `
      <div class="album-card" data-album="${a.name}">
        ${a.artPath
          ? `<img class="album-card-art" loading="lazy" src="/api/art?path=${encodeURIComponent(a.artPath)}" alt="">`
          : `<div class="album-card-art">${MUSIC_NOTE_PLACEHOLDER}</div>`}
        <div class="album-card-name">${a.name}</div>
        <div class="album-card-year">${a.year || ''}</div>
      </div>
    `).join('');
    libraryBanner.innerHTML = `
      <div class="lib-info lib-info-artist">
        <div class="lib-name-row"><div class="lib-name">${data.name}</div>${playAllBtn}</div>
        <div class="lib-stats">${statsText}</div>
        ${albumCards ? `<div class="album-strip">${albumCards}</div>` : ''}
      </div>
    `;
    libraryBanner.querySelectorAll('.album-card').forEach(el => {
      el.addEventListener('click', () => openLibrary('album', el.dataset.album));
    });
    const strip = libraryBanner.querySelector('.album-strip');
    if (strip) {
      strip.addEventListener('wheel', (e) => {
        if (e.deltaY === 0) return; // let native horizontal trackpad scroll pass through untouched
        e.preventDefault();
        strip.scrollLeft += e.deltaY;
      }, { passive: false });
    }
  }
  libraryBanner.querySelector('.lib-play-all-btn').addEventListener('click', () => playAllSongs(data.songs));
  libraryBanner.classList.remove('hidden');
}

function renderBreadcrumb(relPath) {
  const parts = relPath ? relPath.split('/') : [];
  const crumbs = [{ path: '', label: 'Home' }];
  let acc = '';
  for (const part of parts) {
    acc = acc ? acc + '/' + part : part;
    crumbs.push({ path: acc, label: part });
  }
  breadcrumb.innerHTML = crumbs.map((c, i) => `
    ${i > 0 ? '<span class="crumb-sep"> / </span>' : ''}
    <span class="crumb-item">
      <span class="crumb-label" data-path="${c.path}">${c.label}</span>
      ${i === crumbs.length - 1 ? `<button class="crumb-play-btn" data-path="${c.path}" title="Play this folder">▶</button>` : ''}
    </span>
  `).join('');
  breadcrumb.querySelectorAll('.crumb-label').forEach(el => {
    el.addEventListener('click', () => browse(el.dataset.path));
  });
  breadcrumb.querySelectorAll('.crumb-play-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      playFolder({ path: el.dataset.path });
    });
  });
}

function formatDuration(sec) {
  if (!sec || !isFinite(sec)) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function getCurrentTrackPath() {
  return (queueIndex >= 0 && queueIndex < queue.length) ? queue[queueIndex].path : null;
}
function isPlayingMatch(item) {
  const current = getCurrentTrackPath();
  if (!current) return false;
  if (item.isDir) return current.startsWith(item.path + '/');
  return item.path === current;
}
function updatePlayingHighlight() {
  const current = getCurrentTrackPath();
  document.querySelectorAll('.file-row').forEach(row => {
    const p = row.dataset.path;
    const isDir = row.dataset.isdir === 'true';
    let match = false;
    if (current) {
      match = isDir ? current.startsWith(p + '/') : p === current;
    }
    row.classList.toggle('playing', match);
  });
}

function buildFileRow(item, opts = {}) {
  const row = document.createElement('div');
  row.className = 'file-row';
  row.dataset.path = item.path;
  row.dataset.isdir = item.isDir;
  if (selectedItems.has(item.path)) row.classList.add('selected');
  if (isPlayingMatch(item)) row.classList.add('playing');

  const openFolderBtnHtml = opts.showOpenFolder
    ? `<button class="row-open-folder-btn" title="Open containing folder">${FOLDER_ICON_SVG}</button>` : '';

  if (item.isDir) {
    const counts = item.counts || { songs: 0, folders: 0 };
    const displayName = opts.showFullPath ? (item.path || '/') : item.name;
    row.innerHTML = `
      <span class="file-track"></span>
      <span class="file-icon folder-icon-wrap">
        <span class="folder-icon-default">${FOLDER_ICON_SVG}</span>
        <button class="folder-icon-play-btn" title="Play folder">▶</button>
      </span>
      <div class="file-name-wrap">
        <div class="file-name">${displayName}</div>
        <div class="folder-counts">${[
          counts.songs ? `${counts.songs} song${counts.songs === 1 ? '' : 's'}` : '',
          counts.folders ? `${counts.folders} folder${counts.folders === 1 ? '' : 's'}` : ''
        ].filter(Boolean).join(' ')}</div>
      </div>
      <span class="file-title"><span class="cell-text"></span></span>
      <span class="file-artist"><span class="cell-text"></span></span>
      <span class="file-album"><span class="cell-text"></span></span>
      <span class="file-duration"><span class="cell-text"></span></span>
      <span class="file-size"><span class="cell-text"></span></span>
      ${openFolderBtnHtml}
    `;
    row.querySelector('.folder-icon-play-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      playFolder(item);
    });
    row.addEventListener('click', (e) => handleRowClick(e, item, () => browse(item.path)));
  } else {
    row.innerHTML = `
      <span class="file-track">${item.track || ''}</span>
      <span class="file-icon">${item.isAudio ? '🎵' : '📄'}</span>
      <div class="file-name-wrap">
        <div class="file-name">${item.name}</div>
      </div>
      <span class="file-title"><span class="cell-text"></span></span>
      <span class="file-artist"><span class="cell-text"></span></span>
      <span class="file-album"><span class="cell-text"></span></span>
      <span class="file-duration"><span class="cell-text"></span></span>
      <span class="file-size"><span class="cell-text">${item.size ? formatSize(item.size) : ''}</span></span>
      ${openFolderBtnHtml}
    `;
    if (item.isAudio) {
      const iconSpan = row.querySelector('.file-icon');
      const titleSpan = row.querySelector('.file-title .cell-text');
      const artistSpan = row.querySelector('.file-artist .cell-text');
      const albumSpan = row.querySelector('.file-album .cell-text');
      const durationSpan = row.querySelector('.file-duration .cell-text');
      getMeta(item.path).then(meta => {
        titleSpan.textContent = meta.title || '';
        artistSpan.textContent = meta.artist || '';
        albumSpan.textContent = meta.album || '';
        durationSpan.textContent = formatDuration(meta.duration);
        if (meta.artist) {
          artistSpan.classList.add('link-cell');
          artistSpan.addEventListener('click', (e) => {
            e.stopPropagation();
            openLibrary('artist', meta.artist);
          });
        }
        if (meta.album) {
          albumSpan.classList.add('link-cell');
          albumSpan.addEventListener('click', (e) => {
            e.stopPropagation();
            openLibrary('album', meta.album);
          });
        }
        if (meta.hasArt) {
          const img = document.createElement('img');
          img.className = 'file-art';
          img.loading = 'lazy';
          // Tracks with identical embedded art share a hash, so pointing all
          // of them at the same /api/art-by-hash URL lets the browser fetch
          // it once instead of once per track. item.path is passed as the
          // fallback candidate in case the server's hash->path hint is
          // stale (see the endpoint's own comment for the full fallback
          // chain) - it's a track we already know currently has this art.
          img.src = meta.artHash
            ? `/api/art-by-hash?hash=${encodeURIComponent(meta.artHash)}&fallback=${encodeURIComponent(item.path)}`
            : `/api/art?path=${encodeURIComponent(item.path)}`;
          img.onerror = () => { img.replaceWith(iconSpan); };
          iconSpan.replaceWith(img);
        }
      });
      const defaultAction = libraryView
        ? () => handleLibrarySongClick(item)
        : (opts.showOpenFolder ? () => playSingle(item.path) : () => handleSongClick(item));
      row.addEventListener('click', (e) => handleRowClick(e, item, defaultAction));
    } else {
      row.addEventListener('click', (e) => handleRowClick(e, item, null));
    }
  }
  if (opts.showOpenFolder) {
    row.querySelector('.row-open-folder-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      browse(dirNameOf(item.path));
    });
  }
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (selectedItems.has(item.path) && selectedItems.size > 1) {
      showMultiContextMenu(e.clientX, e.clientY, Array.from(selectedItems.values()));
    } else {
      selectOnly(item);
      showContextMenu(e.clientX, e.clientY, item);
    }
  });
  return row;
}

function applyHideNonMusicFilter(items) {
  if (!settings.hideNonMusic) return items;
  return items.filter(i => i.isDir || i.isAudio);
}

// ---------- Column sorting ----------
let sortColumn = null; // null | 'name' | 'title' | 'artist' | 'album' | 'duration' | 'size'
let sortDir = 'asc';
let lastFetchedItems = [];
let lastFetchedIsSearch = false;
let searchHasMore = false;
let searchCurrentQuery = '';
let searchScopeCurrentFolder = false;

const fileListHeaderEl = document.getElementById('fileListHeader');
function syncHeaderScrollbarPad() {
  const scrollbarW = fileList.offsetWidth - fileList.clientWidth;
  fileListHeaderEl.style.paddingRight = (8 + scrollbarW) + 'px';
}
window.addEventListener('resize', syncHeaderScrollbarPad);

function updateSortIndicators() {
  syncHeaderScrollbarPad();
  document.querySelectorAll('.file-list-header .sortable').forEach(el => {
    const arrow = el.querySelector('.sort-arrow');
    const active = el.dataset.sort === sortColumn;
    arrow.classList.toggle('hidden', !active);
    arrow.textContent = active ? (sortDir === 'asc' ? '▼' : '▲') : '';
  });
}

async function applySort(items) {
  if (!sortColumn) return items;
  if (sortColumn === 'title' || sortColumn === 'artist' || sortColumn === 'album' || sortColumn === 'duration') {
    await prefetchMeta(items.filter(i => i.isAudio).map(i => i.path));
  }
  const dir = sortDir === 'asc' ? 1 : -1;
  const valueOf = (item) => {
    switch (sortColumn) {
      case 'name': return (item.name || '').toLowerCase();
      case 'title': {
        if (item.isDir) return (item.name || '').toLowerCase();
        const m = metaCache[item.path];
        return ((m && m.title) || item.name || '').toLowerCase();
      }
      case 'artist': {
        if (item.isDir) return '';
        const m = metaCache[item.path];
        return ((m && m.artist) || '').toLowerCase();
      }
      case 'album': {
        if (item.isDir) return '';
        const m = metaCache[item.path];
        return ((m && m.album) || '').toLowerCase();
      }
      case 'duration': {
        if (item.isDir) return -1;
        const m = metaCache[item.path];
        return (m && m.duration) || 0;
      }
      case 'size': return item.isDir ? -1 : (item.size || 0);
      default: return '';
    }
  };
  return [...items].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // folders always grouped first
    const va = valueOf(a), vb = valueOf(b);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
}

// Appends `items` into `container` in chunks instead of building every row's
// DOM at once - important on mobile where a folder/queue/search result can
// have thousands of entries. Metadata is still prefetched and the full list
// still sorted beforehand (see callers); only the DOM node creation itself is
// deferred, chunk by chunk, as a sentinel element scrolls into view.
// Chunk size comes from settings.maxItemsLoad (configurable in Settings);
// 0 means unlimited, which we treat as Infinity so every list of any size
// takes the "one chunk covers everything" path with no observer at all.
function currentChunkSize() {
  return settings.maxItemsLoad > 0 ? settings.maxItemsLoad : Infinity;
}
const paginationObservers = new WeakMap(); // container -> active IntersectionObserver
const paginationLoaders = new WeakMap(); // container -> function(targetIndex) that force-loads chunks up to and including targetIndex
function renderPaginated(container, items, buildRow, chunkSize = currentChunkSize()) {
  const prevObserver = paginationObservers.get(container);
  if (prevObserver) { prevObserver.disconnect(); paginationObservers.delete(container); }
  let nextIndex = 0;
  let observer = null;
  const sentinel = document.createElement('div');
  sentinel.className = 'pagination-sentinel';
  container.appendChild(sentinel); // always present as the insertBefore reference node, even for a single-chunk list

  function appendChunk() {
    const end = Math.min(nextIndex + chunkSize, items.length);
    const frag = document.createDocumentFragment();
    for (; nextIndex < end; nextIndex++) {
      frag.appendChild(buildRow(items[nextIndex], nextIndex));
    }
    container.insertBefore(frag, sentinel);
    if (nextIndex >= items.length) {
      if (observer) { observer.disconnect(); if (paginationObservers.get(container) === observer) paginationObservers.delete(container); }
      sentinel.remove();
      paginationLoaders.delete(container);
    }
  }

  // Lets a caller (e.g. "scroll to the playing track") force-render enough
  // chunks to reach a specific item index immediately, rather than waiting
  // for the user to scroll the sentinel into view.
  paginationLoaders.set(container, (targetIndex) => {
    while (nextIndex <= targetIndex && nextIndex < items.length) appendChunk();
  });

  if (items.length > chunkSize) {
    observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) appendChunk();
    }, { root: container, rootMargin: '400px' });
    observer.observe(sentinel);
    paginationObservers.set(container, observer);
    appendChunk();
  } else {
    appendChunk(); // single chunk covers everything; sentinel removes itself immediately
  }
}

async function renderFileList(items) {
  clearSelection();
  lastFetchedItems = items;
  lastFetchedIsSearch = false;
  fileListWrap.classList.remove('album-view');
  const filtered = applyHideNonMusicFilter(items);
  // Every row displays title/artist/album/duration via getMeta regardless of
  // sort column, so prefetch in one batch call rather than letting each row
  // fire its own /api/meta request.
  await prefetchMeta(filtered.filter(i => i.isAudio).map(i => i.path));
  const sorted = await applySort(filtered);
  lastRenderedItems = sorted;
  fileList.innerHTML = '';
  renderPaginated(fileList, sorted, (item) => buildFileRow(item));
  updateSortIndicators();
}

function sortByDiscTrackDefault(items) {
  return [...items].sort((a, b) => {
    const da = a.disc || 1, db = b.disc || 1;
    if (da !== db) return da - db;
    const ta = a.track != null ? a.track : Infinity;
    const tb = b.track != null ? b.track : Infinity;
    if (ta !== tb) return ta - tb;
    return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true });
  });
}

function sortByAlbumDiscTrackDefault(items) {
  return [...items].sort((a, b) => {
    const aa = (a.album || '').toLowerCase(), ab = (b.album || '').toLowerCase();
    if (aa !== ab) return aa < ab ? -1 : 1;
    const da = a.disc || 1, db = b.disc || 1;
    if (da !== db) return da - db;
    const ta = a.track != null ? a.track : Infinity;
    const tb = b.track != null ? b.track : Infinity;
    if (ta !== tb) return ta - tb;
    return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true });
  });
}

async function renderSearchResults(items) {
  lastFetchedItems = items;
  lastFetchedIsSearch = true;
  fileList.innerHTML = '';
  const filtered = applyHideNonMusicFilter(items);
  if (filtered.length === 0) {
    clearSelection();
    lastRenderedItems = [];
    fileList.innerHTML = '<div style="padding:16px;color:#77777d;font-size:13px;">No matches</div>';
    updateSortIndicators();
    return;
  }
  clearSelection();

  const isAlbumView = libraryView && libraryView.type === 'album';
  const isArtistView = libraryView && libraryView.type === 'artist';
  fileListWrap.classList.toggle('album-view', !!isAlbumView);

  await prefetchMeta(filtered.filter(i => i.isAudio).map(i => i.path));

  if (isAlbumView) {
    // Group by disc first - sorting (explicit or default) only ever reorders
    // tracks WITHIN a disc, never across discs.
    const discs = [...new Set(filtered.map(i => i.disc || 1))].sort((a, b) => a - b);
    const showDiscHeaders = discs.length > 1;
    let flattened = [];
    for (const disc of discs) {
      const group = filtered.filter(i => (i.disc || 1) === disc);
      const sortedGroup = sortColumn ? await applySort(group) : sortByDiscTrackDefault(group);
      if (showDiscHeaders) {
        const header = document.createElement('div');
        header.className = 'disc-header';
        header.innerHTML = `<span class="disc-header-label">Disc ${disc}</span><span class="disc-header-line"></span>`;
        fileList.appendChild(header);
      }
      for (const item of sortedGroup) {
        fileList.appendChild(buildFileRow(item, { showOpenFolder: true }));
      }
      flattened = flattened.concat(sortedGroup);
    }
    lastRenderedItems = flattened;
  } else {
    const sorted = sortColumn
      ? await applySort(filtered)
      : (isArtistView ? sortByAlbumDiscTrackDefault(filtered) : [...filtered].sort((a, b) => (a.isDir === b.isDir) ? 0 : (a.isDir ? -1 : 1)));
    lastRenderedItems = sorted;
    renderPaginated(fileList, sorted, (item) => buildFileRow(item, { showOpenFolder: true, showFullPath: item.isDir }));
  }

  if (searchHasMore) {
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.className = 'load-more-btn';
    loadMoreBtn.innerHTML = 'Load more results <span class="load-more-arrow">▼</span>';
    loadMoreBtn.addEventListener('click', loadMoreSearchResults);
    fileList.appendChild(loadMoreBtn);
  }
  updateSortIndicators();
}

document.querySelectorAll('.file-list-header .sortable').forEach(el => {
  el.addEventListener('click', () => {
    const col = el.dataset.sort;
    if (sortColumn === col) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortColumn = col;
      sortDir = 'asc';
    }
    if (lastFetchedIsSearch) renderSearchResults(lastFetchedItems);
    else renderFileList(lastFetchedItems);
  });
});

async function performSearch(q) {
  if (!q) return;
  searchCurrentQuery = q;
  const scope = searchScopeCurrentFolder ? preSearchPath : '';
  const data = await api(`/api/search?q=${encodeURIComponent(q)}&scope=${encodeURIComponent(scope)}&offset=0`);
  // guard against stale/out-of-order responses if the user kept typing
  if (searchInput.value.trim() === q) {
    searchHasMore = !!data.hasMore;
    renderSearchResults(data.items);
  }
}

async function loadMoreSearchResults() {
  const q = searchCurrentQuery;
  if (!q) return;
  const scope = searchScopeCurrentFolder ? preSearchPath : '';
  const offset = lastFetchedItems.length;
  const data = await api(`/api/search?q=${encodeURIComponent(q)}&scope=${encodeURIComponent(scope)}&offset=${offset}`);
  searchHasMore = !!data.hasMore;
  renderSearchResults(lastFetchedItems.concat(data.items));
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(0) + ' KB';
  return (bytes/1024/1024).toFixed(1) + ' MB';
}

// ---------- Playback ----------
function resetQueue(tracks) {
  queue = tracks;
  originalQueue = [...tracks];
  shuffled = false;
  updateShuffleBtnState();
}
function pushToQueue(track) {
  queue.push(track);
  originalQueue.push(track);
}
function removeFromQueueAt(index) {
  const track = queue[index];
  queue.splice(index, 1);
  const oIdx = originalQueue.indexOf(track);
  if (oIdx !== -1) originalQueue.splice(oIdx, 1);
}
function syncOriginalQueueIfUnshuffled() {
  if (!shuffled) originalQueue = [...queue];
}

function playSingle(path) {
  if (getCurrentTrackPath() === path) return;
  resetQueue([{ path, name: fileNameOf(path) }]);
  queueIndex = 0;
  playCurrent();
  renderQueue();
}

async function handleSongClick(item) {
  const idx = queue.findIndex(t => t.path === item.path);
  if (idx !== -1) {
    if (idx === queueIndex) return; // already playing this exact track
    queueIndex = idx;
    playCurrent();
    return;
  }
  // Not in the queue: enqueue every song in its containing folder (not subfolders) and play this one.
  const folder = dirNameOf(item.path);
  const { items } = await api(`/api/browse?path=${encodeURIComponent(folder)}`);
  const tracks = items.filter(i => i.isAudio).map(f => ({ path: f.path, name: f.name }));
  const clickedIndex = tracks.findIndex(t => t.path === item.path);
  resetQueue(tracks.length ? tracks : [{ path: item.path, name: item.name }]);
  queueIndex = clickedIndex >= 0 ? clickedIndex : 0;
  playCurrent();
  renderQueue();
}

function handleLibrarySongClick(item) {
  const idx = queue.findIndex(t => t.path === item.path);
  if (idx !== -1) {
    if (idx === queueIndex) return; // already playing this exact track
    queueIndex = idx;
    playCurrent();
    return;
  }
  // Not in the queue: enqueue every song in this artist/album view and play this one.
  const tracks = lastFetchedItems.map(f => ({ path: f.path, name: f.name }));
  const clickedIndex = tracks.findIndex(t => t.path === item.path);
  resetQueue(tracks.length ? tracks : [{ path: item.path, name: item.name }]);
  queueIndex = clickedIndex >= 0 ? clickedIndex : 0;
  playCurrent();
  renderQueue();
}

async function playFolder(item) {
  const { files } = await api(`/api/expand?path=${encodeURIComponent(item.path)}`);
  resetQueue(files.map(f => ({ path: f, name: fileNameOf(f) })));
  queueIndex = queue.length ? 0 : -1;
  if (queueIndex >= 0) playCurrent();
  renderQueue();
}

// ---------- Synced marquee (title + file name scroll at same speed, hold, wait for both) ----------
const MARQUEE_SPEED = 40;   // px per second, same for both lines
const MARQUEE_GAP = 40;     // px of blank space before text reappears
const MARQUEE_HOLD = 1000;  // ms held at the start position each cycle
let marqueeRAF = null;

function stopMarquee() {
  if (marqueeRAF) cancelAnimationFrame(marqueeRAF);
  marqueeRAF = null;
}

function startMarquee(nameSpan, pathSpan) {
  stopMarquee();
  // reset position before measuring
  nameSpan.style.transform = 'translateX(0)';
  pathSpan.style.transform = 'translateX(0)';

  requestAnimationFrame(() => {
    const nameWrap = nameSpan.closest('.marquee-wrap');
    const pathWrap = pathSpan.closest('.marquee-wrap');
    const nameOverflow = nameSpan.scrollWidth - nameWrap.clientWidth;
    const pathOverflow = pathSpan.scrollWidth - pathWrap.clientWidth;

    const nameDist = nameOverflow > 0 ? nameSpan.scrollWidth - nameWrap.clientWidth + MARQUEE_GAP : 0;
    const pathDist = pathOverflow > 0 ? pathSpan.scrollWidth - pathWrap.clientWidth + MARQUEE_GAP : 0;

    if (nameDist === 0 && pathDist === 0) return; // nothing overflows, stay put

    const nameDur = (nameDist / MARQUEE_SPEED) * 1000;
    const pathDur = (pathDist / MARQUEE_SPEED) * 1000;
    const maxDur = Math.max(nameDur, pathDur);
    const cycle = MARQUEE_HOLD + maxDur;

    let start = null;
    function frame(ts) {
      if (start === null) start = ts;
      const t = (ts - start) % cycle;

      const applyPos = (span, dist, dur) => {
        if (dist === 0 || t < MARQUEE_HOLD) {
          span.style.transform = 'translateX(0)';
          return;
        }
        const elapsedMove = t - MARQUEE_HOLD;
        if (elapsedMove >= dur) {
          span.style.transform = 'translateX(0)'; // finished its own pass, wait here for the other
        } else {
          const x = -(elapsedMove / 1000) * MARQUEE_SPEED;
          span.style.transform = `translateX(${x}px)`;
        }
      };

      applyPos(nameSpan, nameDist, nameDur);
      applyPos(pathSpan, pathDist, pathDur);

      marqueeRAF = requestAnimationFrame(frame);
    }
    marqueeRAF = requestAnimationFrame(frame);
  });
}

// ---------- Player bar visibility ----------
const playerBarEl = document.getElementById('playerBar');
function showPlayerBar() { playerBarEl.classList.remove('hidden'); document.querySelector('.lyrics-box-wrap').classList.remove('hidden'); }
function hidePlayerBar() {
  playerBarEl.classList.add('hidden');
  playerArtTrackPath = null; // invalidate any in-flight updatePlayerArt fetch for the track that was playing

  // Fade out the global background
  document.documentElement.style.setProperty('--blur-opacity', '0');
  
  const lbWrap = document.querySelector('.lyrics-box-wrap');
  lbWrap.classList.add('hidden');
  lbWrap.classList.remove('open');
  document.getElementById('lyricsBox').classList.remove('open');
  lyricsBoxOpen = false;
  stopMarquee();
  audioEl.pause();
  audioEl.removeAttribute('src');
  document.getElementById('playPauseBtn').textContent = '▶';
  seekBarEl.value = 0;
  seekBarEl.style.setProperty('--played-pct', '0%'); 
  seekBarEl.style.setProperty('--buffered-pct', '0%');
  const artImg = document.getElementById('playerArt');
  const artIcon = document.getElementById('playerArtIcon');
  artImg.classList.add('hidden');
  artImg.removeAttribute('src');
  artIcon.classList.remove('hidden');
  updatePlayingHighlight();
}

let justEnded = false; // true after the last track ends with nothing queued to follow

function playCurrent() {
  if (queueIndex < 0 || queueIndex >= queue.length) return;
  justEnded = false;
  const track = queue[queueIndex];
  audioEl.src = `/api/stream?path=${encodeURIComponent(track.path)}`;
  seekBarEl.value = 0;
  seekBarEl.style.setProperty('--played-pct', '0%'); seekBarEl.style.setProperty('--buffered-pct', '0%');
  audioEl.playbackRate = speeds[speedIndex];
  audioEl.play();
  showPlayerBar();
  const nameEl = document.getElementById('trackName');
  const pathEl = document.getElementById('trackPath');
  nameEl.querySelector('span').textContent = track.name;
  pathEl.querySelector('span').textContent = track.path;
  startMarquee(nameEl.querySelector('span'), pathEl.querySelector('span'));
  updatePlayerArt(track.path);
  updatePlayingHighlight();
  loadLyricsForTrack(track.path);
  getMeta(track.path).then(meta => {
    if (meta.title) {
      nameEl.querySelector('span').textContent = meta.title;
    }
    const pathSpan = pathEl.querySelector('span');
    if (meta.artist || meta.album) {
      pathSpan.innerHTML = '';
      if (meta.artist) {
        const a = document.createElement('span');
        a.className = 'pb-link';
        a.textContent = meta.artist;
        a.addEventListener('click', () => openLibrary('artist', meta.artist));
        pathSpan.appendChild(a);
      }
      if (meta.artist && meta.album) pathSpan.appendChild(document.createTextNode(' • '));
      if (meta.album) {
        const al = document.createElement('span');
        al.className = 'pb-link';
        al.textContent = meta.album;
        al.addEventListener('click', () => openLibrary('album', meta.album));
        pathSpan.appendChild(al);
      }
    }
    startMarquee(nameEl.querySelector('span'), pathSpan);
    applyReplayGain(meta.replayGainDb);
  });
  document.getElementById('playPauseBtn').textContent = '⏸';
  updateQueuePlayingIndicator();
  const playingEl = queuePanel.querySelector('.queue-item.playing');
  if (playingEl) playingEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// Finds the single most representative accent color in an image, by
// downsampling it onto a tiny canvas and picking the most common color among
// its more saturated pixels. A photo/cover that's mostly a soft, barely-
// tinted background (cream, fog, pale gradients) can still have a real
// accent color - a logo, a stripe, a face - that's small in area but is
// clearly "the" color a person would name if asked. So rather than just
// averaging every pixel (which a large bland background would dominate),
// only pixels clearing a firm saturation bar are considered, with the bar
// progressively relaxed until enough pixels qualify - falling back to every
// pixel (unweighted) only if the art is genuinely near-grayscale throughout.
function extractAccentColor(imgEl) {
  const size = 32; // small sample grid is plenty for this
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(imgEl, 0, 0, size, size);

  let data;
  try {
    data = ctx.getImageData(0, 0, size, size).data;
  } catch (e) {
    // Canvas may be tainted (e.g. cross-origin without CORS headers)
    return null;
  }

  const pixels = [];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 128) continue; // skip transparent pixels
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const lightness = (max + min) / 2;
    if (lightness < 20 || lightness > 235) continue; // skip near-black/near-white
    const sat = max === min ? 0 : (max - min) / (255 - Math.abs(2 * lightness - 255));
    pixels.push({ r, g, b, sat });
  }
  if (!pixels.length) return null;

  const MIN_QUALIFYING_PIXELS = Math.max(8, pixels.length * 0.03);
  let pool = [];
  for (const threshold of [0.18, 0.12, 0.07, 0]) {
    pool = pixels.filter(p => p.sat >= threshold);
    if (pool.length >= MIN_QUALIFYING_PIXELS || threshold === 0) break;
  }
  if (!pool.length) pool = pixels; // last resort: every pixel, unfiltered

  // Bucket into a coarse 4-bit-per-channel grid and take the most common one.
  const buckets = new Map();
  for (const { r, g, b } of pool) {
    const key = `${r >> 4}_${g >> 4}_${b >> 4}`;
    const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
    bucket.r += r; bucket.g += g; bucket.b += b; bucket.n += 1;
    buckets.set(key, bucket);
  }
  let best = null;
  for (const b of buckets.values()) {
    if (!best || b.n > best.n) best = b;
  }
  if (!best) return null;
  return `rgb(${Math.round(best.r / best.n)}, ${Math.round(best.g / best.n)}, ${Math.round(best.b / best.n)})`;
}

// Converts "rgb(r, g, b)" to an {h, s, l} triple (h in degrees, s/l in 0-1).
function rgbStringToHsl(rgbStr) {
  const m = rgbStr.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return null;
  const r = parseInt(m[1], 10) / 255, g = parseInt(m[2], 10) / 255, b = parseInt(m[3], 10) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;
  if (max === min) {
    h = 0; s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return { h, s, l };
}

// Clamps a color's lightness/saturation so it stays legible as text/icon fills
// and thin UI accents against this app's dark chrome (page bg ~#12-#1a, panels
// ~#26-#2a), regardless of how light, dark, or washed-out the source art is.
function makeAccentColor(rgbStr) {
  const hsl = rgbStringToHsl(rgbStr);
  if (!hsl) return '#e8e8ea';
  let { h, s, l } = hsl;
  // Near-grayscale AND weakly-saturated source colors (muddy fog, dull fabric,
  // desaturated shadows) have an unreliable hue — small sampling differences
  // can swing it across the color wheel, and even when the hue is "real" it's
  // faint enough that boosting it hard fabricates a color the art doesn't
  // actually read as. Bail out to a neutral white/grey instead of inventing
  // or amplifying a hue when there isn't a strong one to work with.
  if (s < 0.14) return '#e8e8ea';
  // Too dark to read against the dark UI, and too light loses definition/feels washed out.
  l = Math.min(0.72, Math.max(0.5, l));
  // For art with a real, reasonably confident color, nudge saturation up just
  // enough to read clearly as "a color" without overpowering a muted source,
  // and cap it so a highly saturated source color doesn't come across too
  // vivid/harsh as a thin UI accent.
  s = Math.min(0.5, Math.max(0.28, s));
  return `hsl(${h.toFixed(1)}, ${(s * 100).toFixed(0)}%, ${(l * 100).toFixed(0)}%)`;
}

const blurGroup = document.querySelector('.player-blur-group');
const blurWrap = document.querySelector('.player-blur-bg');
const blurCanvas = document.getElementById('playerBlurCanvas');
const blurCtx = blurCanvas ? blurCanvas.getContext('2d') : null;
// How far the canvas overhangs each side of the visible panel, in CSS px.
// Needs to be at least the blur radius (50px, see .player-blur-bg's filter)
// so the blur kernel always has real painted pixels to sample from at the
// panel's true edges, instead of mixing in empty transparent space there
// and darkening the edge - which is what caused the "always a dark
// fringe/black background" look before this fix.
const BLUR_CANVAS_OVERSCAN = 70;

// Deterministic PRNG so the same album art always reshuffles into the same
// layout (no jarring reshuffle if this runs again for the same art).
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Small stable hash from a string, used as the PRNG seed so the same image
// URL always reshuffles into the same-looking mosaic instead of a different
// random layout on every track change/redraw.
function hashStringToSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}

// "redmean" weighted Euclidean RGB distance - a cheap, well-known
// approximation of perceptual color difference (weights green more heavily,
// and red/blue depending on overall brightness, since human vision is more
// sensitive to green). Used to order the mosaic's sampled colors so the
// most visually distinct ones come first (see drawBlurBackground).
function colorDistance(c1, c2) {
  const rMean = (c1.r + c2.r) / 2;
  const dr = c1.r - c2.r, dg = c1.g - c2.g, db = c1.b - c2.b;
  return Math.sqrt((2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db);
}

// Groups a color into one of 8 45-degree hue "families" (blue, yellow/gold,
// red, etc), or -1 for grayscale. Used alongside colorDistance so two
// samples aren't both treated as "distinct" just because they're far apart
// in raw RGB terms while still reading as the same basic hue.
const HUE_BUCKET_COUNT = 8;
function hueBucketOf(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return -1;
  let h;
  const d = max - min;
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
    case g: h = (b - r) / d + 2; break;
    default: h = (r - g) / d + 4;
  }
  h *= 60;
  return Math.floor(h / (360 / HUE_BUCKET_COUNT)) % HUE_BUCKET_COUNT;
}

// Builds the blurry background by sampling the album art down to a small
// grid of cells, shuffling which cell's color ends up where, then drawing
// that shuffled grid stretched across the full (oversized, see
// BLUR_CANVAS_OVERSCAN) canvas. The CSS blur filter on .player-blur-bg then
// smooths the blocky shuffled grid into soft, organic-looking color
// regions - since the source pixels are the actual album art, the colors
// and their relative proportions naturally match the art without needing
// separate palette-extraction/shape-drawing logic at all.
//
// The canvas is always drawn at the panel's true MAXIMUM possible height -
// player bar height plus the largest the lyrics panel could ever be
// resized to - never at whatever height happens to be current. Every
// state below that ceiling (lyrics closed, lyrics open at the default
// size, or resized to anything in between) is simply a crop into this one
// fixed-size canvas via .player-blur-clip's overflow:hidden, not a
// separately-computed grid. This sidesteps an entire class of bug from
// earlier attempts: recomputing cell density (or even just the canvas
// size) for whatever height was current meant the render grid either had
// too few rows actually landing inside a short visible window (flat/muddy
// look) or reshuffled into a visibly different pattern on every drag tick
// of the resize handle - including behind the player bar, which should
// never change regardless of the lyrics panel's state.
function drawBlurBackground(sourceImg, seedKey) {
  if (!blurCanvas || !blurCtx || !blurWrap || !blurGroup || !sourceImg) return;
  const visibleW = blurGroup.clientWidth || 1;
  // Draw for the TRUE ceiling of how tall this panel could ever be - not
  // "however tall it happens to be right now". Using the current height
  // (even just when the lyrics panel happens to be open) meant every drag
  // of the resize handle produced a differently-sized, differently-
  // shuffled canvas on every tick, which made the artwork behind the
  // player bar visibly shift during a resize even though that portion is
  // never supposed to change. The true ceiling is the player bar's own
  // height (always visible, fixed by its content) plus the largest the
  // lyrics panel can ever be dragged to (see the matching cap in the
  // lyrics resize handler, window.innerHeight - 220).
  const playerBarH = playerBarEl.getBoundingClientRect().height || 0;
  const maxLyricsH = window.innerHeight - 220;
  const maxVisibleH = playerBarH + Math.max(0, maxLyricsH);

  const w = visibleW + BLUR_CANVAS_OVERSCAN * 2;
  const h = maxVisibleH + BLUR_CANVAS_OVERSCAN * 2;
  // Both .player-blur-bg (blurWrap, the filtered element) and its canvas
  // child get the same fixed-max-height, overscan-padded, bottom-anchored
  // treatment - not just the canvas. filter: blur() is applied to
  // .player-blur-bg's own box, and overflow:hidden on that same element
  // clips its content down to whatever that box's CURRENT size is BEFORE
  // the filter runs - so if only the canvas got this treatment while
  // .player-blur-bg stayed inset:0 (shrinking with the panel), the filter
  // would still end up running on a short box whenever the lyrics panel
  // was closed, with the blur radius consuming a much larger fraction of
  // that box than when it's tall. That mismatch is what caused the closed
  // state to look meaningfully darker than the open state despite
  // identical underlying pixel content (verified via direct canvas
  // readback) - confirmed to reproduce in both Chromium and Firefox, so
  // it's standard filter behavior to design around, not an engine quirk.
  // .player-blur-clip (the actual outer wrapper, unfiltered) is what
  // reveals only the current visible slice via its own overflow:hidden.
  blurWrap.style.left = `${-BLUR_CANVAS_OVERSCAN}px`;
  blurWrap.style.right = `${-BLUR_CANVAS_OVERSCAN}px`;
  blurWrap.style.bottom = `${-BLUR_CANVAS_OVERSCAN}px`;
  blurWrap.style.top = 'auto';
  blurWrap.style.width = `${w}px`;
  blurWrap.style.height = `${h}px`;

  blurCanvas.style.left = `${-BLUR_CANVAS_OVERSCAN}px`;
  blurCanvas.style.bottom = `${-BLUR_CANVAS_OVERSCAN}px`;
  blurCanvas.style.top = 'auto';
  blurCanvas.style.width = `${w}px`;
  blurCanvas.style.height = `${h}px`;

  const dpr = window.devicePixelRatio || 1;
  blurCanvas.width = Math.max(1, Math.round(w * dpr));
  blurCanvas.height = Math.max(1, Math.round(h * dpr));
  blurCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  blurCtx.clearRect(0, 0, w, h);

  // Sample the art at a fixed 10x10 grid, independent of the destination
  // panel's shape or size - this always yields 100 distinct sample colors
  // pulled from across the source art.
  const SAMPLE_SIZE = 10;
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = SAMPLE_SIZE;
  sampleCanvas.height = SAMPLE_SIZE;
  const sampleCtx = sampleCanvas.getContext('2d');
  sampleCtx.drawImage(sourceImg, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  let cells;
  try {
    cells = sampleCtx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
  } catch (e) {
    // Canvas may be tainted (e.g. cross-origin without CORS headers)
    blurCtx.fillStyle = '#121214';
    blurCtx.fillRect(0, 0, w, h);
    return;
  }
  const samplePixels = [];
  for (let i = 0; i < SAMPLE_SIZE * SAMPLE_SIZE; i++) {
    const o = i * 4;
    samplePixels.push({ r: cells[o], g: cells[o + 1], b: cells[o + 2] });
  }

  // Order the 100 samples so the most visually distinct ones come first -
  // the front of the list is what a small render grid mostly draws from
  // (later cells only get used via repetition, see below), so front-
  // loading distinct colors matters more than a plain random shuffle,
  // which could just as easily cluster several near-identical shades early.
  //
  // Rather than an iterative farthest-point search, this groups samples by
  // hue family first (so "different hue" falls out of the grouping itself,
  // not a per-step check), sorts each group by distance from its own
  // average (pushing each family's most saturated/extreme shade to the
  // front, most washed-out/average-ish ones last), then interleaves the
  // groups round-robin - so consecutive picks in the final order alternate
  // between hue families whenever more than one is present. A seeded
  // rotation of which hue family starts the interleave keeps the same art
  // always producing the same order without every track starting on
  // whichever hue happens to sort first numerically.
  const byHue = new Map(); // hueBucket -> pixel[], -1 for grayscale
  for (const p of samplePixels) {
    const hb = hueBucketOf(p.r, p.g, p.b);
    if (!byHue.has(hb)) byHue.set(hb, []);
    byHue.get(hb).push(p);
  }
  for (const group of byHue.values()) {
    const n = group.length;
    const avg = {
      r: group.reduce((s, p) => s + p.r, 0) / n,
      g: group.reduce((s, p) => s + p.g, 0) / n,
      b: group.reduce((s, p) => s + p.b, 0) / n
    };
    group.sort((a, b) => colorDistance(b, avg) - colorDistance(a, avg));
  }

  // Dark pixels (near-black backgrounds, shadows, dark clothing/hair) tend
  // to be heavily overrepresented in album art - but a hue can genuinely BE
  // dark throughout (deep red/maroon, dark teal) without that making it any
  // less real or important a color; a dark but saturated red dress is a
  // meaningful accent, not "background noise that happens to be reddish".
  // So dark-reduction is applied WITHIN each hue group, not globally across
  // the whole pool before hue grouping - that ordering matters: applying it
  // first (as an earlier version did) meant a hue that happened to run dark
  // got its dark members thinned out by a pass that had no idea those
  // pixels were a specific, real hue worth preserving, and could end up
  // almost entirely eliminated before hue grouping ever got a chance to
  // recognize it as its own distinct color family. Doing it per-hue-group
  // instead only reduces each hue's OWN excess of dark members relative to
  // its own lighter members, never relative to unrelated hues or the
  // image's dark background.
  const DARK_LIGHTNESS_THRESHOLD = 60; // 0-255
  const DARK_EXTRA_REDUCTION = 0.4; // extra factor on top of sqrt, applied only to a group's dark subset
  function lightnessOf(p) { return (Math.max(p.r, p.g, p.b) + Math.min(p.r, p.g, p.b)) / 2; }
  for (const [hb, group] of byHue) {
    const dark = group.filter(p => lightnessOf(p) < DARK_LIGHTNESS_THRESHOLD);
    if (dark.length < 2) continue; // nothing meaningful to thin
    const notDark = group.filter(p => lightnessOf(p) >= DARK_LIGHTNESS_THRESHOLD);
    const keepDark = Math.max(1, Math.round(Math.sqrt(dark.length) * DARK_EXTRA_REDUCTION));
    // dark/notDark both inherit the group's existing furthest-from-average
    // sort order, so trimming dark down to keepDark still keeps that
    // subset's most distinctive (not just first-encountered) members.
    const thinnedDark = keepDark < dark.length ? dark.slice(0, keepDark) : dark;
    byHue.set(hb, notDark.concat(thinnedDark).sort((a, b) => group.indexOf(a) - group.indexOf(b)));
  }

  const rand = mulberry32(hashStringToSeed(seedKey || ''));
  const groups = [...byHue.values()];
  const startOffset = Math.floor(rand() * groups.length);
  const orderedColors = [];
  let idx = 0;
  const totalThinned = groups.reduce((s, g) => s + g.length, 0);
  while (orderedColors.length < totalThinned) {
    const group = groups[(idx + startOffset) % groups.length];
    if (group.length) orderedColors.push(group.shift());
    idx++;
  }
  const uniqueColors = orderedColors.map(c => `rgb(${c.r}, ${c.g}, ${c.b})`);

  // Render grid sized from the (always-tall) canvas itself, targeting a
  // fixed cell size roughly matched to the blur radius (50px, see
  // .player-blur-bg's filter) - no overscan-ratio compensation needed here
  // since we're no longer trying to squeeze enough rows into a short
  // visible window; the canvas is always tall enough for this to work.
  const TARGET_CELL_SIZE = 45; // px
  const renderCols = Math.max(3, Math.round(w / TARGET_CELL_SIZE));
  const renderRows = Math.max(3, Math.round(h / TARGET_CELL_SIZE));
  const totalCells = renderCols * renderRows;

  const colors = [];
  for (let i = 0; i < totalCells; i++) {
    colors.push(uniqueColors[i % uniqueColors.length]);
  }
  // If the render grid needed more cells than there are unique samples
  // (repetition kicked in), shuffle the final list once more so repeated
  // instances of the same color don't cluster together in a visible
  // pattern across the grid.
  if (totalCells > uniqueColors.length) {
    for (let i = colors.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [colors[i], colors[j]] = [colors[j], colors[i]];
    }
  }

  // Draw the grid stretched across the full (oversized) canvas.
  const cellW = w / renderCols;
  const cellH = h / renderRows;
  for (let row = 0; row < renderRows; row++) {
    for (let col = 0; col < renderCols; col++) {
      blurCtx.fillStyle = colors[row * renderCols + col];
      // Slightly overdraw each cell (by half a pixel-ish amount, scaled to
      // cell size) so adjacent cells overlap a hair and there's no thin
      // seam line surviving the blur at cell boundaries.
      blurCtx.fillRect(
        Math.floor(col * cellW) - 1,
        Math.floor(row * cellH) - 1,
        Math.ceil(cellW) + 2,
        Math.ceil(cellH) + 2
      );
    }
  }
}

let lastBlurSourceImg = null;
let lastBlurSeedKey = null;
window.addEventListener('resize', () => {
  if (lastBlurSourceImg) drawBlurBackground(lastBlurSourceImg, lastBlurSeedKey);
});

function applyBlurColors(sourceImg, seedKey, accentColor) {
  const root = document.documentElement.style;
  if (!sourceImg || !accentColor) {
    root.setProperty('--blur-opacity', '0');
    root.setProperty('--accent-color', '#e8e8ea');
    lastBlurSourceImg = null;
    lastBlurSeedKey = null;
    return;
  }
  lastBlurSourceImg = sourceImg;
  lastBlurSeedKey = seedKey;
  drawBlurBackground(sourceImg, seedKey);
  root.setProperty('--blur-opacity', '1');
  // Clamp to a legible lightness/saturation range so the accent color
  // harmonizes with the mosaic background without disappearing on very
  // light or very dark album art.
  root.setProperty('--accent-color', makeAccentColor(accentColor));
}

function updatePlayerArt(trackPath) {
  playerArtTrackPath = trackPath;
  const artImg = document.getElementById('playerArt');
  const artIcon = document.getElementById('playerArtIcon');
  const artUrl = `/api/art?path=${encodeURIComponent(trackPath)}`;

  artImg.classList.add('hidden');
  artIcon.classList.remove('hidden');

  // Temporarily fade out background while the new image loads
  document.documentElement.style.setProperty('--blur-opacity', '0');

  // Use a separate offscreen image for color sampling so we don't affect
  // the visible <img>'s crossOrigin/loading behavior.
  const sampleImg = new Image();

  artImg.onload = () => {
    if (playerArtTrackPath !== trackPath) return; // a newer track started before this resolved
    artIcon.classList.add('hidden');
    artImg.classList.remove('hidden');
  };

  sampleImg.onload = () => {
    if (playerArtTrackPath !== trackPath) return; // a newer track started before this resolved
    const accentColor = extractAccentColor(sampleImg);
    applyBlurColors(sampleImg, artUrl, accentColor);
  };

  sampleImg.onerror = () => {
    if (playerArtTrackPath !== trackPath) return;
    document.documentElement.style.setProperty('--blur-opacity', '0');
  };

  artImg.onerror = () => {
    if (playerArtTrackPath !== trackPath) return;
    artImg.classList.add('hidden');
    artIcon.classList.remove('hidden');
    document.documentElement.style.setProperty('--blur-opacity', '0');
  };

  artImg.src = artUrl;
  sampleImg.src = artUrl;
}


document.getElementById('playPauseBtn').addEventListener('click', () => {
  if (justEnded) {
    justEnded = false;
    if (loopMode === 'all') {
      queueIndex = 0;
      playCurrent();
    } else {
      audioEl.currentTime = 0;
      audioEl.play();
      document.getElementById('playPauseBtn').textContent = '⏸';
    }
    return;
  }
  if (audioEl.paused) {
    audioEl.play();
    document.getElementById('playPauseBtn').textContent = '⏸';
  } else {
    audioEl.pause();
    document.getElementById('playPauseBtn').textContent = '▶';
  }
});

document.getElementById('nextBtn').addEventListener('click', playNext);
document.getElementById('prevBtn').addEventListener('click', playPrev);

function playNext() {
  if (queueIndex < queue.length - 1) {
    queueIndex++;
    playCurrent();
  } else if (loopMode === 'all' && queue.length) {
    queueIndex = 0;
    playCurrent();
  }
}
function playPrev() {
  if (queueIndex > 0) {
    queueIndex--;
    playCurrent();
  }
}
audioEl.addEventListener('ended', () => {
  if (loopMode === 'one') {
    audioEl.currentTime = 0;
    audioEl.play();
    return;
  }
  const hasNext = queueIndex < queue.length - 1;
  const willLoopAll = loopMode === 'all' && queue.length > 0;
  if (hasNext || willLoopAll) {
    playNext();
  } else {
    justEnded = true;
    document.getElementById('playPauseBtn').textContent = '▶';
  }
});

const seekBarEl = document.getElementById('seekBar');
let seekDragging = false;
let seekRAF = null;

function getBufferedEndPercent() {
  if (!audioEl.duration || !isFinite(audioEl.duration) || !audioEl.buffered.length) return 0;
  const t = audioEl.currentTime;
  for (let i = 0; i < audioEl.buffered.length; i++) {
    if (audioEl.buffered.start(i) <= t && t <= audioEl.buffered.end(i)) {
      return (audioEl.buffered.end(i) / audioEl.duration) * 100;
    }
  }
  // Not currently inside a buffered range (e.g. right at the start) — use the first range's end.
  return (audioEl.buffered.end(0) / audioEl.duration) * 100;
}

function updateSeekBarVisual() {
  if (!audioEl.duration || !isFinite(audioEl.duration)) return;
  const playedPct = Math.min(100, (audioEl.currentTime / audioEl.duration) * 100);
  const bufferedPct = Math.max(playedPct, Math.min(100, getBufferedEndPercent()));
  seekBarEl.style.setProperty('--played-pct', playedPct + '%');
  seekBarEl.style.setProperty('--buffered-pct', bufferedPct + '%');
}

function updateSeekDisplay() {
  if (audioEl.duration) {
    if (!seekDragging) {
      seekBarEl.value = (audioEl.currentTime / audioEl.duration) * 100;
    }
    updateSeekBarVisual();
    const remaining = audioEl.duration - audioEl.currentTime;
    document.getElementById('timeDisplay').textContent =
      `${formatTime(audioEl.currentTime)} / -${formatTime(remaining)}`;
  }
}

function seekLoop() {
  updateSeekDisplay();
  seekRAF = requestAnimationFrame(seekLoop);
}
function startSeekLoop() { if (!seekRAF) seekRAF = requestAnimationFrame(seekLoop); }
function stopSeekLoop() { if (seekRAF) cancelAnimationFrame(seekRAF); seekRAF = null; }

audioEl.addEventListener('play', startSeekLoop);
audioEl.addEventListener('pause', stopSeekLoop);
audioEl.addEventListener('ended', stopSeekLoop);
audioEl.addEventListener('timeupdate', updateSeekDisplay); // fallback for the first frame before 'play' fires
audioEl.addEventListener('progress', updateSeekBarVisual); // buffering can progress while paused/loading
audioEl.addEventListener('loadedmetadata', updateSeekBarVisual);

seekBarEl.addEventListener('pointerdown', () => { seekDragging = true; });
seekBarEl.addEventListener('input', (e) => {
  if (audioEl.duration) {
    audioEl.currentTime = (e.target.value / 100) * audioEl.duration;
  }
});
seekBarEl.addEventListener('change', () => { seekDragging = false; });
function formatTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

// ---------- Loop / Shuffle / Speed / Volume / Folder / Delete ----------
const loopBtn = document.getElementById('loopBtn');
const REPEAT_ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>`;
function updateLoopBtn() {
  const map = {
    off: { label: 'Off', active: false, title: 'Loop: off (click to loop all)' },
    all: { label: 'All', active: true,  title: 'Loop: all (click to loop one)' },
    one: { label: 'One', active: true,  title: 'Loop: one (click to turn off)' }
  };
  const s = map[loopMode];
  loopBtn.innerHTML = `${REPEAT_ICON_SVG}<span class="loop-label">${s.label}</span>`;
  loopBtn.title = s.title;
  loopBtn.classList.toggle('active-state', s.active);
}
loopBtn.addEventListener('click', () => {
  loopMode = loopMode === 'off' ? 'all' : (loopMode === 'all' ? 'one' : 'off');
  updateLoopBtn();
});
updateLoopBtn();

function updateShuffleBtnState() {
  document.getElementById('shuffleBtn').classList.toggle('active-state', shuffled);
  document.getElementById('shuffleQueueBtn').classList.toggle('active-state', shuffled);
}

function toggleShuffle() {
  if (queue.length < 2) return;
  const current = queueIndex >= 0 ? queue[queueIndex] : null;

  if (!shuffled) {
    // Turning ON: snapshot the current order as the baseline, then shuffle.
    originalQueue = [...queue];
    const rest = current ? queue.filter((_, i) => i !== queueIndex) : queue.slice();
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    if (current) {
      queue = [current, ...rest];
      queueIndex = 0;
    } else {
      queue = rest;
    }
    shuffled = true;
  } else {
    // Turning OFF: restore the original (pre-shuffle) order.
    queue = [...originalQueue];
    queueIndex = current ? queue.indexOf(current) : -1;
    shuffled = false;
  }
  updateShuffleBtnState();
  renderQueue();
  scrollToPlayingQueueRow();
}
document.getElementById('shuffleBtn').addEventListener('click', toggleShuffle);
document.getElementById('shuffleQueueBtn').addEventListener('click', toggleShuffle);

document.getElementById('clearQueueBtn').addEventListener('click', () => {
  queue = [];
  originalQueue = [];
  shuffled = false;
  updateShuffleBtnState();
  queueIndex = -1;
  hidePlayerBar();
  document.getElementById('trackName').querySelector('span').textContent = '';
  document.getElementById('trackPath').querySelector('span').textContent = '';
  renderQueue();
});

document.getElementById('closePlayerBtn').addEventListener('click', () => {
  hidePlayerBar();
});

const speedBtn = document.getElementById('speedBtn');
const speedMenu = document.getElementById('speedMenu');
function updateSpeedBtn() { speedBtn.textContent = speeds[speedIndex] + 'x'; }

function renderSpeedMenu() {
  speedMenu.innerHTML = '';
  speeds.forEach((sp, i) => {
    const btn = document.createElement('button');
    btn.textContent = sp + 'x';
    btn.className = i === speedIndex ? 'active' : '';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      speedIndex = i;
      audioEl.playbackRate = speeds[speedIndex];
      updateSpeedBtn();
      speedMenu.classList.add('hidden');
    });
    speedMenu.appendChild(btn);
  });
}

speedBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  renderSpeedMenu();
  speedMenu.classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!speedMenu.contains(e.target) && e.target !== speedBtn) {
    speedMenu.classList.add('hidden');
  }
});
updateSpeedBtn();

const volumeBar = document.getElementById('volumeBar');
const muteBtn = document.getElementById('muteBtn');
const muteIconOn = document.getElementById('muteIconOn');
const muteIconOff = document.getElementById('muteIconOff');
function setMuteIcon(isMuted) {
  muteIconOn.classList.toggle('hidden', isMuted);
  muteIconOff.classList.toggle('hidden', !isMuted);
}
function updateVolumeBarFill() {
  volumeBar.style.setProperty('--volume-pct', volumeBar.value + '%');
}
volumeBar.addEventListener('input', (e) => {
  audioEl.volume = e.target.value / 100;
  audioEl.muted = false;
  setMuteIcon(e.target.value == 0);
  updateVolumeBarFill();
});
muteBtn.addEventListener('click', () => {
  audioEl.muted = !audioEl.muted;
  setMuteIcon(audioEl.muted);
});
updateVolumeBarFill();

document.getElementById('openFolderBtn').addEventListener('click', () => {
  if (queueIndex < 0 || queueIndex >= queue.length) return;
  const track = queue[queueIndex];
  const folder = track.path.includes('/') ? track.path.slice(0, track.path.lastIndexOf('/')) : '';
  browse(folder);
});

document.getElementById('deleteTrackBtn').addEventListener('click', async () => {
  if (queueIndex < 0 || queueIndex >= queue.length) return;
  const track = queue[queueIndex];
  if (!confirmAction(`Delete "${track.name}"? This cannot be undone.`)) return;
  // Stop playback and detach the source *before* the delete request goes out.
  // Otherwise, deleting a file that's actively streaming can make the
  // browser fire 'ended' while the API call is still in flight, which
  // races playNext() against this handler's own queueIndex/queue updates
  // below and can leave queueIndex pointing at the wrong track.
  audioEl.pause();
  audioEl.removeAttribute('src');
  audioEl.load();
  await api('/api/delete', {
    method: 'DELETE', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ path: track.path })
  });
  const removedRow = [...queuePanel.querySelectorAll('.queue-item')].find(row => Number(row.dataset.index) === queueIndex);
  removeFromQueueAt(queueIndex);
  if (queueIndex >= queue.length) queueIndex = queue.length - 1;
  if (queueIndex >= 0) {
    playCurrent();
  } else {
    hidePlayerBar();
    document.getElementById('trackName').querySelector('span').textContent = '';
    document.getElementById('trackPath').querySelector('span').textContent = '';
  }
  if (removedRow) removeQueueRowAt(removedRow); else renderQueue();
  const trackFolder = track.path.includes('/') ? track.path.slice(0, track.path.lastIndexOf('/')) : '';
  if (currentPath === trackFolder) {
    browse(currentPath, { keepSort: true });
  }
});

// ---------- Queue ----------
let dragSrcIndex = null;
let dragSrcRow = null;
let playlistDragSrcIndex = null;
let playlistDragName = null;
let expandedPlaylists = new Set();

function buildQueueRow(track, i) {
  const div = document.createElement('div');
  div.className = 'queue-item' + (i === queueIndex ? ' playing' : '');
  div.draggable = true;
  div.dataset.index = i;
  div.innerHTML = `<span class="drag-handle">⠿</span><span>${track.name}</span><span class="remove-btn">✕</span>`;
  // Handlers read the row's *current* dataset.index rather than capturing `i`
  // in a closure. That way, removing one row from the middle of the queue
  // only requires updating dataset.index on the rows after it (see
  // removeQueueRowAt) instead of rebuilding every row's listeners.
  div.addEventListener('click', () => {
    const idx = Number(div.dataset.index);
    if (idx === queueIndex) return;
    queueIndex = idx;
    playCurrent();
  });
  div.querySelector('.remove-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const idx = Number(div.dataset.index);
    const wasPlayingThisRow = idx === queueIndex;
    removeFromQueueAt(idx);
    if (idx < queueIndex) queueIndex--;
    if (queue.length === 0) {
      audioEl.pause();
      queueIndex = -1;
      hidePlayerBar();
      document.getElementById('trackName').querySelector('span').textContent = '';
      document.getElementById('trackPath').querySelector('span').textContent = '';
    } else if (wasPlayingThisRow) {
      // The track after the removed one has shifted into this same index -
      // play that instead of stopping, unless we removed the last row, in
      // which case there's nothing after it left to play.
      if (queueIndex >= queue.length) queueIndex = queue.length - 1;
      playCurrent();
    }
    removeQueueRowAt(div);
  });
  div.addEventListener('dragstart', (e) => {
    dragSrcIndex = Number(div.dataset.index);
    dragSrcRow = div;
    div.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  div.addEventListener('dragend', () => {
    div.classList.remove('dragging');
    queuePanel.querySelectorAll('.queue-item').forEach(el => el.classList.remove('drag-over'));
    dragSrcIndex = null;
    dragSrcRow = null;
  });
  div.addEventListener('dragover', (e) => {
    e.preventDefault();
    div.classList.add('drag-over');
  });
  div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
  div.addEventListener('drop', (e) => {
    e.preventDefault();
    div.classList.remove('drag-over');
    const destIndex = Number(div.dataset.index);
    const srcRow = dragSrcRow;
    if (dragSrcIndex === null || dragSrcIndex === destIndex || !srcRow) return;
    const currentTrack = queueIndex >= 0 ? queue[queueIndex] : null;
    const [moved] = queue.splice(dragSrcIndex, 1);
    queue.splice(destIndex, 0, moved);
    if (currentTrack) queueIndex = queue.indexOf(currentTrack);
    syncOriginalQueueIfUnshuffled();
    dragSrcIndex = null;
    dragSrcRow = null;
    reorderQueueRow(srcRow, destIndex);
  });
  return div;
}

// Moves one row's DOM node (the row that was actually dragged) to sit at
// destIndex, without rebuilding the rest of the list, and fixes up
// dataset.index for every row afterward.
function reorderQueueRow(div, destIndex) {
  const rows = [...queuePanel.querySelectorAll('.queue-item')];
  if (!rows.includes(div)) { renderQueue(); return; } // dragged row wasn't rendered (paginated out) - safe fallback
  div.remove();
  const refRow = rows.filter(r => r !== div)[destIndex] || null;
  queuePanel.insertBefore(div, refRow || queuePanel.querySelector('.pagination-sentinel'));
  reindexQueueRows();
  updateQueuePlayingIndicator();
}

// Removes a single row's DOM node and re-indexes every row that came after
// it, instead of rebuilding the whole queue panel.
function removeQueueRowAt(div) {
  if (queue.length === 0) { renderQueue(); return; }
  div.remove();
  reindexQueueRows();
  updateQueuePlayingIndicator();
}

// Re-derives dataset.index for every currently-rendered row from its DOM
// position, so handlers (which read dataset.index at event time) stay
// correct after an insert/remove/reorder without needing new listeners.
function reindexQueueRows() {
  [...queuePanel.querySelectorAll('.queue-item')].forEach((row, i) => {
    row.dataset.index = i;
  });
}

// Moves the '.playing' class to whichever row (if any) currently rendered
// corresponds to queueIndex, without touching any other row's DOM.
function updateQueuePlayingIndicator() {
  queuePanel.querySelectorAll('.queue-item.playing').forEach(el => el.classList.remove('playing'));
  const playingRow = [...queuePanel.querySelectorAll('.queue-item')].find(row => Number(row.dataset.index) === queueIndex);
  if (playingRow) playingRow.classList.add('playing');
}

// Scrolls the queue panel to the currently-playing row. If that row hasn't
// been rendered yet (still behind the pagination sentinel), force-loads
// chunks up to it first via the loader renderPaginated registered for this
// container, so the row exists before we try to scroll to it.
function scrollToPlayingQueueRow() {
  if (queueIndex < 0) return;
  const loadUntil = paginationLoaders.get(queuePanel);
  if (loadUntil) loadUntil(queueIndex);
  const playingRow = [...queuePanel.querySelectorAll('.queue-item')].find(row => Number(row.dataset.index) === queueIndex);
  if (playingRow) playingRow.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// Appends newly-queued tracks' rows without touching existing ones. Falls
// back to a full renderQueue() if the queue wasn't fully rendered yet
// (pagination still in progress) or was empty (no pagination state to
// append onto), since dataset.index continuity can't be assumed otherwise.
function appendQueueRows(newTracks) {
  if (newTracks.length === 0) return;
  const alreadyRendered = queuePanel.querySelectorAll('.queue-item').length;
  const stillPaginating = !!queuePanel.querySelector('.pagination-sentinel');
  if (alreadyRendered === 0 || stillPaginating) { renderQueue(); return; }
  const startIndex = queue.length - newTracks.length;
  const frag = document.createDocumentFragment();
  newTracks.forEach((track, i) => {
    frag.appendChild(buildQueueRow(track, startIndex + i));
  });
  queuePanel.appendChild(frag);
}

function renderQueue() {
  queuePanel.innerHTML = '';
  if (queue.length === 0) {
    queuePanel.innerHTML = '<div style="padding:10px;color:#77777d;font-size:13px;">Queue is empty</div>';
    return;
  }
  // Only the first chunk (settings.maxItemsLoad rows, or everything if set to
  // 0/unlimited) renders up front; the rest render as the user scrolls the
  // queue panel (see renderPaginated). Indices are still assigned against the
  // full `queue` array either way, since drag/drop and remove-at-index need
  // to stay correct regardless of what's rendered.
  renderPaginated(queuePanel, queue, buildQueueRow);
}

async function addToQueue(item) {
  const before = queue.length;
  if (item.isDir) {
    const { files } = await api(`/api/expand?path=${encodeURIComponent(item.path)}`);
    files.forEach(f => pushToQueue({ path: f, name: fileNameOf(f) }));
  } else {
    pushToQueue({ path: item.path, name: item.name });
  }
  const newTracks = queue.slice(before);
  appendQueueRows(newTracks);
  if (queueIndex === -1 && queue.length > 0) {
    queueIndex = 0;
    playCurrent();
  }
}

// ---------- Playlists ----------
async function loadPlaylists() {
  playlists = await api('/api/playlists');
  renderPlaylists();
}

function renderPlaylists() {
  playlistsPanel.innerHTML = '';
  const newBtn = document.createElement('button');
  newBtn.className = 'new-playlist-btn';
  newBtn.textContent = '+ New Playlist';
  newBtn.addEventListener('click', async () => {
    const name = await showModal('New playlist name');
    if (name) {
      await api(`/api/playlists/${encodeURIComponent(name)}`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ files: [] })
      });
      loadPlaylists();
    }
  });
  playlistsPanel.appendChild(newBtn);

  Object.entries(playlists)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .forEach(([name, tracks]) => {
    const header = document.createElement('div');
    header.className = 'playlist-header';
    header.innerHTML = `
      <span class="playlist-name">📃 ${name} (${tracks.length})</span>
      <button class="playlist-play-btn" title="Play playlist">▶</button>
    `;
    const tracksDiv = document.createElement('div');
    tracksDiv.className = 'playlist-tracks';
    tracksDiv.style.display = expandedPlaylists.has(name) ? 'block' : 'none';

    header.addEventListener('click', () => {
      const nowOpen = tracksDiv.style.display === 'none';
      tracksDiv.style.display = nowOpen ? 'block' : 'none';
      if (nowOpen) {
        expandedPlaylists.add(name);
        renderPlaylistTracks(name, tracks, tracksDiv);
      } else {
        expandedPlaylists.delete(name);
      }
    });

    function playWholePlaylist() {
      resetQueue(tracks.map(t => ({ path: t, name: fileNameOf(t) })));
      queueIndex = 0;
      playCurrent();
      renderQueue();
    }
    header.querySelector('.playlist-play-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      playWholePlaylist();
    });

    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showPlaylistContextMenu(e.clientX, e.clientY, name, tracks);
    });

    // Rows are only built when the playlist is actually expanded (and
    // paginated within that, for large playlists) - a collapsed playlist
    // costs nothing beyond its header, instead of building every track's DOM
    // and listeners up front just to hide them.
    if (expandedPlaylists.has(name)) renderPlaylistTracks(name, tracks, tracksDiv);

    playlistsPanel.appendChild(header);
    playlistsPanel.appendChild(tracksDiv);
  });
}

function buildPlaylistRow(name, tracks, track, ti) {
  const item = document.createElement('div');
  item.className = 'playlist-item';
  item.draggable = true;
  item.dataset.index = ti;
  item.innerHTML = `<span class="drag-handle">⠿</span><span>${fileNameOf(track)}</span><span class="remove-btn">✕</span>`;
  // Handlers read the row's *current* dataset.index rather than capturing
  // `ti` in a closure, same reasoning as the queue's buildQueueRow - so
  // pagination/removal doesn't require rebuilding every row's listeners.
  item.addEventListener('click', () => {
    const idx = Number(item.dataset.index);
    resetQueue(tracks.map(tt => ({ path: tt, name: fileNameOf(tt) })));
    queueIndex = idx;
    playCurrent();
  });
  item.querySelector('.remove-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const idx = Number(item.dataset.index);
    await api(`/api/playlists/${encodeURIComponent(name)}/remove`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ file: tracks[idx] })
    });
    loadPlaylists();
  });
  item.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    playlistDragSrcIndex = Number(item.dataset.index);
    playlistDragName = name;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  item.addEventListener('dragend', () => {
    item.classList.remove('dragging');
    item.parentElement && item.parentElement.querySelectorAll('.playlist-item').forEach(el => el.classList.remove('drag-over'));
    playlistDragSrcIndex = null;
    playlistDragName = null;
  });
  item.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (playlistDragName === name) item.classList.add('drag-over');
  });
  item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
  item.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    item.classList.remove('drag-over');
    const ti2 = Number(item.dataset.index);
    if (playlistDragName !== name || playlistDragSrcIndex === null || playlistDragSrcIndex === ti2) {
      playlistDragSrcIndex = null;
      playlistDragName = null;
      return;
    }
    const fromIdx = playlistDragSrcIndex;
    const toIdx = ti2;
    const [moved] = tracks.splice(fromIdx, 1);
    tracks.splice(toIdx, 0, moved);
    playlistDragSrcIndex = null;
    playlistDragName = null;
    renderPlaylists();
    api(`/api/playlists/${encodeURIComponent(name)}/reorder`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromIdx, to: toIdx })
    }).catch(() => loadPlaylists());
  });
  return item;
}

function renderPlaylistTracks(name, tracks, tracksDiv) {
  tracksDiv.innerHTML = '';
  renderPaginated(tracksDiv, tracks, (track, ti) => buildPlaylistRow(name, tracks, track, ti));
}

async function addAllToPlaylist(name, items) {
  const folders = items.filter(i => i.isDir).map(i => i.path);
  const files = items.filter(i => !i.isDir).map(i => i.path);
  await api(`/api/playlists/${encodeURIComponent(name)}`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ files, folders })
  });
  loadPlaylists();
}
async function addToPlaylist(name, item) {
  return addAllToPlaylist(name, [item]);
}

// ---- Playlist-level actions (right-click on a playlist in the sidebar) ----
function addPlaylistTracksToQueue(tracks) {
  const before = queue.length;
  tracks.forEach(t => pushToQueue({ path: t, name: fileNameOf(t) }));
  const newTracks = queue.slice(before);
  appendQueueRows(newTracks);
  if (queueIndex === -1 && queue.length > 0) {
    queueIndex = 0;
    playCurrent();
  }
}
async function deletePlaylist(name) {
  if (!confirmAction(`Delete playlist "${name}"? This cannot be undone.`)) return;
  await api(`/api/playlists/${encodeURIComponent(name)}`, { method: 'DELETE' });
  loadPlaylists();
}
async function renamePlaylist(oldName, tracks) {
  const newName = await showModal('Rename playlist to', oldName);
  if (!newName || newName === oldName) return;
  await api(`/api/playlists/${encodeURIComponent(oldName)}/rename`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newName })
  });
  loadPlaylists();
}
async function showAddPlaylistToPlaylistMenu(sourceName, tracks) {
  const names = Object.keys(playlists).filter(n => n !== sourceName);
  if (names.length === 0) {
    const name = await showModal('New playlist name');
    if (name) await addAllToPlaylist(name, tracks.map(t => ({ path: t, isDir: false })));
    return;
  }
  const options = names.map(name => ({
    label: name,
    action: async () => addAllToPlaylist(name, tracks.map(t => ({ path: t, isDir: false })))
  }));
  renderMenuOptions(options);
  const divider = document.createElement('div');
  divider.className = 'context-menu-divider';
  contextMenu.appendChild(divider);
  const newDiv = document.createElement('div');
  newDiv.className = 'context-menu-item';
  newDiv.innerHTML = `<span class="context-menu-label">+ New playlist...</span>`;
  newDiv.addEventListener('click', async (e) => {
    e.stopPropagation();
    hideContextMenu();
    const name = await showModal('New playlist name');
    if (name) await addAllToPlaylist(name, tracks.map(t => ({ path: t, isDir: false })));
  });
  contextMenu.appendChild(newDiv);
  contextMenu.classList.remove('hidden');
}
function showPlaylistContextMenu(x, y, name, tracks) {
  const options = [
    { icon: '➕', label: 'Add to queue', action: () => addPlaylistTracksToQueue(tracks) },
    { icon: '📃', label: 'Add to playlist...', action: () => showAddPlaylistToPlaylistMenu(name, tracks) },
    { icon: '✏️', label: 'Rename', action: () => renamePlaylist(name, tracks) },
    { icon: TRASH_ICON_SVG, label: 'Delete', action: () => deletePlaylist(name) }
  ];
  renderMenuOptions(options);
  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';
  contextMenu.classList.remove('hidden');
}

fileList.addEventListener('click', (e) => {
  if (e.target === fileList) clearSelection();
});
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const inTextField = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;

  if (e.key === 'Escape') {
    if (metaEditState) closeMetaEditor();
    if (selectedItems.size > 0) clearSelection();
    hideContextMenu();
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !inTextField) {
    if (lastRenderedItems.length === 0) return;
    e.preventDefault();
    lastRenderedItems.forEach(item => selectedItems.set(item.path, item));
    lastClickedPath = lastRenderedItems[lastRenderedItems.length - 1].path;
    refreshSelectionVisuals();
  }

  // Page/Home/End scroll the file list (browse view or search results)
  if (!inTextField && (e.key === 'PageDown' || e.key === 'PageUp' || e.key === 'Home' || e.key === 'End')) {
    e.preventDefault();
    if (e.key === 'PageDown') fileList.scrollBy({ top: fileList.clientHeight * 0.9, behavior: 'smooth' });
    else if (e.key === 'PageUp') fileList.scrollBy({ top: -fileList.clientHeight * 0.9, behavior: 'smooth' });
    else if (e.key === 'Home') fileList.scrollTo({ top: 0, behavior: 'smooth' });
    else fileList.scrollTo({ top: fileList.scrollHeight, behavior: 'smooth' });
    return;
  }

  // Ctrl/Cmd+F focuses the search box, like a browser's find
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }

  // F2 renames the currently playing track, if its folder is the one being browsed
  if (e.key === 'F2' && !inTextField) {
    const trackPath = getCurrentTrackPath();
    if (trackPath && !isSearching && dirNameOf(trackPath) === currentPath) {
      e.preventDefault();
      renameItem({ path: trackPath, name: fileNameOf(trackPath), isDir: false, isAudio: true });
    }
    return;
  }

  // Backspace with nothing selected goes up to the parent folder
  if (e.key === 'Backspace' && !inTextField && selectedItems.size === 0 && !isSearching && currentPath) {
    e.preventDefault();
    browse(dirNameOf(currentPath));
  }
});

// ---------- Tabs ----------
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const isQueue = btn.dataset.tab === 'queue';
    document.getElementById('queuePanel').classList.toggle('hidden', !isQueue);
    document.getElementById('queueToolbar').style.display = isQueue ? 'flex' : 'none';
    document.getElementById('playlistsPanel').classList.toggle('hidden', btn.dataset.tab !== 'playlists');
  });
});

// ---------- Context menu ----------
function renderMenuOptions(options) {
  contextMenu.innerHTML = '';
  options.forEach(opt => {
    const div = document.createElement('div');
    div.className = 'context-menu-item';
    div.innerHTML = opt.icon
      ? `<span class="context-menu-icon">${opt.icon}</span><span class="context-menu-label">${opt.label}</span>`
      : `<span class="context-menu-label">${opt.label}</span>`;
    div.addEventListener('click', (e) => { e.stopPropagation(); hideContextMenu(); opt.action(); });
    contextMenu.appendChild(div);
  });
}

function showContextMenu(x, y, item) {
  const options = [];
  if (item.isAudio || item.isDir) {
    options.push({ icon: '➕', label: 'Add to queue', action: () => addToQueue(item) });
    options.push({ icon: '📃', label: 'Add to playlist...', action: () => showAddToPlaylistMenu(item) });
  }
  if (item.isAudio) {
    options.push({ icon: EDIT_ICON_SVG, label: 'Edit metadata', action: () => openMetadataEditor([item]) });
  }
  options.push({ icon: '✏️', label: 'Rename', action: () => renameItem(item) });
  options.push({ icon: '📦', label: 'Move to...', action: () => moveItem(item) });
  options.push({ icon: TRASH_ICON_SVG, label: 'Delete', action: () => deleteItem(item) });
  renderMenuOptions(options);
  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';
  contextMenu.classList.remove('hidden');
}
function hideContextMenu() { contextMenu.classList.add('hidden'); }
document.addEventListener('click', (e) => {
  if (!contextMenu.contains(e.target)) hideContextMenu();
  if (selectedItems.size > 0) clearSelection();
});

// ---- Multi-item context menu (2+ selected items) — no rename, acts on all of them ----
async function addAllToQueue(items) {
  for (const item of items) await addToQueue(item);
}
async function moveItems(items) {
  const destFolder = await showModal(`Move ${items.length} items to folder (relative path, blank = root)`);
  if (destFolder === null) return;
  for (const item of items) {
    await api('/api/move', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: item.path, destFolder })
    });
  }
  clearSelection();
  browse(currentPath, { keepSort: true });
}
async function deleteItems(items) {
  if (!confirmAction(`Delete ${items.length} items? This cannot be undone.`)) return;
  for (const item of items) {
    await api('/api/delete', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: item.path })
    });
  }
  clearSelection();
  browse(currentPath, { keepSort: true });
}
async function showAddToPlaylistMenuMulti(items) {
  const names = Object.keys(playlists);
  if (names.length === 0) {
    const name = await showModal('New playlist name');
    if (name) { await addAllToPlaylist(name, items); clearSelection(); }
    return;
  }
  const options = names.map(name => ({
    label: name,
    action: async () => { await addAllToPlaylist(name, items); clearSelection(); }
  }));
  renderMenuOptions(options);
  const divider = document.createElement('div');
  divider.className = 'context-menu-divider';
  contextMenu.appendChild(divider);
  const newDiv = document.createElement('div');
  newDiv.className = 'context-menu-item';
  newDiv.innerHTML = `<span class="context-menu-label">+ New playlist...</span>`;
  newDiv.addEventListener('click', async (e) => {
    e.stopPropagation();
    hideContextMenu();
    const name = await showModal('New playlist name');
    if (name) { await addAllToPlaylist(name, items); clearSelection(); }
  });
  contextMenu.appendChild(newDiv);
  contextMenu.classList.remove('hidden');
}
function showMultiContextMenu(x, y, items) {
  const audioItems = items.filter(i => i.isAudio);
  const options = [
    { icon: '➕', label: `Add ${items.length} to queue`, action: () => addAllToQueue(items) },
    { icon: '📃', label: 'Add to playlist...', action: () => showAddToPlaylistMenuMulti(items) }
  ];
  if (audioItems.length) {
    options.push({ icon: EDIT_ICON_SVG, label: `Edit metadata (${audioItems.length})`, action: () => openMetadataEditor(audioItems) });
  }
  options.push({ icon: '📦', label: 'Move to...', action: () => moveItems(items) });
  options.push({ icon: TRASH_ICON_SVG, label: `Delete ${items.length} items`, action: () => deleteItems(items) });
  renderMenuOptions(options);
  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';
  contextMenu.classList.remove('hidden');
}

async function showAddToPlaylistMenu(item) {
  const names = Object.keys(playlists);
  if (names.length === 0) {
    const name = await showModal('New playlist name');
    if (name) await addToPlaylist(name, item);
    return;
  }
  contextMenu.innerHTML = '';
  names.forEach(name => {
    const div = document.createElement('div');
    div.className = 'context-menu-item';
    div.textContent = name;
    div.addEventListener('click', (e) => { e.stopPropagation(); hideContextMenu(); addToPlaylist(name, item); });
    contextMenu.appendChild(div);
  });
  const divider = document.createElement('div');
  divider.className = 'context-menu-divider';
  contextMenu.appendChild(divider);
  const newDiv = document.createElement('div');
  newDiv.className = 'context-menu-item';
  newDiv.textContent = '+ New playlist...';
  newDiv.addEventListener('click', async (e) => {
    e.stopPropagation();
    hideContextMenu();
    const name = await showModal('New playlist name');
    if (name) await addToPlaylist(name, item);
  });
  contextMenu.appendChild(newDiv);
  contextMenu.classList.remove('hidden');
}

// ---------- File management ----------
async function renameItem(item) {
  const newName = await showModal('Rename to', fileNameOf(item.path));
  if (newName) {
    await api('/api/rename', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ path: item.path, newName })
    });
    browse(currentPath, { keepSort: true });
  }
}
async function moveItem(item) {
  const destFolder = await showModal('Move to folder (relative path, blank = root)');
  if (destFolder !== null) {
    await api('/api/move', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ path: item.path, destFolder })
    });
    browse(currentPath, { keepSort: true });
  }
}
async function deleteItem(item) {
  if (confirmAction(`Delete "${item.name}"? This cannot be undone.`)) {
    await api('/api/delete', {
      method: 'DELETE', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ path: item.path })
    });
    browse(currentPath, { keepSort: true });
  }
}

document.getElementById('newFolderBtn').addEventListener('click', async () => {
  const name = await showModal('New folder name');
  if (name) {
    await api('/api/mkdir', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ path: currentPath, name })
    });
    browse(currentPath, { keepSort: true });
  }
});

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  if (searchDebounce) clearTimeout(searchDebounce);

  if (!q) {
    searchClearBtn.classList.add('hidden');
    if (isSearching) {
      isSearching = false;
      browse(preSearchPath);
    }
    return;
  }

  if (!isSearching) {
    isSearching = true;
    libraryView = null;
    hideLibraryBanner();
    fileListWrap.classList.add('search-mode');
    preSearchPath = currentPath;
  }
  searchClearBtn.classList.remove('hidden');
  searchDebounce = setTimeout(() => performSearch(q), 250);
});

searchClearBtn.addEventListener('click', () => {
  searchInput.value = '';
  searchInput.dispatchEvent(new Event('input'));
  searchInput.focus();
});

const searchScopeBtn = document.getElementById('searchScopeBtn');
const FOLDER_ICON_CURRENTCOLOR_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;

function updateSearchScopeBtn() {
  searchScopeBtn.classList.toggle('active', searchScopeCurrentFolder);
  searchScopeBtn.innerHTML = searchScopeCurrentFolder ? FOLDER_ICON_CURRENTCOLOR_SVG : GLOBE_ICON_SVG;
  searchScopeBtn.title = searchScopeCurrentFolder
    ? 'Searching current folder only (click to search everywhere)'
    : 'Searching everywhere (click to search only the current folder)';
}
searchScopeBtn.addEventListener('click', () => {
  searchScopeCurrentFolder = !searchScopeCurrentFolder;
  updateSearchScopeBtn();
  const q = searchInput.value.trim();
  if (isSearching && q) performSearch(q);
});
updateSearchScopeBtn();

// ---------- Uploads (panel with per-file status, drag & drop) ----------
const uploadBtn = document.getElementById('uploadBtn');
const uploadPanel = document.getElementById('uploadPanel');
const uploadInput = document.getElementById('uploadInput');
const uploadExplorerBtn = document.getElementById('uploadExplorerBtn');
const uploadClearBtn = document.getElementById('uploadClearBtn');
const uploadList = document.getElementById('uploadList');
const uploadEmpty = document.getElementById('uploadEmpty');
const fileListWrap = document.getElementById('fileListWrap');
const dropOverlay = document.getElementById('dropOverlay');
const uploadItemsMap = {};

function openUploadPanel() { uploadPanel.classList.remove('hidden'); }

uploadBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  uploadPanel.classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!uploadPanel.contains(e.target) && e.target !== uploadBtn) {
    uploadPanel.classList.add('hidden');
  }
});
uploadExplorerBtn.addEventListener('click', () => uploadInput.click());

function refreshUploadEmptyState() {
  const hasItems = uploadList.querySelector('.upload-item') !== null;
  uploadEmpty.classList.toggle('hidden', hasItems);
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '';
  if (bytesPerSec < 1024) return bytesPerSec.toFixed(0) + ' B/s';
  if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(0) + ' KB/s';
  return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
}

function updateUploadBtnState() {
  const anyActive = Object.values(uploadItemsMap).some(it => !it.el.classList.contains('upload-success')
    && !it.el.classList.contains('upload-failed')
    && !it.el.classList.contains('upload-cancelled'));
  uploadBtn.classList.toggle('uploading', anyActive);
}

function addUploadItem(name, destPath) {
  const id = 'up_' + Math.random().toString(36).slice(2);
  const div = document.createElement('div');
  div.className = 'upload-item';
  div.innerHTML = `
    <div class="upload-item-row">
      <div class="upload-item-name">${name}</div>
      <div class="upload-item-actions">
        <button class="upload-cancel-btn" title="Cancel upload">✕</button>
        <button class="upload-open-folder-btn hidden" title="Open containing folder">${FOLDER_ICON_SVG}</button>
      </div>
    </div>
    <div class="upload-item-bar"><div class="upload-item-bar-fill"></div></div>
    <div class="upload-item-status">Starting…</div>
  `;
  uploadList.prepend(div);
  refreshUploadEmptyState();

  const cancelBtn = div.querySelector('.upload-cancel-btn');
  const openFolderBtn = div.querySelector('.upload-open-folder-btn');
  cancelBtn.addEventListener('click', () => {
    const it = uploadItemsMap[id];
    if (it && it.xhr) it.xhr.abort();
  });
  openFolderBtn.addEventListener('click', () => {
    uploadPanel.classList.add('hidden');
    browse(destPath);
  });

  uploadItemsMap[id] = {
    fill: div.querySelector('.upload-item-bar-fill'),
    status: div.querySelector('.upload-item-status'),
    el: div,
    cancelBtn,
    openFolderBtn,
    xhr: null,
    destPath
  };
  updateUploadBtnState();
  return id;
}
function updateUploadProgress(id, pct, speedBytesPerSec, etaSeconds) {
  const it = uploadItemsMap[id];
  if (!it) return;
  it.fill.style.width = pct + '%';
  const speedText = formatSpeed(speedBytesPerSec);
  const etaText = (etaSeconds != null && isFinite(etaSeconds)) ? formatDuration(etaSeconds) + ' left' : '';
  it.status.textContent = [`${pct}%`, speedText, etaText].filter(Boolean).join(' · ');
}
function setUploadStatus(id, status, message) {
  const it = uploadItemsMap[id];
  if (!it) return;
  it.el.classList.add('upload-' + status);
  it.cancelBtn.classList.add('hidden');
  if (status === 'success') {
    it.fill.style.width = '100%';
    it.status.textContent = 'Done';
    it.openFolderBtn.classList.remove('hidden');
  } else if (status === 'failed') {
    it.status.textContent = message || 'Failed';
  } else if (status === 'cancelled') {
    it.status.textContent = 'Cancelled';
  }
  updateUploadBtnState();
}

function clearFinishedUploads() {
  Object.keys(uploadItemsMap).forEach(id => {
    const it = uploadItemsMap[id];
    if (it.el.classList.contains('upload-success') ||
        it.el.classList.contains('upload-failed') ||
        it.el.classList.contains('upload-cancelled')) {
      it.el.remove();
      delete uploadItemsMap[id];
    }
  });
  refreshUploadEmptyState();
  updateUploadBtnState();
}
uploadClearBtn.addEventListener('click', clearFinishedUploads);

function uploadOneFile(file, destPath, displayName) {
  return new Promise((resolve) => {
    const id = addUploadItem(displayName || file.name, destPath);
    const xhr = new XMLHttpRequest();
    uploadItemsMap[id].xhr = xhr;
    xhr.open('POST', '/api/upload');

    let lastLoaded = 0;
    let lastTime = performance.now();
    let smoothedSpeed = 0; // bytes per second, exponential moving average

    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      if (dt > 0.15) {
        const instSpeed = (e.loaded - lastLoaded) / dt;
        smoothedSpeed = smoothedSpeed === 0 ? instSpeed : (smoothedSpeed * 0.7 + instSpeed * 0.3);
        lastLoaded = e.loaded;
        lastTime = now;
      }
      const pct = Math.round((e.loaded / e.total) * 100);
      const remainingBytes = e.total - e.loaded;
      const eta = smoothedSpeed > 0 ? remainingBytes / smoothedSpeed : null;
      updateUploadProgress(id, pct, smoothedSpeed, eta);
    });
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) setUploadStatus(id, 'success');
      else {
        setUploadStatus(id, 'failed');
        if (xhr.status === 401) {
          isAuthenticated = false;
          updateAuthBtn();
          openLoginModal('Log in to upload files');
        }
      }
      resolve();
    };
    xhr.onerror = () => { setUploadStatus(id, 'failed'); resolve(); };
    xhr.onabort = () => { setUploadStatus(id, 'cancelled'); resolve(); };
    const fd = new FormData();
    fd.append('path', destPath);
    fd.append('files', file);
    xhr.send(fd);
  });
}

async function handleUploadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  openUploadPanel();
  await Promise.all(files.map(f => uploadOneFile(f, currentPath)));
  browse(currentPath, { keepSort: true });
}

function joinRel(base, name) { return base ? `${base}/${name}` : name; }

// Recursively walk a dropped FileSystemEntry (file or directory), collecting
// every file found plus a marker for every directory (so empty folders are
// still created), each tagged with its path relative to the dropped root.
function readEntryRecursive(entry, relBase) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (file) => resolve([{ type: 'file', file, relDir: relBase }]),
        () => resolve([])
      );
    } else if (entry.isDirectory) {
      const relDir = joinRel(relBase, entry.name);
      const reader = entry.createReader();
      const readAllEntries = () => new Promise((res) => {
        let all = [];
        const readBatch = () => {
          reader.readEntries((batch) => {
            if (!batch.length) { res(all); return; }
            all = all.concat(batch);
            readBatch();
          }, () => res(all));
        };
        readBatch();
      });
      readAllEntries().then(async (children) => {
        const results = [{ type: 'dir', relDir }];
        for (const child of children) {
          results.push(...(await readEntryRecursive(child, relDir)));
        }
        resolve(results);
      });
    } else {
      resolve([]);
    }
  });
}

async function handleDroppedEntries(entries) {
  openUploadPanel();
  let all = [];
  for (const entry of entries) {
    all = all.concat(await readEntryRecursive(entry, ''));
  }

  // Create every folder (including empty leaves) first. mkdir is recursive
  // so this also creates any missing parents in one shot.
  const dirs = all.filter(r => r.type === 'dir').map(r => r.relDir);
  for (const rel of dirs) {
    try {
      await api('/api/mkdir', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentPath, name: rel })
      });
    } catch {}
  }

  // Then upload all files into their corresponding subfolder.
  const fileEntries = all.filter(r => r.type === 'file');
  await Promise.all(fileEntries.map(r => {
    const destPath = currentPath ? joinRel(currentPath, r.relDir) : r.relDir;
    const displayName = joinRel(r.relDir, r.file.name);
    return uploadOneFile(r.file, destPath, displayName);
  }));

  browse(currentPath, { keepSort: true });
}

uploadInput.addEventListener('change', (e) => {
  handleUploadFiles(e.target.files);
  e.target.value = '';
});

// ---- Drag and drop onto the file list ----
let dragDepth = 0;
fileListWrap.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (!e.dataTransfer.types.includes('Files')) return;
  dragDepth++;
  dropOverlay.classList.remove('hidden');
});
fileListWrap.addEventListener('dragover', (e) => {
  e.preventDefault();
});
fileListWrap.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.add('hidden');
});
fileListWrap.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.add('hidden');

  const items = e.dataTransfer.items;
  if (items && items.length && typeof items[0].webkitGetAsEntry === 'function') {
    const entries = Array.from(items)
      .map(it => (it.kind === 'file' ? it.webkitGetAsEntry() : null))
      .filter(Boolean);
    if (entries.length) {
      if (entries.some(en => en.isDirectory)) {
        handleDroppedEntries(entries);
      } else if (e.dataTransfer.files && e.dataTransfer.files.length) {
        handleUploadFiles(e.dataTransfer.files);
      }
      return;
    }
  }
  if (e.dataTransfer.files && e.dataTransfer.files.length) {
    handleUploadFiles(e.dataTransfer.files);
  }
});

// ---------- Modal helper ----------
function showModal(title, defaultValue = '') {
  return new Promise((resolve) => {
    modalTitle.textContent = title;
    modalInput.value = defaultValue;
    modalOverlay.classList.remove('hidden');
    modalInput.focus();
    modalInput.select();
    const cleanup = () => {
      modalOverlay.classList.add('hidden');
      document.getElementById('modalOk').onclick = null;
      document.getElementById('modalCancel').onclick = null;
      modalInput.removeEventListener('keydown', onKeydown);
    };
    const doOk = () => {
      const val = modalInput.value.trim();
      cleanup();
      resolve(val || null);
    };
    const doCancel = () => {
      cleanup();
      resolve(null);
    };
    function onKeydown(e) {
      if (e.key === 'Enter') { e.preventDefault(); doOk(); }
      else if (e.key === 'Escape') { e.preventDefault(); doCancel(); }
    }
    modalInput.addEventListener('keydown', onKeydown);
    document.getElementById('modalOk').onclick = doOk;
    document.getElementById('modalCancel').onclick = doCancel;
  });
}

// ---------- Settings panel ----------
const settingsOverlay = document.getElementById('settingsOverlay');
const seekBackInput = document.getElementById('seekBackInput');
const seekForwardInput = document.getElementById('seekForwardInput');
const skipDeleteConfirmInput = document.getElementById('skipDeleteConfirmInput');
const rememberVolumeInput = document.getElementById('rememberVolumeInput');
const hideNonMusicInput = document.getElementById('hideNonMusicInput');
const replayGainInput = document.getElementById('replayGainInput');
const maxItemsLoadInput = document.getElementById('maxItemsLoadInput');

function openSettings() {
  seekBackInput.value = settings.seekBack;
  seekForwardInput.value = settings.seekForward;
  skipDeleteConfirmInput.checked = settings.skipDeleteConfirm;
  rememberVolumeInput.checked = settings.rememberVolume;
  hideNonMusicInput.checked = settings.hideNonMusic;
  replayGainInput.checked = settings.replayGainEnabled;
  maxItemsLoadInput.value = settings.maxItemsLoad;
  settingsOverlay.classList.remove('hidden');
}
function closeSettings() {
  const back = parseInt(seekBackInput.value, 10);
  const fwd = parseInt(seekForwardInput.value, 10);
  settings.seekBack = isFinite(back) && back > 0 ? back : DEFAULT_SETTINGS.seekBack;
  settings.seekForward = isFinite(fwd) && fwd > 0 ? fwd : DEFAULT_SETTINGS.seekForward;
  settings.skipDeleteConfirm = skipDeleteConfirmInput.checked;
  settings.rememberVolume = rememberVolumeInput.checked;
  const hideNonMusicChanged = settings.hideNonMusic !== hideNonMusicInput.checked;
  settings.hideNonMusic = hideNonMusicInput.checked;
  settings.replayGainEnabled = replayGainInput.checked;
  const maxItemsLoadRaw = parseInt(maxItemsLoadInput.value, 10);
  const newMaxItemsLoad = isFinite(maxItemsLoadRaw) && maxItemsLoadRaw >= 0 ? maxItemsLoadRaw : DEFAULT_SETTINGS.maxItemsLoad;
  const maxItemsLoadChanged = settings.maxItemsLoad !== newMaxItemsLoad;
  settings.maxItemsLoad = newMaxItemsLoad;
  saveSettings();
  settingsOverlay.classList.add('hidden');
  if (hideNonMusicChanged) {
    if (isSearching) performSearch(searchInput.value.trim());
    else browse(currentPath, { keepSort: true });
  } else if (maxItemsLoadChanged) {
    // Re-render whatever's currently visible so the new chunk size (or
    // unlimited, for 0) takes effect immediately rather than only on the
    // next navigation.
    if (isSearching) performSearch(searchInput.value.trim());
    else if (libraryView) openLibrary(libraryView.type, libraryView.name, { skipHistory: true, keepSort: true });
    else renderFileList(lastFetchedItems);
    renderQueue();
    renderPlaylists();
  }
  const track = queue[queueIndex];
  if (track) getMeta(track.path).then(meta => applyReplayGain(meta.replayGainDb));
}

document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('settingsCloseBtn').addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

document.getElementById('resetLayoutBtn').addEventListener('click', () => {
  localStorage.removeItem('musicapp-layout');
  document.documentElement.style.removeProperty('--sidebar-w');
  document.documentElement.style.removeProperty('--lyrics-h');
  ['title', 'artist', 'album', 'duration', 'size'].forEach(col => {
    fileListWrap.style.removeProperty(`--col-${col}-w`);
  });
  showToast('Layout reset to default');
});

document.getElementById('rebuildLibraryBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const settingsCogIcon = document.getElementById('settingsCogIcon');
  btn.disabled = true;
  btn.textContent = 'Updating...';
  settingsCogIcon.classList.add('spinning');
  try {
    await api('/api/library/rebuild', { method: 'POST' });
    showToast('Library metadata updated');
  } catch (err) {
    showToast(err.message || 'Failed to update library metadata');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update library metadata';
    settingsCogIcon.classList.remove('spinning');
  }
});

// ---------- Authentication ----------
const authBtn = document.getElementById('authBtn');
const loginOverlay = document.getElementById('loginOverlay');
const loginInput = document.getElementById('loginInput');
const loginError = document.getElementById('loginError');

const LOCK_ICON_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;
const UNLOCK_ICON_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>`;
function updateAuthBtn() {
  if (isAuthenticated) {
    authBtn.innerHTML = UNLOCK_ICON_SVG + 'Log out';
    authBtn.title = 'Log out (currently able to make changes)';
    authBtn.classList.add('logged-in');
  } else {
    authBtn.innerHTML = LOCK_ICON_SVG + 'Log in';
    authBtn.title = 'Log in to make changes';
    authBtn.classList.remove('logged-in');
  }
}

function openLoginModal(message) {
  loginInput.value = '';
  loginError.textContent = message && message !== 'Log in to make changes' ? message : '';
  loginError.classList.toggle('hidden', !loginError.textContent);
  loginOverlay.classList.remove('hidden');
  loginInput.focus();
}
function closeLoginModal() {
  loginOverlay.classList.add('hidden');
}

async function checkAuthStatus() {
  try {
    const status = await api('/api/auth-status');
    isAuthenticated = status.authenticated;
    authConfigured = status.authConfigured;
    updateAuthBtn();
  } catch {}
}

async function submitLogin() {
  const password = loginInput.value;
  if (!password) return;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      isAuthenticated = true;
      updateAuthBtn();
      closeLoginModal();
    } else {
      loginError.textContent = data.error || 'Login failed';
      loginError.classList.remove('hidden');
      loginInput.select();
    }
  } catch {
    loginError.textContent = 'Could not reach the server';
    loginError.classList.remove('hidden');
  }
}

authBtn.addEventListener('click', async () => {
  if (isAuthenticated) {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    isAuthenticated = false;
    updateAuthBtn();
  } else {
    openLoginModal();
  }
});
document.getElementById('loginOk').addEventListener('click', submitLogin);
document.getElementById('loginCancel').addEventListener('click', closeLoginModal);
loginInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitLogin();
  else if (e.key === 'Escape') closeLoginModal();
});
loginOverlay.addEventListener('click', (e) => {
  if (e.target === loginOverlay) closeLoginModal();
});

checkAuthStatus();

// ---------- Toast ----------
const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2500);
}

// ---------- Lyrics ----------
let currentLyrics = null; // { synced, lines: [{time, text}] } or null
let lyricsAutoScroll = true;
let lyricsBoxOpen = false;
let lyricsTrackPath = null; // guards against a slow fetch resolving after the track changed again

const lyricsBoxWrap = document.querySelector('.lyrics-box-wrap');
const lyricsBoxEl = document.getElementById('lyricsBox');
const lyricsToggleBtn = document.getElementById('lyricsToggleBtn');
const lyricsContentEl = document.getElementById('lyricsContent');
const lyricsEmptyEl = document.getElementById('lyricsEmpty');
const lyricsLinesEl = document.getElementById('lyricsLines');
const lyricsScrollModeBtn = document.getElementById('lyricsScrollModeBtn');
const lyricsEditBtn = document.getElementById('lyricsEditBtn');
const lyricsFetchEmptyBtn = document.getElementById('lyricsFetchEmptyBtn');

// Parses LRC-style "[mm:ss.xx] text" lines. Lines without a timestamp are kept
// (time: null) so plain/unsynced lyrics still render, just without a highlight.
function parseLRC(raw) {
  if (!raw) return { synced: false, lines: [] };
  const re = /^\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.*)$/;
  const lines = [];
  let anyTimed = false;
  for (const rawLine of raw.split('\n')) {
    const m = rawLine.match(re);
    if (m) {
      anyTimed = true;
      const min = parseInt(m[1], 10), sec = parseInt(m[2], 10);
      const frac = m[3] ? parseFloat('0.' + m[3]) : 0;
      lines.push({ time: min * 60 + sec + frac, text: m[4] || '' });
    } else if (rawLine.trim()) {
      lines.push({ time: null, text: rawLine.trim() });
    }
  }
  return { synced: anyTimed, lines };
}

// Fills in missing timestamps (partial/manual sync) by linear interpolation
// between the nearest known timestamps on either side, using the song's
// start (0) and end (duration) as boundary anchors when a run of missing
// lines sits before the first or after the last known timestamp. This is
// purely for display/scroll purposes - it never touches the stored lyrics.
function interpolateLyricsTimes(lines, duration) {
  const known = [];
  lines.forEach((l, i) => { if (l.time !== null) known.push(i); });
  if (known.length === 0) return lines.map(l => ({ ...l }));

  const anchors = [
    { idx: -1, time: 0 },
    ...known.map(i => ({ idx: i, time: lines[i].time })),
    { idx: lines.length, time: duration != null ? duration : lines[known[known.length - 1]].time }
  ];

  const result = lines.map(l => ({ ...l }));
  for (let a = 0; a < anchors.length - 1; a++) {
    const start = anchors[a], end = anchors[a + 1];
    const steps = end.idx - start.idx;
    if (steps <= 1) continue; // no missing lines between these two anchors
    for (let i = start.idx + 1; i < end.idx; i++) {
      const frac = (i - start.idx) / steps;
      result[i].time = start.time + (end.time - start.time) * frac;
    }
  }
  return result;
}

function renderLyricsContent() {
  lyricsLinesEl.innerHTML = '';
  const hasLyrics = currentLyrics && currentLyrics.lines.length > 0;
  lyricsEmptyEl.classList.toggle('hidden', hasLyrics);
  if (!hasLyrics) return;
  currentLyrics.lines.forEach(line => {
    const div = document.createElement('div');
    div.className = 'lyrics-line' + (currentLyrics.synced ? '' : ' unsynced');
    div.textContent = line.text;
    lyricsLinesEl.appendChild(div);
  });
}

async function loadLyricsForTrack(trackPath) {
  lyricsTrackPath = trackPath;
  currentLyrics = null;
  renderLyricsContent();
  try {
    const data = await api(`/api/lyrics?path=${encodeURIComponent(trackPath)}`);
    if (lyricsTrackPath !== trackPath) return; // a newer track started before this resolved
    currentLyrics = data.lyrics ? parseLRC(data.lyrics) : null;
  } catch {
    if (lyricsTrackPath !== trackPath) return;
    currentLyrics = null;
  }
  renderLyricsContent();
}

function updateLyricsSync() {
  if (!currentLyrics || !currentLyrics.lines.length || !lyricsLinesEl.children.length) return;
  const t = audioEl.currentTime;
  const dur = audioEl.duration;

  if (currentLyrics.synced) {
    if (!currentLyrics.interpolatedLines && dur && isFinite(dur)) {
      currentLyrics.interpolatedLines = interpolateLyricsTimes(currentLyrics.lines, dur);
    }
    const syncLines = currentLyrics.interpolatedLines || currentLyrics.lines;
    let activeIdx = -1;
    for (let i = 0; i < syncLines.length; i++) {
      const lineTime = syncLines[i].time;
      if (lineTime !== null && lineTime <= t) activeIdx = i;
    }
    const children = lyricsLinesEl.children;
    for (let i = 0; i < children.length; i++) {
      children[i].classList.toggle('active', i === activeIdx);
    }
    if (lyricsAutoScroll && activeIdx >= 0 && children[activeIdx]) {
      children[activeIdx].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  } else if (lyricsAutoScroll && dur && isFinite(dur)) {
    // No per-line timing available - scroll proportionally to overall song progress.
    const scrollable = lyricsContentEl.scrollHeight - lyricsContentEl.clientHeight;
    if (scrollable > 0) lyricsContentEl.scrollTop = (t / dur) * scrollable;
  }
}
audioEl.addEventListener('timeupdate', updateLyricsSync);

function toggleLyricsBox() {
  lyricsBoxOpen = !lyricsBoxOpen;
  lyricsBoxWrap.classList.toggle('open', lyricsBoxOpen);
  lyricsBoxEl.classList.toggle('open', lyricsBoxOpen);
  lyricsToggleBtn.title = lyricsBoxOpen ? 'Hide lyrics' : 'Show lyrics';
  // No redraw needed: drawBlurBackground always draws tall enough for the
  // panel's maximum possible height and anchors the canvas to the bottom
  // of its wrapper, so opening/closing the lyrics panel just reveals more
  // or less of the same already-drawn artwork via CSS overflow:hidden.
}
lyricsToggleBtn.addEventListener('click', toggleLyricsBox);

function updateScrollModeBtn() {
  lyricsScrollModeBtn.classList.toggle('on', lyricsAutoScroll);
  lyricsScrollModeBtn.setAttribute('aria-checked', String(lyricsAutoScroll));
  document.querySelector('.lyrics-scroll-toggle-wrap').classList.toggle('on', lyricsAutoScroll);
}
lyricsScrollModeBtn.addEventListener('click', () => {
  lyricsAutoScroll = !lyricsAutoScroll;
  updateScrollModeBtn();
});
updateScrollModeBtn();

lyricsEditBtn.addEventListener('click', () => {
  const track = queue[queueIndex];
  if (!track) return;
  openMetadataEditor([{ path: track.path, name: fileNameOf(track.path), isAudio: true }]);
});

lyricsFetchEmptyBtn.addEventListener('click', async () => {
  const track = queue[queueIndex];
  if (!track) return;
  lyricsFetchEmptyBtn.disabled = true;
  lyricsFetchEmptyBtn.textContent = 'Fetching...';
  try {
    const data = await api('/api/lyrics/fetch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: track.path })
    });
    if (data.found) {
      await api('/api/edit-meta/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits: [{ path: track.path, tags: { lyrics: data.lyrics } }] })
      });
      delete metaCache[track.path];
      await loadLyricsForTrack(track.path);
    } else {
      showToast('No matching lyrics found');
    }
  } catch (err) {
    showToast(err.message || 'Failed to fetch lyrics');
  } finally {
    lyricsFetchEmptyBtn.disabled = false;
    lyricsFetchEmptyBtn.textContent = 'Fetch lyrics';
  }
});

// ---------- Metadata editor ----------
const META_FIELDS = ['title', 'artist', 'album', 'year', 'track', 'disc'];
const KEEP_MULTI = '--- keep multiple values ---';

let metaEditState = null;
// {
//   files: [{ path, name, newName, orig:{title,artist,album,year,track,disc}, vals:{...same}, hasArt, art:{action:'keep'|'delete'|'set', data?, mime?} }],
//   idx, group
// }

const metaOverlay = document.getElementById('metaOverlay');
const metaGroupWrap = document.getElementById('metaGroupWrap');
const metaGroupChk = document.getElementById('metaGroupChk');
const metaFileCounter = document.getElementById('metaFileCounter');
const metaPrevBtn = document.getElementById('metaPrevBtn');
const metaNextBtn = document.getElementById('metaNextBtn');
const metaFilename = document.getElementById('metaFilename');
const metaArtImg = document.getElementById('metaArtImg');
const metaArtPlaceholder = document.getElementById('metaArtPlaceholder');
const metaArtSplit = document.getElementById('metaArtSplit');
const metaArtOldImg = document.getElementById('metaArtOldImg');
const metaArtOldPlaceholder = document.getElementById('metaArtOldPlaceholder');
const metaArtNewImg = document.getElementById('metaArtNewImg');
const metaArtUploadBtn = document.getElementById('metaArtUploadBtn');
const metaArtDeleteBtn = document.getElementById('metaArtDeleteBtn');
const metaArtKeepBtn = document.getElementById('metaArtKeepBtn');
const metaArtPrevBtn = document.getElementById('metaArtPrevBtn');
const metaArtNextBtn = document.getElementById('metaArtNextBtn');
const metaArtIndex = document.getElementById('metaArtIndex');
const metaArtBroadcastWrap = document.getElementById('metaArtBroadcastWrap');
const metaArtBroadcastChk = document.getElementById('metaArtBroadcastChk');
const metaArtChangedCount = document.getElementById('metaArtChangedCount');
const metaArtInput = document.getElementById('metaArtInput');
const metaArtStatus = document.getElementById('metaArtStatus');
const metaCancelBtn = document.getElementById('metaCancelBtn');
const metaApplyBtn = document.getElementById('metaApplyBtn');

async function openMetadataEditor(items) {
  if (!META_EDITOR_AVAILABLE) {
    alert('The metadata editor UI failed to load (index.html/style.css appear out of date on this server). Please redeploy them alongside app.js.');
    return;
  }
  const audioItems = items.filter(i => i.isAudio);
  if (!audioItems.length) return;
  let data;
  try {
    data = await api('/api/edit-meta/get', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: audioItems.map(i => i.path) })
    });
  } catch (err) {
    alert('Could not load metadata: ' + err.message);
    return;
  }
  metaEditState = {
    files: data.files.map(f => {
      const orig = {
        title: f.title || '',
        artist: f.artist || '',
        album: f.album || '',
        year: f.year ? String(f.year) : '',
        track: f.track ? String(f.track) : '',
        disc: f.disc ? String(f.disc) : ''
      };
      return {
        path: f.path, name: f.name, newName: f.name,
        orig, vals: { ...orig },
        origLyrics: f.lyrics || '', lyricsVal: f.lyrics || '',
        hasArt: f.hasArt,
        art: { action: 'keep' }
      };
    }),
    idx: 0,
    group: audioItems.length > 1
  };
  metaEditState.uniqueArts = await computeUniqueArts(metaEditState.files);
  metaEditState.artBroadcast = false;
  metaEditState.artBrowseIdx = 0;
  renderMetaEditor();
  metaOverlay.classList.remove('hidden');
}

// Fetches each file's art and dedupes by exact byte content (the common case:
// every track in an album sharing one identical embedded cover) rather than
// by which file it came from, so the browse list only shows genuinely
// distinct images.
async function computeUniqueArts(files) {
  const candidates = files.filter(f => f.hasArt);
  await Promise.all(candidates.map(async (f) => {
    try {
      const res = await fetch(`/api/art?path=${encodeURIComponent(f.path)}`);
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      f.origArtData = dataUrl.split(',')[1];
      f.origArtMime = blob.type || 'image/jpeg';
    } catch {
      f.origArtData = null; // treat as unreadable rather than fail the whole editor
    }
  }));
  const seen = new Set();
  const results = [];
  for (const f of candidates) {
    if (!f.origArtData || seen.has(f.origArtData)) continue;
    seen.add(f.origArtData);
    results.push({ data: f.origArtData, mime: f.origArtMime });
  }
  return results;
}

function closeMetaEditor() {
  metaOverlay.classList.add('hidden');
  metaEditState = null;
  closeMetaFieldDropdown();
}

function renderMetaEditor() {
  const state = metaEditState;
  if (!state) return;
  const n = state.files.length;

  metaGroupWrap.style.display = n > 1 ? '' : 'none';
  metaApplyBtn.textContent = n > 1 ? 'Apply all' : 'Apply';
  document.getElementById('metaField-title').closest('.meta-row').classList.toggle('hidden', state.group);
  document.getElementById('metaField-track').closest('.meta-row').classList.toggle('hidden', state.group);
  document.getElementById('metaLyricsRow').classList.toggle('hidden', state.group);
  if (!state.group) {
    document.getElementById('metaFieldLyrics').value = state.files[state.idx].lyricsVal || '';
  }
  metaGroupChk.checked = state.group;
  metaFileCounter.textContent = n === 1 ? '' : (state.group ? `${n} files` : `${state.idx + 1} / ${n}`);

  const metaFileNavEl = document.querySelector('.meta-file-nav');
  const metaFilenameSingleRow = document.getElementById('metaFilenameSingleRow');
  const metaFilenameSingle = document.getElementById('metaFilenameSingle');

  if (n === 1) {
    metaFileNavEl.style.display = 'none';
    metaFilenameSingleRow.classList.remove('hidden');
    metaFilenameSingle.value = state.files[0].newName;
  } else if (state.group) {
    metaFileNavEl.style.display = 'none';
    metaFilenameSingleRow.classList.add('hidden');
  } else {
    metaFileNavEl.style.display = '';
    metaFilenameSingleRow.classList.add('hidden');
    const showNav = n > 1;
    metaPrevBtn.style.visibility = showNav ? 'visible' : 'hidden';
    metaNextBtn.style.visibility = showNav ? 'visible' : 'hidden';
    metaFilename.value = state.files[state.idx].newName;
    metaFilename.disabled = false;
  }

  const showValueList = state.group && state.files.length > 1;
  closeMetaFieldDropdown();
  META_FIELDS.forEach(field => {
    const input = document.getElementById(`metaField-${field}`);
    const datalist = document.getElementById(`dl-${field}`);
    const arrowBtn = document.querySelector(`.meta-field-arrow-btn[data-field="${field}"]`);
    const uniqueVals = [...new Set(state.files.map(f => f.orig[field]).filter(v => v !== ''))];
    let optionsHtml = uniqueVals.map(v => `<option value="${v}"></option>`).join('');
    if (state.group) optionsHtml = `<option value="${KEEP_MULTI}"></option>` + optionsHtml;
    datalist.innerHTML = optionsHtml;
    arrowBtn.disabled = !showValueList;

    if (state.group) {
      const allSame = state.files.every(f => f.vals[field] === state.files[0].vals[field]);
      input.value = allSame ? state.files[0].vals[field] : KEEP_MULTI;
    } else {
      input.value = state.files[state.idx].vals[field];
    }
  });

  renderMetaArt();
}

function closeMetaFieldDropdown() {
  const existing = document.querySelector('.meta-field-dropdown');
  if (existing) existing.remove();
}

function toggleMetaFieldDropdown(field, btn) {
  const already = btn.parentElement.querySelector('.meta-field-dropdown');
  closeMetaFieldDropdown();
  if (already) return; // was already open on this field — just close it

  const state = metaEditState;
  const uniqueVals = [...new Set(state.files.map(f => f.orig[field]).filter(v => v !== ''))];
  const options = [KEEP_MULTI, ...uniqueVals];

  const dropdown = document.createElement('div');
  dropdown.className = 'meta-field-dropdown';
  dropdown.innerHTML = options.map((v, i) =>
    `<div class="meta-field-dropdown-item${i === 0 ? ' keep-multi' : ''}" data-i="${i}">${v}</div>`
  ).join('');
  dropdown.querySelectorAll('.meta-field-dropdown-item').forEach(el => {
    el.addEventListener('click', () => {
      const val = options[Number(el.dataset.i)];
      const input = document.getElementById(`metaField-${field}`);
      input.value = val;
      if (val !== KEEP_MULTI) {
        state.files.forEach(f => { f.vals[field] = val; });
      }
      closeMetaFieldDropdown();
    });
  });
  btn.parentElement.appendChild(dropdown);
}

function navigateMetaArt(delta) {
  const state = metaEditState;
  const list = state.uniqueArts;
  if (!list || list.length < 2) return;
  state.artBrowseIdx = (state.artBrowseIdx + delta + list.length) % list.length;
  if (state.group && !state.artBroadcast) {
    // Browsing only — nothing is committed until "Use this image" is checked.
    renderMetaArt();
    return;
  }
  const chosen = list[state.artBrowseIdx];
  setArtAction({ action: 'set', data: chosen.data, mime: chosen.mime });
}

document.addEventListener('click', (e) => {
  if (e.target.closest('.meta-field-arrow-btn')) return;
  if (e.target.closest('.meta-field-dropdown')) return;
  closeMetaFieldDropdown();
});

document.querySelectorAll('.meta-field-arrow-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    toggleMetaFieldDropdown(btn.dataset.field, btn);
  });
});
metaArtPrevBtn.addEventListener('click', () => navigateMetaArt(-1));
metaArtNextBtn.addEventListener('click', () => navigateMetaArt(1));
metaArtBroadcastChk.addEventListener('change', () => {
  if (!metaEditState) return;
  const wasChecked = metaEditState.artBroadcast;
  const nowChecked = metaArtBroadcastChk.checked;
  metaEditState.artBroadcast = nowChecked;
  if (wasChecked && !nowChecked) {
    // Unchecked: undo whatever was broadcast.
    metaEditState.files.forEach(f => { f.art = { action: 'keep' }; });
  } else if (!wasChecked && nowChecked) {
    // Checked: commit whatever image is currently being browsed/previewed to every file.
    const list = metaEditState.uniqueArts;
    if (list && list.length) {
      const chosen = list[metaEditState.artBrowseIdx] || list[0];
      metaEditState.files.forEach(f => { f.art = resolveArtForFile(f, { action: 'set', data: chosen.data, mime: chosen.mime }); });
    }
  }
  renderMetaArt();
});

function showSingleArt(src) {
  metaArtSplit.classList.add('hidden');
  if (src) {
    metaArtImg.src = src;
    metaArtImg.classList.remove('hidden');
    metaArtPlaceholder.classList.add('hidden');
  } else {
    metaArtImg.classList.add('hidden');
    metaArtImg.removeAttribute('src');
    metaArtPlaceholder.classList.remove('hidden');
  }
}

function showSplitArt(oldSrc, newSrc) {
  metaArtImg.classList.add('hidden');
  metaArtPlaceholder.classList.add('hidden');
  metaArtSplit.classList.remove('hidden');
  if (oldSrc) {
    metaArtOldImg.src = oldSrc;
    metaArtOldImg.classList.remove('hidden');
    metaArtOldPlaceholder.classList.add('hidden');
  } else {
    metaArtOldImg.classList.add('hidden');
    metaArtOldImg.removeAttribute('src');
    metaArtOldPlaceholder.classList.remove('hidden');
  }
  metaArtNewImg.src = newSrc;
}

function renderMetaArt() {
  const state = metaEditState;
  const multiFile = state.files.length > 1;

  // The broadcast checkbox only makes sense (and is only shown) while editing fields as a group.
  const showChk = state.group && multiFile;
  metaArtBroadcastWrap.classList.toggle('hidden', !showChk);
  metaArtBroadcastChk.checked = state.artBroadcast;

  // Upload/Delete need a clear single target: either the current file (ungrouped),
  // or "all files" explicitly opted into (grouped + checked).
  const controlsEnabled = !state.group || state.artBroadcast;
  metaArtUploadBtn.disabled = !controlsEnabled;
  metaArtDeleteBtn.disabled = !controlsEnabled;
  // Reset is also enabled whenever there's something pending to clear, even if
  // grouped+unchecked (e.g. leftover edits from individual mode before regrouping).
  const anyPending = state.files.some(f => f.art.action !== 'keep');
  metaArtKeepBtn.disabled = !(controlsEnabled || anyPending);

  metaArtStatus.textContent = '';
  metaArtChangedCount.textContent = '';
  let displayedData = null; // base64 of whatever's actually shown right now, used below to sync the counter

  // Always show how many files currently have a pending change (excludes files
  // whose "change" already matches their original), across the whole selection —
  // stays useful as an overview even while only viewing one file at a time.
  {
    const n = state.files.filter(f => {
      if (f.art.action === 'delete') return f.hasArt;
      if (f.art.action === 'set') return f.art.data !== f.origArtData;
      return false;
    }).length;
    if (n > 0) metaArtChangedCount.textContent = `${n} image${n === 1 ? '' : 's'} changed`;
  }

  if (state.group && state.artBroadcast) {
    // Broadcasting: one plain preview representing the shared choice.
    const allDelete = state.files.every(f => f.art.action === 'delete');
    if (allDelete) {
      metaArtStatus.textContent = 'Will be removed';
      showSingleArt(null);
    } else {
      const setFile = state.files.find(f => f.art.action === 'set');
      if (setFile) {
        showSingleArt(`data:${setFile.art.mime};base64,${setFile.art.data}`);
        displayedData = setFile.art.data;
      } else {
        const withArt = state.files.find(f => f.hasArt);
        showSingleArt(withArt ? `/api/art?path=${encodeURIComponent(withArt.path)}` : null);
        displayedData = withArt ? withArt.origArtData : null;
      }
    }
  } else if (state.group && !state.artBroadcast) {
    // Grouped but not committed yet: shows whatever's currently browsed as a live
    // preview only — nothing is written to any file until the checkbox is checked.
    if (state.uniqueArts && state.uniqueArts.length > 0) {
      const preview = state.uniqueArts[state.artBrowseIdx] || state.uniqueArts[0];
      showSingleArt(`data:${preview.mime};base64,${preview.data}`);
      displayedData = preview.data;
    } else {
      showSingleArt(null);
    }
  } else {
    // Ungrouped: editing this one file. A pending new image shows old (gray) vs new side by side.
    const f = state.files[state.idx];
    if (f.art.action === 'set') {
      const oldSrc = f.hasArt ? `/api/art?path=${encodeURIComponent(f.path)}` : null;
      showSplitArt(oldSrc, `data:${f.art.mime};base64,${f.art.data}`);
      displayedData = f.art.data;
    } else if (f.art.action === 'delete') {
      metaArtStatus.textContent = 'Will be removed';
      showSingleArt(null);
    } else {
      showSingleArt(f.hasArt ? `/api/art?path=${encodeURIComponent(f.path)}` : null);
      displayedData = f.hasArt ? f.origArtData : null;
    }
  }

  // Browsing arrows always work, regardless of the checkbox. The counter reflects
  // whatever image is ACTUALLY on screen right now (not just wherever browsing last
  // left off), so it stays accurate across switching files or group/individual mode.
  const showNav = state.uniqueArts && state.uniqueArts.length > 1;
  document.querySelector('.meta-art-nav').classList.toggle('hidden', !showNav);
  if (showNav) {
    const idx = displayedData != null ? state.uniqueArts.findIndex(a => a.data === displayedData) : -1;
    if (idx !== -1) {
      state.artBrowseIdx = idx; // keep the pointer in sync so the next arrow click continues from here
      metaArtIndex.textContent = `${idx + 1} / ${state.uniqueArts.length}`;
    } else {
      metaArtIndex.textContent = `– / ${state.uniqueArts.length}`;
    }
  }
}

function resolveArtForFile(f, newArt) {
  // Browsing/broadcasting back to exactly what a file already has isn't a real
  // change — treat it as 'keep' rather than a redundant 'set' (avoids showing
  // a split/old-vs-new comparison for two identical images).
  if (newArt.action === 'set' && newArt.data === f.origArtData) {
    return { action: 'keep' };
  }
  return { ...newArt };
}

function setArtAction(newArt) {
  if (!metaEditState) return;
  const state = metaEditState;
  if (state.group && state.artBroadcast) {
    state.files.forEach(f => { f.art = resolveArtForFile(f, newArt); });
  } else {
    const f = state.files[state.idx];
    f.art = resolveArtForFile(f, newArt);
  }
  renderMetaArt();
}

// Guards against a mismatched deployment (app.js updated without the matching
// index.html/style.css): if the modal markup isn't present, skip wiring it up
// entirely and warn loudly, instead of throwing on a null element and taking
// down every script that runs after this point (queue, browsing, playback...).
const META_EDITOR_AVAILABLE = !!(metaOverlay && metaGroupWrap && metaGroupChk && metaFileCounter &&
  metaPrevBtn && metaNextBtn && metaFilename && metaArtImg && metaArtPlaceholder &&
  metaArtSplit && metaArtOldImg && metaArtOldPlaceholder && metaArtNewImg &&
  metaArtUploadBtn && metaArtDeleteBtn && metaArtKeepBtn && metaArtPrevBtn && metaArtNextBtn && metaArtIndex &&
  metaArtBroadcastWrap && metaArtBroadcastChk && metaArtChangedCount && metaArtInput && metaArtStatus &&
  metaCancelBtn && metaApplyBtn && document.getElementById('metaLyricsRow') &&
  document.getElementById('metaFilenameSingleRow') && document.getElementById('metaFilenameSingle') &&
  document.getElementById('metaFieldLyrics') && document.getElementById('metaLyricsFetchBtn') &&
  document.getElementById('metaLyricsDeleteBtn') && document.getElementById('metaLyricsLrclibBtn') &&
  META_FIELDS.every(f => document.getElementById(`metaField-${f}`) && document.getElementById(`dl-${f}`)));

if (!META_EDITOR_AVAILABLE) {
  console.error('Metadata editor UI not found in this page (index.html/style.css out of date vs app.js) — "Edit metadata" will be unavailable until they are redeployed together.');
}

if (META_EDITOR_AVAILABLE) {
META_FIELDS.forEach(field => {
  const input = document.getElementById(`metaField-${field}`);
  input.addEventListener('input', () => {
    if (!metaEditState) return;
    const val = input.value;
    if (metaEditState.group) {
      if (val === KEEP_MULTI) return; // explicit "no change" selection
      metaEditState.files.forEach(f => { f.vals[field] = val; });
    } else {
      metaEditState.files[metaEditState.idx].vals[field] = val;
    }
  });
});

metaFilename.addEventListener('input', () => {
  if (!metaEditState || metaEditState.group) return;
  metaEditState.files[metaEditState.idx].newName = metaFilename.value;
});

document.getElementById('metaFilenameSingle').addEventListener('input', (e) => {
  if (!metaEditState || metaEditState.files.length !== 1) return;
  metaEditState.files[0].newName = e.target.value;
});

const metaFieldLyrics = document.getElementById('metaFieldLyrics');
const metaLyricsFetchBtn = document.getElementById('metaLyricsFetchBtn');
const metaLyricsDeleteBtn = document.getElementById('metaLyricsDeleteBtn');
const metaLyricsLrclibBtn = document.getElementById('metaLyricsLrclibBtn');

metaFieldLyrics.addEventListener('input', () => {
  if (!metaEditState || metaEditState.group) return;
  metaEditState.files[metaEditState.idx].lyricsVal = metaFieldLyrics.value;
});

metaLyricsLrclibBtn.addEventListener('click', () => {
  if (!metaEditState || metaEditState.group) return;
  const f = metaEditState.files[metaEditState.idx];
  const title = (f.vals.title || '').trim();
  const query = title || f.name.replace(/\.[^./]+$/, '');
  window.open(`https://lrclib.net/search/${encodeURIComponent(query)}`, '_blank', 'noopener');
});

metaLyricsDeleteBtn.addEventListener('click', () => {
  if (!metaEditState || metaEditState.group) return;
  metaEditState.files[metaEditState.idx].lyricsVal = '';
  metaFieldLyrics.value = '';
});

metaLyricsFetchBtn.addEventListener('click', async () => {
  if (!metaEditState || metaEditState.group) return;
  const f = metaEditState.files[metaEditState.idx];
  metaLyricsFetchBtn.disabled = true;
  metaLyricsFetchBtn.textContent = 'Fetching...';
  try {
    const data = await api('/api/lyrics/fetch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: f.path })
    });
    if (data.found) {
      f.lyricsVal = data.lyrics;
      metaFieldLyrics.value = data.lyrics;
    } else {
      showToast('No matching lyrics found');
    }
  } catch (err) {
    showToast(err.message || 'Failed to fetch lyrics');
  } finally {
    metaLyricsFetchBtn.disabled = false;
    metaLyricsFetchBtn.textContent = 'Fetch lyrics';
  }
});

metaGroupChk.addEventListener('change', () => {
  if (!metaEditState) return;
  metaEditState.group = metaGroupChk.checked;
  if (metaEditState.group) {
    metaEditState.artBroadcast = false;
  }
  renderMetaEditor();
});
metaPrevBtn.addEventListener('click', () => {
  if (!metaEditState || metaEditState.group) return;
  metaEditState.idx = (metaEditState.idx - 1 + metaEditState.files.length) % metaEditState.files.length;
  renderMetaEditor();
});
metaNextBtn.addEventListener('click', () => {
  if (!metaEditState || metaEditState.group) return;
  metaEditState.idx = (metaEditState.idx + 1) % metaEditState.files.length;
  renderMetaEditor();
});

metaArtUploadBtn.addEventListener('click', () => metaArtInput.click());
metaArtInput.addEventListener('change', async () => {
  const file = metaArtInput.files[0];
  metaArtInput.value = '';
  if (!file) return;
  if (file.type !== 'image/jpeg' && file.type !== 'image/png') {
    metaArtStatus.textContent = 'Only JPEG/PNG images are supported';
    return;
  }
  const dataUrl = await new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
  setArtAction({ action: 'set', data: dataUrl.split(',')[1], mime: file.type });
});
metaArtDeleteBtn.addEventListener('click', () => setArtAction({ action: 'delete' }));
metaArtKeepBtn.addEventListener('click', () => {
  const state = metaEditState;
  if (!state) return;
  if (state.group) {
    state.files.forEach(f => { f.art = { action: 'keep' }; });
  } else {
    state.files[state.idx].art = { action: 'keep' };
  }
  if (state.artBroadcast) state.artBroadcast = false;
  renderMetaArt();
});

metaCancelBtn.addEventListener('click', closeMetaEditor);
metaOverlay.addEventListener('click', (e) => { if (e.target === metaOverlay) closeMetaEditor(); });

async function applyMetaEdits() {
  const state = metaEditState;
  if (!state) return;

  const edits = [];
  for (const f of state.files) {
    const tags = {};
    for (const field of META_FIELDS) {
      const newVal = (f.vals[field] || '').trim();
      const origVal = f.orig[field] || '';
      if (newVal !== origVal) tags[field] = newVal;
    }
    if ((f.lyricsVal || '') !== (f.origLyrics || '')) tags.lyrics = f.lyricsVal || '';
    let art = null;
    if (f.art.action === 'set') art = { action: 'set', data: f.art.data, mime: f.art.mime };
    else if (f.art.action === 'delete' && f.hasArt) art = { action: 'delete' };

    let newName;
    const trimmedName = (f.newName || '').trim();
    if (trimmedName && trimmedName !== f.name) newName = trimmedName;

    if (Object.keys(tags).length === 0 && !art && !newName) continue; // nothing changed for this file
    edits.push({ path: f.path, tags, art, newName });
  }

  if (edits.length === 0) { closeMetaEditor(); return; }

  metaApplyBtn.disabled = true;
  metaApplyBtn.textContent = 'Applying...';
  try {
    const { results } = await api('/api/edit-meta/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edits })
    });

    const renameMap = {};
    for (const r of results) {
      delete metaCache[r.path];
      if (r.newPath) { delete metaCache[r.newPath]; renameMap[r.path] = r.newPath; }
    }
    if (Object.keys(renameMap).length) {
      [queue, originalQueue].forEach(list => {
        list.forEach(t => {
          if (renameMap[t.path]) {
            t.path = renameMap[t.path];
            t.name = fileNameOf(t.path);
          }
        });
      });
      renderQueue();
    }

    closeMetaEditor();
    const playingTrack = queue[queueIndex];
    if (playingTrack && edits.some(e => e.path === playingTrack.path || renameMap[e.path] === playingTrack.path)) {
      loadLyricsForTrack(playingTrack.path);
    }
    if (libraryView) openLibrary(libraryView.type, libraryView.name, { skipHistory: true, keepSort: true });
    else if (isSearching) performSearch(searchInput.value.trim());
    else browse(currentPath, { skipHistory: true, keepSort: true });

    const failures = results.filter(r => !r.ok);
    if (failures.length) {
      alert(`${failures.length} file(s) failed to update:\n` + failures.map(f => `${f.path}: ${f.error}`).join('\n'));
    }
  } catch (err) {
    alert('Failed to apply changes: ' + err.message);
  } finally {
    metaApplyBtn.disabled = false;
    metaApplyBtn.textContent = metaEditState && metaEditState.files.length > 1 ? 'Apply all' : 'Apply';
  }
}
metaApplyBtn.addEventListener('click', applyMetaEdits);
} // end META_EDITOR_AVAILABLE guard

function confirmAction(message) {
  if (settings.skipDeleteConfirm) return true;
  return confirm(message);
}

// ---------- Keyboard shortcuts: left/right arrow seek, space play/pause ----------
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const isSeekBar = e.target.id === 'seekBar';
  if (!isSeekBar && (tag === 'input' || tag === 'textarea' || e.target.isContentEditable)) return;
  const anyModalOpen = [settingsOverlay, metaOverlay, loginOverlay, modalOverlay].some(
    el => el && !el.classList.contains('hidden')
  );
  if (anyModalOpen) return;

  if (e.code === 'Space' || e.key === ' ') {
    if (!playerBarEl.classList.contains('hidden')) {
      e.preventDefault();
      document.getElementById('playPauseBtn').click();
    }
    return;
  }

  if (e.altKey) return;

  if (!audioEl.duration || !isFinite(audioEl.duration)) return;

  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    audioEl.currentTime = Math.max(0, audioEl.currentTime - settings.seekBack);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    audioEl.currentTime = Math.min(audioEl.duration, audioEl.currentTime + settings.seekForward);
  }
});

// remember volume between sessions, if enabled
if (settings.rememberVolume) {
  try {
    const savedVol = localStorage.getItem('musicapp-volume');
    if (savedVol !== null) {
      audioEl.volume = parseFloat(savedVol);
      volumeBar.value = Math.round(audioEl.volume * 100);
      updateVolumeBarFill();
    }
  } catch {}
}
volumeBar.addEventListener('change', () => {
  if (settings.rememberVolume) {
    try { localStorage.setItem('musicapp-volume', audioEl.volume); } catch {}
  }
});

// ---------- Resizable layout (column widths + sidebar width) ----------
const COL_MIN_WIDTHS = { title: 80, artist: 60, album: 60, duration: 50, size: 50 };
const SIDEBAR_MIN = 220;
// For each border, which two columns it controls: the left neighbor and the right neighbor.
// A null left neighbor means "Name" (the flexible column), which isn't a settable variable —
// shrinking/growing the right neighbor alone lets Name silently absorb the difference,
// and this is the only border where that happens (dragging it never moves any other border).
const RESIZE_PAIRS = {
  title:    { left: null,      right: 'title' },
  artist:   { left: 'title',   right: 'artist' },
  album:    { left: 'artist',  right: 'album' },
  duration: { left: 'album',   right: 'duration' },
  size:     { left: 'duration', right: 'size' }
};

function loadLayout() {
  try {
    const raw = localStorage.getItem('musicapp-layout');
    if (!raw) return;
    const layout = JSON.parse(raw);
    if (layout.sidebarW) {
      document.documentElement.style.setProperty('--sidebar-w', layout.sidebarW + 'px');
    }
    if (layout.lyricsH) {
      document.documentElement.style.setProperty('--lyrics-h', layout.lyricsH + 'px');
    }
    if (layout.cols) {
      Object.entries(layout.cols).forEach(([col, w]) => {
        fileListWrap.style.setProperty(`--col-${col}-w`, w + 'px');
      });
    }
  } catch {}
}
function saveLayout() {
  try {
    const style = getComputedStyle(fileListWrap);
    const cols = {};
    ['title', 'artist', 'album', 'duration', 'size'].forEach(col => {
      cols[col] = parseInt(style.getPropertyValue(`--col-${col}-w`), 10);
    });
    const sidebarW = parseInt(getComputedStyle(document.getElementById('sidebar')).width, 10);
    const lyricsH = parseInt(getComputedStyle(document.getElementById('lyricsBox')).getPropertyValue('--lyrics-h')) || 280;
    localStorage.setItem('musicapp-layout', JSON.stringify({ cols, sidebarW, lyricsH }));
  } catch {}
}

document.querySelectorAll('.col-resize-handle').forEach(handle => {
  const pair = RESIZE_PAIRS[handle.dataset.col];
  handle.addEventListener('click', (e) => e.stopPropagation());
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const style = getComputedStyle(fileListWrap);
    const startRight = parseInt(style.getPropertyValue(`--col-${pair.right}-w`), 10);
    const startLeft = pair.left ? parseInt(style.getPropertyValue(`--col-${pair.left}-w`), 10) : null;
    handle.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    function onMove(ev) {
      const delta = ev.clientX - startX;
      if (pair.left === null) {
        // Only this border's right column changes; Name (flexible) absorbs the rest —
        // this never shifts any other border.
        const newRight = Math.max(COL_MIN_WIDTHS[pair.right], startRight - delta);
        fileListWrap.style.setProperty(`--col-${pair.right}-w`, newRight + 'px');
      } else {
        // Grow the left neighbor and shrink the right neighbor by the same amount —
        // every other column (including Name and everything beyond the right neighbor)
        // stays exactly where it is.
        const newLeft = Math.max(COL_MIN_WIDTHS[pair.left], startLeft + delta);
        const newRight = Math.max(COL_MIN_WIDTHS[pair.right], startRight - delta);
        fileListWrap.style.setProperty(`--col-${pair.left}-w`, newLeft + 'px');
        fileListWrap.style.setProperty(`--col-${pair.right}-w`, newRight + 'px');
      }
    }
    function onUp() {
      handle.classList.remove('resizing');
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      saveLayout();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
});

const sidebarResizeHandle = document.getElementById('sidebarResizeHandle');
const sidebarEl = document.getElementById('sidebar');
sidebarResizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = sidebarEl.getBoundingClientRect().width;
  sidebarResizeHandle.classList.add('resizing');
  document.body.style.cursor = 'col-resize';
  function onMove(ev) {
    const delta = ev.clientX - startX;
    const maxWidth = window.innerWidth - 200; // keep the file list from being squeezed to nothing
    const newWidth = Math.min(maxWidth, Math.max(SIDEBAR_MIN, startWidth - delta));
    document.documentElement.style.setProperty('--sidebar-w', newWidth + 'px');
  }
  function onUp() {
    sidebarResizeHandle.classList.remove('resizing');
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveLayout();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

loadLayout();

const lyricsResizeHandle = document.getElementById('lyricsResizeHandle');
lyricsResizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const startY = e.clientY;
  const startHeight = lyricsBoxEl.getBoundingClientRect().height;
  lyricsResizeHandle.classList.add('resizing');
  lyricsBoxEl.classList.add('no-transition');
  document.body.style.cursor = 'row-resize';
  function onMove(ev) {
    const delta = ev.clientY - startY;
    const maxHeight = window.innerHeight - 220; // keep the file list from being squeezed to nothing
    const newHeight = Math.min(maxHeight, Math.max(120, startHeight - delta));
    document.documentElement.style.setProperty('--lyrics-h', newHeight + 'px');
    // No redraw needed: drawBlurBackground already sized the canvas for
    // this exact maximum (window.innerHeight - 220 + player bar height),
    // so dragging within that range just reveals more/less of the same
    // fixed artwork via CSS, the same way open/close does.
  }
  function onUp() {
    lyricsResizeHandle.classList.remove('resizing');
    lyricsBoxEl.classList.remove('no-transition');
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveLayout();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// ---------- Init ----------
const initialHash = decodeURIComponent((location.hash || '#').slice(1));
if (initialHash.startsWith('artist=')) {
  const n = initialHash.slice(7);
  history.replaceState({ view: 'artist', name: n }, '', location.hash);
  openLibrary('artist', n, { skipHistory: true });
} else if (initialHash.startsWith('album=')) {
  const n = initialHash.slice(6);
  history.replaceState({ view: 'album', name: n }, '', location.hash);
  openLibrary('album', n, { skipHistory: true });
} else {
  history.replaceState({ path: initialHash }, '', location.hash || '#');
  browse(initialHash, { skipHistory: true });
}
loadPlaylists();
renderQueue();