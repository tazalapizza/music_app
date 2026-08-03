// ---------------------------------------------------------------------------
// selection.js — Path helpers (fileNameOf/dirNameOf), multi-select
// (ctrl/shift-click row selection), and metadata fetch helpers (getMeta,
// prefetchMeta). Depends on: state.js.
// ---------------------------------------------------------------------------

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
  // Mobile select mode (see layout-init.js) and "selection is non-empty"
  // are meant to be the same state — dots visible only when select mode
  // is off, which also guarantees nothing is selected. Every caller of
  // clearSelection() (list re-render, navigating away, an action
  // finishing, tapping empty space) is a point where select mode should
  // end too, so this is hooked here once rather than duplicated at each
  // call site.
  if (window.exitMobileSelectMode) window.exitMobileSelectMode();
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