// ---------------------------------------------------------------------------
// filemanagement.js — Rename/move/delete for single items, new-folder
// button, search input wiring, and the search-scope toggle.
// Depends on: state.js, selection.js, browse.js, filelist.js.
// ---------------------------------------------------------------------------

// ---------- Inline name editing (new folder / rename) ----------
// Desktop has a keyboard, so an inline input with Enter/Escape/click-outside
// is enough. Mobile has no such shortcuts, so it instead gets a dedicated
// full-screen treatment (like the Files/Documents app pattern): the rest of
// the screen dims, the row being edited is raised above that dim layer, and
// a temporary top bar (Cancel / action title / Confirm) replaces the normal
// topbar for the duration of the edit.
const isDesktopUI = () => window.matchMedia('(hover: hover)').matches;
const renameOverlay = document.getElementById('renameOverlay');
const renameOverlayBar = document.querySelector('.rename-overlay-bar');
const renameOverlayTitle = document.getElementById('renameOverlayTitle');
const renameOverlayCancelBtn = document.getElementById('renameOverlayCancelBtn');
const renameOverlayConfirmBtn = document.getElementById('renameOverlayConfirmBtn');

// Belt-and-suspenders alongside .rename-no-scroll's touch-action: none
// (filelist.css) - some in-app WebViews still let an in-progress touch drag
// scroll the list underneath despite that CSS, so an active, non-passive
// touchmove listener vetoes the gesture outright while renaming.
function preventTouchScroll(e) { e.preventDefault(); }

// iOS WKWebView scrolls the visual viewport to keep a focused input above
// the keyboard even though html/body are overflow:hidden - a plain
// position:fixed bar stays pinned to the (unmoved) layout viewport, so it
// visually slides out of view/"under" the keyboard instead of following.
// Re-pinning it to visualViewport's own offset on every change keeps it
// genuinely stuck to the top of whatever's actually visible.
function syncRenameOverlayBarPosition() {
  if (!window.visualViewport) return;
  renameOverlayBar.style.top = window.visualViewport.offsetTop + 'px';
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncRenameOverlayBarPosition);
  window.visualViewport.addEventListener('scroll', syncRenameOverlayBarPosition);
}

// Wires up a name-editing <input> (already inserted into `row` in place of
// its normal name display) with confirm/cancel behavior appropriate to the
// platform, and returns nothing - `onConfirm(value)` is called with the
// trimmed, non-empty new name; the caller is responsible for restoring
// `row`'s original content on cancel (or leaving it, if it's a
// to-be-discarded placeholder like the new-folder row).
function wireNameEditInput({ row, input, title, initialSelect, onConfirm, onCancel }) {
  input.enterKeyHint = 'done';
  // The row itself may still have its own open-folder/play click handler
  // attached; stop clicks on the input (and their mousedown, which can fire
  // the row's own listeners first on some browsers) from bubbling up to it.
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());
  // Wrapped in a form so mobile virtual keyboards' "Go/Done" key - which
  // doesn't reliably dispatch a real Enter keydown - triggers submit instead.
  const form = document.createElement('form');
  input.replaceWith(form);
  form.appendChild(input);

  const isDesktop = isDesktopUI();
  if (!isDesktop) {
    row.classList.add('rename-spotlight');
    renameOverlayTitle.textContent = title;
    renameOverlay.classList.remove('hidden');
    fileList.classList.add('rename-no-scroll');
    fileList.addEventListener('touchmove', preventTouchScroll, { passive: false });
    syncRenameOverlayBarPosition();
  }

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    input.removeEventListener('keydown', onKeydown);
    if (isDesktop) {
      document.removeEventListener('mousedown', onOutsideClick, { capture: true });
    } else {
      row.classList.remove('rename-spotlight');
      renameOverlay.classList.add('hidden');
      renameOverlay.removeEventListener('click', onOutsideClick);
      fileList.classList.remove('rename-no-scroll');
      fileList.removeEventListener('touchmove', preventTouchScroll, { passive: false });
      renameOverlayBar.style.top = '';
      renameOverlayConfirmBtn.onclick = null;
      renameOverlayCancelBtn.onclick = null;
    }
    const value = commit ? input.value.trim() : '';
    if (value) onConfirm(value);
    else onCancel();
  };
  function onKeydown(e) {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  }
  // Clicking outside the input cancels, same as Escape - on desktop that's
  // anywhere outside the row's form (registered on mousedown/capture so it
  // beats the target's own click handlers, e.g. navigating into another
  // folder, firing first); on mobile it's a tap on the dimmed scrim, since
  // everything else on screen is already covered by it.
  function onOutsideClick(e) {
    if (form.contains(e.target) || renameOverlayBar.contains(e.target)) return;
    finish(false);
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); finish(true); });
  input.addEventListener('keydown', onKeydown);
  if (isDesktop) {
    document.addEventListener('mousedown', onOutsideClick, { capture: true });
  } else {
    // Mobile: tapping the dimmed scrim outside the spotlighted row cancels,
    // same as desktop's click-outside. The bar's own Cancel/Confirm buttons
    // are handled separately below; this only ever sees taps that land on
    // the scrim itself (the row and bar sit visually above it).
    renameOverlay.addEventListener('click', onOutsideClick);
    renameOverlayConfirmBtn.onclick = () => finish(true);
    renameOverlayCancelBtn.onclick = () => finish(false);
  }
  input.focus();
  if (initialSelect) input.setSelectionRange(initialSelect[0], initialSelect[1]);
  else input.select();
}

// ---------- File management ----------
async function renameItem(item) {
  const row = fileList.querySelector(`.file-row[data-path="${CSS.escape(item.path)}"]`);
  const currentName = fileNameOf(item.path);
  const dotIndex = currentName.lastIndexOf('.');
  const selectRange = (!item.isDir && dotIndex > 0) ? [0, dotIndex] : null;

  if (!row) {
    const newName = await showModal('Rename to', currentName, selectRange);
    if (newName) {
      await api('/api/rename', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ path: item.path, newName })
      });
      browse(currentPath, { keepSort: true });
    }
    return;
  }

  // Mobile's meta row view (settings.mobileFileRowView === 'meta', see
  // filelist.js) displays the track's title tag instead of its filename -
  // renaming there edits that title tag (same as the metadata editor's
  // title field) rather than the file on disk, since that's the text the
  // user is actually looking at and tapping on.
  const mobileMetaTitleEl = item.isAudio ? row.querySelector('.file-name-wrap-meta .row-title') : null;
  const editingMetaTitle = settings.mobileFileRowView === 'meta' && mobileMetaTitleEl && !isDesktopUI();

  if (editingMetaTitle) {
    const currentTitle = mobileMetaTitleEl.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'file-name-edit-input';
    input.value = currentTitle;
    mobileMetaTitleEl.replaceWith(input);

    wireNameEditInput({
      row,
      input,
      title: 'Rename',
      onConfirm: async (newTitle) => {
        if (newTitle !== currentTitle) {
          const { results } = await api('/api/edit-meta/apply', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ edits: [{ path: item.path, tags: { title: newTitle } }] })
          });
          for (const r of results) delete metaCache[r.path];
          browse(currentPath, { keepSort: true });
        } else {
          input.closest('form').replaceWith(mobileMetaTitleEl);
        }
      },
      onCancel: () => input.closest('form').replaceWith(mobileMetaTitleEl)
    });
    return;
  }

  const nameEl = row.querySelector('.file-name');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'file-name-edit-input';
  input.value = currentName;
  nameEl.replaceWith(input);

  wireNameEditInput({
    row,
    input,
    title: 'Rename',
    initialSelect: selectRange,
    onConfirm: async (newName) => {
      if (newName !== currentName) {
        await api('/api/rename', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ path: item.path, newName })
        });
        browse(currentPath, { keepSort: true });
      } else {
        input.closest('form').replaceWith(nameEl);
      }
    },
    onCancel: () => input.closest('form').replaceWith(nameEl)
  });
}
// ---------- Move (cut/paste) ----------
// "Move" stages the selected item(s) as a pending move (moveClipboard) instead
// of prompting for a destination path immediately. The user then navigates to
// the target folder and clicks "Move here" (top bar) to complete it, or
// "Cancel move" to discard it.
let moveClipboard = [];

const moveHereGroup = document.getElementById('moveHereGroup');
const moveHereGroupDesktopSlot = moveHereGroup.parentElement; // .topbar-actions, its original/desktop position
const moveHereMobileSlot = document.getElementById('moveHereMobileSlot');
const moveHereStatus = document.getElementById('moveHereStatus');
// #moveHereGroup lives inside .topbar-actions (matching its desktop
// position, right where "Move here"/"Cancel move" always rendered) but on
// mobile needs to show as its own full-width row above the breadcrumb
// instead - CSS alone can't relocate an element to a different parent, so
// it's physically moved between the two slots depending on viewport.
function placeMoveHereGroup() {
  const target = isDesktopUI() ? moveHereGroupDesktopSlot : moveHereMobileSlot;
  if (moveHereGroup.parentElement !== target) target.appendChild(moveHereGroup);
}
window.matchMedia('(hover: hover)').addEventListener('change', placeMoveHereGroup);
placeMoveHereGroup();

function updateMoveHereBtn() {
  placeMoveHereGroup();
  moveHereGroup.classList.toggle('hidden', moveClipboard.length === 0);
  moveHereStatus.textContent = moveClipboard.length
    ? `Moving ${moveClipboard.length} item${moveClipboard.length === 1 ? '' : 's'}`
    : '';
}
function stageMove(items) {
  moveClipboard = items;
  updateMoveHereBtn();
  clearSelection();
}
async function pasteMoveHere() {
  const items = moveClipboard;
  moveClipboard = [];
  updateMoveHereBtn();
  for (const item of items) {
    await api('/api/move', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ path: item.path, destFolder: currentPath }),
      retryOnAuth: false
    });
  }
  browse(currentPath, { keepSort: true });
}
document.getElementById('moveHereBtn').addEventListener('click', pasteMoveHere);
document.getElementById('moveCancelBtn').addEventListener('click', () => {
  moveClipboard = [];
  updateMoveHereBtn();
});
async function deleteItem(item) {
  if (confirmAction(`Delete "${item.name}"? This cannot be undone.`)) {
    await api('/api/delete', {
      method: 'DELETE', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ path: item.path })
    });
    browse(currentPath, { keepSort: true });
  }
}

document.getElementById('newFolderBtn').addEventListener('click', () => {
  if (isSearching) return; // no folder list to insert a placeholder row into

  const row = document.createElement('div');
  row.className = 'file-row';
  row.innerHTML = `
    <span class="file-track"></span>
    <span class="file-icon folder-icon-wrap"><span class="folder-icon-default">${FOLDER_ICON_SVG}</span></span>
    <div class="file-name-wrap"></div>
  `;
  const nameWrap = row.querySelector('.file-name-wrap');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'file-name-edit-input';
  input.placeholder = 'New folder';
  nameWrap.appendChild(input);
  fileList.insertBefore(row, fileList.firstChild);

  wireNameEditInput({
    row,
    input,
    title: 'New folder',
    onConfirm: async (name) => {
      await api('/api/mkdir', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ path: currentPath, name })
      });
      browse(currentPath, { keepSort: true });
    },
    onCancel: () => row.remove()
  });
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

