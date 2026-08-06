// ---------------------------------------------------------------------------
// filelist.js — Building file/folder rows, column sorting, paginated
// rendering, the main file list, and search results rendering.
// Depends on: state.js, selection.js, browse.js.
// ---------------------------------------------------------------------------


// Mobile select mode (see layout-init.js/responsive.css) intercepts row
// taps to toggle selection instead of the normal open/play action —
// checked here, once, rather than duplicated across every row.addEventListener
// call site below. Outside select mode this is a pure pass-through to the
// existing handleRowClick, so desktop's ctrl/shift-click behavior is
// completely unaffected.
function handleRowClickMobileAware(e, item, defaultAction) {
  if (window.mobileSelectModeActive) {
    e.stopPropagation();
    toggleSelect(item);
    if (window.updateMobileSelectModeUI) window.updateMobileSelectModeUI();
    return;
  }
  handleRowClick(e, item, defaultAction);
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
  // Mobile-only: a 3-dot menu button (opens the same context menu used on
  // desktop's right-click), only visible when select mode is off. In
  // select mode it's hidden and the row itself becomes the tap target for
  // toggling selection (see handleRowClickMobileAware below) — no
  // separate checkbox, the row's own accent-color highlight (.selected)
  // is the only selection indicator. See responsive.css for the show/hide
  // rules and layout-init.js for the select-mode wiring.
  const mobileRowControlsHtml = `
    <button class="row-menu-btn" title="More options"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="5" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="12" cy="19" r="1.8"></circle></svg></button>
  `;

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
      ${mobileRowControlsHtml}
    `;
    row.querySelector('.folder-icon-play-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      playFolder(item);
    });
    row.addEventListener('click', (e) => handleRowClickMobileAware(e, item, () => browse(item.path)));
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
      ${mobileRowControlsHtml}
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
      row.addEventListener('click', (e) => handleRowClickMobileAware(e, item, defaultAction));
    } else {
      row.addEventListener('click', (e) => handleRowClickMobileAware(e, item, null));
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
  // Mobile-only 3-dot button: only ever visible when select mode is off
  // (see responsive.css), which per the app's select-mode design also
  // guarantees selectedItems is empty at that point — so this always acts
  // on just this single row, same as a fresh right-click on desktop.
  row.querySelector('.row-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    showContextMenu(rect.right, rect.bottom, item);
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

// Columns whose sort order depends on fetched metadata rather than data
// already on the item object (name/size/isDir come from the folder listing
// itself). Shared by applySort() and its callers, so "which columns need
// metadata" is defined once instead of duplicated at each call site.
const METADATA_SORT_COLUMNS = new Set(['title', 'artist', 'album', 'duration']);

async function applySort(items) {
  if (!sortColumn) return items;
  if (METADATA_SORT_COLUMNS.has(sortColumn)) {
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
    // Rows built here can include marquee targets (queue/playlist row
    // titles, file names, etc. - see MARQUEE_TARGETS in layout-init.js).
    // The generic debounced MutationObserver rescan would technically
    // still catch this insertion, but every other place in the app that
    // adds marquee-target content calls scanMarquees() directly rather
    // than relying on that alone - matching that pattern here too, for a
    // chunk of rows that's about to actually become visible right after
    // the IntersectionObserver fires for it.
    if (typeof scanMarquees === 'function') scanMarquees(container);
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
  // Metadata is prefetched in the background rather than awaited here.
  // Awaiting a full-folder batch before rendering a single row means quick
  // repeat navigation (double-click, rapid back/forward, browsing fast)
  // stacks up multiple in-flight renderFileList() calls racing each other -
  // an older call's prefetch can resolve after a newer folder has already
  // replaced it, and large folders turn each navigation into its own
  // hundreds-of-files server-side metadata parse, piling up concurrently.
  // (See renderQueue() in queue-playlists.js for the same fix applied
  // there, and the reasoning in more detail.)
  //
  // Skipped when sorting by a metadata column: applySort() below already
  // awaits its own prefetch for exactly the same paths in that case (it
  // has to - there's no valid row order to render before that data
  // exists), so firing it here too would just be the same batch request
  // sent twice at once.
  const isMetaSort = METADATA_SORT_COLUMNS.has(sortColumn);
  if (!isMetaSort) {
    prefetchMeta(filtered.filter(i => i.isAudio).map(i => i.path));
  }
  const sorted = await applySort(filtered);
  // A newer renderFileList() call may have started (and possibly already
  // finished) while applySort() above was resolving for this one - only the
  // most recently *started* call should be allowed to actually paint the
  // list, or a slower older call finishing later would clobber a faster
  // newer one's rows with stale data.
  if (items !== lastFetchedItems) return;
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

  // Album view needs disc/track metadata up front to group rows correctly
  // (disc headers are structural, not cosmetic) - artist view and the
  // default listing group nothing metadata-dependent, so their rows can
  // render immediately and upgrade in place via buildFileRow's own
  // getMeta() call, same as the folder browser (see renderFileList).
  // applySort() awaits its own prefetch when actually sorting by a
  // metadata column, so this only needs to cover the still-uncovered case:
  // album view with no explicit sort, which skips applySort() entirely.
  if (isAlbumView) {
    await prefetchMeta(filtered.filter(i => i.isAudio).map(i => i.path));
  } else if (!METADATA_SORT_COLUMNS.has(sortColumn)) {
    prefetchMeta(filtered.filter(i => i.isAudio).map(i => i.path));
  }
  // A newer renderSearchResults() call (e.g. the user kept typing) may have
  // started, and even already cleared+rebuilt fileList, while the prefetch
  // above was resolving for this older call - bail before it appends
  // anything on top of a different search's results.
  if (items !== lastFetchedItems) return;

  if (isAlbumView) {
    // Group by disc first - sorting (explicit or default) only ever reorders
    // tracks WITHIN a disc, never across discs.
    const discs = [...new Set(filtered.map(i => i.disc || 1))].sort((a, b) => a - b);
    const showDiscHeaders = discs.length > 1;
    let flattened = [];
    for (const disc of discs) {
      const group = filtered.filter(i => (i.disc || 1) === disc);
      const sortedGroup = sortColumn ? await applySort(group) : sortByDiscTrackDefault(group);
      if (items !== lastFetchedItems) return; // same guard, re-checked after each per-disc await
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
    if (items !== lastFetchedItems) return;
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

// ---------------------------------------------------------------------------
// Desktop-only: scrollbars for the file list, album strip, tab panel, and
// upload list stay hidden until either (a) the user is actively scrolling,
// or (b) the cursor is specifically over the scrollbar's own track region —
// not just anywhere in the scrollable content, which is what CSS :hover
// alone would trigger on. Both conditions toggle the same .scrollbar-active
// class (see filelist.css), which the CSS then swaps the transparent
// thumb/track colors on.
(function setupHoverScrollbars() {
  const SCROLLBAR_THICKNESS = 6; // px, matches ::-webkit-scrollbar width/height in filelist.css
  const EDGE_HIT_SLOP = 4; // extra px of forgiveness around the exact edge, for easier targeting
  const SCROLL_HIDE_DELAY = 600; // ms of inactivity after a scroll before hiding again

  function attach(el) {
    if (!el) return;
    let hideTimer = null;
    function show() {
      el.classList.add('scrollbar-active');
      clearTimeout(hideTimer);
    }
    function scheduleHide() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => el.classList.remove('scrollbar-active'), SCROLL_HIDE_DELAY);
    }
    el.addEventListener('scroll', () => { show(); scheduleHide(); }, { passive: true });
    el.addEventListener('mousemove', (e) => {
      const rect = el.getBoundingClientRect();
      const nearRightEdge = el.scrollHeight > el.clientHeight &&
        e.clientX >= rect.right - SCROLLBAR_THICKNESS - EDGE_HIT_SLOP;
      const nearBottomEdge = el.scrollWidth > el.clientWidth &&
        e.clientY >= rect.bottom - SCROLLBAR_THICKNESS - EDGE_HIT_SLOP;
      if (nearRightEdge || nearBottomEdge) show();
      else if (!hideTimer) el.classList.remove('scrollbar-active');
    });
    el.addEventListener('mouseleave', () => {
      if (!hideTimer) el.classList.remove('scrollbar-active');
    });
  }
  // Exposed globally: .album-strip is created fresh via innerHTML every
  // time an artist view renders (see browse.js), so it doesn't exist yet
  // when this script first runs, and a one-time querySelectorAll here
  // would never find it (or would lose the listener on the next re-render,
  // since it's a brand new element each time). browse.js calls this
  // directly right after inserting a new strip.
  window.setupHoverScrollbarFor = attach;

  // .file-list is present at load; the other three (queue/playlist tab
  // panels, the upload list) are also static elements already in
  // index.html, never recreated — only .album-strip varies, handled above.
  document.querySelectorAll('.file-list, .upload-list').forEach(attach);
  document.querySelectorAll('.tab-panel').forEach(attach);
  // .player-blur-group is mobile-only (the full-player scroll container —
  // see responsive.css); also static and present at load, so it's safe to
  // attach here unconditionally alongside the desktop-only elements above.
  // The mousemove/mouseleave edge-hover half of attach() is simply inert on
  // touch (no such events fire there), leaving just the scroll-triggered
  // show/hide, which is exactly what's wanted on mobile too — this is what
  // lets responsive.css gate every scrollbar's visibility on the same
  // .scrollbar-active class desktop uses, rather than relying on each
  // browser's own (inconsistent) native scrollbar fade.
  document.querySelectorAll('.player-blur-group').forEach(attach);
})();