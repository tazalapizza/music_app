// ---------------------------------------------------------------------------
// filemanagement.js — Rename/move/delete for single items, new-folder
// button, search input wiring, and the search-scope toggle.
// Depends on: state.js, selection.js, browse.js, filelist.js.
// ---------------------------------------------------------------------------

// ---------- File management ----------
async function renameItem(item) {
  const currentName = fileNameOf(item.path);
  const dotIndex = currentName.lastIndexOf('.');
  const selectRange = (!item.isDir && dotIndex > 0) ? [0, dotIndex] : null;
  const newName = await showModal('Rename to', currentName, selectRange);
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

