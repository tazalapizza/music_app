// ---------------------------------------------------------------------------
// queue-playlists.js — Queue panel rendering/drag-reorder, playlists panel,
// tab switching, and the right-click context menus (single + multi-select).
// Depends on: state.js, selection.js, playback.js, controls.js.
// ---------------------------------------------------------------------------

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
    { icon: PLUS_ICON_SVG, label: 'Add to queue', action: () => addPlaylistTracksToQueue(tracks) },
    { icon: PLAYLIST_ICON_SVG, label: 'Add to playlist...', action: () => showAddPlaylistToPlaylistMenu(name, tracks) },
    { icon: RENAME_ICON_SVG, label: 'Rename', action: () => renamePlaylist(name, tracks) },
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
    options.push({ icon: PLUS_ICON_SVG, label: 'Add to queue', action: () => addToQueue(item) });
    options.push({ icon: PLAYLIST_ICON_SVG, label: 'Add to playlist...', action: () => showAddToPlaylistMenu(item) });
  }
  if (item.isAudio) {
    options.push({ icon: EDIT_ICON_SVG, label: 'Edit metadata', action: () => openMetadataEditor([item]) });
  }
  options.push({ icon: RENAME_ICON_SVG, label: 'Rename', action: () => renameItem(item) });
  options.push({ icon: FOLDER_ICON_SVG, label: 'Move to...', action: () => moveItem(item) });
  options.push({ icon: TRASH_ICON_SVG, label: 'Delete', action: () => deleteItem(item) });
  renderMenuOptions(options);
  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';
  contextMenu.classList.remove('hidden');
}
function hideContextMenu() { contextMenu.classList.add('hidden'); }
document.addEventListener('click', (e) => {
  if (!contextMenu.contains(e.target)) hideContextMenu();
  // Mobile select mode manages its own selection lifecycle (rows toggle
  // items in/out, OK explicitly clears) — this desktop-oriented "clicked
  // away from a context menu, drop the selection" behavior would
  // otherwise wipe the selection (and, via clearSelection's hook, exit
  // select mode) on literally the next row tap after the first one.
  if (window.mobileSelectModeActive) return;
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
    { icon: PLUS_ICON_SVG, label: `Add ${items.length} to queue`, action: () => addAllToQueue(items) },
    { icon: PLAYLIST_ICON_SVG, label: 'Add to playlist...', action: () => showAddToPlaylistMenuMulti(items) }
  ];
  if (audioItems.length) {
    options.push({ icon: EDIT_ICON_SVG, label: `Edit metadata (${audioItems.length})`, action: () => openMetadataEditor(audioItems) });
  }
  options.push({ icon: FOLDER_ICON_SVG, label: 'Move to...', action: () => moveItems(items) });
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