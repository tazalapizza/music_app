// ---------------------------------------------------------------------------
// browse.js — Folder browsing, browser history (popstate), and the
// artist/album library views (banners, breadcrumbs).
// Depends on: state.js, selection.js.
// ---------------------------------------------------------------------------

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
      if (window.setupHoverScrollbarFor) window.setupHoverScrollbarFor(strip);
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