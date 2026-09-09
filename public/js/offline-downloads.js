// ---------------------------------------------------------------------------
// offline-downloads.js — Two unrelated things sharing one "Download" menu
// entry, split by isDesktopUI() (filemanagement.js) at the call site in
// queue-playlists.js:
//
// - Mobile: downloadTrackForOffline/downloadFolderForOffline store a track
//   (or a whole folder, recursively) - audio + embedded art - in IndexedDB
//   so it keeps playing with no network at all. Downloaded tracks are
//   addressed by the same `path` the rest of the app already uses (see
//   playback.js's streamUrl) - nothing about the queue/playlist data model
//   changes; playCurrent() just prefers a local blob URL over the network
//   URL when one exists for that path.
// - Desktop: downloadFileToComputer/downloadFolderToComputer just trigger a
//   normal browser file save (no IndexedDB, no offline-in-app playback, no
//   "remove" concept, no storage-used display in Settings) - desktop
//   already has network access to this app's own server, so there's no
//   real offline-playback need there; the ask on desktop is a real file.
//
// Depends on: state.js (DOWNLOAD_ICON_SVG/TRASH_ICON_SVG/CHECK_ICON_SVG),
// settings-auth-toast-lyrics.js (showToast), selection.js (api), state.js
// (fileNameOf) - all called lazily at click time so load order doesn't
// matter.
// ---------------------------------------------------------------------------

// ---------- Desktop: plain file downloads (no IndexedDB, no offline wiring) ----------
// progressPath, when given, drives that path's own row indicator (the same
// ring/registry offline-downloads.js's mobile side uses - see
// registerOfflineIndicator/updateOfflineIndicatorsFor above) instead of a
// generic UI element, so a single file or folder download shows its
// progress right on the row being downloaded, like mobile's does. isOffline
// Downloaded()/isFolderFullyOffline() stay false for every path here since
// desktop never writes to that store, so the indicator only ever shows the
// transient ring, never the "stored" checkmark.
async function downloadFileToComputer(item, progressPath) {
  if (progressPath) { downloadProgress.set(progressPath, 0); updateOfflineIndicatorsFor(progressPath); }
  try {
    const res = await fetch(`${location.origin}/api/stream?path=${encodeURIComponent(item.path)}`);
    if (!res.ok) throw new Error('Failed to fetch file');
    const blob = progressPath
      ? await readBlobWithProgress(res, (p) => {
          downloadProgress.set(progressPath, p);
          updateOfflineIndicatorsFor(progressPath);
        })
      : await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.error('[download] failed:', item.path, err);
    showToast('Download failed');
  } finally {
    if (progressPath) { downloadProgress.delete(progressPath); updateOfflineIndicatorsFor(progressPath); }
  }
}

// Bundles several files into one .zip on the server (see the
// /api/download-zip route in server.js) and triggers a single browser
// download for it. Triggering one download per file in a loop instead used
// to hit the browser's own "this site is downloading multiple files"
// guard, which makes the user click through a confirmation for every file.
// progressPath: see downloadFileToComputer's comment above. Falls back to a
// generic ring on the settings button when there's no single row to anchor
// to (a multi-file or multi-folder selection).
async function downloadZipToComputer(paths, zipName, progressPath) {
  const zipProgressRing = progressPath ? null : document.getElementById('zipProgressRing');
  if (zipProgressRing) {
    zipProgressRing.style.setProperty('--offline-progress', '0');
    zipProgressRing.classList.add('active');
  } else {
    downloadProgress.set(progressPath, 0);
    updateOfflineIndicatorsFor(progressPath);
  }
  try {
    const res = await fetch(`${location.origin}/api/download-zip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, zipName })
    });
    if (!res.ok) throw new Error('Failed to build zip');
    // X-Total-Size (set by /api/download-zip) is a same-server estimate of
    // the finished zip's size - the real response is chunked (archiver
    // streams it as it's built) so it has no true Content-Length to read
    // progress against otherwise.
    const totalSize = Number(res.headers.get('X-Total-Size')) || 0;
    const blob = await readBlobWithProgress(res, (p) => {
      if (zipProgressRing) zipProgressRing.style.setProperty('--offline-progress', String(p));
      else { downloadProgress.set(progressPath, p); updateOfflineIndicatorsFor(progressPath); }
    }, totalSize);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = zipName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.error('[download] zip failed:', err);
    showToast('Download failed');
  } finally {
    if (zipProgressRing) zipProgressRing.classList.remove('active');
    else { downloadProgress.delete(progressPath); updateOfflineIndicatorsFor(progressPath); }
  }
}

// A single file downloads directly; two or more are zipped into one
// download so the browser only ever prompts/downloads once. No single row
// to anchor progress to for this bulk case - falls back to the settings
// button's ring (see downloadZipToComputer).
async function downloadFilesToComputer(items) {
  if (items.length === 1) { await downloadFileToComputer(items[0]); return; }
  await downloadZipToComputer(items.map((i) => i.path), 'songs.zip');
}

async function downloadFolderToComputer(item) {
  try {
    const { files } = await api(`/api/expand?path=${encodeURIComponent(item.path)}`);
    if (!files.length) { showToast('No audio files in this folder'); return; }
    await downloadZipToComputer(files, `${item.name}.zip`, item.path);
  } catch (err) {
    console.error('[download] folder download failed:', item.path, err);
    showToast('Download failed');
  }
}

// Multi-select of several folders: expands all of them and bundles every
// file into one zip, rather than one zip download per folder.
async function downloadFoldersToComputer(items) {
  try {
    const expanded = await Promise.all(items.map((item) => api(`/api/expand?path=${encodeURIComponent(item.path)}`)));
    const files = expanded.flatMap((r) => r.files);
    if (!files.length) { showToast('No audio files in these folders'); return; }
    await downloadZipToComputer(files, 'folders.zip');
  } catch (err) {
    console.error('[download] folders download failed:', err);
    showToast('Download failed');
  }
}

// ---------- Mobile: offline in-app playback (IndexedDB-backed) ----------

const OFFLINE_DB_NAME = 'vibing-offline';
const OFFLINE_DB_VERSION = 2;
const OFFLINE_STORE = 'tracks';
const OFFLINE_FOLDER_STORE = 'folders';

function openOfflineDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OFFLINE_STORE)) db.createObjectStore(OFFLINE_STORE, { keyPath: 'path' });
      if (!db.objectStoreNames.contains(OFFLINE_FOLDER_STORE)) db.createObjectStore(OFFLINE_FOLDER_STORE, { keyPath: 'path' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// path -> { audio: blobURL, art: blobURL|null, size } for every downloaded
// track, kept in memory so playCurrent() can look one up synchronously
// instead of going through IndexedDB (which is async) on every play.
const offlineBlobUrls = new Map();

// Paths of folders whose entire (at the time of download) audio contents
// were downloaded as a unit - drives the folder row's own checkmark. This
// is a point-in-time marker, not a live invariant: files added to the
// folder afterwards, or removed individually via "Remove offline download"
// on one of its tracks (see invalidateAncestorFolderStatus below), aren't
// tracked automatically beyond that one invalidation check.
const offlineFolderPaths = new Set();

// path (file or folder) -> 0..1 while a download is in flight (absent once
// done/failed/never started) - drives the filling-circle indicator in
// filelist.js's rows. A folder's own progress is the fraction of its audio
// files that have finished downloading so far.
const downloadProgress = new Map();

// path -> Set<HTMLElement>: every currently-rendered .offline-indicator for
// that path (a row can be rebuilt/re-rendered at any time - see
// registerOfflineIndicator below), so a download's progress/completion can
// update whichever rows happen to be on screen right now.
const offlineIndicatorEls = new Map();

function registerOfflineIndicator(path, el) {
  if (!offlineIndicatorEls.has(path)) offlineIndicatorEls.set(path, new Set());
  offlineIndicatorEls.get(path).add(el);
  applyOfflineIndicatorState(el, path);
}

function applyOfflineIndicatorState(el, path) {
  el.classList.remove('downloading', 'downloaded');
  el.innerHTML = '';
  if (downloadProgress.has(path)) {
    el.classList.add('downloading');
    el.style.setProperty('--offline-progress', String(downloadProgress.get(path)));
  } else if (isOfflineDownloaded(path) || isFolderFullyOffline(path)) {
    el.classList.add('downloaded');
    el.innerHTML = CHECK_ICON_SVG;
  }
}

function updateOfflineIndicatorsFor(path) {
  const els = offlineIndicatorEls.get(path);
  if (!els) return;
  for (const el of els) {
    if (!el.isConnected) { els.delete(el); continue; } // row was re-rendered/removed since - drop the stale reference
    applyOfflineIndicatorState(el, path);
  }
}

async function loadOfflineIndexIntoMemory() {
  const db = await openOfflineDB();
  const store = db.transaction(OFFLINE_STORE, 'readonly').objectStore(OFFLINE_STORE);
  const records = await new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  for (const rec of records) {
    offlineBlobUrls.set(rec.path, {
      audio: URL.createObjectURL(rec.audioBlob),
      art: rec.artBlob ? URL.createObjectURL(rec.artBlob) : null,
      size: rec.audioBlob.size + (rec.artBlob ? rec.artBlob.size : 0)
    });
  }
  const folderStore = db.transaction(OFFLINE_FOLDER_STORE, 'readonly').objectStore(OFFLINE_FOLDER_STORE);
  const folderRecords = await new Promise((resolve, reject) => {
    const req = folderStore.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  for (const rec of folderRecords) offlineFolderPaths.add(rec.path);
}
loadOfflineIndexIntoMemory().catch(err => console.error('[offline] failed to load downloaded tracks:', err));

function isOfflineDownloaded(path) {
  return offlineBlobUrls.has(path);
}
function isFolderFullyOffline(path) {
  return offlineFolderPaths.has(path);
}
function getOfflineStreamUrl(path) {
  const entry = offlineBlobUrls.get(path);
  return entry ? entry.audio : null;
}
function getOfflineArtUrl(path) {
  const entry = offlineBlobUrls.get(path);
  return entry && entry.art ? entry.art : null;
}

// Total bytes across every downloaded track (audio + art), for the settings
// panel's storage-used display.
function getOfflineDownloadsTotalSize() {
  let total = 0;
  for (const entry of offlineBlobUrls.values()) total += entry.size;
  return total;
}
function getOfflineDownloadsCount() {
  return offlineBlobUrls.size;
}

// Reads a fetch Response's body as a Blob while reporting progress against
// its Content-Length (falls back to a single no-progress await when the
// server didn't send a length or the browser can't stream the body).
// totalOverride covers responses that are streamed/chunked and so have no
// real Content-Length (e.g. /api/download-zip, whose final size isn't known
// until the zip is fully built) - the server sends its own best-effort
// total in a custom header instead (see readBlobWithProgress's zip caller).
async function readBlobWithProgress(res, onProgress, totalOverride) {
  const total = totalOverride || Number(res.headers.get('Content-Length')) || 0;
  if (!res.body || !total) return res.blob();
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(Math.min(received / total, 1));
  }
  return new Blob(chunks);
}

async function downloadTrackForOffline(item, opts = {}) {
  if (isOfflineDownloaded(item.path)) { if (!opts.silent) showToast('Already downloaded'); return; }
  if (downloadProgress.has(item.path)) return; // already downloading
  downloadProgress.set(item.path, 0);
  updateOfflineIndicatorsFor(item.path);
  try {
    const audioRes = await fetch(`${location.origin}/api/stream?path=${encodeURIComponent(item.path)}`);
    if (!audioRes.ok) throw new Error('Failed to fetch audio');
    const audioBlob = await readBlobWithProgress(audioRes, (p) => {
      downloadProgress.set(item.path, p);
      updateOfflineIndicatorsFor(item.path);
    });
    // Art is a nice-to-have for offline playback - a missing/failed cover
    // shouldn't block the track itself from being downloaded.
    let artBlob = null;
    try {
      const artRes = await fetch(`${location.origin}/api/art?path=${encodeURIComponent(item.path)}`);
      if (artRes.ok) artBlob = await artRes.blob();
    } catch {}
    const db = await openOfflineDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(OFFLINE_STORE, 'readwrite');
      tx.objectStore(OFFLINE_STORE).put({ path: item.path, name: item.name, audioBlob, artBlob });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    offlineBlobUrls.set(item.path, {
      audio: URL.createObjectURL(audioBlob),
      art: artBlob ? URL.createObjectURL(artBlob) : null,
      size: audioBlob.size + (artBlob ? artBlob.size : 0)
    });
    downloadProgress.delete(item.path);
    updateOfflineIndicatorsFor(item.path);
    if (!opts.silent) showToast(`Downloaded "${item.name}"`);
  } catch (err) {
    console.error('[offline] download failed:', item.path, err);
    downloadProgress.delete(item.path);
    updateOfflineIndicatorsFor(item.path);
    if (!opts.silent) showToast('Download failed');
  }
}

// A folder path is an ancestor of (or equal to) a file path only when the
// file path starts with the folder path followed by a separator (a plain
// startsWith without the separator would wrongly match "Foo" against
// "Foobar/track.mp3").
function pathIsInsideFolder(filePath, folderPath) {
  if (!folderPath) return true; // "" is the library root - contains everything
  return filePath === folderPath || filePath.startsWith(folderPath + '/') || filePath.startsWith(folderPath + '\\');
}

// Drops the "fully downloaded" marker for any ancestor folder of a file
// that just had its own offline copy removed - that folder is no longer
// entirely downloaded, so its checkmark shouldn't keep showing.
function invalidateAncestorFolderStatus(filePath) {
  for (const folderPath of Array.from(offlineFolderPaths)) {
    if (!pathIsInsideFolder(filePath, folderPath)) continue;
    offlineFolderPaths.delete(folderPath);
    openOfflineDB()
      .then((db) => tx1(db, OFFLINE_FOLDER_STORE, 'readwrite', (store) => store.delete(folderPath)))
      .catch(() => {});
    updateOfflineIndicatorsFor(folderPath);
  }
}

// Small helper so one-shot IndexedDB writes (a single put/delete/clear)
// don't each need their own promise/transaction boilerplate at every call
// site below.
function tx1(db, storeName, mode, run) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    run(tx.objectStore(storeName));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function removeOfflineDownload(item, opts = {}) {
  const entry = offlineBlobUrls.get(item.path);
  if (!entry) return;
  URL.revokeObjectURL(entry.audio);
  if (entry.art) URL.revokeObjectURL(entry.art);
  offlineBlobUrls.delete(item.path);
  const db = await openOfflineDB();
  await tx1(db, OFFLINE_STORE, 'readwrite', (store) => store.delete(item.path));
  invalidateAncestorFolderStatus(item.path);
  updateOfflineIndicatorsFor(item.path);
  if (!opts.silent) showToast(`Removed "${item.name}" from offline downloads`);
}

async function downloadFolderForOffline(item) {
  if (isFolderFullyOffline(item.path)) { showToast('Already downloaded'); return; }
  if (downloadProgress.has(item.path)) return; // already downloading
  downloadProgress.set(item.path, 0);
  updateOfflineIndicatorsFor(item.path);
  try {
    const { files } = await api(`/api/expand?path=${encodeURIComponent(item.path)}`);
    if (!files.length) {
      downloadProgress.delete(item.path);
      updateOfflineIndicatorsFor(item.path);
      showToast('No audio files in this folder');
      return;
    }
    const tracks = files.map((f) => ({ path: f, name: fileNameOf(f) }));
    let completed = tracks.filter((t) => isOfflineDownloaded(t.path)).length;
    const total = tracks.length;
    const bumpFolderProgress = () => {
      downloadProgress.set(item.path, completed / total);
      updateOfflineIndicatorsFor(item.path);
    };
    bumpFolderProgress();
    for (const track of tracks) {
      if (!isOfflineDownloaded(track.path)) {
        await downloadTrackForOffline(track, { silent: true });
      }
      completed++;
      bumpFolderProgress();
    }
    downloadProgress.delete(item.path);
    offlineFolderPaths.add(item.path);
    const db = await openOfflineDB();
    await tx1(db, OFFLINE_FOLDER_STORE, 'readwrite', (store) => store.put({ path: item.path }));
    updateOfflineIndicatorsFor(item.path);
    showToast(`Downloaded "${item.name}" (${total} song${total === 1 ? '' : 's'})`);
  } catch (err) {
    console.error('[offline] folder download failed:', item.path, err);
    downloadProgress.delete(item.path);
    updateOfflineIndicatorsFor(item.path);
    showToast('Download failed');
  }
}

async function removeFolderOfflineDownload(item) {
  try {
    const { files } = await api(`/api/expand?path=${encodeURIComponent(item.path)}`);
    for (const f of files) {
      if (isOfflineDownloaded(f)) await removeOfflineDownload({ path: f, name: fileNameOf(f) }, { silent: true });
    }
  } catch (err) {
    console.error('[offline] failed to expand folder for removal:', item.path, err);
  }
  offlineFolderPaths.delete(item.path);
  const db = await openOfflineDB();
  await tx1(db, OFFLINE_FOLDER_STORE, 'readwrite', (store) => store.delete(item.path));
  updateOfflineIndicatorsFor(item.path);
  showToast(`Removed "${item.name}" from offline downloads`);
}

// Settings panel "Delete all downloads" - wipes every stored track/folder
// marker in one shot rather than requiring one removal call per item.
async function deleteAllOfflineDownloads() {
  const paths = [...offlineBlobUrls.keys(), ...offlineFolderPaths];
  for (const entry of offlineBlobUrls.values()) {
    URL.revokeObjectURL(entry.audio);
    if (entry.art) URL.revokeObjectURL(entry.art);
  }
  offlineBlobUrls.clear();
  offlineFolderPaths.clear();
  const db = await openOfflineDB();
  await tx1(db, OFFLINE_STORE, 'readwrite', (store) => store.clear());
  await tx1(db, OFFLINE_FOLDER_STORE, 'readwrite', (store) => store.clear());
  paths.forEach(updateOfflineIndicatorsFor);
}
