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

// Tracks in-flight /api/meta requests by path so concurrent callers asking
// for the same not-yet-cached path (e.g. playCurrent() fetching it for the
// player bar and renderQueue() fetching it for the matching queue row,
// moments apart) share one request instead of each firing their own - the
// metaCache check alone only catches this once a request has already
// resolved, not while it's still pending.
const pendingMetaFetches = new Map(); // path -> Promise

async function getMeta(path) {
  if (metaCache[path]) return metaCache[path];
  const pending = pendingMetaFetches.get(path);
  if (pending) return pending;
  const promise = (async () => {
    try {
      const data = await api(`/api/meta?path=${encodeURIComponent(path)}`);
      metaCache[path] = data;
      return data;
    } catch {
      return { title: fileNameOf(path), artist: '', duration: null, hasArt: false };
    } finally {
      pendingMetaFetches.delete(path);
    }
  })();
  pendingMetaFetches.set(path, promise);
  return promise;
}

// The server's own /api/meta/batch limit (META_BATCH_LIMIT in server.js) is
// currently 100 - this only needs to stay at or below that so a chunk never
// gets silently truncated server-side (see that constant's comment for what
// happens if it does). It's set lower here, not matched exactly, so each
// individual request/response and its concurrent parse work on the server
// stays small - large mixed page sizes (500/100) were part of what made a
// big folder's worth of metadata requests turn into a heavy simultaneous
// parsing burst; smaller chunks spread that out.
const META_BATCH_CHUNK_SIZE = 20;
// With chunks this small, a large folder/queue can now split into dozens of
// requests (e.g. 1000 tracks -> 50 chunks) - the server-side concurrency
// limiter (withMetaParseSlot in server.js) caps how much parsing work runs
// at once regardless, but there's still no reason for one tab to open
// dozens of simultaneous connections for a single prefetch call.
const META_BATCH_CONCURRENCY = 6;

// Fetches metadata for many paths in one or more requests instead of one
// request per track. Populates metaCache so subsequent getMeta() calls for
// these paths (e.g. from buildFileRow) resolve instantly from cache.
async function prefetchMeta(paths) {
  const missing = [...new Set(paths)].filter(p => !metaCache[p] && !pendingMetaFetches.has(p));
  if (missing.length === 0) return;

  const chunks = [];
  for (let i = 0; i < missing.length; i += META_BATCH_CHUNK_SIZE) {
    chunks.push(missing.slice(i, i + META_BATCH_CHUNK_SIZE));
  }

  async function runChunk(chunk) {
    // Registered in pendingMetaFetches (same map getMeta() checks) before
    // the request goes out, so a getMeta() call for a path that's already
    // part of this in-flight batch attaches to it instead of firing its own
    // separate /api/meta request for a path that's seconds away from
    // showing up in metaCache anyway.
    const chunkPromise = (async () => {
      try {
        const { meta } = await api('/api/meta/batch', { method: 'POST', body: JSON.stringify({ paths: chunk }), headers: { 'Content-Type': 'application/json' } });
        for (const p of chunk) {
          if (meta[p]) metaCache[p] = meta[p];
        }
        // getMeta() expects its own return value to be this path's data
        // specifically (or the fallback shape on failure) - resolve each
        // path's shared promise to that, not to the whole batch response.
        return chunk.reduce((acc, p) => {
          acc[p] = meta[p] || { title: fileNameOf(p), artist: '', duration: null, hasArt: false };
          return acc;
        }, {});
      } catch {
        // Fall through silently for this chunk - individual getMeta() calls
        // (including ones already attached to this promise) fall back to
        // their own per-path placeholder below.
        return chunk.reduce((acc, p) => {
          acc[p] = { title: fileNameOf(p), artist: '', duration: null, hasArt: false };
          return acc;
        }, {});
      } finally {
        for (const p of chunk) pendingMetaFetches.delete(p);
      }
    })();
    for (const p of chunk) pendingMetaFetches.set(p, chunkPromise.then(byPath => byPath[p]));
    await chunkPromise;
  }

  let next = 0;
  async function worker() {
    while (next < chunks.length) {
      await runChunk(chunks[next++]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(META_BATCH_CONCURRENCY, chunks.length) }, worker));
}